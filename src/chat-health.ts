import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type ChatHealthLevel = "healthy" | "growing" | "handoff" | "critical";
export type ChatTabPresence = "active" | "idle" | "stale" | "archived";

export type ChatHealthTelemetry = {
  tabKey: string;
  tabId: number | null;
  windowId: number | null;
  conversationId: string;
  pagePath: string;
  pageTitle: string | null;
  url: string | null;
  collectedAt: string;
  turns: number | null;
  inpMs: number | null;
  fps: number | null;
  heapMb: number | null;
  domNodes: number | null;
  longTasksPerMin: number | null;
  sessionMinutes: number | null;
  estimatedTokens: number | null;
  estimatedUserTokens: number | null;
  estimatedAssistantTokens: number | null;
  textChars: number | null;
  tokenEstimateMethod: string | null;
};

type MetricBaseline = { value: number; samples: number };
type Baseline = {
  samples: number;
  inpMs: MetricBaseline;
  fps: MetricBaseline;
  heapMb: MetricBaseline;
  domNodes: MetricBaseline;
  longTasksPerMin: MetricBaseline;
};

export type ChatHealthSettings = {
  autoCheckpointEnabled: boolean;
  handoffThreshold: number;
  requiredStreak: number;
  cooldownMinutes: number;
  historyDays: number;
  activeSeconds: number;
  staleMinutes: number;
  tokenBudget: number;
};

export type ChatHealthAutomation = {
  autoCheckpointEnabled: boolean;
  handoffThreshold: number;
  requiredStreak: number;
  streak: number;
  due: boolean;
  handoffReady: boolean;
  checkpointSequence: number | null;
  lastCheckpointAt: string | null;
  reason: string;
};

export type ChatHealthView = ChatHealthTelemetry & {
  available: true;
  firstSeenAt: string;
  lastSeenAt: string;
  presence: ChatTabPresence;
  score: number;
  level: ChatHealthLevel;
  recommendation: string;
  degradationPct: number;
  baselineReady: boolean;
  baselineSamples: number;
  automation: ChatHealthAutomation;
};

export type ChatHealthOverview = {
  totalTabs: number;
  activeTabs: number;
  idleTabs: number;
  staleTabs: number;
  healthyTabs: number;
  growingTabs: number;
  handoffTabs: number;
  criticalTabs: number;
  handoffReadyTabs: number;
  lowestScore: number | null;
  averageScore: number | null;
  worstTabKey: string | null;
  highestEstimatedTokens: number | null;
  averageEstimatedTokens: number | null;
};

type SampleRow = {
  tab_key: string;
  tab_id: number | null;
  window_id: number | null;
  conversation_id: string;
  page_path: string;
  page_title: string | null;
  url: string | null;
  collected_at: string;
  collected_ms: number;
  turns: number | null;
  inp_ms: number | null;
  fps: number | null;
  heap_mb: number | null;
  dom_nodes: number | null;
  long_tasks_per_min: number | null;
  session_minutes: number | null;
  estimated_tokens: number | null;
  estimated_user_tokens: number | null;
  estimated_assistant_tokens: number | null;
  text_chars: number | null;
  token_estimate_method: string | null;
  score: number;
  level: ChatHealthLevel;
};

type TabRow = SampleRow & {
  first_seen_at: string;
  last_seen_at: string;
  last_seen_ms: number;
  baseline_ready: number;
  baseline_samples: number;
  archived: number;
};

