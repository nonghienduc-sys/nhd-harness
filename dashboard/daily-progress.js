(() => {
  const STYLE_ID = 'nhd-daily-progress-style';
  const CARD_ID = 'dailyProgressCard';
  let lastRoot = '';
  let timer = null;

  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function localDateKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function prettyDate(key) { const [y,m,d]=key.split('-'); return `${d}/${m}/${y}`; }
  function clamp(n) { return Math.max(0, Math.min(100, Number(n) || 0)); }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .daily-progress-card{position:relative;overflow:hidden}.daily-progress-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:18px}.daily-progress-head h2{margin:3px 0 4px}.daily-progress-head p{margin:0;color:var(--muted,#91a0b5)}
      .daily-progress-status{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid rgba(255,255,255,.09);border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}.daily-progress-status i{width:9px;height:9px;border-radius:50%;background:#f59e0b;box-shadow:0 0 16px rgba(245,158,11,.6)}.daily-progress-status.complete i{background:#22c55e;box-shadow:0 0 16px rgba(34,197,94,.55)}.daily-progress-status.not_started i{background:#64748b;box-shadow:none}
      .daily-progress-summary{display:grid;grid-template-columns:130px 1fr;gap:22px;align-items:center}.daily-progress-ring{--p:0;position:relative;width:118px;height:118px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#3b82f6 calc(var(--p)*1%),rgba(148,163,184,.14) 0)}.daily-progress-ring:after{content:'';position:absolute;inset:10px;border-radius:50%;background:var(--panel,#111827)}.daily-progress-ring strong,.daily-progress-ring span{position:relative;z-index:1}.daily-progress-ring strong{font-size:28px;line-height:1}.daily-progress-ring span{font-size:11px;color:#94a3b8;margin-top:-24px}
      .daily-progress-list{display:grid;gap:9px}.daily-progress-item{display:grid;grid-template-columns:minmax(150px,1fr) minmax(120px,1.4fr) auto;gap:12px;align-items:center}.daily-progress-item .label{font-size:13px;font-weight:650}.daily-progress-item .track{height:8px;border-radius:99px;background:rgba(148,163,184,.13);overflow:hidden}.daily-progress-item .fill{height:100%;border-radius:inherit;background:linear-gradient(90deg,#2563eb,#38bdf8);transition:width .25s ease}.daily-progress-item.done .fill{background:#22c55e}.daily-progress-item .count{font-size:12px;color:#a8b3c5;text-align:right;min-width:78px}.daily-progress-item.done .count{color:#5ee38c}
      .daily-progress-foot{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:17px;padding-top:14px;border-top:1px solid rgba(148,163,184,.11);font-size:12px;color:#8fa0b8}.daily-progress-foot strong{color:#dce6f5}.daily-progress-empty{padding:18px 0 4px;color:#98a6b9}.daily-progress-empty strong{display:block;color:#e6edf7;margin-bottom:6px}
      @media(max-width:760px){.daily-progress-summary{grid-template-columns:1fr}.daily-progress-ring{margin:auto}.daily-progress-item{grid-template-columns:1fr auto}.daily-progress-item .track{grid-row:2;grid-column:1/-1}.daily-progress-head{flex-direction:column}.daily-progress-status{align-self:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function ensureCard() {
    let card = document.getElementById(CARD_ID);
    if (card) return card;
    const host = document.querySelector('.project-workspace') || document.getElementById('overviewProjectCards')?.closest('.workspace-section') || document.querySelector('#overview .dashboard-grid') || document.getElementById('overview');
    if (!host) return null;
    card = document.createElement('article');
    card.id = CARD_ID;
    card.className = 'workspace-section daily-progress-card';
    const tokenCard = document.querySelector('.token-chart-card');
    if (host.classList.contains('project-workspace') && host.parentNode) host.parentNode.insertBefore(card, tokenCard || host.nextSibling);
    else host.appendChild(card);
    return card;
  }

  function render(data) {
    ensureStyle();
    const card = ensureCard();
    if (!card) return;
    const date = data?.date || localDateKey();
    const projectName = data?.project?.name || 'Project hiện tại';
    if (!data?.available || !data?.plan) {
      card.innerHTML = `<div class="daily-progress-head"><div><p class="eyebrow">TIẾN ĐỘ HÔM NAY · ${esc(prettyDate(date))}</p><h2>Hôm nay đã xong chưa?</h2><p>${esc(projectName)}</p></div><span class="daily-progress-status not_started"><i></i> Chưa có kế hoạch ngày</span></div><div class="daily-progress-empty"><strong>Project này chưa có Daily Plan cho hôm nay.</strong><span>Khi ChatGPT/MCP tạo kế hoạch ngày, tiến độ sẽ xuất hiện ở đây và tự cập nhật theo checkpoint.</span></div>`;
      return;
    }
    const percent = clamp(data.percent);
    const statusClass = data.complete ? 'complete' : data.status === 'not_started' ? 'not_started' : '';
    const statusText = data.complete ? 'Đã hoàn thành hôm nay' : data.status === 'not_started' ? 'Chưa bắt đầu' : 'Chưa hoàn thành hôm nay';
    const rows = (data.plan.items || []).map(item => {
      const p = item.target > 0 ? clamp((item.current / item.target) * 100) : 0;
      const done = item.current >= item.target;
      return `<div class="daily-progress-item ${done?'done':''}"><span class="label">${done?'✓ ':'○ '}${esc(item.label)}</span><span class="track"><i class="fill" style="width:${p}%"></i></span><span class="count">${esc(item.current)} / ${esc(item.target)} ${esc(item.unit)}</span></div>`;
    }).join('');
    const remaining = data.complete ? 'Không còn đầu việc hôm nay' : `Còn ${data.remainingItems} / ${data.totalItems} hạng mục chưa đạt mục tiêu`;
    card.innerHTML = `<div class="daily-progress-head"><div><p class="eyebrow">TIẾN ĐỘ HÔM NAY · ${esc(prettyDate(date))}</p><h2>${esc(data.plan.title)}</h2><p>${esc(projectName)}</p></div><span class="daily-progress-status ${statusClass}"><i></i>${esc(statusText)}</span></div><div class="daily-progress-summary"><div class="daily-progress-ring" style="--p:${percent}"><strong>${percent}%</strong><span>hoàn thành</span></div><div class="daily-progress-list">${rows}</div></div><div class="daily-progress-foot"><span><strong>${esc(remaining)}</strong>${data.plan.note ? ` · ${esc(data.plan.note)}` : ''}</span><span>Cập nhật từ MCP project memory${data.updatedAt ? ` · ${esc(new Date(data.updatedAt).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}))}` : ''}</span></div>`;
  }

  let loading = false;
  async function load() {
    if (document.hidden || loading) return;
    loading = true;
    try {
      const snapshot = await fetch('/api/health/fast', {cache:'no-store'}).then(r => r.ok ? r.json() : Promise.reject(new Error('health')));
      const health = snapshot.data;
      if (!health) return;
      const root = health?.context?.activeProjectRoot || '';
      if (!root) return render({available:false,date:localDateKey(),project:{name:'Chưa có project active'}});
      lastRoot = root;
      const date = localDateKey();
      const url = `/api/projects/daily-progress?root=${encodeURIComponent(root)}&date=${encodeURIComponent(date)}`;
      const response = await fetch(url, {cache:'no-store'});
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'daily progress error');
      render(data);
    } catch (error) {
      const card = ensureCard();
      if (card) card.innerHTML = `<div class="daily-progress-empty"><strong>Không đọc được tiến độ hôm nay.</strong><span>${esc(error?.message || error)}</span></div>`;
    } finally {
      loading = false;
    }
  }

  function start() {
    ensureStyle();
    setTimeout(load, 250);
    if (timer) clearInterval(timer);
    timer = setInterval(load, 10000);
    document.getElementById('refreshButton')?.addEventListener('click', () => setTimeout(load, 150));
    window.addEventListener('focus', load);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true}); else start();
  window.NHDDailyProgress = { refresh: load, get activeRoot(){ return lastRoot; } };
})();
