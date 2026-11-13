import { randomUUID } from "node:crypto";
import { RecoveryPlan, RoutePlan, VerificationContract } from "./router.js";

export type ExecutionState = "planned" | "observed" | "executing" | "verifying" | "verified" | "recovering" | "rolled_back" | "failed";
export type VerificationStatus = "verified" | "ambiguous" | "failed";

export type VerificationEvidence = {
  checks: Record<string, boolean>;
  ambiguous?: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type VerificationResult = {
  status: VerificationStatus;
  ok: boolean;
  required: string[];
  passed: string[];
  missing: string[];
  error: string | null;
  details: Record<string, unknown>;
};

export type RecoveryDecision = {
  action: "none" | "reobserve" | "reinspect-dom" | "refresh-live-state" | "prune-stale" | "fail";
  mayRepeatExecution: boolean;
  automatic: boolean;
  reason: string;
};

export type ActionReceipt = {
  receiptId: string;
  route: RoutePlan["route"];
  status: ExecutionState;
  observedBefore: Record<string, unknown> | null;
  action: Record<string, unknown> | null;
  observedAfter: Record<string, unknown> | null;
  verification: VerificationResult | null;
  recovery: RecoveryDecision | null;
  auditId: string | null;
  startedAt: string;
  completedAt: string | null;
};

export class WorkstationVerifier {
  verify(contract: VerificationContract, evidence: VerificationEvidence): VerificationResult {
    const passed = contract.required.filter((check) => evidence.checks[check] === true);
    const missing = contract.required.filter((check) => evidence.checks[check] !== true);
    if (evidence.error) {
      return { status: "failed", ok: false, required: [...contract.required], passed, missing, error: evidence.error, details: evidence.details ?? {} };
    }
    if (evidence.ambiguous || missing.length > 0) {
      return { status: "ambiguous", ok: false, required: [...contract.required], passed, missing, error: null, details: evidence.details ?? {} };
    }
    return { status: "verified", ok: true, required: [...contract.required], passed, missing: [], error: null, details: evidence.details ?? {} };
  }
}

export class RecoveryController {
  decide(plan: RecoveryPlan, verification: VerificationResult, attempts: number): RecoveryDecision {
    if (verification.status === "verified") {
      return { action: "none", mayRepeatExecution: false, automatic: false, reason: "Verification succeeded; no recovery is required." };
    }
    if (verification.status === "failed") {
      return { action: "fail", mayRepeatExecution: false, automatic: false, reason: verification.error ?? "Verification failed." };
    }
    if (attempts >= plan.maxAutomaticRetries) {
      return { action: "fail", mayRepeatExecution: false, automatic: false, reason: "Automatic recovery budget is exhausted." };
    }

    const action = plan.strategy === "reinspect-dom"
      ? "reinspect-dom"
      : plan.strategy === "refresh-live-state"
        ? "refresh-live-state"
        : plan.strategy === "prune-stale-and-retry-read"
          ? "prune-stale"
          : plan.strategy === "reobserve"
            ? "reobserve"
            : "fail";

    if (action === "fail") return { action, mayRepeatExecution: false, automatic: false, reason: "No automatic recovery strategy is configured." };
    return {
      action,
      mayRepeatExecution: !plan.neverRepeatAfterAmbiguousExecution,
      automatic: true,
      reason: plan.neverRepeatAfterAmbiguousExecution
        ? "Only state refresh/re-observation is permitted; the previous action must not be repeated automatically."
        : "Bounded automatic recovery is permitted by the route plan.",
    };
  }
}

export class RecoveryStateMachine {
  private stateValue: ExecutionState = "planned";
  private readonly historyValue: { state: ExecutionState; at: string; note?: string }[] = [{ state: "planned", at: new Date().toISOString() }];
  private recoveryAttemptsValue = 0;

  constructor(readonly plan: RoutePlan) {}

  get state() { return this.stateValue; }
  get history() { return [...this.historyValue]; }
  get recoveryAttempts() { return this.recoveryAttemptsValue; }

  observed(note?: string) { this.move("observed", ["planned", "recovering"], note); }
  executing(note?: string) { this.move("executing", ["observed"], note); }
  verifying(note?: string) { this.move("verifying", ["executing", "observed", "recovering"], note); }

  verified(note?: string) {
    this.move("verified", ["verifying"], note);
  }

  recovering(decision: RecoveryDecision, note?: string) {
    if (!decision.automatic || decision.action === "fail" || decision.action === "none") throw new Error("Recovery decision does not permit automatic recovery.");
    if (this.stateValue !== "verifying") throw new Error(`Cannot enter recovery from state ${this.stateValue}.`);
    this.recoveryAttemptsValue += 1;
    this.stateValue = "recovering";
    this.historyValue.push({ state: "recovering", at: new Date().toISOString(), note: note ?? decision.reason });
  }

  rolledBack(note?: string) { this.move("rolled_back", ["recovering", "failed"], note); }
  failed(note?: string) {
    if (this.stateValue === "verified" || this.stateValue === "rolled_back") throw new Error(`Cannot fail terminal state ${this.stateValue}.`);
    this.stateValue = "failed";
    this.historyValue.push({ state: "failed", at: new Date().toISOString(), note });
  }

  private move(next: ExecutionState, allowed: ExecutionState[], note?: string) {
    if (!allowed.includes(this.stateValue)) throw new Error(`Invalid execution transition ${this.stateValue} -> ${next}.`);
    this.stateValue = next;
    this.historyValue.push({ state: next, at: new Date().toISOString(), note });
  }
}

export class ReceiptBuilder {
  private readonly receipt: ActionReceipt;

  constructor(readonly plan: RoutePlan) {
    this.receipt = {
      receiptId: randomUUID(),
      route: plan.route,
      status: "planned",
      observedBefore: null,
      action: null,
      observedAfter: null,
      verification: null,
      recovery: null,
      auditId: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  before(value: Record<string, unknown>) { this.receipt.observedBefore = structuredClone(value); return this; }
  action(value: Record<string, unknown>) { this.receipt.action = structuredClone(value); return this; }
  after(value: Record<string, unknown>) { this.receipt.observedAfter = structuredClone(value); return this; }
  verification(value: VerificationResult) { this.receipt.verification = structuredClone(value); return this; }
  recovery(value: RecoveryDecision | null) { this.receipt.recovery = value ? structuredClone(value) : null; return this; }
  audit(id: string | null) { this.receipt.auditId = id; return this; }

  finish(status: ExecutionState) {
    this.receipt.status = status;
    this.receipt.completedAt = new Date().toISOString();
    return structuredClone(this.receipt);
  }
}
