// Bảng chuyển chế độ Brain (harness / self / direct). Dữ liệu từ API là không tin cậy: chỉ hiển thị dạng text đã escape.
(() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function findContainer() {
    return document.getElementById('main') || document.querySelector('main') || document.querySelector('.page-body') || document.body;
  }

  async function api(method, body) {
    const opts = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch('/api/brain-mode', opts);
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    if (!r.ok) {
      const err = new Error((data && data.error) || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  function render(container, state) {
    const card = document.createElement('div');
    card.className = 'card mb-3';
    card.id = 'brain-mode-panel';

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = 'Chế độ Brain';
    body.appendChild(title);

    if (state.error) {
      const p = document.createElement('p');
      p.className = 'text-danger mb-2';
      p.textContent = 'Chưa có API chế độ Brain (cần cập nhật server)';
      body.appendChild(p);

      const btnWrap = document.createElement('div');
      btnWrap.className = 'btn-list';
      const b1 = document.createElement('button');
      b1.type = 'button';
      b1.className = 'btn btn-secondary disabled';
      b1.disabled = true;
      b1.textContent = 'Chế độ 1: Brain + harness + model bé (bắt buộc)';
      const b2 = document.createElement('button');
      b2.type = 'button';
      b2.className = 'btn btn-secondary disabled';
      b2.disabled = true;
      b2.textContent = 'Chế độ 2: Brain + harness, Brain tự làm (không model bé)';
      const b3 = document.createElement('button');
      b3.type = 'button';
      b3.className = 'btn btn-secondary disabled';
      b3.disabled = true;
      b3.textContent = 'Chế độ 3: Brain không dùng harness';
      btnWrap.appendChild(b1);
      btnWrap.appendChild(b2);
      btnWrap.appendChild(b3);
      body.appendChild(btnWrap);

      card.appendChild(body);
      return card;
    }

    if (state.override) {
      const warn = document.createElement('p');
      warn.className = 'text-warning mb-2';
      warn.textContent = 'NHD_BRAIN_ONLY=0 đang tắt chặn';
      body.appendChild(warn);
    }

    const status = document.createElement('p');
    status.className = 'text-secondary mb-2';
    status.textContent = `Chế độ hiện tại: ${state.mode === 'self' ? 'Chế độ 2' : state.mode === 'direct' ? 'Chế độ 3' : 'Chế độ 1'}`;
    body.appendChild(status);

    const btnWrap = document.createElement('div');
    btnWrap.className = 'btn-list';

    const b1 = document.createElement('button');
    b1.type = 'button';
    b1.className = state.mode === 'harness' ? 'btn btn-primary' : 'btn btn-secondary';
    b1.textContent = 'Chế độ 1: Brain + harness + model bé (bắt buộc)';
    b1.addEventListener('click', () => switchMode('harness'));

    const b2 = document.createElement('button');
    b2.type = 'button';
    b2.className = state.mode === 'self' ? 'btn btn-primary' : 'btn btn-secondary';
    b2.textContent = 'Chế độ 2: Brain + harness, Brain tự làm (không model bé)';
    b2.addEventListener('click', () => switchMode('self'));

    const b3 = document.createElement('button');
    b3.type = 'button';
    b3.className = state.mode === 'direct' ? 'btn btn-primary' : 'btn btn-secondary';
    b3.textContent = 'Chế độ 3: Brain không dùng harness';
    b3.addEventListener('click', () => switchMode('direct'));

    btnWrap.appendChild(b1);
    btnWrap.appendChild(b2);
    btnWrap.appendChild(b3);
    body.appendChild(btnWrap);

    card.appendChild(body);
    return card;
  }

  let container = null;
  let currentState = { mode: null, override: false, error: false };
  let switching = false;

  function mount() {
    if (!container) container = findContainer();
    const old = document.getElementById('brain-mode-panel');
    if (old) old.remove();
    const card = render(container, currentState);
    container.insertBefore(card, container.firstChild);
  }

  async function load() {
    try {
      const data = await api('GET');
      currentState = { mode: data && data.mode, override: !!(data && data.override), error: false };
    } catch (e) {
      currentState = { mode: null, override: false, error: true };
    }
    mount();
  }

  async function switchMode(mode) {
    if (switching) return;
    if (currentState.error) return;
    if (mode === currentState.mode) return;
    if (mode === 'self') {
      const ok = window.confirm('Bạn chắc chắn muốn chuyển sang Chế độ 2: Brain + harness, Brain tự làm (không model bé)?');
      if (!ok) return;
    }
    if (mode === 'direct') {
      const ok = window.confirm('Bạn chắc chắn muốn chuyển sang Chế độ 3: Brain không dùng harness?');
      if (!ok) return;
    }
    switching = true;
    try {
      const data = await api('POST', { mode, confirmed: true });
      currentState = { mode: data && data.mode, override: !!(data && data.override), error: false };
    } catch (e) {
      currentState = { ...currentState, error: true };
    }
    switching = false;
    mount();
  }

  function init() {
    load();
    setInterval(load, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
