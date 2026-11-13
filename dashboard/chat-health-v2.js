(() => {
  let payload = { overview: {}, tabs: [], settings: {} };
  let selectedTabKey = null;
  let selectedTab = null;
  let selectedHistory = null;
  let liveStream = null;
  let liveReconnectTimer = null;
  let realtimePollInFlight = false;

  const statusLabel = level => level === 'healthy' ? 'Healthy' : level === 'growing' ? 'Growing' : level === 'handoff' ? 'Handoff' : level === 'critical' ? 'Critical' : 'Unknown';
  const scoreClass = score => score >= 80 ? 'good' : score >= 65 ? 'growing' : score >= 50 ? 'handoff' : 'critical';
  const tabName = tab => (tab?.pageTitle || tab?.conversationId || tab?.tabKey || 'ChatGPT tab').replace(/\s*[|–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT tab';
  const shortId = value => { const s = String(value || '—'); return s.length > 34 ? `${s.slice(0, 15)}…${s.slice(-12)}` : s; };
  const metricValue = (value, suffix = '') => value == null ? '—' : `${value}${suffix}`;
  const formatTokens = value => value == null ? '—' : Math.round(Number(value)).toLocaleString('vi-VN');
  const tokenUsagePct = tab => {
    const budget = Number(payload.settings?.tokenBudget || 0);
    if (tab?.estimatedTokens == null || budget <= 0) return null;
    const tokens = Number(tab.estimatedTokens);
    return Number.isFinite(tokens) ? Math.round((tokens / budget) * 1000) / 10 : null;
  };

  function overviewMetrics(o = {}) {
    return [
      metric(o.totalTabs ?? 0, 'Tracked tabs'),
      metric(o.activeTabs ?? 0, 'Active now'),
      metric(o.handoffReadyTabs ?? 0, 'Handoff ready'),
      metric(o.criticalTabs ?? 0, 'Critical'),
      metric(o.lowestScore ?? '—', 'Lowest score'),
      metric(o.averageScore ?? '—', 'Average score'),
      metric(formatTokens(o.highestEstimatedTokens), 'Max est. tokens'),
      metric(formatTokens(o.averageEstimatedTokens), 'Avg est. tokens'),
    ].join('');
  }

  function renderDashboardCard(data) {
    const o = data.overview || {};
    setText('chatTabsActive', o.activeTabs ?? 0);
    setText('chatTabsHandoff', o.handoffReadyTabs ?? 0);
    setText('chatTabsLowest', o.lowestScore ?? '—');
    setText('chatTabsTotal', o.totalTabs ?? 0);
    setText('chatTabsTokens', formatTokens(o.highestEstimatedTokens));

    const tokenTabs = (data.tabs || []).filter(tab => tab.presence !== 'archived' && tab.estimatedTokens != null);
    const liveTokenTabs = tokenTabs.filter(tab => tab.presence === 'active' || tab.presence === 'idle');
    const tokenTab = [...(liveTokenTabs.length ? liveTokenTabs : tokenTabs)]
      .sort((a,b) => Number(b.estimatedTokens || 0) - Number(a.estimatedTokens || 0))[0] || null;
    const tokenBudget = Number(data.settings?.tokenBudget || 128000);
    const tokenCount = tokenTab == null ? null : Number(tokenTab.estimatedTokens);
    const tokenPct = tokenCount == null || !Number.isFinite(tokenCount) || tokenBudget <= 0 ? null : Math.round((tokenCount / tokenBudget) * 1000) / 10;
    setText('overviewTokenCount', formatTokens(tokenCount));
    setText('overviewTokenBudget', '/ ' + formatTokens(tokenBudget));
    setText('overviewTokenPercent', tokenPct == null ? '—' : tokenPct + '%');
    setText('overviewTokenChat', tokenTab ? tabName(tokenTab) : 'Chưa có telemetry token từ tab ChatGPT');
    setText('overviewUserTokens', tokenTab ? formatTokens(tokenTab.estimatedUserTokens) : '—');
    setText('overviewAssistantTokens', tokenTab ? formatTokens(tokenTab.estimatedAssistantTokens) : '—');
    setText('overviewTextChars', tokenTab?.textChars == null ? '—' : Number(tokenTab.textChars).toLocaleString('vi-VN'));
    const tokenBar = $('overviewTokenBar');
    if (tokenBar) {
      const width = tokenPct == null ? 0 : Math.max(0, Math.min(100, tokenPct));
      tokenBar.style.width = width + '%';
      tokenBar.className = 'token-budget-fill ' + (tokenPct == null ? '' : tokenPct >= 90 ? 'critical' : tokenPct >= 75 ? 'warn' : '');
    }
    const tokenStatus = $('overviewTokenStatus');
    if (tokenStatus) {
      tokenStatus.className = tokenPct == null ? '' : tokenPct >= 90 ? 'critical' : tokenPct >= 75 ? 'warn' : 'good';
      tokenStatus.textContent = tokenPct == null ? 'Đang chờ sensor' : tokenPct >= 90 ? 'Context gần đầy' : tokenPct >= 75 ? 'Nên chuẩn bị handoff' : 'Context ổn định';
    }

    const state = $('chatTabsCardState');
    if (state) {
      const ready = Number(o.handoffReadyTabs || 0);
      const low = Number(o.lowestScore);
      state.className = `recommendation ${ready > 0 || (Number.isFinite(low) && low < 65) ? 'warn' : 'neutral'}`;
      state.innerHTML = ready > 0
        ? `<strong>${ready} tab đã sẵn sàng handoff</strong><p>Mở Multi-Tab Monitor để xử lý đúng tab, không ảnh hưởng các tab khác.</p>`
        : Number.isFinite(low)
          ? `<strong>Lowest score: ${esc(low)}/100</strong><p>Mỗi tab được theo dõi bằng baseline và history riêng.</p>`
          : '<strong>Chưa có tab ChatGPT</strong><p>Mở hoặc reload một tab ChatGPT có sensor để bắt đầu theo dõi.</p>';
    }
    const list = $('chatWorstList');
    if (list) {
      const candidates = [...(data.tabs || [])]
        .filter(t => t.presence !== 'archived')
        .sort((a,b) => Number(b.automation?.handoffReady) - Number(a.automation?.handoffReady) || a.score - b.score)
        .slice(0,3);
      list.innerHTML = candidates.length ? candidates.map(tab => `<button class="worst-tab-row" data-dashboard-tab="${esc(tab.tabKey)}"><span><strong>${esc(tabName(tab))}</strong><small>${esc(tab.presence)} · ${esc(relativeTime(tab.lastSeenAt))}</small></span><b class="score-pill score-${esc(scoreClass(tab.score))}">${esc(tab.score)}</b></button>`).join('') : '<p>Chưa có dữ liệu tab.</p>';
      list.querySelectorAll('[data-dashboard-tab]').forEach(button => button.onclick = () => { selectedTabKey = button.dataset.dashboardTab; gotoTab('chat-health'); void loadMulti(false); });
    }
  }

  function tabMatchesFilter(tab, filter) {
    if (filter === 'all') return true;
    if (filter === 'active') return tab.presence === 'active';
    if (filter === 'ready') return !!tab.automation?.handoffReady;
    return tab.level === filter;
  }

  function sortedTabs() {
    const filter = $('chatTabFilter')?.value || 'all';
    const sort = $('chatTabSort')?.value || 'recent';
    const rows = (payload.tabs || []).filter(tab => tabMatchesFilter(tab, filter));
    return rows.sort((a,b) => {
      if (sort === 'recent') return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
      if (sort === 'turns') return Number(b.turns || 0) - Number(a.turns || 0);
      if (sort === 'heap') return Number(b.heapMb || 0) - Number(a.heapMb || 0);
      if (sort === 'tokens') return Number(b.estimatedTokens || 0) - Number(a.estimatedTokens || 0);
      return Number(b.automation?.handoffReady) - Number(a.automation?.handoffReady) || a.score - b.score;
    });
  }

  function renderTabsTable() {
    const body = $('chatTabsBody');
    if (!body) return;
    const rows = sortedTabs();
    body.innerHTML = rows.length ? rows.map(tab => `<tr class="chat-tab-row ${tab.tabKey === selectedTabKey ? 'selected' : ''} ${tab.presence === 'stale' ? 'stale-row' : ''}" data-tab-key="${esc(tab.tabKey)}">
      <td><strong>${esc(tabName(tab))}</strong><div class="path">tab ${esc(tab.tabId ?? '—')} · ${esc(shortId(tab.conversationId))}</div></td>
      <td><span class="score-pill score-${esc(scoreClass(tab.score))}">${esc(tab.score)}</span></td>
      <td><span class="mini-status ${tab.level === 'healthy' ? 'ok' : tab.level === 'growing' ? 'warn' : tab.level === 'handoff' ? 'orange' : 'bad'}">${esc(statusLabel(tab.level))}</span></td>
      <td><span class="presence presence-${esc(tab.presence)}">${esc(tab.presence)}</span></td>
      <td>${esc(tab.turns ?? '—')}</td>
      <td>${esc(formatTokens(tab.estimatedTokens))}</td>
      <td>${esc(metricValue(tab.heapMb, ' MB'))}</td>
      <td>${esc(metricValue(tab.fps, ''))}</td>
      <td>${esc(relativeTime(tab.lastSeenAt))}</td>
      <td>${tab.automation?.handoffReady ? '<span class="mini-status bad">Ready</span>' : tab.automation?.due ? '<span class="mini-status orange">Due</span>' : '<span class="mini-status">No</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="10">Không có tab phù hợp bộ lọc.</td></tr>';
    body.querySelectorAll('[data-tab-key]').forEach(row => row.onclick = () => { selectedTabKey = row.dataset.tabKey; renderTabsTable(); void loadSelected(); });
  }

  function renderHandoffQueue() {
    const el = $('handoffQueue');
    if (!el) return;
    const threshold = Number(payload.settings?.handoffThreshold ?? 65);
    const queue = (payload.tabs || []).filter(tab => tab.automation?.handoffReady || tab.score < threshold).sort((a,b) => Number(b.automation?.handoffReady) - Number(a.automation?.handoffReady) || a.score - b.score);
    el.innerHTML = queue.length ? queue.map(tab => `<button class="handoff-queue-item" data-queue-tab="${esc(tab.tabKey)}"><span><strong>${esc(tabName(tab))}</strong><small>${esc(tab.automation?.handoffReady ? `Checkpoint #${tab.automation.checkpointSequence || '?'}` : `Score ${tab.score} · streak ${tab.automation?.streak || 0}/${tab.automation?.requiredStreak || 0}`)}</small></span><span class="mini-status ${tab.automation?.handoffReady ? 'bad' : 'orange'}">${tab.automation?.handoffReady ? 'Handoff ready' : 'Watch'}</span></button>`).join('') : '<p>Chưa có tab cần handoff.</p>';
    el.querySelectorAll('[data-queue-tab]').forEach(button => button.onclick = () => { selectedTabKey = button.dataset.queueTab; renderTabsTable(); void loadSelected(); });
  }

  function renderSettings(settings) {
    if (!settings) return;
    if ($('autoCheckpointEnabled')) $('autoCheckpointEnabled').checked = !!settings.autoCheckpointEnabled;
    for (const [id,key] of [['handoffThreshold','handoffThreshold'],['requiredStreak','requiredStreak'],['cooldownMinutes','cooldownMinutes'],['historyDays','historyDays'],['activeSeconds','activeSeconds'],['staleMinutes','staleMinutes'],['tokenBudget','tokenBudget']]) if ($(id)) $(id).value = settings[key];
  }

  function renderAutomation(a) {
    const badge = $('autoHandoffBadge'), state = $('autoHandoffState'), ack = $('ackHandoff');
    if (!a) {
      if (badge) { badge.className='badge neutral'; badge.textContent='Monitoring'; }
      if (state) state.textContent='Chưa chọn tab.';
      if (ack) ack.disabled=true;
      return;
    }
    if (badge) { badge.className=`badge ${a.handoffReady?'bad':a.due?'warn':''}`; badge.textContent=a.handoffReady?'Handoff ready':a.due?'Checkpoint due':a.autoCheckpointEnabled?'Auto ON':'Auto OFF'; }
    if (state) state.innerHTML=`<strong>${a.handoffReady?'Đã chuẩn bị handoff':'Đang theo dõi riêng tab này'}</strong><p>Threshold ${esc(a.handoffThreshold)} · streak ${esc(a.streak)}/${esc(a.requiredStreak)}${a.checkpointSequence?` · checkpoint #${esc(a.checkpointSequence)}`:''}</p><p>${esc(a.reason||'')}</p>`;
    if (ack) ack.disabled=!a.handoffReady;
  }

  function renderSelected(tab) {
    selectedTab = tab;
    const has = !!tab;
    setText('selectedTabTitle', has ? tabName(tab) : 'Chưa chọn tab');
    setText('selectedTabMeta', has ? `tab ${tab.tabId ?? '—'} · window ${tab.windowId ?? '—'} · ${shortId(tab.conversationId)}` : '—');
    const presence = $('selectedTabPresence');
    if (presence) { presence.className=`badge ${has && tab.presence==='active'?'':'neutral'}`; presence.textContent=has?tab.presence:'—'; }
    setText('selectedTabScore', has ? tab.score : '—');
    setText('selectedTabState', has ? statusLabel(tab.level) : 'Chưa có telemetry');
    setText('selectedTabHint', has ? tab.recommendation : 'Chọn một tab để xem chi tiết.');
    const ring=$('selectedTabScoreRing'); if(ring){ ring.className=`score-ring ${has?scoreClass(tab.score):''}`; ring.style.setProperty('--score-angle',`${has?tab.score*3.6:0}deg`); }
    const metrics=$('selectedTabMetrics'); if(metrics) metrics.innerHTML=has?[
      `<div><small>Turns</small><strong>${esc(tab.turns??'—')}</strong></div>`,
      `<div><small>INP</small><strong>${esc(metricValue(tab.inpMs,' ms'))}</strong></div>`,
      `<div><small>FPS</small><strong>${esc(tab.fps??'—')}</strong></div>`,
      `<div><small>JS Heap</small><strong>${esc(metricValue(tab.heapMb,' MB'))}</strong></div>`,
      `<div><small>Long tasks</small><strong>${esc(metricValue(tab.longTasksPerMin,'/min'))}</strong></div>`,
      `<div><small>Session</small><strong>${esc(metricValue(tab.sessionMinutes,'m'))}</strong></div>`,
      `<div><small>Context tokens (est.)</small><strong>${esc(formatTokens(tab.estimatedTokens))}</strong></div>`,
      `<div><small>User tokens (est.)</small><strong>${esc(formatTokens(tab.estimatedUserTokens))}</strong></div>`,
      `<div><small>Assistant tokens (est.)</small><strong>${esc(formatTokens(tab.estimatedAssistantTokens))}</strong></div>`,
      `<div><small>Budget used</small><strong>${esc(tokenUsagePct(tab) == null ? '—' : tokenUsagePct(tab) + '%')}</strong></div>`
    ].join(''):'';
    const telemetry=$('selectedTabTelemetry'); if(telemetry) telemetry.innerHTML=has?`<div><strong>Tab key:</strong> <span class="path">${esc(tab.tabKey)}</span></div><div><strong>DOM:</strong> ${esc(tab.domNodes??'—')} nodes</div><div><strong>Token estimate:</strong> ${esc(formatTokens(tab.estimatedTokens))} / ${esc(formatTokens(payload.settings?.tokenBudget))} (${esc(tokenUsagePct(tab) == null ? '—' : tokenUsagePct(tab) + '%')})</div><div><strong>Estimator:</strong> ${esc(tab.tokenEstimateMethod || 'not reported')}</div><div><strong>Visible text:</strong> ${esc(tab.textChars == null ? '—' : Number(tab.textChars).toLocaleString('vi-VN'))} chars</div><div><strong>Baseline:</strong> ${tab.baselineReady?'Ready':`${esc(tab.baselineSamples)}/6 samples`}</div><div><strong>First seen:</strong> ${esc(relativeTime(tab.firstSeenAt))}</div><div><strong>Last seen:</strong> ${esc(relativeTime(tab.lastSeenAt))}</div>`:'';
    renderAutomation(tab?.automation);
    if ($('archiveChatTab')) $('archiveChatTab').disabled=!has;
  }

  function series(samples,key){ return (samples||[]).map((row,i)=>({x:i,y:Number(row[key])})).filter(p=>Number.isFinite(p.y)); }
  function lineSvg(points,minY,maxY,threshold=null){ if(points.length<2)return''; const w=600,h=150,p=10,span=Math.max(1,maxY-minY); const coords=points.map((pt,i)=>{const x=p+(i/Math.max(1,points.length-1))*(w-2*p);const y=h-p-((pt.y-minY)/span)*(h-2*p);return`${x.toFixed(1)},${Math.max(p,Math.min(h-p,y)).toFixed(1)}`}).join(' '); let thresholdLine=''; if(threshold!=null){const y=h-p-((threshold-minY)/span)*(h-2*p);thresholdLine=`<line class="chart-threshold" x1="${p}" y1="${y.toFixed(1)}" x2="${w-p}" y2="${y.toFixed(1)}"/>`;} return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line class="chart-grid" x1="${p}" y1="${h-p}" x2="${w-p}" y2="${h-p}"/>${thresholdLine}<polyline class="chart-line" points="${coords}" fill="none"/></svg>`; }
  function renderChart(id,points,options={}){const el=$(id);if(!el)return;if(points.length<2){el.className='history-chart empty';el.textContent='Đang tích lũy dữ liệu...';return;}const vals=points.map(p=>p.y);const min=options.min??Math.min(...vals);let max=options.max??Math.max(...vals);if(max<=min)max=min+1;el.className='history-chart';el.innerHTML=lineSvg(points,min,max,options.threshold??null);}
  function renderHistory(r){ selectedHistory=r; const samples=r?.samples||[],settings=r?.settings||payload.settings||{};const scores=series(samples,'score'),fps=series(samples,'fps'),heap=series(samples,'heapMb'),tokens=series(samples,'estimatedTokens');renderChart('scoreHistoryChart',scores,{min:0,max:100,threshold:Number(settings.handoffThreshold||65)});renderChart('fpsHistoryChart',fps,{min:0,max:Math.max(60,...fps.map(p=>p.y))});renderChart('heapHistoryChart',heap,{min:0,max:Math.max(256,...heap.map(p=>p.y))*1.1});renderChart('tokenHistoryChart',tokens,{min:0,max:Math.max(Number(settings.tokenBudget||128000),...tokens.map(p=>p.y))*1.05,threshold:Number(settings.tokenBudget||128000)});const latest=samples.at(-1);setText('historyScoreSummary',latest?`${latest.score}/100`:'—');setText('historyFpsSummary',latest?.fps!=null?`${Math.round(latest.fps*10)/10} FPS`:'—');setText('historyHeapSummary',latest?.heapMb!=null?`${Math.round(latest.heapMb*10)/10} MB`:'—');setText('historyTokenSummary',latest?.estimatedTokens!=null?`${formatTokens(latest.estimatedTokens)} est.`:'—');const sum=r?.summary;setText('chatHistorySummary',sum?`${sum.count} mẫu · avg ${sum.avgScore} · min ${sum.minScore} · max ${sum.maxScore}`:'Chưa có lịch sử'); }

  function mergeLiveTab(tab) {
    if (!tab?.tabKey) return;
    const index = (payload.tabs || []).findIndex(item => item.tabKey === tab.tabKey);
    if (index >= 0) payload.tabs[index] = { ...payload.tabs[index], ...tab };
    else payload.tabs = [tab, ...(payload.tabs || [])];
  }

  function renderLiveTelemetry(message) {
    if (message?.overview) payload.overview = message.overview;
    if (message?.settings) payload.settings = message.settings;
    if (message?.tab) mergeLiveTab(message.tab);
    renderDashboardCard(payload);
    if (message?.tab?.estimatedTokens != null) {
      const tab = message.tab;
      const budget = Number(message.settings?.tokenBudget || payload.settings?.tokenBudget || 128000);
      const tokens = Number(tab.estimatedTokens);
      const pct = Number.isFinite(tokens) && budget > 0 ? Math.round((tokens / budget) * 1000) / 10 : null;
      setText('overviewTokenCount', formatTokens(tokens));
      setText('overviewTokenBudget', '/ ' + formatTokens(budget));
      setText('overviewTokenPercent', pct == null ? '—' : pct + '%');
      setText('overviewTokenChat', tabName(tab));
      setText('overviewUserTokens', formatTokens(tab.estimatedUserTokens));
      setText('overviewAssistantTokens', formatTokens(tab.estimatedAssistantTokens));
      setText('overviewTextChars', tab.textChars == null ? '—' : Number(tab.textChars).toLocaleString('vi-VN'));
      const bar = $('overviewTokenBar');
      if (bar) {
        bar.style.width = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + '%';
        bar.className = 'token-budget-fill ' + (pct == null ? '' : pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : '');
      }
      const status = $('overviewTokenStatus');
      if (status) {
        status.className = pct == null ? '' : pct >= 90 ? 'critical' : pct >= 75 ? 'warn' : 'good';
        status.textContent = pct == null ? 'Đang chờ sensor' : pct >= 90 ? 'Context gần đầy' : pct >= 75 ? 'Nên chuẩn bị handoff' : 'Context ổn định';
      }
      const badge = $('overviewTokenLive');
      if (badge) badge.title = 'SSE event ' + (message.at || '');
    }
    if ($('multiTabOverviewMetrics')) $('multiTabOverviewMetrics').innerHTML = overviewMetrics(payload.overview || {});
    if ($('chatTabsBody')) renderTabsTable();
    if ($('handoffQueue')) renderHandoffQueue();
    if (message?.tab?.tabKey && message.tab.tabKey === selectedTabKey) renderSelected(message.tab);
    const badge = $('overviewTokenLive');
    if (badge) { badge.textContent = 'LIVE'; badge.classList.add('connected'); }
  }

  function connectRealtimeStream() {
    if (!('EventSource' in window)) return;
    if (liveStream) liveStream.close();
    liveStream = new EventSource('/api/chat-health/stream');
    liveStream.addEventListener('telemetry', event => {
      try { renderLiveTelemetry(JSON.parse(event.data)); } catch {}
    });
    liveStream.onopen = () => {
      const badge = $('overviewTokenLive');
      if (badge) { badge.textContent = 'LIVE'; badge.classList.add('connected'); }
    };
    liveStream.onerror = () => {
      const badge = $('overviewTokenLive');
      if (badge) { badge.textContent = 'RECONNECTING'; badge.classList.remove('connected'); }
      liveStream?.close();
      liveStream = null;
      clearTimeout(liveReconnectTimer);
      liveReconnectTimer = setTimeout(connectRealtimeStream, 1500);
    };
  }

  async function pollRealtimeToken() {
    if (realtimePollInFlight) return;
    realtimePollInFlight = true;
    try {
      const next = await json('/api/chat-health/tabs');
      payload.overview = next.overview || payload.overview || {};
      payload.settings = next.settings || payload.settings || {};
      payload.tabs = next.tabs || payload.tabs || [];
      renderDashboardCard(payload);
      const badge = $('overviewTokenLive');
      if (badge) {
        badge.textContent = 'LIVE · 250ms';
        badge.classList.add('connected');
        badge.title = 'Token snapshot refresh every 250 ms; SSE push remains enabled when available.';
      }
    } catch {
      const badge = $('overviewTokenLive');
      if (badge && !liveStream) {
        badge.textContent = 'RECONNECTING';
        badge.classList.remove('connected');
      }
    } finally {
      realtimePollInFlight = false;
    }
  }

  async function loadSelected(){
    if(!selectedTabKey){renderSelected(null);renderHistory(null);return;}
    try{
      const [tab,history]=await Promise.all([json(`/api/chat-health/tabs/${encodeURIComponent(selectedTabKey)}`),json(`/api/chat-health/tabs/${encodeURIComponent(selectedTabKey)}/history?limit=360`)]);
      renderSelected(tab);renderHistory(history);
    }catch(error){toast(error.message);}
  }

  async function loadMulti(showToast=false){
    try{
      payload=await json('/api/chat-health/tabs');
      const keys=new Set((payload.tabs||[]).map(t=>t.tabKey));
      if(!selectedTabKey||!keys.has(selectedTabKey)) selectedTabKey=payload.overview?.worstTabKey || payload.tabs?.[0]?.tabKey || null;
      setText('chatSensorBadge',payload.overview?.totalTabs?`Tracking ${payload.overview.totalTabs} tab${payload.overview.totalTabs===1?'':'s'}`:'Sensor chưa có tab');
      if($('multiTabOverviewMetrics'))$('multiTabOverviewMetrics').innerHTML=overviewMetrics(payload.overview);
      renderDashboardCard(payload);renderSettings(payload.settings);renderTabsTable();renderHandoffQueue();await loadSelected();
      if(showToast)toast(`Đã cập nhật ${payload.overview?.totalTabs||0} tab ChatGPT`);
    }catch(error){if(showToast)toast(error.message);}
  }

  async function saveSettings(){try{const body={autoCheckpointEnabled:!!$('autoCheckpointEnabled')?.checked,handoffThreshold:Number($('handoffThreshold')?.value),requiredStreak:Number($('requiredStreak')?.value),cooldownMinutes:Number($('cooldownMinutes')?.value),historyDays:Number($('historyDays')?.value),activeSeconds:Number($('activeSeconds')?.value),staleMinutes:Number($('staleMinutes')?.value),tokenBudget:Number($('tokenBudget')?.value)};await json('/api/chat-health/settings',{method:'PATCH',body:JSON.stringify(body)});toast('Đã lưu Multi-Tab Chat Health settings');await loadMulti();}catch(error){toast(error.message)}}
  async function acknowledge(){if(!selectedTabKey)return;try{await json(`/api/chat-health/tabs/${encodeURIComponent(selectedTabKey)}/handoff/ack`,{method:'POST',body:'{}'});toast('Đã đánh dấu handoff cho đúng tab');await loadMulti();}catch(error){toast(error.message)}}
  async function archive(){if(!selectedTabKey)return;const target=selectedTabKey;try{await json(`/api/chat-health/tabs/${encodeURIComponent(target)}/archive`,{method:'POST',body:'{}'});toast('Đã archive tab khỏi monitor');selectedTabKey=null;await loadMulti();}catch(error){toast(error.message)}}

  if($('chatTabFilter'))$('chatTabFilter').onchange=renderTabsTable;
  if($('chatTabSort'))$('chatTabSort').onchange=renderTabsTable;
  if($('saveChatHealthSettings'))$('saveChatHealthSettings').onclick=saveSettings;
  if($('ackHandoff'))$('ackHandoff').onclick=acknowledge;
  if($('archiveChatTab'))$('archiveChatTab').onclick=archive;
  window.loadChatHealth=loadMulti;
  connectRealtimeStream();
  setTimeout(()=>loadMulti(false),300);
  setTimeout(()=>pollRealtimeToken(),150);
  setInterval(()=>pollRealtimeToken(),250);
  setInterval(()=>loadMulti(false),10000);
})();
