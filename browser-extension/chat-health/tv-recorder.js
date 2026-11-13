/* NHD TradingView Fibonacci Recorder v0.1: opt-in, read-only, local-only. */
(() => {
  "use strict";
  const C = globalThis.NHDFibRecorderCore;
  if (!C?.isTradingViewChart(location.href) || document.getElementById("nhd-fib-recorder-host")) return;
  let active = false, down = null, busy = false;
  const state = {
    startedAt: null, chart: {}, events: [], captures: []
  };
  const host = document.createElement("div");
  host.id = "nhd-fib-recorder-host";
  host.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483646;font:13px Arial,sans-serif;pointer-events:auto";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = [
    "<style>",
    "*{box-sizing:border-box} .panel{color:#e8edf6;background:#141d2c;border:1px solid #596b86;border-radius:10px;width:298px;max-height:85vh;overflow:auto;box-shadow:0 8px 28px #0008;padding:10px}",
    ".heading{display:flex;align-items:center;justify-content:space-between;gap:6px;font-weight:700;font-size:13px}",
    ".muted{color:#b4c1d5;font-size:11px;line-height:1.4;margin-top:5px}",
    ".buttons{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:8px}",
    "button{border:1px solid #647998;border-radius:6px;background:#263850;color:white;padding:7px 4px;cursor:pointer;font-size:12px}",
    "button:disabled{opacity:.42;cursor:not-allowed} button:hover:enabled{background:#344f72}",
    "input{width:100%;margin-top:5px;padding:7px;background:#17243a;border:1px solid #60748d;border-radius:6px;color:white}",
    ".small{width:auto;padding:3px 7px}.hidden{display:none}.state{margin-top:7px;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}",
    "</style>",
    '<div class="panel">',
    '<div class="heading"><span>NHD · Fib Replay Recorder</span><button class="small" id="min" title="Thu gọn">−</button></div>',
    '<div id="inner">',
    '<div class="muted">Chỉ ghi khi bạn bật. Không đặt lệnh, không gửi dữ liệu tới máy chủ. Mở hộp Coordinates của Fib để đọc giá neo.</div>',
    '<input id="note" type="text" maxlength="250" placeholder="Ghi chú: lý do đặt Fib / Entry / TP..." autocomplete="off"/>',
    '<div class="buttons">',
    '<button id="toggle">Bắt đầu ghi</button><button id="fib" disabled>Ghi Fibonacci</button>',
    '<button id="entry" disabled>Đánh dấu Entry</button><button id="tp" disabled>Đánh dấu TP</button>',
    '<button id="replay" disabled>Mốc Replay</button><button id="chart" disabled>Chụp biểu đồ</button>',
    '<button id="export" disabled>Xuất TXT (JSON)</button><button id="clear">Xóa phiên</button>',
    '</div>',
    '<div class="state" id="state" aria-live="polite">Chưa ghi. Dữ liệu chỉ ở trong tab này.</div>',
    '<div class="muted">Tọa độ chuột (pixel) không được coi là giá. Giá Fib chỉ được ghi nhận tạm thời từ trường tọa độ rõ nhãn; phải kiểm chứng.</div>',
    '</div></div>'
  ].join("");
  document.documentElement.appendChild(host);
  const byId = id => shadow.getElementById(id);
  function status(message) {
    byId("state").textContent = (active ? "● Đang ghi" : "○ Tạm dừng") +
      " | " + state.events.length + " thao tác | " + state.captures.length + " mốc\n" + (message || "");
  }
  function addEvent(event) {
    if (!active) return;
    state.events.push({ ...event, at: new Date().toISOString() });
    state.events = C.boundedEventArray(state.events);
  }
  function chartMeta() {
    return {
      title: String(document.title || "").slice(0, 180),
      url: location.origin + location.pathname,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      capturedAt: new Date().toISOString(),
      mode: "bar_replay_state_not_verified"
    };
  }
  function visible(el) {
    try { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    } catch { return false; }
  }
  function numeric(value) { return C.parseNumeric(value) !== null; }
  function directLabel(el) {
    const labels = [];
    for (const attr of ["aria-label", "placeholder", "title"]) if (el.getAttribute(attr)) labels.push(el.getAttribute(attr));
    if (el.labels) for (const label of el.labels) labels.push(label.innerText || label.textContent || "");
    const id = el.id;
    if (id) { try { const label = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (label) labels.push(label.textContent || ""); } catch {} }
    for (const candidate of labels) {
      const clean = C.cleanLabel(candidate);
      if (/^(?:price|giá)\s*[123]$/i.test(clean)) return clean;
    }
    return C.cleanLabel(labels[0] || "");
  }
  function getDialogCoordinates() {
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-name*="properties"],[class*="dialog"]')]
      .filter(visible).filter(el => /coordinates|tọa độ|price\s*[123]|giá\s*[123]/i.test(String(el.innerText || "").slice(0, 6000)));
    const matched = [];
    for (const panel of dialogs.slice(0, 3)) {
      const inputs = [...panel.querySelectorAll('input:not([type="password"]):not([type="hidden"]),[role="spinbutton"]')]
        .filter(visible).slice(0, 40);
      const fields = [];
      for (const el of inputs) {
        const raw = String("value" in el ? el.value : (el.getAttribute("aria-valuenow") || el.textContent || "")).slice(0, 80);
        if (!numeric(raw)) continue;
        const direct = directLabel(el);
        let context = "";
        for (let p = el.parentElement, n = 0; p && n < 3; n++, p = p.parentElement) {
          const text = C.cleanLabel(p.innerText || p.textContent || "");
          if (text && text.length < 140) { context = text; if (/price\s*[123]|giá\s*[123]/i.test(text)) break; }
        }
        fields.push({ label: direct, value: raw, context: context.slice(0, 120) });
      }
      if (fields.length) matched.push({ fields, result: C.parseCoordinates(fields) });
    }
    if (!matched.length) return { status: "coordinates_dialog_not_found_or_unreadable", verified: false, fields: [], anchors: {}, confidence: "none" };
    // Never merge values from separate dialogs or assume that a nearby bar-number field is a price.
    const selected = matched.sort((a,b) => Object.keys(b.result.anchors).length - Object.keys(a.result.anchors).length)[0];
    return { status: "provisional_review_required", ...selected.result, fields: selected.fields };
  }
  function inChart(x, y) {
    const canvases = [...document.querySelectorAll("canvas")].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width >= 140 && r.height >= 100 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (!canvases.length) return null;
    const r = canvases.sort((a,b) => {
      const q = a.getBoundingClientRect(), p = b.getBoundingClientRect();
      return q.width*q.height - p.width*p.height;
    })[0].getBoundingClientRect();
    return { x: Math.round(x), y: Math.round(y),
      canvas: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } };
  }
  function isOverlayEvent(e) { return e.composedPath?.().includes(host) || host.contains(e.target); }
  document.addEventListener("pointerdown", e => {
    if (!active || isOverlayEvent(e)) return;
    const point = inChart(e.clientX, e.clientY);
    if (point) down = { point, time: Date.now(), pointerId: e.pointerId };
  }, { capture: true, passive: true });
  document.addEventListener("pointerup", e => {
    if (!active || !down || down.pointerId !== e.pointerId) return;
    const last = down; down = null;
    const to = inChart(e.clientX, e.clientY);
    if (!to) return;
    addEvent({ kind: "chart_pointer", from: last.point, to, durationMs: Date.now() - last.time, mouseButton: e.button });
    status("Đã ghi vị trí chuột; cần đối chiếu Coordinates để lấy giá chính xác.");
  }, { capture: true, passive: true });
  document.addEventListener("keydown", e => {
    if (!active || isOverlayEvent(e) || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      addEvent({ kind: "replay_shortcut", action: e.key === "ArrowRight" ? "step" : "toggle" });
      status("Đã ghi phím điều khiển Replay (không ghi nội dung nhập liệu).");
    }
  }, { capture: true, passive: true });
  document.addEventListener("click", e => {
    if (!active || isOverlayEvent(e)) return;
    const btn = e.target?.closest?.('[data-name],button,[role="button"]');
    if (!btn) return;
    const name = C.cleanLabel(btn.getAttribute?.("data-name") || btn.getAttribute?.("aria-label") || "");
    if (/replay|phát lại/i.test(name)) addEvent({ kind: "replay_control", control: name.slice(0, 60) });
  }, { capture: true, passive: true });
  async function capture(kind) {
    if (!active || busy) return;
    busy = true;
    const capture = {
      kind, at: new Date().toISOString(),
      note: String(byId("note").value || "").trim().slice(0, 250),
      chart: chartMeta(),
      coordinates: getDialogCoordinates(),
      screenshot: null,
      screenshotStatus: "pending"
    };
    if (state.captures.length >= C.MAX_CAPTURES) {
      state.captures.shift();
      capture.limitNotice = "Oldest capture discarded (12-frame privacy/size limit).";
    }
    state.captures.push(capture);
    addEvent({ kind: "user_marker", marker: kind, captureIndex: state.captures.length - 1 });
    status("Đang ghi mốc " + kind + "...");
    const previousDisplay = host.style.display;
    try {
      host.style.display = "none";
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const response = await chrome.runtime.sendMessage({ type: "NHD_TV_CAPTURE_ACTIVE" });
      if (response?.ok && response.result?.dataUrl?.startsWith("data:image/jpeg;base64,")) {
        capture.screenshot = response.result.dataUrl;
        capture.screenshotStatus = "captured";
      } else capture.screenshotStatus = "unavailable: " + String(response?.error || "extension_not_reloaded").slice(0, 140);
    } catch (error) {
      capture.screenshotStatus = "unavailable: " + String(error?.message || error).slice(0, 140);
    } finally {
      host.style.display = previousDisplay;
      busy = false;
      const n = Object.keys(capture.coordinates.anchors || {}).length;
      status("Mốc " + kind + ": ảnh " + capture.screenshotStatus +
        "; " + n + " giá neo tạm đọc. " + (n < 2 ? "Hãy mở Fib → Settings → Coordinates rồi bấm Ghi Fibonacci." : "Phải đối chiếu giá trong hộp Coordinates."));
    }
  }
  function download() {
    const data = C.prepareExport(state);
    const file = "NHD-Fib-Replay-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = file;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
    status("Đã yêu cầu tải " + file + " về máy. Bạn có thể để NHD đọc tệp TXT này.");
  }
  function setActive(value) {
    active = !!value; down = null;
    if (active && !state.startedAt) state.startedAt = new Date().toISOString();
    if (active) state.chart = chartMeta();
    byId("toggle").textContent = active ? "Tạm dừng ghi" : "Bắt đầu ghi";
    for (const id of ["fib","entry","tp","replay","chart"]) byId(id).disabled = !active;
    byId("export").disabled = !state.startedAt;
    status(active ? "Hãy vẽ Fib, mở tọa độ, rồi bấm Ghi Fibonacci." : "Đã tạm dừng; dữ liệu vẫn nằm trong tab này.");
  }
  byId("toggle").addEventListener("click", () => setActive(!active));
  for (const id of ["fib","entry","tp","replay","chart"]) byId(id).addEventListener("click", () => { void capture(id); });
  byId("export").addEventListener("click", download);
  byId("clear").addEventListener("click", () => {
    if (active) setActive(false);
    state.startedAt = null; state.chart = {}; state.events = []; state.captures = [];
    byId("export").disabled = true;
    status("Phiên đã xóa khỏi bộ nhớ của tab (không tác động TradingView).");
  });
  byId("min").addEventListener("click", () => {
    const inner = byId("inner");
    inner.classList.toggle("hidden");
    byId("min").textContent = inner.classList.contains("hidden") ? "+" : "−";
  });
  status("Sẵn sàng, chưa theo dõi.");
})();
