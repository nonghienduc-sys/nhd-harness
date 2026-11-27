"use strict";

// A failed liveness probe measures responsiveness, not process death.
const HEALTH_TIMEOUT_MS = 10_000;
const STARTUP_GRACE_MS = 180_000;
const FAILING_RESTART_MS = 90_000;

function decideBackendAction({ now, startedAt, firstHealthyAt, failingSince, healthOk, processAlive }) {
  if (!processAlive) return "restart";
  if (healthOk) return "ok";
  if (!firstHealthyAt && now - startedAt < STARTUP_GRACE_MS) return "wait";
  if (!failingSince || now - failingSince < FAILING_RESTART_MS) return "wait";
  return "restart";
}

module.exports = { HEALTH_TIMEOUT_MS, STARTUP_GRACE_MS, FAILING_RESTART_MS, decideBackendAction };
