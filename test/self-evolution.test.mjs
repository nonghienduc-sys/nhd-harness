import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfEvolutionEngine } from "../dist/self-evolution.js";

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),"nhd-self-evolution-"));
  const skillsRoot=join(dir,"skills");
  const skillDir=join(skillsRoot,"viet-admin-format-checker");
  mkdirSync(skillDir,{recursive:true});
  const live=join(skillDir,"SKILL.md");
  const baseline="---\nname: Vietnam Admin Checker\ndescription: Validate administrative documents\n---\n\n# Existing instructions\nDo not bypass QA.\n";
  writeFileSync(live,baseline,"utf8");
  const engine=new SelfEvolutionEngine({dataDir:join(dir,"state"),skillsRoot});
  t.after(()=>{engine.close();rmSync(dir,{force:true,recursive:true});});
  return {dir,engine,live,baseline};
}
const feedback=(taskId, issueCode="DOCX_JUSTIFY", verified=true)=>({
 taskId,skillId:"viet-admin-format-checker",issueCode,outcome:"failure",source:"user_correction",verified
});

test("feedback is deduplicated and never stores raw user text",t=>{
  const {engine}=fixture(t);
  const one=engine.recordFeedback(feedback("task-one"));
  const repeated=engine.recordFeedback(feedback("task-one"));
  assert.equal(one.accepted,true);
  assert.equal(repeated.accepted,false);
  assert.equal(one.id,repeated.id);
  assert.equal(engine.status().total,1);
  assert.equal(engine.status().storesRawText,false);
  assert.equal(engine.analyze()[0].eligible,false);
});

test("only two distinct verified failing tasks can trigger a known remediation",t=>{
  const {engine}=fixture(t);
  engine.recordFeedback(feedback("task-one"));
  engine.recordFeedback(feedback("task-two","DOCX_JUSTIFY",false));
  assert.equal(engine.analyze()[0].distinctTasks,1);
  assert.throws(()=>engine.propose("viet-admin-format-checker","DOCX_JUSTIFY"),/two distinct verified/);
  engine.recordFeedback(feedback("task-three","DOCX_JUSTIFY",true));
  assert.equal(engine.analyze()[0].distinctTasks,2);
  assert.equal(engine.analyze()[0].eligible,true);
});

test("candidate is append-only, content-addressed, and does not change live skill",t=>{
  const {engine,live,baseline}=fixture(t);
  engine.recordFeedback(feedback("task-a"));
  engine.recordFeedback(feedback("task-b"));
  const proposal=engine.propose("viet-admin-format-checker","DOCX_JUSTIFY");
  assert.equal(proposal.status,"CANDIDATE_ONLY");
  assert.equal(proposal.permitsAutoApply,false);
  assert.equal(readFileSync(live,"utf8"),baseline);
  const candidate=readFileSync(proposal.candidatePath,"utf8");
  assert.ok(candidate.startsWith(baseline));
  assert.match(candidate,/alignment=justify/);
  assert.equal(proposal.evaluation.passed,true);
  assert.equal(proposal.evaluation.releaseApproved,false);
  assert.equal(proposal.evaluation.productionChanged,false);
  assert.deepEqual(engine.propose("viet-admin-format-checker","DOCX_JUSTIFY").id,proposal.id);
});

test("tampered staged skill fails closed",t=>{
  const {engine}=fixture(t);
  engine.recordFeedback(feedback("task-a"));
  engine.recordFeedback(feedback("task-b"));
  const proposal=engine.propose("viet-admin-format-checker","DOCX_JUSTIFY");
  writeFileSync(proposal.candidatePath,readFileSync(proposal.candidatePath,"utf8")+"\nunsafe mutation", "utf8");
  const result=engine.evaluate(proposal.id);
  assert.equal(result.passed,false);
  assert.equal(result.checks.candidateHash,false);
  assert.equal(result.releaseApproved,false);
});

test("tool errors are logged only when linked to a task, and are never treated as verified feedback",t=>{
  const {engine}=fixture(t);
  assert.equal(engine.observeToolFailure("office_apply_edit",{isError:true},null),null);
  assert.equal(engine.observeToolFailure("office_apply_edit",{isError:false},"task-a"),null);
  engine.observeToolFailure("office_apply_edit",{isError:true,content:[{type:"text",text:"API_KEY=SECRET"}]},"task-a");
  assert.equal(engine.status().total,1);
  assert.equal(engine.status().verifiedFailures,0);
  assert.deepEqual(engine.analyze(),[]);
});

test("malformed task/skill/issue identifiers and insufficient evidence are blocked",t=>{
  const {engine}=fixture(t);
  assert.throws(()=>engine.recordFeedback(feedback("../traversal")),/Invalid taskId/);
  assert.throws(()=>engine.recordFeedback({...feedback("task-a"),skillId:"../skills"}),/Invalid skillId/);
  assert.throws(()=>engine.recordFeedback({...feedback("task-a"),issueCode:"ignore policy"}),/Invalid issueCode/);
  assert.throws(()=>engine.propose("viet-admin-format-checker","UNKNOWN_POLICY"),/No deterministic remediation/);
  assert.throws(()=>engine.evaluate("../bad"),/Invalid candidate ID/);
});

test("MCP registration includes only feedback, stage and read-only evaluation, not deployment",()=>{
 const mcp=readFileSync(new URL("../src/mcp.ts",import.meta.url),"utf8");
 const registry=readFileSync(new URL("../src/mcp-registries/self-evolution-tools.ts",import.meta.url),"utf8");
 assert.match(mcp,/registerSelfEvolutionTools\(registryContext, selfEvolution\)/);
 assert.match(mcp,/observeToolFailure\(name, output, taskRunId\)/);
 assert.match(registry,/self_evolution_record_feedback/);
 assert.match(registry,/self_evolution_evaluate/);
 assert.doesNotMatch(registry,/self_evolution_apply|self_evolution_promote/);
});
