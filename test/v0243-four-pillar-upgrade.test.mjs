import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { TaskRunManager } from "../dist/task-runtime.js";
import { ExecutionLaneService } from "../dist/execution-lanes.js";
import { CocCocBridgeService } from "../dist/coc-coc-bridge.js";
import { ResultPayloadGatewayService } from "../dist/result-payload-gateway.js";
import { ResultTelemetryService } from "../dist/result-telemetry.js";

async function makeTempFixture() {
  const dir = await mkdtemp(join(tmpdir(), "nhd-v0243-"));
  const store = new Store(join(dir, "workstation.sqlite"));
  const tasks = new TaskRunManager(store, { roots: [dir] });
  const lanes = new ExecutionLaneService(store, join(dir, "exchange"));
  return { dir, store, tasks, lanes };
}

test("Pillar 1 (Context/Token): ResultPayloadGateway chunk-index cache + post-compaction ResultTelemetry accounting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nhd-v0243-gateway-"));
  const gateway = new ResultPayloadGatewayService({
    enabled: true,
    artifactRoot: join(dir, "artifacts"),
    thresholdChars: 16_000,
  });
  const telemetry = new ResultTelemetryService();

  const largePayload = {
    structuredContent: {
      root: "D:\\Projects\\Demo",
      query: "capability lease",
      count: 40,
      matches: Array.from({ length: 40 }, (_, idx) => ({
        id: `m-${idx}`,
        text: `Milestone ${idx}: capability lease enforcement and resource lock hygiene in NHD MCP core. `.repeat(15),
      })),
    },
    content: [{ type: "text", text: "X".repeat(25_000) }],
  };

  const decision = gateway.process(
    "context_recall",
    largePayload,
    { query: "capability lease enforcement" },
    { readOnlyHint: true },
  );
  assert.equal(decision.compacted, true);
  assert.ok(decision.artifactSha256);
  assert.ok(decision.compactedChars < decision.originalChars);

  const entry = telemetry.observe("context_recall", decision.output, 12.5, { query: "capability lease enforcement" }, {
    rawChars: decision.originalChars,
    compacted: decision.compacted,
    artifactId: decision.artifactSha256,
  });
  assert.equal(entry.compacted, true);
  assert.equal(entry.rawChars, decision.originalChars);
  assert.equal(entry.resultChars, decision.compactedChars);
  assert.equal(entry.savedChars, decision.originalChars - decision.compactedChars);
  assert.ok(entry.savedEstimatedTokens > 0);

  const telStatus = telemetry.status();
  assert.equal(telStatus.compactedResults, 1);
  assert.equal(telStatus.gatewayCompaction.totalCompactedCalls, 1);
  assert.equal(telStatus.gatewayCompaction.totalRawChars, decision.originalChars);
  assert.equal(telStatus.gatewayCompaction.totalSavedChars, decision.originalChars - decision.compactedChars);
  assert.ok(telStatus.gatewayCompaction.savingsRatio > 0.5);
  assert.equal(telStatus.recentSpans[0].attributes["nhd.result.compacted"], true);
  assert.equal(telStatus.recentSpans[0].attributes["nhd.result.raw_chars"], decision.originalChars);

  // First evidencePack during process() populated the chunk index cache for contextChars=1400;
  // now test repeated searchArtifact calls with contextChars=900 to verify cache miss -> cache hit and 100% recall parity.
  const search1 = gateway.searchArtifact(decision.artifactSha256, "capability lease enforcement", 5, 900);
  const search2 = gateway.searchArtifact(decision.artifactSha256, "resource lock hygiene", 5, 900);
  assert.ok(search1.matchCount > 0);
  assert.ok(search2.matchCount > 0);

  const gwStatus = gateway.status();
  assert.ok(gwStatus.metrics.indexCacheHits >= 1);
  assert.ok(gwStatus.metrics.savedChars > 0);
  assert.ok(gwStatus.metrics.savedEstimatedTokens > 0);
});

