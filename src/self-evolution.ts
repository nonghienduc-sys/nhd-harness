import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * NHD self-evolution v1: feedback metadata -> repeat detection -> an append-only
 * candidate skill. This module deliberately cannot change live skills, execute
 * candidate code, update runtime pointers, or approve its own release.
 */
export type EvolutionFeedback = {
  taskId: string;
  skillId: string;
  issueCode: string;
  outcome: "failure" | "success";
  source: "user_correction" | "verified_qa" | "tool_failure";
  verified: boolean;
};
export type EvolutionIssue = {
  skillId: string;
  issueCode: string;
  failures: number;
  distinctTasks: number;
  firstSeen: string;
  lastSeen: string;
  eligible: boolean;
};

const REMEDIATIONS: Record<string, { rule: string; checks: string[] }> = {
  DOCX_JUSTIFY: {
    rule: "For Vietnamese administrative documents, apply paragraph alignment=justify to every body paragraph, including paragraphs inserted after the initial formatting pass. Independently inspect the final DOCX paragraph properties and visually review rendered pages before release.",
    checks: ["All body paragraphs are justified in DOCX XML", "Page-by-page visual review receipt exists", "ND30 release gate remains mandatory"],
  },
  DOCX_SHAPE_LINE: {
    rule: "Place administrative divider lines using the checked template's anchored Word shape or line geometry. Verify its actual position after PDF rendering; a text underline or border is not an automatic substitute.",
    checks: ["Expected shape and anchor exist", "Measured line position matches approved template", "Visual review covers the page"],
  },
  DOCX_RELEASE_QA: {
    rule: "Do not mark official administrative documents as final unless the managed release gate binds hashes of the exact DOCX, PDF and every reviewed page image. Failed or missing evidence remains DRAFT.",
    checks: ["Exact final DOCX/PDF hashes match", "Every rendered page has a review receipt", "Release fails closed on missing evidence"],
  },
  SKILL_DUPLICATE: {
    rule: "Before introducing a new skill, compare the current Skill Registry for equivalent functionality. Prefer a canonical skill and disable legacy routing only after regression verification; retain rollback material.",
    checks: ["Canonical skill identified", "No duplicate routing activated", "Legacy resources retained for rollback"],
  },
};

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_EVENTS = 50_000;

function validateFeedback(input: EvolutionFeedback) {
  if (!input.taskId || input.taskId.length > 256 || !/^[a-zA-Z0-9._:-]+$/.test(input.taskId)) throw new Error("Invalid taskId.");
  if (!ID_RE.test(input.skillId)) throw new Error("Invalid skillId.");
  if (!CODE_RE.test(input.issueCode)) throw new Error("Invalid issueCode.");
  if (!["failure", "success"].includes(input.outcome)) throw new Error("Invalid outcome.");
  if (!["user_correction", "verified_qa", "tool_failure"].includes(input.source)) throw new Error("Invalid feedback source.");
  if (typeof input.verified !== "boolean") throw new Error("verified must be boolean.");
}

export class SelfEvolutionEngine {
  private readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly skillsRoot: string;
  readonly candidateRoot: string;