const finite = (value: unknown, min: number, max: number): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
};
const text = (value: unknown, fallback = "", max = 1000) => String(value ?? fallback).slice(0, max);
const penalty = (value: number | null, good: number, bad: number, maxPenalty: number, invert = false) => {
  if (value == null) return 0;
  if (!invert) {
    if (value <= good) return 0;
    if (value >= bad) return maxPenalty;
    return ((value - good) / (bad - good)) * maxPenalty;
  }
  if (value >= good) return 0;
  if (value <= bad) return maxPenalty;
  return ((good - value) / (good - bad)) * maxPenalty;
};
const metric = (): MetricBaseline => ({ value: 0, samples: 0 });
const newBaseline = (): Baseline => ({ samples: 0, inpMs: metric(), fps: metric(), heapMb: metric(), domNodes: metric(), longTasksPerMin: metric() });
const addMetric = (target: MetricBaseline, value: number | null) => {
  if (value == null) return;
  target.samples += 1;
  target.value += (value - target.value) / target.samples;
};
const toBool = (value: string | null | undefined, fallback: boolean) => value == null ? fallback : value === "1" || value.toLowerCase() === "true";
const toNumber = (value: string | null | undefined, fallback: number, min: number, max: number) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export class ChatHealthService {
  private readonly latestByTab = new Map<string, ChatHealthView>();
  private readonly baselines = new Map<string, Baseline>();
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  readonly dbPath: string;

  constructor(options: { dataDir?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    if (options.dataDir) {
      mkdirSync(options.dataDir, { recursive: true });
      this.dbPath = resolve(options.dataDir, "chat-health.sqlite");
    } else {
      this.dbPath = ":memory:";
    }
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
    this.migrateLegacyOnce();
    this.loadLatestTabs();
  }

  report(input: Record<string, unknown>): ChatHealthView {
    const tabId = finite(input.tabId, 0, 2_147_483_647);
    const windowId = finite(input.windowId, 0, 2_147_483_647);
    const pagePath = text(input.pagePath, "/", 1000) || "/";
    const conversationId = text(input.conversationId, pagePath || "unknown", 500) || "unknown";
    const computedKey = this.buildTabKey(tabId, conversationId);
    const requestedKey = text(input.tabKey, computedKey, 1000);
    const tabKey = requestedKey === computedKey ? computedKey : computedKey;
    const collectedAt = new Date(this.now()).toISOString();
    const telemetry: ChatHealthTelemetry = {
      tabKey,
      tabId,
      windowId,
      conversationId,
      pagePath,
      pageTitle: input.pageTitle == null ? null : text(input.pageTitle, "", 500),
      url: input.url == null ? null : text(input.url, "", 2000),
      collectedAt,
      turns: finite(input.turns, 0, 100000),
      inpMs: finite(input.inpMs, 0, 10000),
      fps: finite(input.fps, 0, 240),
      heapMb: finite(input.heapMb, 0, 65536),
      domNodes: finite(input.domNodes, 0, 10000000),
      longTasksPerMin: finite(input.longTasksPerMin, 0, 10000),
      sessionMinutes: finite(input.sessionMinutes, 0, 100000),
      estimatedTokens: finite(input.estimatedTokens, 0, 100000000),
      estimatedUserTokens: finite(input.estimatedUserTokens, 0, 100000000),
      estimatedAssistantTokens: finite(input.estimatedAssistantTokens, 0, 100000000),
      textChars: finite(input.textChars, 0, 1000000000),
      tokenEstimateMethod: input.tokenEstimateMethod == null ? null : text(input.tokenEstimateMethod, "", 80),
    };

    let baseline = this.baselines.get(tabKey);
    if (!baseline) {
      baseline = this.restoreBaseline(tabKey);
      this.baselines.set(tabKey, baseline);
    }
    if (baseline.samples < 6) this.addBaselineSample(baseline, telemetry);

    let score = 100;
    score -= penalty(telemetry.inpMs, 200, 700, 30);
    score -= penalty(telemetry.fps, 55, 25, 20, true);
    score -= penalty(telemetry.longTasksPerMin, 1, 12, 16);
    if (baseline.heapMb.samples >= 3 && telemetry.heapMb != null && baseline.heapMb.value > 0) score -= penalty(telemetry.heapMb / baseline.heapMb.value, 1.35, 2.8, 16);
    if (baseline.domNodes.samples >= 3 && telemetry.domNodes != null && baseline.domNodes.value > 0) score -= penalty(telemetry.domNodes / baseline.domNodes.value, 1.4, 3.5, 10);
    if (baseline.inpMs.samples >= 3 && telemetry.inpMs != null && baseline.inpMs.value > 0) score -= penalty(telemetry.inpMs / baseline.inpMs.value, 1.4, 3.2, 8);
    score = Math.max(0, Math.min(100, Math.round(score)));

    const level = this.levelFor(score);
    this.insertSample({ ...telemetry, score, level });
    const prior = this.db.prepare("SELECT first_seen_at FROM chat_health_tabs WHERE tab_key=?").get(tabKey) as { first_seen_at: string } | undefined;
    const firstSeenAt = prior?.first_seen_at ?? collectedAt;
    const baselineReady = baseline.samples >= 6;
    const automation = this.automationState(tabKey, score, baselineReady);
    const view: ChatHealthView = {
      ...telemetry,
      available: true,
      firstSeenAt,
      lastSeenAt: collectedAt,
      presence: "active",
      score,
      level,
      recommendation: this.recommendationFor(level),
      degradationPct: 100 - score,
      baselineReady,
      baselineSamples: baseline.samples,
      automation,
    };
    this.upsertTab(view, false);
    this.latestByTab.set(tabKey, view);
    this.pruneHistory();
    return view;
  }

  status(): (ChatHealthView & { overview: ChatHealthOverview }) | { available: false; reason: string; settings: ChatHealthSettings; overview: ChatHealthOverview } {
    const tabs = this.listTabs(false).tabs;
    const overview = this.summarize(tabs);
    const worst = overview.worstTabKey ? tabs.find((tab) => tab.tabKey === overview.worstTabKey) ?? null : tabs[0] ?? null;
    return worst ? { ...worst, overview } : { available: false, reason: "No ChatGPT tab telemetry has been received yet.", settings: this.settings(), overview };
  }

  listTabs(includeArchived = false) {
    const rows = this.db.prepare(`SELECT * FROM chat_health_tabs ${includeArchived ? "" : "WHERE archived=0"} ORDER BY archived ASC,last_seen_ms DESC`).all() as TabRow[];
    const settings = this.settings();
    const tabs = rows.map((row) => this.rowToView(row, settings));
    tabs.sort((a, b) => {
      const pa = this.presenceRank(a.presence), pb = this.presenceRank(b.presence);
      if (pa !== pb) return pa - pb;
      if (a.automation.handoffReady !== b.automation.handoffReady) return a.automation.handoffReady ? -1 : 1;
      if (a.score !== b.score) return a.score - b.score;
      return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
    });
    return { overview: this.summarize(tabs.filter((tab) => tab.presence !== "archived")), tabs, settings };
  }

  getTab(tabKey: string): ChatHealthView | null {
    const row = this.db.prepare("SELECT * FROM chat_health_tabs WHERE tab_key=?").get(tabKey) as TabRow | undefined;
    return row ? this.rowToView(row) : null;
  }

  history(tabKey?: string, limit = 180) {
    const key = tabKey || this.statusTabKey();
    const bounded = Math.max(10, Math.min(Math.floor(limit), 720));
    if (!key) return { tabKey: null, samples: [], alerts: [], summary: null, settings: this.settings() };
    const rows = this.db.prepare("SELECT * FROM chat_health_samples_v3 WHERE tab_key=? ORDER BY id DESC LIMIT ?").all(key, bounded) as SampleRow[];
    rows.reverse();
    const alerts = this.db.prepare("SELECT kind,level,score,checkpoint_sequence,created_at FROM chat_health_alerts_v3 WHERE tab_key=? ORDER BY id DESC LIMIT 20").all(key) as Array<Record<string, unknown>>;
    const scores = rows.map((row) => row.score).filter(Number.isFinite);
    const summary = scores.length ? {
      count: scores.length,
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
      avgScore: Math.round((scores.reduce((sum, n) => sum + n, 0) / scores.length) * 10) / 10,
      firstAt: rows[0]?.collected_at ?? null,
      lastAt: rows.at(-1)?.collected_at ?? null,
    } : null;
    return {
      tabKey: key,
      samples: rows.map((row) => this.sampleRowToPublic(row)),
      alerts,
      summary,
      settings: this.settings(),
    };
  }

  settings(): ChatHealthSettings {
    const rows = this.db.prepare("SELECT key,value FROM chat_health_meta WHERE key IN ('auto_checkpoint_enabled','handoff_threshold','required_streak','cooldown_minutes','history_days','active_seconds','stale_minutes','token_budget')").all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      autoCheckpointEnabled: toBool(values.get("auto_checkpoint_enabled"), true),
      handoffThreshold: toNumber(values.get("handoff_threshold"), 65, 25, 95),
      requiredStreak: Math.round(toNumber(values.get("required_streak"), 3, 1, 12)),
      cooldownMinutes: Math.round(toNumber(values.get("cooldown_minutes"), 10, 0, 240)),
      historyDays: Math.round(toNumber(values.get("history_days"), 7, 1, 30)),
      activeSeconds: Math.round(toNumber(values.get("active_seconds"), 30, 10, 300)),
      staleMinutes: Math.round(toNumber(values.get("stale_minutes"), 5, 1, 240)),
      tokenBudget: Math.round(toNumber(values.get("token_budget"), 128000, 8000, 2000000)),
    };
  }

  updateSettings(input: Record<string, unknown>): ChatHealthSettings {
    const current = this.settings();
    const next: ChatHealthSettings = {
      autoCheckpointEnabled: typeof input.autoCheckpointEnabled === "boolean" ? input.autoCheckpointEnabled : current.autoCheckpointEnabled,
      handoffThreshold: finite(input.handoffThreshold, 25, 95) ?? current.handoffThreshold,
      requiredStreak: Math.round(finite(input.requiredStreak, 1, 12) ?? current.requiredStreak),
      cooldownMinutes: Math.round(finite(input.cooldownMinutes, 0, 240) ?? current.cooldownMinutes),
      historyDays: Math.round(finite(input.historyDays, 1, 30) ?? current.historyDays),
      activeSeconds: Math.round(finite(input.activeSeconds, 10, 300) ?? current.activeSeconds),
      staleMinutes: Math.round(finite(input.staleMinutes, 1, 240) ?? current.staleMinutes),
      tokenBudget: Math.round(finite(input.tokenBudget, 8000, 2000000) ?? current.tokenBudget),
    };
    this.setMeta("auto_checkpoint_enabled", next.autoCheckpointEnabled ? "1" : "0");
    this.setMeta("handoff_threshold", String(next.handoffThreshold));
    this.setMeta("required_streak", String(next.requiredStreak));
    this.setMeta("cooldown_minutes", String(next.cooldownMinutes));
    this.setMeta("history_days", String(next.historyDays));
    this.setMeta("active_seconds", String(next.activeSeconds));
    this.setMeta("stale_minutes", String(next.staleMinutes));
    this.setMeta("token_budget", String(next.tokenBudget));
    return next;
  }

  markAutoCheckpoint(view: ChatHealthView, checkpointSequence: number): ChatHealthView {
    const now = new Date(this.now()).toISOString();
    this.setMeta(`last_auto_checkpoint_at:${view.tabKey}`, now);
    this.setMeta(`handoff_pending:${view.tabKey}`, "1");
    this.setMeta(`handoff_checkpoint_sequence:${view.tabKey}`, String(checkpointSequence));
    this.db.prepare("INSERT INTO chat_health_alerts_v3(tab_key,conversation_id,kind,level,score,checkpoint_sequence,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(view.tabKey, view.conversationId, "auto_checkpoint", view.level, view.score, checkpointSequence, now);
    const updated = { ...view, automation: this.automationState(view.tabKey, view.score, view.baselineReady) };
    this.upsertTab(updated, false);
    this.latestByTab.set(view.tabKey, updated);
    return updated;
  }

  acknowledgeHandoff(tabKey?: string) {
    const key = tabKey || this.statusTabKey() || "";
    if (!key) return { acknowledged: false, tabKey: null };
    const tab = this.getTab(key);
    this.setMeta(`handoff_pending:${key}`, "0");
    this.setMeta(`handoff_checkpoint_sequence:${key}`, "");
    this.db.prepare("INSERT INTO chat_health_alerts_v3(tab_key,conversation_id,kind,level,score,checkpoint_sequence,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(key, tab?.conversationId ?? "", "handoff_acknowledged", tab?.level ?? "healthy", tab?.score ?? 100, null, new Date(this.now()).toISOString());
    const refreshed = this.getTab(key);
    if (refreshed) this.latestByTab.set(key, refreshed);
    return { acknowledged: true, tabKey: key };
  }

  archiveTab(tabKey: string) {
    const key = text(tabKey, "", 1000);
    const result = this.db.prepare("UPDATE chat_health_tabs SET archived=1 WHERE tab_key=?").run(key);
    this.latestByTab.delete(key);
    return { archived: Number(result.changes ?? 0) > 0, tabKey: key };
  }

  close() { this.db.close(); }

  private buildTabKey(tabId: number | null, conversationId: string) {
    return `${tabId == null ? "unknown" : Math.round(tabId)}:${conversationId}`.slice(0, 1000);
  }

  private levelFor(score: number): ChatHealthLevel {
    return score >= 80 ? "healthy" : score >= 65 ? "growing" : score >= 50 ? "handoff" : "critical";
  }

  private recommendationFor(level: ChatHealthLevel) {
    return level === "healthy" ? "Có thể tiếp tục làm việc." : level === "growing" ? "Chat bắt đầu nặng; chuẩn bị checkpoint." : level === "handoff" ? "Hoàn tất đoạn việc hiện tại và chuyển sang chat mới." : "Nên checkpoint và handoff sang chat mới ngay.";
  }

  private presenceFor(lastSeenMs: number, archived: boolean, settings = this.settings()): ChatTabPresence {
    if (archived) return "archived";
    const age = Math.max(0, this.now() - lastSeenMs);
    if (age <= settings.activeSeconds * 1000) return "active";
    if (age <= settings.staleMinutes * 60_000) return "idle";
    return "stale";
  }

  private presenceRank(presence: ChatTabPresence) {
    return presence === "active" ? 0 : presence === "idle" ? 1 : presence === "stale" ? 2 : 3;
  }

  private automationState(tabKey: string, score: number, baselineReady: boolean, settings = this.settings()): ChatHealthAutomation {
    const streak = this.lowScoreStreak(tabKey, settings.handoffThreshold);
    const pending = this.getMeta(`handoff_pending:${tabKey}`) === "1";
    const checkpointSequence = pending ? Number(this.getMeta(`handoff_checkpoint_sequence:${tabKey}`) || 0) || null : null;
    const lastCheckpointAt = this.getMeta(`last_auto_checkpoint_at:${tabKey}`) || null;
    const cooldownOk = !lastCheckpointAt || this.now() - new Date(lastCheckpointAt).getTime() >= settings.cooldownMinutes * 60_000;
    const due = settings.autoCheckpointEnabled && baselineReady && score < settings.handoffThreshold && streak >= settings.requiredStreak && !pending && cooldownOk;
    let reason = "Monitoring active.";
    if (!settings.autoCheckpointEnabled) reason = "Auto-checkpoint is disabled.";
    else if (!baselineReady) reason = "Waiting for baseline.";
    else if (pending) reason = `Handoff prepared at checkpoint #${checkpointSequence ?? "?"}.`;
    else if (!cooldownOk) reason = "Auto-checkpoint cooldown is active for this tab.";
    else if (score >= settings.handoffThreshold) reason = "Score is above the handoff threshold.";
    else if (streak < settings.requiredStreak) reason = `Waiting for ${settings.requiredStreak - streak} more low-score sample(s).`;
    else if (due) reason = "Automatic handoff checkpoint is due for this tab.";
    return { autoCheckpointEnabled: settings.autoCheckpointEnabled, handoffThreshold: settings.handoffThreshold, requiredStreak: settings.requiredStreak, streak, due, handoffReady: pending, checkpointSequence, lastCheckpointAt, reason };
  }

  private lowScoreStreak(tabKey: string, threshold: number) {
    const rows = this.db.prepare("SELECT score FROM chat_health_samples_v3 WHERE tab_key=? ORDER BY id DESC LIMIT 24").all(tabKey) as Array<{ score: number }>;
    let streak = 0;
    for (const row of rows) {
      if (Number(row.score) < threshold) streak += 1;
      else break;
    }
    return streak;
  }

  private restoreBaseline(tabKey: string): Baseline {
    const baseline = newBaseline();
    const rows = this.db.prepare("SELECT * FROM chat_health_samples_v3 WHERE tab_key=? ORDER BY id ASC LIMIT 6").all(tabKey) as SampleRow[];
    for (const row of rows) this.addBaselineSample(baseline, this.sampleRowToTelemetry(row));
    return baseline;
  }

  private addBaselineSample(baseline: Baseline, sample: ChatHealthTelemetry) {
    baseline.samples += 1;
    addMetric(baseline.inpMs, sample.inpMs);
    addMetric(baseline.fps, sample.fps);
    addMetric(baseline.heapMb, sample.heapMb);
    addMetric(baseline.domNodes, sample.domNodes);
    addMetric(baseline.longTasksPerMin, sample.longTasksPerMin);
  }

  private insertSample(view: ChatHealthTelemetry & { score: number; level: ChatHealthLevel }) {
    this.db.prepare(`INSERT INTO chat_health_samples_v3(tab_key,tab_id,window_id,conversation_id,page_path,page_title,url,collected_at,collected_ms,turns,inp_ms,fps,heap_mb,dom_nodes,long_tasks_per_min,session_minutes,estimated_tokens,estimated_user_tokens,estimated_assistant_tokens,text_chars,token_estimate_method,score,level)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(view.tabKey, view.tabId, view.windowId, view.conversationId, view.pagePath, view.pageTitle, view.url, view.collectedAt, this.now(), view.turns, view.inpMs, view.fps, view.heapMb, view.domNodes, view.longTasksPerMin, view.sessionMinutes, view.estimatedTokens, view.estimatedUserTokens, view.estimatedAssistantTokens, view.textChars, view.tokenEstimateMethod, view.score, view.level);
  }

  private upsertTab(view: ChatHealthView, archived: boolean) {
    this.db.prepare(`INSERT INTO chat_health_tabs(tab_key,tab_id,window_id,conversation_id,page_path,page_title,url,first_seen_at,last_seen_at,last_seen_ms,turns,inp_ms,fps,heap_mb,dom_nodes,long_tasks_per_min,session_minutes,estimated_tokens,estimated_user_tokens,estimated_assistant_tokens,text_chars,token_estimate_method,score,level,baseline_ready,baseline_samples,archived)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tab_key) DO UPDATE SET tab_id=excluded.tab_id,window_id=excluded.window_id,conversation_id=excluded.conversation_id,page_path=excluded.page_path,page_title=excluded.page_title,url=excluded.url,last_seen_at=excluded.last_seen_at,last_seen_ms=excluded.last_seen_ms,turns=excluded.turns,inp_ms=excluded.inp_ms,fps=excluded.fps,heap_mb=excluded.heap_mb,dom_nodes=excluded.dom_nodes,long_tasks_per_min=excluded.long_tasks_per_min,session_minutes=excluded.session_minutes,estimated_tokens=excluded.estimated_tokens,estimated_user_tokens=excluded.estimated_user_tokens,estimated_assistant_tokens=excluded.estimated_assistant_tokens,text_chars=excluded.text_chars,token_estimate_method=excluded.token_estimate_method,score=excluded.score,level=excluded.level,baseline_ready=excluded.baseline_ready,baseline_samples=excluded.baseline_samples,archived=excluded.archived`)
      .run(view.tabKey, view.tabId, view.windowId, view.conversationId, view.pagePath, view.pageTitle, view.url, view.firstSeenAt, view.lastSeenAt, new Date(view.lastSeenAt).getTime(), view.turns, view.inpMs, view.fps, view.heapMb, view.domNodes, view.longTasksPerMin, view.sessionMinutes, view.estimatedTokens, view.estimatedUserTokens, view.estimatedAssistantTokens, view.textChars, view.tokenEstimateMethod, view.score, view.level, view.baselineReady ? 1 : 0, view.baselineSamples, archived ? 1 : 0);
  }

  private rowToView(row: TabRow, settings = this.settings()): ChatHealthView {
    const baselineReady = !!row.baseline_ready;
    const score = Number(row.score);
    return {
      available: true,
      tabKey: row.tab_key,
      tabId: row.tab_id,
      windowId: row.window_id,
      conversationId: row.conversation_id,
      pagePath: row.page_path,
      pageTitle: row.page_title,
      url: row.url,
      collectedAt: row.last_seen_at,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      presence: this.presenceFor(Number(row.last_seen_ms), !!row.archived, settings),
      turns: row.turns,
      inpMs: row.inp_ms,
      fps: row.fps,
      heapMb: row.heap_mb,
      domNodes: row.dom_nodes,
      longTasksPerMin: row.long_tasks_per_min,
      sessionMinutes: row.session_minutes,
      estimatedTokens: row.estimated_tokens,
      estimatedUserTokens: row.estimated_user_tokens,
      estimatedAssistantTokens: row.estimated_assistant_tokens,
      textChars: row.text_chars,
      tokenEstimateMethod: row.token_estimate_method,
      score,
      level: row.level,
      recommendation: this.recommendationFor(row.level),
      degradationPct: 100 - score,
      baselineReady,
      baselineSamples: Number(row.baseline_samples ?? 0),
      automation: this.automationState(row.tab_key, score, baselineReady, settings),
    };
  }

  private sampleRowToTelemetry(row: SampleRow): ChatHealthTelemetry {
    return { tabKey: row.tab_key, tabId: row.tab_id, windowId: row.window_id, conversationId: row.conversation_id, pagePath: row.page_path, pageTitle: row.page_title, url: row.url, collectedAt: row.collected_at, turns: row.turns, inpMs: row.inp_ms, fps: row.fps, heapMb: row.heap_mb, domNodes: row.dom_nodes, longTasksPerMin: row.long_tasks_per_min, sessionMinutes: row.session_minutes, estimatedTokens: row.estimated_tokens, estimatedUserTokens: row.estimated_user_tokens, estimatedAssistantTokens: row.estimated_assistant_tokens, textChars: row.text_chars, tokenEstimateMethod: row.token_estimate_method };
  }

  private sampleRowToPublic(row: SampleRow) {
    return { ...this.sampleRowToTelemetry(row), score: row.score, level: row.level };
  }

  private summarize(tabs: ChatHealthView[]): ChatHealthOverview {
    const live = tabs.filter((tab) => tab.presence !== "archived");
    const scoreTabs = live.filter((tab) => Number.isFinite(tab.score));
    const worst = scoreTabs.length ? [...scoreTabs].sort((a, b) => a.score - b.score)[0] : null;
    return {
      totalTabs: live.length,
      activeTabs: live.filter((tab) => tab.presence === "active").length,
      idleTabs: live.filter((tab) => tab.presence === "idle").length,
      staleTabs: live.filter((tab) => tab.presence === "stale").length,
      healthyTabs: live.filter((tab) => tab.level === "healthy").length,
      growingTabs: live.filter((tab) => tab.level === "growing").length,
      handoffTabs: live.filter((tab) => tab.level === "handoff").length,
      criticalTabs: live.filter((tab) => tab.level === "critical").length,
      handoffReadyTabs: live.filter((tab) => tab.automation.handoffReady).length,
      lowestScore: worst?.score ?? null,
      averageScore: scoreTabs.length ? Math.round((scoreTabs.reduce((sum, tab) => sum + tab.score, 0) / scoreTabs.length) * 10) / 10 : null,
      worstTabKey: worst?.tabKey ?? null,
      highestEstimatedTokens: live.length ? Math.max(...live.map((tab) => Number(tab.estimatedTokens || 0))) : null,
      averageEstimatedTokens: live.some((tab) => tab.estimatedTokens != null)
        ? Math.round(live.reduce((sum, tab) => sum + Number(tab.estimatedTokens || 0), 0) / live.filter((tab) => tab.estimatedTokens != null).length)
        : null,
    };
  }

  private statusTabKey() {
    const tabs = this.listTabs(false).tabs;
    return tabs[0]?.tabKey ?? null;
  }

  private loadLatestTabs() {
    const rows = this.db.prepare("SELECT * FROM chat_health_tabs").all() as TabRow[];
    for (const row of rows) if (!row.archived) this.latestByTab.set(row.tab_key, this.rowToView(row));
  }

  private pruneHistory() {
    const cutoff = this.now() - this.settings().historyDays * 86_400_000;
    this.db.prepare("DELETE FROM chat_health_samples_v3 WHERE collected_ms<?").run(cutoff);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM chat_health_meta WHERE key=?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO chat_health_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  private migrateLegacyOnce() {
    if (this.getMeta("multitab_migration_v1") === "1") return;
    const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_health_samples'").get() as { name: string } | undefined;
    if (exists) {
      const rows = this.db.prepare("SELECT * FROM chat_health_samples ORDER BY id ASC").all() as Array<Record<string, unknown>>;
      const latest = new Map<string, SampleRow>();
      for (const old of rows) {
        const conversationId = text(old.conversation_id, "legacy", 500);
        const tabKey = `legacy:${conversationId}`.slice(0, 1000);
        const row: SampleRow = {
          tab_key: tabKey,
          tab_id: null,
          window_id: null,
          conversation_id: conversationId,
          page_path: text(old.page_path, conversationId, 1000),
          page_title: "Legacy Chat Health history",
          url: null,
          collected_at: text(old.collected_at, new Date(this.now()).toISOString(), 100),
          collected_ms: Number(old.collected_ms ?? this.now()),
          turns: finite(old.turns, 0, 100000),
          inp_ms: finite(old.inp_ms, 0, 10000),
          fps: finite(old.fps, 0, 240),
          heap_mb: finite(old.heap_mb, 0, 65536),
          dom_nodes: finite(old.dom_nodes, 0, 10000000),
          long_tasks_per_min: finite(old.long_tasks_per_min, 0, 10000),
          session_minutes: finite(old.session_minutes, 0, 100000),
          estimated_tokens: null,
          estimated_user_tokens: null,
          estimated_assistant_tokens: null,
          text_chars: null,
          token_estimate_method: null,
          score: Number(old.score ?? 100),
          level: this.levelFor(Number(old.score ?? 100)),
        };
        this.db.prepare(`INSERT INTO chat_health_samples_v3(tab_key,tab_id,window_id,conversation_id,page_path,page_title,url,collected_at,collected_ms,turns,inp_ms,fps,heap_mb,dom_nodes,long_tasks_per_min,session_minutes,score,level) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(row.tab_key,row.tab_id,row.window_id,row.conversation_id,row.page_path,row.page_title,row.url,row.collected_at,row.collected_ms,row.turns,row.inp_ms,row.fps,row.heap_mb,row.dom_nodes,row.long_tasks_per_min,row.session_minutes,row.score,row.level);
        latest.set(tabKey, row);
      }
      for (const row of latest.values()) {
        const first = this.db.prepare("SELECT collected_at FROM chat_health_samples_v3 WHERE tab_key=? ORDER BY id ASC LIMIT 1").get(row.tab_key) as { collected_at: string } | undefined;
        const baseline = this.restoreBaseline(row.tab_key);
        const view: ChatHealthView = { ...this.sampleRowToTelemetry(row), available: true, firstSeenAt: first?.collected_at ?? row.collected_at, lastSeenAt: row.collected_at, presence: "archived", score: row.score, level: row.level, recommendation: this.recommendationFor(row.level), degradationPct: 100-row.score, baselineReady: baseline.samples>=6, baselineSamples: baseline.samples, automation: this.automationState(row.tab_key,row.score,baseline.samples>=6) };
        this.upsertTab(view, true);
      }
    }
    this.setMeta("multitab_migration_v1", "1");
  }

  private initSchema() {
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS chat_health_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_health_samples_v3(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tab_key TEXT NOT NULL,
        tab_id INTEGER,
        window_id INTEGER,
        conversation_id TEXT NOT NULL,
        page_path TEXT NOT NULL,
        page_title TEXT,
        url TEXT,
        collected_at TEXT NOT NULL,
        collected_ms INTEGER NOT NULL,
        turns REAL,
        inp_ms REAL,
        fps REAL,
        heap_mb REAL,
        dom_nodes REAL,
        long_tasks_per_min REAL,
        session_minutes REAL,
        estimated_tokens REAL,
        estimated_user_tokens REAL,
        estimated_assistant_tokens REAL,
        text_chars REAL,
        token_estimate_method TEXT,
        score INTEGER NOT NULL,
        level TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_health_v3_tab ON chat_health_samples_v3(tab_key,id DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_health_v3_time ON chat_health_samples_v3(collected_ms DESC);
      CREATE TABLE IF NOT EXISTS chat_health_tabs(
        tab_key TEXT PRIMARY KEY,
        tab_id INTEGER,
        window_id INTEGER,
        conversation_id TEXT NOT NULL,
        page_path TEXT NOT NULL,
        page_title TEXT,
        url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        turns REAL,
        inp_ms REAL,
        fps REAL,
        heap_mb REAL,
        dom_nodes REAL,
        long_tasks_per_min REAL,
        session_minutes REAL,
        estimated_tokens REAL,
        estimated_user_tokens REAL,
        estimated_assistant_tokens REAL,
        text_chars REAL,
        token_estimate_method TEXT,
        score INTEGER NOT NULL,
        level TEXT NOT NULL,
        baseline_ready INTEGER NOT NULL DEFAULT 0,
        baseline_samples INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chat_health_tabs_seen ON chat_health_tabs(archived,last_seen_ms DESC);
      CREATE TABLE IF NOT EXISTS chat_health_alerts_v3(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tab_key TEXT NOT NULL,
        conversation_id TEXT,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        score INTEGER NOT NULL,
        checkpoint_sequence INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_health_alerts_v3_tab ON chat_health_alerts_v3(tab_key,id DESC);
    `);
    const tokenColumns = [
      ["estimated_tokens", "REAL"],
      ["estimated_user_tokens", "REAL"],
      ["estimated_assistant_tokens", "REAL"],
      ["text_chars", "REAL"],
      ["token_estimate_method", "TEXT"],
    ] as const;
    for (const table of ["chat_health_samples_v3", "chat_health_tabs"] as const) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      for (const [name, definition] of tokenColumns) {
        if (!names.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }
}
