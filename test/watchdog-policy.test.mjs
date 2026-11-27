import { test } from "node:test";
import assert from "node:assert/strict";
import policy from "../electron/watchdog-policy.cjs";

const { HEALTH_TIMEOUT_MS, STARTUP_GRACE_MS, FAILING_RESTART_MS, decideBackendAction } = policy;
const now = 1_000_000;
const healthyBefore = { now, startedAt: now - 300_000, firstHealthyAt: now - 250_000,
  failingSince: 0, healthOk: false, processAlive: true };
const decide = (changes = {}) => decideBackendAction({ ...healthyBefore, ...changes });

test("watchdog treats death, startup and transient failures separately", () => {
  assert.ok(HEALTH_TIMEOUT_MS >= 10_000 && HEALTH_TIMEOUT_MS <= 900_000);
  assert.ok(STARTUP_GRACE_MS >= 180_000 && STARTUP_GRACE_MS <= 900_000);
  assert.ok(FAILING_RESTART_MS >= 90_000 && FAILING_RESTART_MS <= 900_000);
  assert.equal(decide({ processAlive: false, healthOk: true }), "restart");
  assert.equal(decide({ healthOk: true }), "ok");
  assert.equal(decide(), "wait");
  assert.equal(decide({ failingSince: now - FAILING_RESTART_MS + 1 }), "wait");
  assert.equal(decide({ failingSince: now - FAILING_RESTART_MS }), "restart");
  assert.equal(decide({ firstHealthyAt: 0, startedAt: now - STARTUP_GRACE_MS + 1,
    failingSince: now - STARTUP_GRACE_MS + 1 }), "wait");
  assert.equal(decide({ firstHealthyAt: 0, startedAt: now - STARTUP_GRACE_MS,
    failingSince: now - STARTUP_GRACE_MS }), "restart");
  assert.equal(decide({ firstHealthyAt: 0, startedAt: now - STARTUP_GRACE_MS,
    failingSince: 0 }), "wait");
  assert.equal(decideBackendAction(Object.freeze({ ...healthyBefore })), "wait");
});