  constructor({ dataDir, skillsRoot }: { dataDir: string; skillsRoot: string }) {
    this.dataDir = resolve(dataDir, "self-evolution");
    this.skillsRoot = resolve(skillsRoot);
    this.candidateRoot = resolve(this.dataDir, "candidates");
    mkdirSync(this.candidateRoot, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, "events.sqlite"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, skill_id TEXT NOT NULL,
      issue_code TEXT NOT NULL, outcome TEXT NOT NULL, source TEXT NOT NULL,
      verified INTEGER NOT NULL, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_issue_idx ON feedback(skill_id,issue_code,at);`);
  }

  close() { this.db.close(); }

  recordFeedback(input: EvolutionFeedback) {
    validateFeedback(input);
    const id = digest([input.taskId, input.skillId, input.issueCode, input.outcome, input.source].join("|"));
    const count = Number((this.db.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number }).n);
    if (count >= MAX_EVENTS && !this.db.prepare("SELECT id FROM feedback WHERE id=?").get(id)) {
      throw new Error("Feedback capacity reached; manual archival required.");
    }
    const at = new Date().toISOString();
    const result = this.db.prepare("INSERT OR IGNORE INTO feedback(id,task_id,skill_id,issue_code,outcome,source,verified,at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, input.taskId, input.skillId, input.issueCode, input.outcome, input.source, input.verified ? 1 : 0, at);
    return { id, accepted: result.changes === 1, storedRawText: false };
  }

  /** Tool failures are sampled by task and operation, not by raw error text. */
  observeToolFailure(toolName: string, output: unknown, taskId?: string | null) {
    if (!taskId || !/^[a-zA-Z0-9._:-]{1,256}$/.test(taskId) || toolName.startsWith("self_evolution_")) return null;
    const value = output as { isError?: boolean } | null;
    if (!value?.isError) return null;
    const skillId = "tool-" + toolName.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 74);
    return this.recordFeedback({ taskId, skillId, issueCode: "MCP_TOOL_ERROR", source: "tool_failure", outcome: "failure", verified: false });
  }

  analyze(minDistinctTasks = 2): EvolutionIssue[] {
    if (!Number.isInteger(minDistinctTasks) || minDistinctTasks < 2 || minDistinctTasks > 100) throw new Error("Invalid minimum task count.");
    const rows = this.db.prepare(`SELECT skill_id AS skillId, issue_code AS issueCode,
      COUNT(*) AS failures, COUNT(DISTINCT task_id) AS distinctTasks,
      MIN(at) AS firstSeen, MAX(at) AS lastSeen
      FROM feedback WHERE outcome='failure' AND verified=1
      GROUP BY skill_id, issue_code ORDER BY distinctTasks DESC, failures DESC
      LIMIT 100`).all() as unknown as Array<Omit<EvolutionIssue, "eligible">>;
    return rows.map((row) => ({
      ...row, eligible: row.distinctTasks >= minDistinctTasks && Boolean(REMEDIATIONS[row.issueCode]) && !row.skillId.startsWith("tool-")
    }));
  }

  status() {
    const count = this.db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN verified=1 AND outcome='failure' THEN 1 ELSE 0 END),0) AS verifiedFailures FROM feedback").get() as { total: number; verifiedFailures: number };
    return { version: 1, ...count, candidateRoot: this.candidateRoot, storesRawText: false,
      autoApply: false, modifiesLiveSkills: false, modifiesSafety: false, autoPromote: false,
      issues: this.analyze().filter((x) => x.eligible).length };
  }

  private readSkill(skillId: string) {
    if (!ID_RE.test(skillId) || skillId.startsWith("tool-")) throw new Error("Invalid editable skill ID.");
    const directory = resolve(this.skillsRoot, skillId);
    if (!directory.startsWith(this.skillsRoot + sep) || !existsSync(directory) || lstatSync(directory).isSymbolicLink()) throw new Error("Skill path invalid.");
    const path = resolve(directory, "SKILL.md");
    if (!path.startsWith(directory + sep) || !existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error("Skill instructions missing.");
    const content = readFileSync(path, "utf8");
    if (!content.startsWith("---")) throw new Error("Skill frontmatter missing.");
    return { path, content, hash: digest(content) };
  }

  propose(skillId: string, issueCode: string) {
    if (!CODE_RE.test(issueCode) || !REMEDIATIONS[issueCode]) throw new Error("No deterministic remediation for this issue.");
    const issue = this.analyze().find((x) => x.skillId === skillId && x.issueCode === issueCode && x.eligible);
    if (!issue) throw new Error("Requires at least two distinct verified failing tasks and an approved rule.");
    const baseline = this.readSkill(skillId);
    const recipe = REMEDIATIONS[issueCode];
    const id = digest([skillId, issueCode, baseline.hash, recipe.rule].join("|")).slice(0, 24);
    const folder = join(this.candidateRoot, id);
    mkdirSync(folder, { recursive: true });
    const appendix = `\n\n## NHD self-evolution candidate: ${issueCode}\n\n${recipe.rule}\n\nAcceptance checks:\n${recipe.checks.map((c) => `- ${c}`).join("\n")}\n`;
    const candidate = baseline.content + appendix;
    const manifest = {
      schema: 1, id, skillId, issueCode, baselinePath: baseline.path, baselineSha256: baseline.hash,
      candidateSha256: digest(candidate), failures: issue.failures, distinctTasks: issue.distinctTasks,
      checks: recipe.checks, status: "CANDIDATE_ONLY", approval: "required",
      permitsAutoApply: false, permitsAutoPromote: false,
    };
    const candidatePath = join(folder, "SKILL.md.candidate");
    const manifestPath = join(folder, "manifest.json");
    if (existsSync(candidatePath) && digest(readFileSync(candidatePath)) !== manifest.candidateSha256) throw new Error("Candidate collision or tampering.");
    if (!existsSync(candidatePath)) writeFileSync(candidatePath, candidate, { flag: "wx" });
    if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return { ...manifest, candidatePath, manifestPath, evaluation: this.evaluate(id) };
  }

  evaluate(id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid candidate ID.");
    const folder = join(this.candidateRoot, id);
    const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as {
      id: string; baselineSha256: string; candidateSha256: string; skillId: string; issueCode: string;
    };
    const baseline = this.readSkill(manifest.skillId);
    const candidate = readFileSync(join(folder, "SKILL.md.candidate"), "utf8");
    const proposed = candidate.slice(baseline.content.length);
    const checks = {
      manifestId: manifest.id === id,
      baseUnchanged: baseline.hash === manifest.baselineSha256,
      candidateHash: digest(candidate) === manifest.candidateSha256,
      appendOnly: candidate.startsWith(baseline.content),
      expectedRule: proposed.includes(REMEDIATIONS[manifest.issueCode]?.rule ?? "\0"),
      noDangerousInstructions: !/bypass.{0,30}(?:safety|approval|permission)|disable.{0,30}(?:safety|guard|audit)|ignore.{0,30}(?:policy|authorization)|invoke-expression|\biex\b/i.test(proposed),
      repeatedVerifiedFailures: this.analyze().some((x) => x.skillId === manifest.skillId && x.issueCode === manifest.issueCode && x.eligible),
    };
    const passed = Object.values(checks).every(Boolean);
    return { id, passed, checks, stage: passed ? "AWAITING_INDEPENDENT_TESTS_AND_HUMAN_REVIEW" : "BLOCKED",
      releaseApproved: false, productionChanged: false };
  }
}