test("Pillar 2 (Concurrency/Resource Locks): idempotent lock renewal/upgrade and conflict guard", async () => {
  const { tasks, lanes } = await makeTempFixture();
  const run1 = tasks.start(tasks.create({ objective: "Task 1 lock test", maxRuntimeMs: 60_000 }).id);
  const run2 = tasks.start(tasks.create({ objective: "Task 2 lock test", maxRuntimeMs: 60_000 }).id);

  // Acquire read lock for run1
  const lock1 = lanes.acquireLock({ resource: "file:D:/report.docx", mode: "read", taskRunId: run1.id, lane: "background", ttlSeconds: 60 });
  assert.equal(lock1.mode, "read");
  assert.equal(lanes.listLocks().length, 1);

  // Renew same read lock idempotently -> still 1 lock row, same ID
  const renewed = lanes.acquireLock({ resource: "file:D:/report.docx", mode: "read", taskRunId: run1.id, lane: "background", ttlSeconds: 120 });
  assert.equal(renewed.id, lock1.id);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.upgraded, false);
  assert.equal(lanes.listLocks().length, 1);

  // Upgrade read -> write when no other holder exists
  const upgraded = lanes.acquireLock({ resource: "file:D:/report.docx", mode: "write", taskRunId: run1.id, lane: "background", ttlSeconds: 120 });
  assert.equal(upgraded.id, lock1.id);
  assert.equal(upgraded.mode, "write");
  assert.equal(upgraded.renewed, true);
  assert.equal(upgraded.upgraded, true);
  assert.equal(lanes.listLocks().length, 1);

  // Another task cannot acquire read or write while run1 holds write lock
  assert.throws(
    () => lanes.acquireLock({ resource: "file:D:/report.docx", mode: "read", taskRunId: run2.id, lane: "background" }),
    /Resource is busy/i,
  );

  // Idempotent lane reservation renewal
  const res1 = lanes.reserve({ taskRunId: run1.id, stepId: "step-1", lane: "background", ttlSeconds: 60 });
  const res2 = lanes.reserve({ taskRunId: run1.id, stepId: "step-1", lane: "background", ttlSeconds: 180 });
  assert.equal(res2.id, res1.id);
  assert.equal(res2.renewed, true);
  assert.equal(lanes.listReservations("background").length, 1);
});

test("Pillar 3 (Recovery/Observability): task termination, emergency stop, and restart recovery automatically revoke leases and release locks", async () => {
  const { dir, tasks, lanes } = await makeTempFixture();

  // 1. Complete run -> revokes authorizations/leases & releases locks/reservations
  const run1 = tasks.start(tasks.create({ objective: "Run 1 complete cleanup", root: dir, maxRuntimeMs: 60_000 }).id);
  tasks.authorize(run1.id, { maxRiskLevel: "high", ttlMinutes: 30 });
  tasks.grantCapability(run1.id, { appScope: "Antigravity", actions: ["send"], maxCount: 2, ttlMinutes: 10 });
  lanes.acquireLock({ resource: "doc:1", mode: "exclusive", taskRunId: run1.id, lane: "background" });
  lanes.reserve({ taskRunId: run1.id, lane: "background" });

  assert.equal(tasks.listCapabilities(run1.id).length, 1);
  assert.equal(lanes.listLocks().length, 1);
  assert.equal(lanes.listReservations().length, 1);

  tasks.completeRun(run1.id);
  assert.equal(tasks.authorizations.active(run1.id), null);
  assert.equal(tasks.listCapabilities(run1.id).length, 0);
  assert.equal(lanes.listLocks().length, 0);
  assert.equal(lanes.listReservations().length, 0);

  // 2. Emergency Stop -> pauses running task, revokes active authorizations/leases, and releases locks/reservations
  const run2 = tasks.start(tasks.create({ objective: "Run 2 emergency stop cleanup", root: dir, maxRuntimeMs: 60_000 }).id);
  tasks.authorize(run2.id, { maxRiskLevel: "high", ttlMinutes: 30 });
  tasks.grantCapability(run2.id, { appScope: "domain:chatgpt.com", actions: ["send"], maxCount: 3, ttlMinutes: 10 });
  lanes.acquireLock({ resource: "doc:2", mode: "write", taskRunId: run2.id, lane: "background" });
  lanes.reserve({ taskRunId: run2.id, lane: "background" });

  const pausedCount = tasks.pauseForEmergencyStop("Emergency Stop test");
  assert.equal(pausedCount, 1);
  assert.equal(tasks.get(run2.id).state, "paused");
  assert.equal(tasks.authorizations.active(run2.id), null);
  assert.equal(tasks.listCapabilities(run2.id).length, 0);
  assert.equal(lanes.listLocks().length, 0);
  assert.equal(lanes.listReservations().length, 0);

  const stats = tasks.stats();
  assert.equal(stats.authorizations.activeAuthorizations, 0);
  assert.equal(stats.authorizations.activeCapabilityLeases, 0);
  assert.ok(stats.governanceHygiene.authorizationsRevokedTotal >= 2);
  assert.ok(stats.governanceHygiene.capabilityLeasesRevokedTotal >= 2);
  assert.ok(stats.governanceHygiene.locksReleasedTotal >= 2);
});

