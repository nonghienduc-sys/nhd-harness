import { BrowserService, BrowserWaitCondition } from "./browser.js";
import { CapabilitySnapshot, WorkstationRouter } from "./router.js";
import { ReceiptBuilder, RecoveryController, RecoveryStateMachine, WorkstationVerifier } from "./orchestration.js";

export type BrowserClickCondition = Exclude<BrowserWaitCondition, { kind: "value" }>;

export type VerifiedBrowserActionResult = {
  ok: boolean;
  ambiguous: boolean;
  error: string | null;
  receipt: ReturnType<ReceiptBuilder["finish"]>;
  recoveryObservation: { page: Record<string, unknown>; controlCount: number } | null;
};

export class BrowserOrchestrator {
  private readonly router = new WorkstationRouter();
  private readonly verifier = new WorkstationVerifier();
  private readonly recovery = new RecoveryController();

  constructor(readonly browser: BrowserService, readonly capabilities: () => Promise<CapabilitySnapshot>) {}

  async clickVerified(selectorId: string, condition: BrowserClickCondition, timeoutMs = 5000): Promise<VerifiedBrowserActionResult> {
    if ((condition as BrowserWaitCondition).kind === "value") throw new Error("Verified click does not accept a selector-value post-condition; use URL, title, text, or no-navigation.");
    const plan = this.router.plan({ domain: "browser", operation: "navigate" }, await this.capabilities());
    const state = new RecoveryStateMachine(plan);
    const receipt = new ReceiptBuilder(plan);
    const before = await this.browser.status();
    receipt.before({ page: before.activePage ?? null });
    state.observed("Browser page observed before click.");
    state.executing("Single click attempt started.");
    receipt.action({ type: "click", selectorId });

    try {
      const action = await this.browser.click(selectorId);
      state.verifying("Browser click completed; checking explicit post-condition and fresh DOM.");
      const waited = await this.browser.waitForCondition(condition, timeoutMs);
      const observed = await this.browser.inspect("", 50);
      const verification = this.verifier.verify(plan.verification, {
        checks: Object.fromEntries(plan.verification.required.map((check) => [check, true])),
        details: { condition, waitedMs: waited.waitedMs, page: waited.page, actionPage: action.page, postDomControlCount: observed.controls.length },
      });
      state.verified("Browser click post-condition and fresh DOM verified.");
      const finalReceipt = receipt.after({ page: waited.page, condition, postDomControlCount: observed.controls.length }).verification(verification).recovery(null).finish("verified");
      return { ok: true, ambiguous: false, error: null, receipt: finalReceipt, recoveryObservation: null };
    } catch (error) {
      return this.ambiguous(plan, state, receipt, error);
    }
  }

  async fillVerified(selectorId: string, text: string, timeoutMs = 5000): Promise<VerifiedBrowserActionResult> {
    const plan = this.router.plan({ domain: "browser", operation: "edit" }, await this.capabilities());
    const state = new RecoveryStateMachine(plan);
    const receipt = new ReceiptBuilder(plan);
    const before = await this.browser.status();
    receipt.before({ page: before.activePage ?? null });
    state.observed("Browser page observed before fill.");
    state.executing("Single fill attempt started.");
    receipt.action({ type: "fill", selectorId, characters: text.length });

    try {
      await this.browser.fill(selectorId, text);
      state.verifying("Browser fill completed; verifying exact control value and fresh DOM.");
      const condition: BrowserWaitCondition = { kind: "value", selectorId, equals: text };
      const waited = await this.browser.waitForCondition(condition, timeoutMs);
      const observed = await this.browser.inspect("", 50);
      const verification = this.verifier.verify(plan.verification, {
        checks: Object.fromEntries(plan.verification.required.map((check) => [check, true])),
        details: { condition: { kind: "value", selectorId, characters: text.length }, waitedMs: waited.waitedMs, page: waited.page, postDomControlCount: observed.controls.length },
      });
      state.verified("Browser fill value and fresh DOM verified.");
      const finalReceipt = receipt.after({ page: waited.page, verifiedValueCharacters: text.length, postDomControlCount: observed.controls.length }).verification(verification).recovery(null).finish("verified");
      return { ok: true, ambiguous: false, error: null, receipt: finalReceipt, recoveryObservation: null };
    } catch (error) {
      return this.ambiguous(plan, state, receipt, error);
    }
  }

  private async ambiguous(plan: ReturnType<WorkstationRouter["plan"]>, state: RecoveryStateMachine, receipt: ReceiptBuilder, error: unknown): Promise<VerifiedBrowserActionResult> {
    if (state.state === "executing") state.verifying("Action outcome is ambiguous; execution will not be repeated.");
    const message = error instanceof Error ? error.message : String(error);
    const verification = this.verifier.verify(plan.verification, { checks: {}, ambiguous: true, details: { error: message } });
    const decision = this.recovery.decide(plan.recovery, verification, state.recoveryAttempts);
    let recoveryObservation: { page: Record<string, unknown>; controlCount: number } | null = null;
    if (decision.automatic && decision.action === "reinspect-dom") {
      state.recovering(decision, "Re-inspect DOM only; do not repeat the previous action.");
      try {
        const observed = await this.browser.inspect("", 50);
        recoveryObservation = { page: observed.page, controlCount: observed.controls.length };
        state.observed("DOM re-inspected after ambiguous action.");
      } catch { /* best-effort recovery observation */ }
    }
    state.failed("Browser action was not machine-verified; caller must not repeat it automatically.");
    const after = await this.browser.status().catch(() => ({ activePage: null }));
    const finalReceipt = receipt
      .after({ page: after.activePage ?? null, recoveryObservation })
      .verification(verification)
      .recovery(decision)
      .finish("failed");
    return { ok: false, ambiguous: true, error: message, receipt: finalReceipt, recoveryObservation };
  }
}
