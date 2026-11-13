// SBCE board (0.24.29+, giao diện 20261113-ui): jobs, cost, writer/judge models, checks, quality per model, draft preview, owner review.
// Model output and drafts are untrusted data: always rendered as text, never as HTML.
(() => {
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  const when = v => { const t = new Date(v); return Number.isFinite(t.getTime()) ? t.toLocaleString('vi-VN', { hour12: false }) : '—'; };
  const ago = v => {
    const t = new Date(v).getTime(); if (!Number.isFinite(t)) return '—';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'vừa xong' : m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.round(m / 60)} giờ trước` : `${Math.round(m / 1440)} ngày trước`;
  };
  const pct = v => v === null || v === undefined ? '—' : `${String(v).replace('.', ',')}%`;
  const credit = v => v === null || v === undefined ? '—' : money(v);
  const STATUS = {
    queued: ['Đang chờ', 'warn'], running: ['Đang chạy', 'warn'], verifying: ['Đang kiểm', 'warn'], fixing: ['Đang sửa', 'warn'],
    ready_for_review: ['Chờ duyệt', 'orange'], accepted: ['Đã duyệt', 'ok'], applied: ['Đã áp dụng', 'ok'],
    failed: ['Trả lại / lỗi', 'bad'], needs_brain: ['Cần Brain', 'bad'], cancelled: ['Đã huỷ', '']
  };
  const status = s => { const [label, cls] = STATUS[s] || [s, '']; return `<span class="sbce-pill ${cls}">${esc(label)}</span>`; };
  const checkLabel = n => ({ L0_artifact_shape: 'L0 hình dạng', L0_no_instruction_leak: 'L0 không lọt chỉ dẫn', L1_cross_family_judge: 'L1 judge chéo họ', L0_machine_acceptance: 'L0 máy kiểm', L0_L1: 'L0/L1' }[n] || n);
  const checks = list => (list || []).map(c => `<span class="sbce-check ${c.ok ? 'ok' : 'bad'}" title="${esc(c.name)}">${c.ok ? '✓' : '✗'} ${esc(checkLabel(c.name))}</span>`).join('') || '<span class="muted">—</span>';
  const models = list => list && list.length ? list.map(esc).join(', ') : '—';
  async function api(url, options = {}) {
    const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }
  let selected = null, timer = null;

  function kpi(label, value, sub, cls = '', extra = '') {
    return `<div class="sbce-kpi ${cls}"><span class="sbce-kpi-label">${esc(label)}</span><strong>${esc(value)}</strong><span class="sbce-kpi-sub">${esc(sub)}</span>${extra}</div>`;
  }
  function renderOverview(worker, data) {
    const st = data.stats || {};
    const pending = data.jobs.filter(j => j.status === 'ready_for_review').length;
    const online = worker.status === 'online';
    const used = Number(data.budget?.usedVnd) || 0, limit = Number(data.budget?.limitVnd) || 0;
    const share = limit > 0 ? Math.min(100, used / limit * 100) : 0;
    const avg = data.totals.jobCount ? data.totals.spentVnd / data.totals.jobCount : 0;
    $('sbceMetrics').innerHTML = `
      <div class="sbce-strip">
        <span class="sbce-dot ${online ? 'ok' : 'bad'}"></span><b>${esc(online ? 'Online' : (worker.status || '—'))}</b><span>Worker</span>
        <i></i><span>Chế độ</span><b>${esc(data.mode || worker.mode || '—')}</b>
        <i></i><span>Model đang bật</span><b>${esc(worker.modelCount ?? '—')}</b>
      </div>
      <div class="sbce-kpis">
        ${kpi('Tỉ lệ đạt (Brain)', pct(st.acceptRate), `${st.accepted ?? 0} duyệt · ${st.rejected ?? 0} trả lại`, 'accent')}
        ${kpi('Chờ duyệt', pending, pending ? 'job đang chờ bạn quyết định' : 'không có job nào đang chờ', pending ? 'attention' : '')}
        ${kpi('Tổng chi', `${money(data.totals.spentVnd)} credit`, `${data.totals.jobCount} job · TB ${money(avg)} / job`)}
        ${kpi('Chi hôm nay', money(used), `hạn mức ${money(limit)} credit`, '', `<div class="sbce-meter"><i style="width:${share.toFixed(2)}%"></i></div>`)}
      </div>`;
  }
  function bar(ok, bad, wait) {
    const total = ok + bad + wait;
    if (!total) return '<div class="sbce-bar empty"></div>';
    const w = n => (n / total * 100).toFixed(2);
    return `<div class="sbce-bar">${ok ? `<i class="ok" style="width:${w(ok)}%"></i>` : ''}${bad ? `<i class="bad" style="width:${w(bad)}%"></i>` : ''}${wait ? `<i class="warn" style="width:${w(wait)}%"></i>` : ''}</div>`;
  }
  function renderStats(st) {
    if (!st) { $('sbceStatsSummary').textContent = 'Worker chưa trả thống kê (cần bản 0.24.32).'; return; }
    $('sbceStatsSummary').textContent = `${st.jobCount} job · Brain duyệt ${st.accepted}, trả lại ${st.rejected}, đang chờ ${st.pending} · judge rẻ cho qua ${st.l1Passed}, bỏ sót ${st.l1Missed}`;
    $('sbceWriterStats').innerHTML = (st.writers || []).map(w => `
      <div class="sbce-model">
        <div class="sbce-model-head"><b>${esc(w.modelId)}</b><span class="sbce-rate">${esc(pct(w.acceptRate))}<small>tỉ lệ đạt</small></span></div>
        ${bar(w.accepted, w.rejected, w.pending)}
        <div class="sbce-model-meta"><span><b>${esc(w.jobs)}</b> job</span><span class="ok"><b>${esc(w.accepted)}</b> duyệt</span><span class="bad"><b>${esc(w.rejected)}</b> trả lại</span><span><b>${esc(credit(w.costVnd))}</b> credit</span><span><b>${esc(credit(w.costPerAccepted))}</b> / bản đạt</span></div>
      </div>`).join('') || '<p class="muted">Chưa có dữ liệu.</p>';
    $('sbceJudgeStats').innerHTML = (st.judges || []).map(g => `
      <div class="sbce-model">
        <div class="sbce-model-head"><b>${esc(g.modelId)}</b><span class="sbce-rate ${g.missed ? 'sbce-bad' : 'sbce-good'}">${esc(pct(g.missRate))}<small>bỏ sót</small></span></div>
        ${bar(g.passed - g.missed, g.missed, 0)}
        <div class="sbce-model-meta"><span><b>${esc(g.jobs)}</b> job</span><span><b>${esc(g.passed)}</b> cho qua</span><span class="${g.missed ? 'bad' : ''}"><b>${esc(g.missed)}</b> bỏ sót</span><span><b>${esc(credit(g.costVnd))}</b> credit</span></div>
      </div>`).join('') || '<p class="muted">Chưa có dữ liệu.</p>';
  }
  function checkSummary(list) {
    const all = list || [];
    if (!all.length) return '<span class="muted">—</span>';
    const okCount = all.filter(c => c.ok).length;
    return `<div class="sbce-checks"><span class="sbce-score ${okCount === all.length ? 'ok' : 'bad'}">${okCount}/${all.length}</span>${checks(all)}</div>`;
  }

  async function loadBoard() {
    const note = $('sbceBoardStatus');
    try {
      const [worker, data] = await Promise.all([api('/api/sbce/status').catch(e => ({ status: 'error', error: e.message })), api('/api/sbce/jobs?limit=50')]);
      renderOverview(worker, data);
      $('sbceJobRows').innerHTML = data.jobs.length ? data.jobs.map(j => `
        <tr data-job="${esc(j.id)}" class="${j.id === selected ? 'selected' : ''}">
          <td><div class="sbce-job-title">${esc(j.title || j.kind)}</div><div class="sbce-job-id">${esc(j.id.slice(0, 12))} · ${esc(j.kind)}</div></td>
          <td>${status(j.status)}</td>
          <td><span class="sbce-flow"><span>${models(j.writers)}</span><em>→</em><span>${models(j.judges)}</span></span></td>
          <td>${checkSummary(j.review?.checks)}</td>
          <td class="num"><b>${money(j.spentVnd)}</b></td>
          <td class="num" title="${esc(when(j.createdAt))}"><span class="sbce-time">${esc(ago(j.createdAt))}</span></td>
        </tr>`).join('') : '<tr><td colspan="6" class="muted sbce-empty">Chưa có job SBCE nào.</td></tr>';
      renderStats(data.stats);
      document.querySelectorAll('#sbceJobRows tr[data-job]').forEach(tr => tr.onclick = () => openJob(tr.dataset.job));
      note.textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN', { hour12: false })}`;
    } catch (e) {
      note.textContent = 'Không đọc được SBCE: ' + e.message;
    }
  }

  async function openJob(id) {
    selected = id;
    document.querySelectorAll('#sbceJobRows tr[data-job]').forEach(tr => tr.classList.toggle('selected', tr.dataset.job === id));
    const box = $('sbceDetail');
    box.hidden = false;
    $('sbceDetailTitle').textContent = 'Đang tải…';
    $('sbceDraft').textContent = '';
    try {
      const j = await api('/api/sbce/jobs/' + encodeURIComponent(id));
      $('sbceDetailTitle').textContent = j.title || j.kind;
      $('sbceDetailMeta').innerHTML = `${status(j.status)} <span class="sbce-job-id">${esc(j.id)}</span>`;
      $('sbceDetailInfo').innerHTML = `
        <dt>Model viết</dt><dd>${models(j.writers)}</dd>
        <dt>Model chấm</dt><dd>${models(j.judges)}</dd>
        <dt>Chi phí</dt><dd>${money(j.spentVnd)} credit <span class="muted">(giữ chỗ ${money(j.budgetVnd)}) · ${esc(j.attempts)} lượt</span></dd>
        <dt>Token</dt><dd>${esc(j.review?.tokensIn ?? 0)} vào / ${esc(j.review?.tokensOut ?? 0)} ra</dd>
        <dt>Các bước kiểm</dt><dd><div class="sbce-checks">${checks(j.review?.checks)}</div></dd>
        <dt>Tóm tắt</dt><dd>${esc(j.review?.summary || '—')}</dd>
        <dt>Rủi ro</dt><dd>${esc((j.review?.risks || []).join(' · ') || '—')}</dd>
        <dt>Ghi chú</dt><dd>${esc(j.review?.needsBrain || j.reason || '—')}</dd>`;
      $('sbceCalls').innerHTML = (j.calls || []).map(c => `<tr><td>${esc(when(c.at))}</td><td><span class="sbce-pill ${c.role === 'judge' ? 'info' : ''}">${esc(c.role === 'writer' ? 'Viết' : c.role === 'judge' ? 'Chấm' : c.role)}</span></td><td>${esc(c.modelId)}</td><td>${esc(c.state)}</td><td class="num">${money(c.costVnd)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Chưa có lần gọi model.</td></tr>';
      $('sbceDraft').textContent = j.draft ? j.draft.text + (j.draft.truncated ? `\n\n… (đã cắt, tổng ${j.draft.totalChars} ký tự)` : '') : '(Không có bản nháp)';
      const canReview = j.status === 'ready_for_review';
      const allOk = (j.review?.checks || []).length > 0 && j.review.checks.every(c => c.ok === true);
      $('sbceAccept').disabled = !canReview || !allOk;
      $('sbceReject').disabled = !canReview;
      $('sbceReviewHint').textContent = canReview ? (allOk ? 'Đọc kỹ bản nháp trước khi duyệt. Mọi quyết định đều cần xác nhận và được ghi audit.' : 'Có bước kiểm chưa đạt: chỉ được trả lại.') : 'Job này không ở trạng thái chờ duyệt.';
      if (typeof box.scrollIntoView === 'function') box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      $('sbceDetailTitle').textContent = 'Lỗi: ' + e.message;
    }
  }

  async function review(decision) {
    if (!selected) return;
    const label = decision === 'accept' ? 'DUYỆT' : 'TRẢ LẠI';
    const note = window.prompt(`Ghi chú khi ${label.toLowerCase()} job (không bắt buộc):`, '');
    if (note === null) return;
    if (!window.confirm(`Xác nhận ${label} job ${selected}?\nThao tác này không hoàn tác được và sẽ được ghi audit.`)) return;
    try {
      await api('/api/sbce/jobs/' + encodeURIComponent(selected) + '/review', { method: 'POST', body: JSON.stringify({ decision, note, confirmed: true }) });
      $('sbceReviewHint').textContent = decision === 'accept' ? 'Đã duyệt.' : 'Đã trả lại.';
      await loadBoard();
      await openJob(selected);
    } catch (e) {
      $('sbceReviewHint').textContent = 'Không thực hiện được: ' + e.message;
    }
  }

  function activate() {
    loadBoard();
    clearInterval(timer);
    timer = setInterval(() => { if ($('sbce')?.classList.contains('active') && !document.hidden) loadBoard(); else clearInterval(timer); }, 15000);
  }
  function wire() {
    $('sbceRefresh').onclick = loadBoard;
    $('sbceAccept').onclick = () => review('accept');
    $('sbceReject').onclick = () => review('reject');
    $('sbceClose').onclick = () => { selected = null; $('sbceDetail').hidden = true; document.querySelectorAll('#sbceJobRows tr.selected').forEach(tr => tr.classList.remove('selected')); };
    document.querySelectorAll('nav button[data-tab="sbce"]').forEach(b => b.addEventListener('click', activate));
    if ($('sbce')?.classList.contains('active')) activate();
  }
  window.loadSbceBoard = loadBoard;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
