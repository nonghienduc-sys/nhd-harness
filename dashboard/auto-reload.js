(function () {
  'use strict';

  const CHECK_INTERVAL_MS = 60000;
  const FETCH_TIMEOUT_MS = 5000;
  const STORAGE_KEY = 'nhdAutoReload';
  const RELOAD_WINDOW_MS = 5 * 60 * 1000;
  const MAX_RELOADS_IN_WINDOW = 3;
  const HEADER_URL = '/';
  const VERSION_URL = '/api/health/live';
  const RELOAD_MESSAGE = '[auto-reload] dashboard/backend đổi phiên bản, tải lại';

  let baselineHeader = '';
  let baselineVersion = '';
  let initialized = false;
  let busy = false;
  let timerId = null;

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      const init = Object.assign({}, options || {}, {
        cache: 'no-store',
        signal: controller.signal
      });
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readHeaderStamp() {
    try {
      const res = await fetchWithTimeout(HEADER_URL, { method: 'HEAD' });
      if (!res) return '';
      const etag = res.headers.get('ETag');
      if (etag && etag.trim()) return 'etag:' + etag.trim();
      const lastModified = res.headers.get('Last-Modified');
      if (lastModified && lastModified.trim()) return 'lm:' + lastModified.trim();
      return '';
    } catch (err) {
      return '';
    }
  }

  async function readLiveVersion() {
    try {
      const res = await fetchWithTimeout(VERSION_URL, { method: 'GET' });
      if (!res || !res.ok) return '';
      const data = await res.json();
      if (!data) return '';
      const value = data.version;
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'number' && isFinite(value)) return String(value);
      return '';
    } catch (err) {
      return '';
    }
  }

  function readReloadLog() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (t) {
        return typeof t === 'number' && isFinite(t);
      });
    } catch (err) {
      return [];
    }
  }

  function writeReloadLog(list) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      /* sessionStorage không dùng được: bỏ qua */
    }
  }

  function recentReloads() {
    const now = Date.now();
    return readReloadLog().filter(function (t) {
      return now - t >= 0 && now - t < RELOAD_WINDOW_MS;
    });
  }

  function reloadBudgetLeft() {
    return recentReloads().length < MAX_RELOADS_IN_WINDOW;
  }

  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.isContentEditable === true;
  }

  function reloadNow() {
    if (isTyping()) return false;
    if (!reloadBudgetLeft()) return false;
    const log = recentReloads();
    log.push(Date.now());
    writeReloadLog(log);
    console.info(RELOAD_MESSAGE);
    window.location.reload();
    return true;
  }

  async function checkForUpdate() {
    if (busy) return;
    busy = true;
    try {
      const stamps = await Promise.all([readHeaderStamp(), readLiveVersion()]);
      const header = stamps[0] || '';
      const version = stamps[1] || '';

      if (!initialized) {
        if (!header && !version) return;
        baselineHeader = header;
        baselineVersion = version;
        initialized = true;
        return;
      }

      let headerChanged = false;
      if (header) {
        if (!baselineHeader) {
          baselineHeader = header;
        } else if (header !== baselineHeader) {
          headerChanged = true;
        }
      }

      let versionChanged = false;
      if (version) {
        if (!baselineVersion) {
          baselineVersion = version;
        } else if (version !== baselineVersion) {
          versionChanged = true;
        }
      }

      if (!headerChanged && !versionChanged) return;
      reloadNow();
    } finally {
      busy = false;
    }
  }

  function start() {
    checkForUpdate();
    if (timerId !== null) return;
    timerId = window.setInterval(function () {
      if (document.hidden) return;
      checkForUpdate();
    }, CHECK_INTERVAL_MS);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    checkForUpdate();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
