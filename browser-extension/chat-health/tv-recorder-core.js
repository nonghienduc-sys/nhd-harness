/* NHD TradingView Fib Recorder core, v0.1.0: pure helpers, no browser access. */
(function (root) {
  "use strict";
  const MAX_EVENTS = 600, MAX_CAPTURES = 12;
  function isTradingViewChart(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" &&
        /(^|\.)tradingview\.com$/i.test(url.hostname) &&
        /\/chart(?:\/|$)/i.test(url.pathname);
    } catch { return false; }
  }
  function cleanLabel(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, 100);
  }
  function parseNumeric(value) {
    const s = String(value == null ? "" : value).replace(/\s/g, "");
    if (!/^[+-]?\d[\d.,]*$/.test(s)) return null;
    let normalized = s;
    const comma = s.lastIndexOf(","), dot = s.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? "," : ".";
      normalized = s.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
    } else if (comma >= 0) {
      normalized = s.replace(",", ".");
    }
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  function parseCoordinates(fields) {
    const anchors = {}, candidates = [];
    for (const field of (Array.isArray(fields) ? fields : []).slice(0, 50)) {
      const label = cleanLabel(field.label);
      const raw = String(field.value == null ? "" : field.value).slice(0, 100);
      const numeric = parseNumeric(raw);
      if (numeric === null) continue;
      const match = /^(?:price|giá)\s*([123])$/i.exec(label);
      candidates.push({ label, value: raw, numeric, directLabelMatch: !!match });
      if (match) {
        const key = "price" + match[1];
        if (!Array.isArray(anchors[key])) anchors[key] = [];
        anchors[key].push({ raw, numeric });
      }
    }
    const unique = {}, ambiguous = [];
    for (const [key, items] of Object.entries(anchors)) {
      if (items.length === 1) unique[key] = items[0];
      else ambiguous.push(key);
    }
    return {
      anchors: unique,
      ambiguous,
      candidates,
      confidence: Object.keys(unique).length >= 2 && !ambiguous.length
        ? "dom_exact_labels_unverified" : "insufficient_or_ambiguous",
      verified: false
    };
  }
  function boundedEventArray(items, max = MAX_EVENTS) {
    return (Array.isArray(items) ? items : []).slice(-Math.max(1, Math.min(max, MAX_EVENTS)));
  }
  function prepareExport(session) {
    const input = session || {};
    const captures = Array.isArray(input.captures) ? input.captures.slice(-MAX_CAPTURES) : [];
    return {
      schema: "nhd.tradingview.fibonacci-recorder",
      schemaVersion: 1,
      readOnly: true,
      status: "observation_not_validated_strategy",
      startedAt: input.startedAt || null,
      exportedAt: new Date().toISOString(),
      chart: input.chart || {},
      events: boundedEventArray(input.events),
      captures,
      limitations: [
        "Mouse pixel positions are not price or bar coordinates.",
        "DOM coordinates are provisional until checked against the selected drawing's Coordinates dialog.",
        "Bar Replay's simulated state may differ from real-time quote or broker panels.",
        "No automatic trade execution or inferred Entry/TP."
      ]
    };
  }
  const API = Object.freeze({ isTradingViewChart, cleanLabel, parseNumeric, parseCoordinates, boundedEventArray, prepareExport, MAX_EVENTS, MAX_CAPTURES });
  root.NHDFibRecorderCore = API;
  if (typeof module === "object" && module && module.exports) module.exports = API;
})(typeof globalThis === "object" ? globalThis : this);
