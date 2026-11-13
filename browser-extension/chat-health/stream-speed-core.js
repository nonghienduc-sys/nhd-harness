/* Pure metric math. Does not store, transmit or inspect message text. */
(() => {
  "use strict";
  function buildSample(input) {
    const chars = Number(input.visibleChars);
    const words = Number(input.wordCount);
    const first = Number(input.firstAt);
    const last = Number(input.lastChangeAt);
    if (!Number.isFinite(chars) || chars < 1 || !Number.isFinite(first) || !Number.isFinite(last) || last < first) return null;
    const decode = Math.max(0, last - first);
    const send = input.sentAt == null ? null : Number(input.sentAt);
    const ttfv = send !== null && Number.isFinite(send) && first >= send ? Math.round(first - send) : null;
    const total = send !== null && Number.isFinite(send) && last >= send ? Math.round(last - send) : null;
    const estimatedTokens = Math.max(1, Math.round(chars / 4));
    const validDecode = decode >= 250 && Number(input.sampleCount) >= 2;
    const quality = input.visibilityState === "visible" && validDecode ? "observed" : input.visibilityState !== "visible" ? "partial" : "low_confidence";
    return {
      sampleId: String(input.sampleId),
      measuredAtUtc: String(input.measuredAtUtc || new Date().toISOString()),
      timingOrigin: ["submit_event","user_turn_dom"].includes(input.timingOrigin) ? input.timingOrigin : "unknown",
      completionSignal: input.completionSignal || "idle_inferred",
      visibilityState: input.visibilityState === "visible" ? "visible" : "hidden",
      quality,
      visibleChars: chars,
      wordCount: Number.isFinite(words) ? Math.max(0,words) : 0,
      sampleCount: Math.max(1,Number(input.sampleCount)||1),
      timeToFirstVisibleMs: ttfv,
      observedDecodeMs: Math.round(decode),
      totalVisibleElapsedMs: total,
      estimatedOutputTokens: estimatedTokens,
      estimatedTokensPerSecond: validDecode ? Math.round((estimatedTokens*100000/decode))/100 : null,
      visibleCharsPerSecond: validDecode ? Math.round((chars*100000/decode))/100 : null,
      detectorVersion: "nhd-ui-observer-v1"
    };
  }
  globalThis.NHDStreamSpeedCore = Object.freeze({ buildSample });
})();
