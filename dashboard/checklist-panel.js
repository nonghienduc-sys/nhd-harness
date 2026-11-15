// Checklist nhiệm vụ (20261113): mỗi chat/tác vụ (task_run) là một luồng; mỗi job SBCE hiện checklist Brain giao
// và tiến độ qua các tầng Giao việc → Model viết → L0 máy kiểm → L1 judge khác họ → Brain duyệt.
// Mọi dữ liệu từ model/phiếu đều là dữ liệu không tin cậy: chỉ hiển thị dạng text đã escape.
(() => {
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = v => {
    const t = new Date(v).getTime(); if (!Number.isFinite(t)) return '—';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'vừa xong' : m < 60 ? `${m} phút trước` : m < 1440 ? `${Math.round(m / 60)} giờ trước` : `${Math.round(m / 1440)} ngày trước`;
  };
  const money = v => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  async function api(url) {
    const r = await fetch(url, { headers: { 'content-type': 'application/json' } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  const STATUS = {
    queued: ['Đang chờ', 'run'], running: ['Đang chạy', 'run'], verifying: ['Đang kiểm', 'run'], fixing: ['Đang sửa', 'run'],
    ready_for_review: ['Chờ Brain duyệt', 'wait'], needs_brain: ['Bị kẹt', 'wait'],
    accepted: ['Đã duyệt', 'ok'], applied: ['Đã áp dụng', 'ok'], failed: ['Trả lại / lỗi', 'bad'], cancelled: ['Đã huỷ', 'off']
  };
  const group = s => (STATUS[s] || [s, 'off'])[1];
  const pill = s => { const [label, cls] = STATUS[s] || [s, 'off']; return `<span class="ck-pill ${cls}">${esc(label)}</span>`; };
  const KIND = { code_change: 'Sửa code', doc_write: 'Viết tài liệu', doc_edit: 'Sửa tài liệu', data_extract: 'Trích xuất', research: 'Tra cứu', shell_task: 'Lệnh shell', test_write: 'Viết test' };
  const TYPE = { command: ['Lệnh', 'L0'], grep_absent: ['Không chứa', 'L0'], schema: ['Schema', 'L0'], artifact_exists: ['Tệp tồn tại', 'L0'], rubric: ['Rubric', 'L1'] };
  const CHECK = { L0_artifact_shape: 'Đúng hình dạng sản phẩm', L0_no_instruction_leak: 'Không lọt chỉ dẫn hệ thống', L1_cross_family_judge: 'Judge khác họ chấm đạt', L0_machine_acceptance: 'Máy chạy tiêu chí kiểm', L0_L1: 'Qua cổng L0/L1 (bản cũ ghi gộp)', L0_static_patch_integrity: 'Patch không đụng vùng cấm', L0_edit_blocks: 'Khối sửa hợp lệ', L0_writer_output: 'Model không trả được sản phẩm', L0_patch_applies: 'Patch áp được', L0_typecheck: 'Build/typecheck đạt', L0_tests: 'Test đạt', L0_artifact_exists: 'Tệp tồn tại', L0_grep_absent: 'Không chứa mẫu cấm', L0_context_refs: 'Tham chiếu ngữ cảnh hợp lệ', L0_evidence_available: 'Có nguồn chứng cứ' };
  const ICON = { done: '✓', fail: '✕', active: '●', wait: '◔', todo: '', skip: '–' };

  // Trạng thái từng tầng của một job, suy ra từ status + các cổng kiểm đã ghi.
  function stages(job) {
    const checks = job.review?.checks || [];
    const l0 = checks.filter(c => /^L0_/.test(c.name)), l1 = checks.find(c => c.name === 'L1_cross_family_judge'), both = checks.find(c => c.name === 'L0_L1');
    const st = job.status, running = ['queued', 'running', 'verifying', 'fixing'].includes(st), cancelled = st === 'cancelled';
    const stop = cancelled ? 'skip' : 'todo';
    const writer = (job.writers || []).length ? 'done' : st === 'queued' ? 'wait' : running ? 'active' : stop;
    let L0 = l0.length ? (l0.every(c => c.ok) ? 'done' : 'fail') : both ? (both.ok ? 'done' : 'fail') : running && writer === 'done' ? 'active' : stop;
    let L1 = l1 ? (l1.ok ? 'done' : 'fail') : running && L0 === 'done' ? 'active' : stop;
    if (L0 === 'fail' && L1 === 'todo') L1 = 'skip';
    let brain = 'todo';
    if (st === 'accepted' || st === 'applied') brain = 'done';
    else if (st === 'failed' && L1 === 'done') brain = 'fail';
    else if (st === 'ready_for_review' || st === 'needs_brain') brain = 'wait';
    else if (st === 'failed' || cancelled) brain = 'skip';
    return [
      { key: 'order', label: 'Giao việc', sub: 'Brain viết tiêu chí', state: 'done' },
      { key: 'write', label: 'Model viết', sub: (job.writers || []).join(', ') || '—', state: writer },
      { key: 'L0', label: 'L0 máy kiểm', sub: 'build · test · schema', state: L0 },
      { key: 'L1', label: 'L1 judge khác họ', sub: (job.judges || []).join(', ') || '—', state: L1 },
      { key: 'brain', label: 'Brain duyệt', sub: brain === 'wait' ? 'đang chờ bạn' : brain === 'done' ? 'đã duyệt' : brain === 'fail' ? 'trả lại' : '—', state: brain }
    ];
  }
  const dots = job => `<span class="ck-dots" aria-hidden="true">${stages(job).map(s => `<i class="${s.state}" title="${esc(s.label)}"></i>`).join('')}</span>`;

  let board = null, filter = 'all', query = '', selected = null, openThreads = new Set(), closedThreads = new Set(), detailCache = new Map(), timer = null, loading = false;

  function threadsOf(data) {
    const map = new Map();
    for (const job of data.jobs || []) {
      const key = job.owner || '__none__';
      if (!map.has(key)) map.set(key, { key, task: (data.tasks || {})[key] || null, jobs: [] });
      map.get(key).jobs.push(job);
    }
    const list = [...map.values()];
    for (const t of list) {
      t.updated = Math.max(...t.jobs.map(j => new Date(j.updatedAt).getTime() || 0));
      t.counts = { run: 0, wait: 0, ok: 0, bad: 0, off: 0 };
      for (const j of t.jobs) t.counts[group(j.status)]++;
      t.live = t.counts.run + t.counts.wait > 0;
    }
    return list.sort((a, b) => Number(b.live) - Number(a.live) || b.updated - a.updated);
  }
  const matches = job => (filter === 'all' || group(job.status) === filter) && (!query || `${job.title} ${job.id}`.toLowerCase().includes(query));

  const ageText = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} phút` : m < 2880 ? `${Math.round(m / 60)} giờ` : `${Math.round(m / 1440)} ngày`; };
  const oldest = list => Math.max(...list.map(j => Date.now() - (new Date(j.updatedAt).getTime() || Date.now())));
  function renderKpis(threads, jobs) {
    const today = new Date().toDateString();
    const k = (label, value, sub, cls) => `<div class="col-6 col-lg"><div class="card card-sm ck-kpi ${cls}"><div class="card-body"><div class="ck-kpi-label">${esc(label)}</div><div class="ck-kpi-value">${esc(value)}</div><div class="ck-kpi-sub">${esc(sub)}</div></div></div></div>`;
    const run = jobs.filter(j => group(j.status) === 'run').length;
    const review = jobs.filter(j => j.status === 'ready_for_review'), stuck = jobs.filter(j => j.status === 'needs_brain');
    const okToday = jobs.filter(j => group(j.status) === 'ok' && new Date(j.updatedAt).toDateString() === today).length;
    $('ckKpis').innerHTML =
      k('Luồng đang mở', threads.filter(t => t.live).length, `${threads.length} luồng gần đây`, 'is-blue') +
      k('Job đang chạy', run, run ? 'model rẻ đang làm / đang kiểm' : 'không có job nào chạy', run ? 'is-run' : '') +
      k('Chờ duyệt', review.length, review.length ? `cũ nhất ${ageText(oldest(review))}` : 'không có gì chờ duyệt', review.length ? 'is-wait' : '') +
      k('Bị kẹt', stuck.length, stuck.length ? `cũ nhất ${ageText(oldest(stuck))} · giao lại sẽ tự đóng` : 'không có job kẹt', stuck.length ? 'is-wait' : '') +
      k('Đạt hôm nay', okToday, 'đã qua đủ L0 → L1 → Brain', 'is-ok');
  }

  function renderThreads() {
    const threads = threadsOf(board);
    renderKpis(threads, board.jobs || []);
    const html = threads.map(t => {
      const jobs = t.jobs.filter(matches);
      if (!jobs.length) return '';
      const open = closedThreads.has(t.key) ? false : openThreads.has(t.key) || t.live || jobs.some(j => j.id === selected) || threads.length <= 2;
      const total = t.jobs.length, done = t.counts.ok;
      const seg = ['ok', 'run', 'wait', 'bad', 'off'].map(c => t.counts[c] ? `<i class="${c}" style="flex:${t.counts[c]}"></i>` : '').join('');
      const title = t.task ? t.task.objective : t.key === '__none__' ? 'Chưa phân luồng' : 'Task ' + t.key.slice(0, 12);
      const meta = t.task ? [base(t.task.root), t.task.state].filter(Boolean).join(' · ') : t.key === '__none__' ? 'backend chưa trả owner — cần khởi động lại để tách theo chat' : 'task không còn trong bộ nhớ';
      const rows = jobs.map(j => `<button type="button" class="ck-job ${j.id === selected ? 'active' : ''}" data-ck-job="${esc(j.id)}">
          <span class="ck-job-main"><span class="ck-job-title">${esc(j.title || j.id)}</span><span class="ck-job-meta">${esc(KIND[j.kind] || j.kind || '')}${j.criteriaCount ? ` · ${j.criteriaCount} tiêu chí` : ''} · ${esc(ago(j.updatedAt))}</span></span>
          ${dots(j)}${pill(j.status)}</button>`).join('');
      return `<details class="ck-thread ${t.live ? 'live' : ''}" data-ck-thread="${esc(t.key)}" ${open ? 'open' : ''}>
        <summary><span class="ck-thread-icon" aria-hidden="true">${t.live ? '◉' : '○'}</span><span class="ck-thread-head"><span class="ck-thread-title">${esc(title)}</span><span class="ck-thread-meta">${esc(meta)}</span></span>
          <span class="ck-thread-count"><b>${done}/${total}</b> xong</span></summary>
        <div class="ck-progress" aria-hidden="true">${seg}</div>
        <div class="ck-jobs">${rows}</div></details>`;
    }).join('');
    $('ckThreads').innerHTML = html || `<div class="ck-empty">${(board.jobs || []).length ? 'Không có job khớp bộ lọc.' : 'Chưa có job SBCE nào. Khi Brain giao việc qua <code>delegate_task</code>, checklist sẽ hiện ở đây.'}</div>`;
  }

  function criterionText(a) {
    if (a.type === 'rubric') return esc(a.text || '—');
    const parts = [];
    if (a.run) parts.push(`<code>${esc(a.run)}</code>`);
    if (a.expect) parts.push(`→ mong đợi <b>${esc(a.expect)}</b>`);
    if (a.pattern) parts.push(`không chứa <code>${esc(a.pattern)}</code>`);
    if (a.paths && a.paths.length) parts.push(a.paths.map(p => `<code>${esc(p)}</code>`).join(' '));
    if (a.text) parts.push(esc(a.text));
    return parts.join(' ') || esc(TYPE[a.type]?.[0] || a.type);
  }

  function renderDetail(job) {
    const box = $('ckDetail');
    if (!job) { box.innerHTML = '<div class="ck-empty ck-empty-detail"><div class="ck-empty-icon" aria-hidden="true">☑</div><b>Chọn một job trong danh sách</b><span>để xem checklist Brain đã giao và tiến độ qua từng tầng kiểm.</span></div>'; return; }
    const st = stages(job), byKey = Object.fromEntries(st.map(s => [s.key, s.state]));
    const cl = job.checklist;
    const crit = cl ? cl.acceptance.map((a, i) => {
      const tier = TYPE[a.type]?.[1] || 'L1';
      const state = byKey[tier] === 'done' ? (byKey.brain === 'fail' ? 'warn' : 'done') : byKey[tier] || 'todo';
      return `<li class="ck-item ${state}"><span class="ck-tick" aria-hidden="true">${ICON[state] ?? ''}</span><span class="ck-item-body"><span class="ck-item-top"><span class="ck-type">${esc(TYPE[a.type]?.[0] || a.type)}</span><span class="ck-tier">${tier === 'L0' ? 'máy kiểm' : 'judge chấm'}</span><span class="ck-num">#${i + 1}</span></span><span class="ck-item-text">${criterionText(a)}</span></span></li>`;
    }).join('') : '';
    const checks = (job.review?.checks || []).map(c => `<li class="${c.ok ? 'done' : 'fail'}"><span aria-hidden="true">${c.ok ? '✓' : '✕'}</span>${esc(CHECK[c.name] || c.name)}<small>${esc(c.name)}</small></li>`).join('');
    const gate = (cs, re) => { const g = (cs || []).filter(c => re.test(c.name)); return !g.length ? '<span class="ck-att-na" title="chưa chạy">–</span>' : g.every(c => c.ok) ? '<span class="ck-att-ok">✓</span>' : '<span class="ck-att-bad" title="' + esc(g.filter(c => !c.ok).map(c => CHECK[c.name] || c.name).join(', ')) + '">✕</span>'; };
    const attempts = (job.review?.attempts || []).map(a => `<tr><td>#${esc(a.attempt)}</td><td>${esc(a.model)} <small>${esc(a.tier)}</small></td><td>${gate(a.checks, /^L0_/)}</td><td>${gate(a.checks, /^L1_/)}</td><td class="ck-att-err">${esc(a.error || '')}</td></tr>`).join('');
    const risks = (job.review?.risks || []).map(r => `<li>${esc(r)}</li>`).join('');
    box.innerHTML = `
      <div class="card ck-detail-card">
        <div class="card-header ck-detail-head">
          <div class="min-w-0"><div class="ck-detail-pre">${esc(KIND[job.kind] || job.kind || '')} · ${esc(job.id)}</div><h3 class="card-title ck-detail-title">${esc(job.title || job.id)}</h3>
            <div class="ck-detail-meta">${pill(job.status)}<span>${esc(money(job.spentVnd))} / ${esc(money(job.budgetVnd))} credit</span><span>${esc(job.attempts ?? 0)} lượt</span><span>${esc(ago(job.updatedAt))}</span>${cl?.risk ? `<span class="ck-risk ${esc(cl.risk)}">rủi ro ${esc({ low: 'thấp', medium: 'vừa', high: 'cao' }[cl.risk] || cl.risk)}</span>` : ''}</div></div>
          <div class="card-actions"><button type="button" class="btn btn-sm" data-goto="sbce">Bảng SBCE ›</button></div>
        </div>
        <div class="card-body">
          <ol class="ck-steps">${st.map((s, i) => `<li class="${s.state}"><span class="ck-step-dot">${ICON[s.state] || i + 1}</span><span class="ck-step-label">${esc(s.label)}</span><span class="ck-step-sub">${esc(s.sub)}</span></li>`).join('')}</ol>
          ${job.reason ? `<div class="ck-reason ${group(job.status)}"><b>Ghi chú:</b> ${esc(job.reason)}</div>` : ''}
          ${cl ? `
            <div class="ck-block"><h4>Mục tiêu</h4><p class="ck-goal">${esc(cl.goal)}</p></div>
            ${cl.deliverables.length ? `<div class="ck-block"><h4>Sản phẩm cần giao <span>${cl.deliverables.length}</span></h4><ul class="ck-deliver">${cl.deliverables.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
            <div class="ck-block"><h4>Tiêu chí nghiệm thu <span>${cl.acceptance.length}</span></h4><ul class="ck-list">${crit}</ul>
              <p class="ck-note">Dấu tích theo tầng kiểm: tiêu chí máy kiểm lấy kết quả L0, tiêu chí rubric lấy kết quả judge L1 (judge hiện chấm gộp cả phiếu, chưa chấm riêng từng dòng).</p></div>
            ${cl.constraints.length ? `<details class="ck-more"><summary>Ràng buộc (${cl.constraints.length})</summary><ul>${cl.constraints.map(c => `<li>${esc(c)}</li>`).join('')}</ul></details>` : ''}
            <details class="ck-more"><summary>Tiêu chí an toàn mặc định (${cl.safety.length})</summary><ul>${cl.safety.map(c => `<li>${esc(c)}</li>`).join('')}</ul></details>`
            : `<div class="alert alert-warning ck-alert"><div><b>Chưa đọc được checklist của job này.</b><div class="text-secondary small">Backend SBCE đang chạy bản cũ chưa trả tiêu chí nghiệm thu. Cần khởi động lại harness để bật.</div></div></div>`}
          ${checks ? `<div class="ck-block"><h4>Cổng kiểm đã chạy</h4><ul class="ck-gates">${checks}</ul></div>` : ''}
          ${attempts ? `<div class="ck-block"><h4>Từng lượt <span>${(job.review.attempts || []).length}</span></h4><table class="ck-attempts"><thead><tr><th>Lượt</th><th>Model</th><th>L0</th><th>L1</th><th>Lý do</th></tr></thead><tbody>${attempts}</tbody></table><p class="ck-note">– = tầng đó chưa chạy ở lượt này (ví dụ L0 trượt nên không gọi judge).</p></div>` : ''}
          ${risks ? `<details class="ck-more"><summary>Rủi ro ghi nhận</summary><ul>${risks}</ul></details>` : ''}
        </div>
      </div>`;
  }

  async function showDetail(id) {
    selected = id;
    const job = (board?.jobs || []).find(j => j.id === id);
    renderThreads();
    if (!job) return renderDetail(null);
    const key = id + '@' + job.updatedAt;
    if (detailCache.has(key)) return renderDetail(detailCache.get(key));
    renderDetail({ ...job, checklist: undefined });
    try {
      const d = await api('/api/sbce/jobs/' + encodeURIComponent(id));
      const merged = { ...job, ...d, checklist: d.checklist || null };
      detailCache.set(key, merged);
      if (selected === id) renderDetail(merged);
    } catch (e) { if (selected === id) renderDetail({ ...job, checklist: null }); }
  }

  async function load() {
    if (loading) return; loading = true;
    try {
      board = await api('/api/sbce/jobs?limit=100');
      $('ckStatus').textContent = 'Cập nhật ' + new Date().toLocaleTimeString('vi-VN', { hour12: false });
      if (selected && !(board.jobs || []).some(j => j.id === selected)) selected = null;
      if (!selected) { const first = (board.jobs || []).find(j => ['run', 'wait'].includes(group(j.status))) || (board.jobs || [])[0]; if (first && window.innerWidth >= 992) selected = first.id; }
      renderThreads();
      if (selected) await showDetail(selected); else renderDetail(null);
    } catch (e) {
      $('ckStatus').textContent = 'Lỗi: ' + e.message;
      if (!board) $('ckThreads').innerHTML = `<div class="ck-empty">Không đọc được SBCE (${esc(e.message)}).</div>`;
    } finally { loading = false; }
  }
  const visible = () => $('checklist')?.classList.contains('active') && !document.hidden;
  function start() { load(); clearInterval(timer); timer = setInterval(() => { if (visible() && $('ckAuto')?.checked) load(); }, 5000); }

  document.addEventListener('click', e => {
    const nav = e.target.closest?.('[data-tab="checklist"],[data-goto="checklist"]'); if (nav) { setTimeout(start, 0); return; }
    const go = e.target.closest?.('#ckDetail [data-goto]'); if (go) { document.querySelector(`nav button[data-tab="${go.getAttribute('data-goto')}"]`)?.click(); return; }
    const job = e.target.closest?.('[data-ck-job]'); if (job) { showDetail(job.getAttribute('data-ck-job')); if (window.innerWidth < 992) $('ckDetail').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const f = e.target.closest?.('[data-ck-filter]'); if (f) { filter = f.getAttribute('data-ck-filter'); document.querySelectorAll('[data-ck-filter]').forEach(b => b.classList.toggle('active', b === f)); if (board) renderThreads(); }
  });
  document.addEventListener('toggle', e => {
    const d = e.target; if (!d.matches?.('[data-ck-thread]')) return;
    const k = d.getAttribute('data-ck-thread'); if (d.open) { openThreads.add(k); closedThreads.delete(k); } else { closedThreads.add(k); openThreads.delete(k); }
  }, true);
  $('ckSearch')?.addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); if (board) renderThreads(); });
  $('ckRefresh')?.addEventListener('click', load);
  if ($('checklist')?.classList.contains('active')) start();
})();
