(() => {
  const $ = (id) => document.getElementById(id);
  const state = { refreshing: false };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  function setText(id, value) { const el=$(id); if(el) el.textContent=String(value ?? '—'); }
  function setButton(id, disabled) { const el=$(id); if(el) el.disabled=Boolean(disabled); }

  function render(data) {
    const bg=data.background || {};
    const iso=data.isolated || {};
    const scheduler=data.scheduler || {};
    const bgSched=scheduler.background || {};
    const isoSched=scheduler.isolated || {};
    setText('backgroundLaneState', bg.state === 'online' ? 'ONLINE' : String(bg.state || 'UNKNOWN').toUpperCase());
    setText('backgroundLaneMeta', `${bgSched.active || 0}/${bgSched.maxConcurrent || bg.maxConcurrent || 2} slot · host foreground BLOCKED`);

    let isoState='OFFLINE';
    if(iso.online) isoState='ONLINE';
    else if(!iso.featureAvailable) isoState='PREREQUISITE';
    else if(iso.configured) isoState='READY';
    setText('isolatedLaneState', isoState);
    setText('isolatedLaneMeta', `${isoSched.active || 0}/${isoSched.maxConcurrent || iso.maxConcurrent || 1} slot · ${iso.provider || 'windows-sandbox'}`);
    setText('laneSchedulerState', `BG ${bgSched.active || 0}/${bgSched.maxConcurrent || 2} · ISO ${isoSched.active || 0}/${isoSched.maxConcurrent || 1}`);
    setText('laneLockState', `${data.locks?.active || 0} resource lock`);

    let prereq='Isolated Agent sẵn sàng.';
    if(!iso.featureAvailable) prereq='Windows Sandbox chưa được bật. Chạy scripts\\setup-isolated-agent.ps1 -EnableFeature bằng PowerShell Administrator, rồi reboot một lần nếu Windows yêu cầu.';
    else if(!iso.configured) prereq=iso.detail || 'Isolated Agent chưa cấu hình xong.';
    else if(!iso.online) prereq='Windows Sandbox đã có. Bấm Start Isolated Agent để mở guest riêng.';
    else prereq=`Isolated Agent online · ${iso.sessionId || 'guest session'} · heartbeat ${iso.lastHeartbeatAt || '—'}`;
    setText('isolatedPrerequisite', prereq);

    setButton('startIsolatedAgent', Boolean(iso.online || !iso.featureAvailable || !iso.configured));
    setButton('stopIsolatedAgent', !iso.online);
  }

  async function refresh() {
    if(state.refreshing) return;
    state.refreshing=true;
    try { render(await api('/api/execution-lanes/status')); }
    catch(error) { setText('isolatedPrerequisite', `Không đọc được lane status: ${error.message}`); }
    finally { state.refreshing=false; }
  }

  $('refreshExecutionLanes')?.addEventListener('click', refresh);
  $('startIsolatedAgent')?.addEventListener('click', async () => {
    setButton('startIsolatedAgent', true);
    setText('isolatedPrerequisite', 'Đang khởi động Windows Sandbox và chờ guest heartbeat...');
    try { await api('/api/isolated-agent/start', { method:'POST', body:JSON.stringify({ memoryMb:3072, timeoutMs:90000 }) }); }
    catch(error) { setText('isolatedPrerequisite', `Start thất bại: ${error.message}`); }
    await refresh();
  });
  $('stopIsolatedAgent')?.addEventListener('click', async () => {
    setButton('stopIsolatedAgent', true);
    try { await api('/api/isolated-agent/stop', { method:'POST', body:'{}' }); }
    catch(error) { setText('isolatedPrerequisite', `Stop thất bại: ${error.message}`); }
    await refresh();
  });
  $('openLaneDocs')?.addEventListener('click', async () => {
    const path='D:\\ChatGPT-Workstation-MCP\\docs\\DUAL_EXECUTION_LANES_v0.20.md';
    try { await navigator.clipboard.writeText(path); setText('isolatedPrerequisite', `Đã copy đường dẫn tài liệu: ${path}`); }
    catch { setText('isolatedPrerequisite', `Tài liệu: ${path}`); }
  });

  refresh();
  setInterval(refresh, 5000);
})();