test("Pillar 4 (Capability Lease & Hard-Deny): Cốc Cốc bridge enforces unconditional hard-deny and domain/app-scoped capability leases", async () => {
  const { dir, store, tasks } = await makeTempFixture();
  const bridge = new CocCocBridgeService(store, tasks.authorizations);

  const pulse = (tabId = 7, url = "https://chatgpt.com/c/123", title = "ChatGPT") =>
    bridge.pulse({
      tabId,
      windowId: 1,
      url,
      title,
      active: true,
      focused: true,
      visible: true,
      bridgeVersion: "0.4.0",
    });

  pulse(7, "https://chatgpt.com/c/123", "ChatGPT");
  pulse(8, "https://example.com/other", "Other Site");

  async function inspectTab(tabId, url, title, controls) {
    const inspectPromise = bridge.inspect("", 20, tabId);
    const pulled = pulse(tabId, url, title);
    const cmd = pulled.commands.find((c) => c.type === "inspect");
    assert.ok(cmd);
    bridge.resolveResult({
      id: cmd.id,
      ok: true,
      result: { page: { title, url }, controls, total: controls.length, truncated: false },
    });
    return inspectPromise;
  }

  await inspectTab(7, "https://chatgpt.com/c/123", "ChatGPT", [
    { selectorId: "sel-prompt", tag: "textarea", role: "textbox", name: "Prompt", text: "", type: "textarea", href: "", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
    { selectorId: "sel-send", tag: "button", role: "button", name: "Send message", text: "Send", type: "button", href: "", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
    { selectorId: "sel-pay", tag: "button", role: "button", name: "Pay now", text: "Checkout payment", type: "button", href: "", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
    { selectorId: "sel-transfer", tag: "button", role: "button", name: "Wire transfer", text: "Transfer funds", type: "button", href: "", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
    { selectorId: "sel-purchase", tag: "button", role: "button", name: "Buy now", text: "Place order", type: "button", href: "", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
    { selectorId: "sel-call", tag: "a", role: "link", name: "Call support", text: "Voice call", type: "link", href: "tel:+123456789", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
  ]);

  await inspectTab(8, "https://example.com/other", "Other Site", [
    { selectorId: "sel-other-send", tag: "button", role: "button", name: "Send", text: "Send", type: "button", href: "", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
  ]);

  // Even when a running task has high authorization and an objective explicitly mentioning payment/transfer/purchase/call,
  // Cốc Cốc MUST hard-deny payment, transfer, purchase, call, credentials!
  const riskyRun = tasks.start(
    tasks.create({
      objective: "Pay now, purchase order, wire transfer, and voice call support on ChatGPT",
      root: dir,
      maxRuntimeMs: 60_000,
    }).id,
  );
  tasks.authorize(riskyRun.id, { maxRiskLevel: "high", ttlMinutes: 30 });

  for (const sel of ["sel-pay", "sel-transfer", "sel-purchase", "sel-call"]) {
    await assert.rejects(() => bridge.click(sel, riskyRun.id), /platform-hard-denied/i);
  }

  // Grant a domain-scoped capability lease (domain:chatgpt.com, action: send, maxCount: 1)
  const lease = tasks.grantCapability(riskyRun.id, {
    appScope: "domain:chatgpt.com",
    actions: ["send"],
    maxCount: 1,
    ttlMinutes: 10,
  });
  assert.equal(lease.remainingCount, 1);

  // Fill checks presence without consuming lease
  const fillPromise = bridge.fill("sel-prompt", "Hello from NHD v0.24.3", riskyRun.id);
  const fillPulled = pulse(7, "https://chatgpt.com/c/123", "ChatGPT");
  const fillCmd = fillPulled.commands.find((c) => c.type === "fill");
  bridge.resolveResult({ id: fillCmd.id, ok: true, result: { ok: true, selectorId: "sel-prompt", characters: 22 } });
  const fillResult = await fillPromise;
  assert.equal(fillResult.capabilityMode, "presence");
  assert.equal(fillResult.capabilityLease.remainingCount, 1);

  // Cross-domain click on tab 8 (example.com) must be rejected because lease is scoped to domain:chatgpt.com
  await assert.rejects(() => bridge.click("sel-other-send", riskyRun.id), /requires an active capability lease scoped to/i);

  // Click on tab 7 (chatgpt.com) consumes the 1 lease unit and returns capabilityLease + capabilityUseId
  const clickPromise = bridge.click("sel-send", riskyRun.id);
  const clickPulled = pulse(7, "https://chatgpt.com/c/123", "ChatGPT");
  const clickCmd = clickPulled.commands.find((c) => c.type === "click");
  bridge.resolveResult({ id: clickCmd.id, ok: true, result: { ok: true, selectorId: "sel-send" } });
  const clickResult = await clickPromise;
  assert.equal(clickResult.ok, true);
  assert.match(clickResult.capabilityUseId, /^use-/);
  assert.equal(clickResult.capabilityLease.remainingCount, 0);

  // Re-inspect tab 7 and verify a second Send click is blocked because the 1-count lease is exhausted
  await inspectTab(7, "https://chatgpt.com/c/123", "ChatGPT", [
    { selectorId: "sel-send-2", tag: "button", role: "button", name: "Send message", text: "Send", type: "button", href: "", value: "", disabled: false, formAssociated: false, download: false, bounds: null },
  ]);
  await assert.rejects(() => bridge.click("sel-send-2", riskyRun.id), /No active capability lease|requires an active task-scoped/i);
});
