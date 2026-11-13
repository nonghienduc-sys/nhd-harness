(() => {
  const SENSOR_VERSION = '0.2.7';
  const markerRoot = document.documentElement;
  if (markerRoot?.dataset?.nhdChatHealthSensorVersion === SENSOR_VERSION) return;
  if (markerRoot?.dataset) markerRoot.dataset.nhdChatHealthSensorVersion = SENSOR_VERSION;

  const SAMPLE_INTERVAL_MS = 30000;
  const REALTIME_DEBOUNCE_MS = 200;
  const WINDOW_MS = 60000;
  let currentKey = location.pathname;
  let sessionStartedAt = Date.now();
  let frameTimes = [];
  let longTaskTimes = [];
  let interactions = [];
  let realtimeTimer = null;
  let reportInFlight = false;
  let pendingRealtimeReport = false;
  let pendingReportMode = null;
  let lastRealtimeSignature = '';
  const sentMessageFingerprints = new Map();

  const now = () => performance.now();
  const trim = (items, cutoff) => items.filter(item => item.at >= cutoff);

  function openRoots() {
    const roots = [document];
    for (let cursor = 0; cursor < roots.length; cursor += 1) {
      const root = roots[cursor];
      let elements = [];
      try { elements = [...root.querySelectorAll('*')]; } catch {}
      for (const element of elements) {
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
      }
    }
    return roots;
  }

  function deepQueryAll(selector) {
    const found = [];
    const seen = new Set();
    for (const root of openRoots()) {
      let matches = [];
      try { matches = [...root.querySelectorAll(selector)]; } catch {}
      for (const item of matches) {
        if (!seen.has(item)) { seen.add(item); found.push(item); }
      }
    }
    return found;
  }

  function resetForConversation() {
    currentKey = location.pathname;
    sessionStartedAt = Date.now();
    frameTimes = [];
    longTaskTimes = [];
    interactions = [];
  }

  function watchSpaNavigation() {
    setInterval(() => {
      if (location.pathname !== currentKey) {
        resetForConversation();
        scheduleRealtimeReport(0, 'delta');
      }
    }, 1000);
  }

  function watchFrames() {
    const tick = t => {
      if (document.visibilityState === 'visible') {
        frameTimes.push(t);
        const cutoff = t - WINDOW_MS;
        while (frameTimes.length && frameTimes[0] < cutoff) frameTimes.shift();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function watchLongTasks() {
    try {
      const observer = new PerformanceObserver(list => {
        const cutoff = now() - WINDOW_MS;
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50 && entry.startTime >= cutoff) {
            longTaskTimes.push({ at: entry.startTime, duration: entry.duration });
          }
        }
        longTaskTimes = trim(longTaskTimes, cutoff);
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {}
  }

  function watchInteractions() {
    try {
      const observer = new PerformanceObserver(list => {
        const cutoff = now() - WINDOW_MS * 5;
        for (const entry of list.getEntries()) {
          if (!entry.interactionId || entry.duration <= 0 || entry.startTime < cutoff) continue;
          interactions.push({ at: entry.startTime, id: entry.interactionId, duration: entry.duration });
        }
        interactions = trim(interactions, cutoff);
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch {}
  }

  function estimateInp() {
    const byInteraction = new Map();
    for (const item of interactions) {
      const previous = byInteraction.get(item.id) || 0;
      if (item.duration > previous) byInteraction.set(item.id, item.duration);
    }
    const values = [...byInteraction.values()].sort((a, b) => a - b);
    if (!values.length) return null;
    const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.98) - 1));
    return Math.round(values[index]);
  }

  function estimateFps() {
    if (frameTimes.length < 2) return null;
    const elapsed = frameTimes[frameTimes.length - 1] - frameTimes[0];
    if (elapsed <= 0) return null;
    return Math.round(((frameTimes.length - 1) * 1000 / elapsed) * 10) / 10;
  }

  function deepParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode?.();
    return root?.host || null;
  }

  function nearestTurnIdentity(node) {
    let cursor = node;
    for (let depth = 0; cursor && depth < 18; depth += 1) {
      const testId = String(cursor.getAttribute?.('data-testid') || '');
      if (testId.startsWith('conversation-turn-')) {
        const match = testId.match(/conversation-turn-(\d+)/);
        return { id: testId, ordinal: match ? Number(match[1]) : null };
      }
      const turnId = String(cursor.getAttribute?.('data-turn-id') || cursor.getAttribute?.('data-message-id') || '');
      if (turnId) return { id: turnId, ordinal: null };
      cursor = deepParent(cursor);
    }
    return null;
  }

  function cleanMessageText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function actionName(node) {
    return String(
      node?.getAttribute?.('aria-label') ||
      node?.getAttribute?.('title') ||
      node?.getAttribute?.('data-testid') ||
      node?.innerText ||
      ''
    ).trim();
  }

  function textFingerprint(role, content) {
    const input = `${role}\u241f${content}`;
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function normalizeAnchoredContent(role, value) {
    let content = cleanMessageText(value);
    if (role === 'assistant') {
      const markers = ['ChatGPT said:', 'ChatGPT ?? n?i:'];
      let cut = -1;
      let markerLength = 0;
      for (const marker of markers) {
        const index = content.lastIndexOf(marker);
        if (index > cut) { cut = index; markerLength = marker.length; }
      }
      if (cut >= 0) content = content.slice(cut + markerLength).trim();
      content = content.replace(/^Worked for\s+[^\n]+\n?/i, '').trim();
    } else if (role === 'user') {
      const marker = 'You said:';
      if (content.startsWith(marker)) content = content.slice(marker.length).trim();
      const worked = content.search(/\nWorked for\s+/i);
      if (worked >= 0) content = content.slice(0, worked).trim();
      const assistantMarker = content.indexOf('\nChatGPT said:');
      if (assistantMarker >= 0) content = content.slice(0, assistantMarker).trim();
    }
    return content
      .replace(/^Copy message\s*/i, '')
      .replace(/^Copy\s*/i, '')
      .replace(/\s*Copy message$/i, '')
      .replace(/\s*Copy$/i, '')
      .trim();
  }

  function messageContainerFromAction(button) {
    let node = button;
    for (let depth = 0; depth < 14; depth += 1) {
      node = deepParent(node);
      if (!node) break;
      const text = cleanMessageText(node.innerText || node.textContent || '');
      if (text.length >= 2 && text.length <= 50000) {
        const childButtons = [...node.querySelectorAll?.('button') || []];
        const actionButtons = childButtons.filter(item => {
          const name = actionName(item).toLowerCase();
          return name === 'copy' || name === 'copy message';
        });
        if (actionButtons.length >= 1) return { node, text };
      }
    }
    return null;
  }

  function actionAnchoredMessages() {
    const buttons = deepQueryAll('button,[role="button"]');
    const candidates = [];
    const seen = new Set();
    for (const button of buttons) {
      const name = actionName(button).toLowerCase();
      let role = null;
      if (name === 'copy message') role = 'user';
      else if (name === 'copy') role = 'assistant';
      if (!role) continue;
      const found = messageContainerFromAction(button);
      if (!found?.text) continue;
      const content = normalizeAnchoredContent(role, found.text);
      if (!content) continue;
      const turn = nearestTurnIdentity(button) || nearestTurnIdentity(found.node);
      const keyBase = turn?.id
        ? `turn:${turn.id}:${role}`
        : `anchor:${role}:${textFingerprint(role, content)}`;
      if (seen.has(keyBase)) continue;
      seen.add(keyBase);
      const rect = found.node.getBoundingClientRect?.();
      candidates.push({
        key: keyBase.slice(0, 500),
        role,
        content: content.slice(0, 20000),
        turnOrdinal: Number.isFinite(turn?.ordinal) ? turn.ordinal : null,
        top: Number.isFinite(rect?.top) ? rect.top : candidates.length
      });
    }
    candidates.sort((a, b) => {
      if (Number.isFinite(a.turnOrdinal) && Number.isFinite(b.turnOrdinal)) return a.turnOrdinal - b.turnOrdinal;
      if (Number.isFinite(a.turnOrdinal)) return -1;
      if (Number.isFinite(b.turnOrdinal)) return 1;
      return a.top - b.top;
    });
    return candidates.map((item, index) => ({
      key: item.key,
      ordinal: Number.isFinite(item.turnOrdinal) ? item.turnOrdinal : index,
      role: item.role,
      content: item.content
    }));
  }

  function legacyConversationElements() {
    const primary = deepQueryAll('[data-testid^="conversation-turn-"]');
    if (primary.length) return primary;
    return deepQueryAll('[data-message-author-role]');
  }

  function legacyRoleForNode(node) {
    const roleNode = node?.matches?.('[data-message-author-role]') ? node : node?.querySelector?.('[data-message-author-role]');
    const role = String(roleNode?.getAttribute?.('data-message-author-role') || '').toLowerCase();
    return role === 'user' || role === 'assistant' ? { role, roleNode } : null;
  }

  function countTurns() {
    const legacy = legacyConversationElements();
    if (legacy.length) return legacy.length;
    const anchored = actionAnchoredMessages();
    return anchored.length || null;
  }

  function heapMb() {
    const memory = performance.memory;
    if (!memory || !Number.isFinite(memory.usedJSHeapSize)) return null;
    return Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10;
  }

  function estimateTokensFromText(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const cjkMatches = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g);
    const cjkChars = cjkMatches ? cjkMatches.length : 0;
    const remainingChars = Math.max(0, text.length - cjkChars);
    return Math.max(1, Math.round((remainingChars / 4) + (cjkChars * 0.75)));
  }

  function conversationTokenStats() {
    const legacy = legacyConversationElements();
    const hasLegacyRoles = legacy.some(node => legacyRoleForNode(node));
    const anchored = hasLegacyRoles ? [] : actionAnchoredMessages();
    let estimatedTokens = 0;
    let estimatedUserTokens = 0;
    let estimatedAssistantTokens = 0;
    let textChars = 0;

    if (anchored.length) {
      for (const item of anchored) {
        const tokens = estimateTokensFromText(item.content);
        estimatedTokens += tokens;
        textChars += item.content.length;
        if (item.role === 'user') estimatedUserTokens += tokens;
        else if (item.role === 'assistant') estimatedAssistantTokens += tokens;
      }
    } else {
      for (const node of legacy) {
        const value = cleanMessageText(node.innerText || node.textContent || '');
        if (!value) continue;
        const tokens = estimateTokensFromText(value);
        estimatedTokens += tokens;
        textChars += value.length;
        const legacyRole = legacyRoleForNode(node);
        if (legacyRole?.role === 'user') estimatedUserTokens += tokens;
        else if (legacyRole?.role === 'assistant') estimatedAssistantTokens += tokens;
      }
    }

    return {
      estimatedTokens,
      estimatedUserTokens,
      estimatedAssistantTokens,
      textChars,
      tokenEstimateMethod: anchored.length ? 'local-action-anchor-v2' : 'local-visible-text-v1'
    };
  }

  function visibleConversationMessages() {
    const legacy = legacyConversationElements();
    if (!legacy.length) return actionAnchoredMessages();
    const candidates = [];
    for (let index = 0; index < legacy.length; index += 1) {
      const node = legacy[index];
      const legacyRole = legacyRoleForNode(node);
      if (!legacyRole) continue;
      const { role, roleNode } = legacyRole;
      const content = cleanMessageText(roleNode?.innerText || roleNode?.textContent || node.innerText || node.textContent || '').slice(0, 20000);
      if (!content) continue;
      const key = String(node.getAttribute?.('data-testid') || roleNode?.getAttribute?.('data-message-id') || `${index}:${role}`).slice(0, 500);
      candidates.push({ key, ordinal: index, role, content });
    }
    if (!candidates.length) return actionAnchoredMessages();
    const selected = [];
    let budget = 4_500_000;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const item = candidates[i];
      if (item.content.length > budget && selected.length) break;
      const content = item.content.slice(Math.max(0, item.content.length - budget));
      selected.push({ ...item, content });
      budget -= content.length;
      if (budget <= 0) break;
    }
    return selected.reverse();
  }

  function collectJournalDelta(full = false) {
    const messages = visibleConversationMessages();
    const changed = [];
    const fingerprints = [];
    for (const item of messages) {
      const fingerprint = textFingerprint(item.role, item.content);
      if (full || sentMessageFingerprints.get(item.key) !== fingerprint) changed.push(item);
      fingerprints.push([item.key, fingerprint]);
    }
    return { messages: changed, fingerprints };
  }

  function mergeReportMode(current, incoming) {
    const rank = { telemetry: 0, delta: 1, full: 2 };
    if (!current) return incoming;
    return rank[incoming] > rank[current] ? incoming : current;
  }

  function collect(includeMessages = false, allowHidden = false) {
    if (!allowHidden && document.visibilityState !== 'visible') return null;
    const stamp = now();
    longTaskTimes = trim(longTaskTimes, stamp - WINDOW_MS);
    interactions = trim(interactions, stamp - WINDOW_MS * 5);
    const tokenStats = conversationTokenStats();

    const chatFocused = document.hasFocus();
    const payload = {
      conversationId: location.pathname || '/',
      pagePath: location.pathname || '/',
      turns: countTurns(),
      domNodes: document.getElementsByTagName('*').length,
      longTasksPerMin: longTaskTimes.length,
      sessionMinutes: Math.round(((Date.now() - sessionStartedAt) / 60000) * 10) / 10,
      chatFocused,
      ...(includeMessages && chatFocused ? { visibleMessages: visibleConversationMessages() } : {}),
      ...tokenStats
    };

    const inp = estimateInp();
    const fps = estimateFps();
    const heap = heapMb();
    if (inp != null) payload.inpMs = inp;
    if (fps != null) payload.fps = fps;
    if (heap != null) payload.heapMb = heap;
    return payload;
  }

  function realtimeSignature(payload) {
    return [
      payload.conversationId,
      payload.turns,
      payload.estimatedTokens,
      payload.estimatedUserTokens,
      payload.estimatedAssistantTokens,
      payload.textChars
    ].join('|');
  }

  async function report(mode = 'telemetry') {
    const full = mode === 'full';
    const payload = collect(false, full);
    if (!payload) return;
    let journal = null;
    if (mode === 'delta' || full) {
      journal = collectJournalDelta(full);
      payload.visibleMessages = journal.messages;
      payload.journalMode = mode;
      payload.journalFlushComplete = full;
      if (full) payload.chatFocused = true;
    }
    const signature = realtimeSignature(payload);
    if (mode === 'telemetry' && signature === lastRealtimeSignature) return;
    if (reportInFlight) {
      pendingRealtimeReport = true;
      pendingReportMode = mergeReportMode(pendingReportMode, mode);
      return;
    }
    reportInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'NHD_CHAT_HEALTH_REPORT', payload });
      if (response?.ok) {
        lastRealtimeSignature = signature;
        if (journal) for (const [key, fingerprint] of journal.fingerprints) sentMessageFingerprints.set(key, fingerprint);
        if (response.flushRequested && !full) {
          pendingRealtimeReport = true;
          pendingReportMode = 'full';
        }
      }
    } catch {}
    finally {
      reportInFlight = false;
      if (pendingRealtimeReport) {
        const nextMode = pendingReportMode || 'delta';
        pendingRealtimeReport = false;
        pendingReportMode = null;
        scheduleRealtimeReport(0, nextMode);
      }
    }
  }

  function scheduleRealtimeReport(delay = REALTIME_DEBOUNCE_MS, mode = 'delta') {
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(() => { void report(mode); }, Math.max(0, delay));
  }

  function mutationTouchesConversation(mutation) {
    const element = mutation.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target?.parentElement;
    if (element?.closest?.('[data-testid^="conversation-turn-"], [data-message-author-role]')) return true;
    for (const node of mutation.addedNodes || []) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches?.('[data-testid^="conversation-turn-"], [data-message-author-role]')) return true;
      if (node.querySelector?.('[data-testid^="conversation-turn-"], [data-message-author-role]')) return true;
    }
    return false;
  }

  function watchConversationChanges() {
    const callback = mutations => {
      if (document.visibilityState !== 'visible') return;
      if (mutations.some(mutationTouchesConversation)) scheduleRealtimeReport();
    };
    const observed = new WeakSet();
    const attach = () => {
      for (const root of openRoots()) {
        const target = root === document ? document.documentElement : root;
        if (!target || observed.has(target)) continue;
        try {
          const observer = new MutationObserver(callback);
          observer.observe(target, { subtree: true, childList: true, characterData: true });
          observed.add(target);
        } catch {}
      }
    };
    attach();
    setInterval(attach, 2000);
  }

  function watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleRealtimeReport(0, 'delta');
      else void report('full');
    });
    window.addEventListener('pagehide', () => { void report('full'); });
  }

  watchSpaNavigation();
  watchFrames();
  watchLongTasks();
  watchInteractions();
  watchConversationChanges();
  watchVisibility();
  setTimeout(() => { void report('full'); }, 1000);
  setInterval(() => { void report('telemetry'); }, SAMPLE_INTERVAL_MS);
})();
