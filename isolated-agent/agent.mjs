import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer, createConnection } from 'node:net';

const VERSION = '0.3.3';
const EXCHANGE = resolve(process.env.NHD_AGENT_EXCHANGE || 'C:\\NHD\\Exchange');
const INBOX = resolve(EXCHANGE, 'commands');
const OUTBOX = resolve(EXCHANGE, 'responses');
const STATE = resolve(EXCHANGE, 'state');
const SCREENSHOTS = resolve(EXCHANGE, 'screenshots');
const HEARTBEAT = resolve(EXCHANGE, 'heartbeat.json');
const AGENT_ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const DESKTOP_SCRIPT = resolve(AGENT_ROOT, 'desktop.ps1');
const DESKTOP_WORKER_SCRIPT = resolve(AGENT_ROOT, 'desktop-worker.ps1');
const DEBUG_PORT = 9224;
const DESKTOP_BRIDGE_PIPE = '\\\\.\\pipe\\NHD-Isolated-Desktop-v1';
const SELECTOR_TTL_MS = 5 * 60_000;
const MODE = process.argv.includes('--stdio') ? 'stdio' : process.argv.includes('--bootstrap') ? 'bootstrap' : process.argv.includes('--file-bus') ? 'file-bus' : 'file-bus';
let browserProcess = null;
let activeTargetId = null;
let busy = false;
let stopping = false;
const sessionId = `sandbox-${randomBytes(8).toString('hex')}`;
const selectors = new Map();

for (const dir of [EXCHANGE, INBOX, OUTBOX, STATE, SCREENSHOTS]) mkdirSync(dir, { recursive: true });

function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, path);
}
function safeText(value, max = 1000) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }

function edgeExecutable() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find(existsSync) || null;
}

async function debugReachable() {
  try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(600) }); return r.ok; }
  catch { return false; }
}

async function ensureBrowser() {
  if (await debugReachable()) return;
  const exe = edgeExecutable();
  if (!exe) throw new Error('No Chromium browser is available inside the isolated environment.');
  const profile = resolve(STATE, 'browser-profile-v2');
  mkdirSync(profile, { recursive: true });
  browserProcess = spawn(exe, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--headless=new', '--disable-gpu', '--window-size=1280,900', 'about:blank',
  ], { windowsHide: false, stdio: 'ignore' });
  browserProcess.once('exit', () => { browserProcess = null; activeTargetId = null; selectors.clear(); });
  for (let i = 0; i < 60; i++) { if (await debugReachable()) return; await sleep(250); }
  throw new Error('Isolated browser did not expose CDP within 15 seconds.');
}

class CdpSession {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (!msg.id) return;
        const waiter = this.pending.get(msg.id); if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message || 'CDP command failed.'));
        else waiter.resolve(msg.result || {});
      } catch {}
    });
    socket.addEventListener('close', () => { for (const waiter of this.pending.values()) waiter.reject(new Error('CDP session closed.')); this.pending.clear(); });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout.')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once:true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }, { once:true });
    });
    return new CdpSession(socket);
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
      this.pending.set(id, { resolve:v => { clearTimeout(timer); resolvePromise(v); }, reject:e => { clearTimeout(timer); reject(e); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.socket.close(); } catch {} }
}

async function targets() {
  await ensureBrowser();
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Target discovery HTTP ${response.status}`);
  return (await response.json()).filter(x => x.type === 'page' && x.webSocketDebuggerUrl);
}
async function pageTarget(preferred) {
  const pages = await targets();
  const target = pages.find(x => x.id === preferred) || pages.find(x => x.id === activeTargetId) || pages.find(x => x.url === 'about:blank') || pages.find(x => /^https?:\/\//i.test(x.url)) || pages[0];
  if (!target) throw new Error('No isolated browser page target exists.');
  activeTargetId = target.id; return target;
}
async function pageInfo(session) {
  const r = await session.send('Runtime.evaluate', { expression:'({title:document.title,url:location.href,readyState:document.readyState})', returnByValue:true });
  const v = r.result?.value || {}; return { title:String(v.title||''), url:String(v.url||''), readyState:String(v.readyState||'') };
}
async function waitReady(session, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { try { const p = await pageInfo(session); if (p.readyState === 'interactive' || p.readyState === 'complete') return p; } catch {} await sleep(150); }
  throw new Error('Isolated page readiness timeout.');
}
function pruneSelectors() { const now=Date.now(); for(const [key,value] of selectors) if(value.expiresAt < now) selectors.delete(key); }
function selector(selectorId) { pruneSelectors(); const item=selectors.get(String(selectorId||'')); if(!item) throw new Error('Isolated selector expired; inspect again.'); return item; }

const DEEP_HELPERS = `
const __nhdRoots=()=>{const roots=[document],docs=[document];for(let i=0;i<roots.length;i++){let all=[];try{all=[...roots[i].querySelectorAll('*')]}catch{};for(const el of all){if(el.shadowRoot&&!roots.includes(el.shadowRoot))roots.push(el.shadowRoot);if(String(el.tagName||'').toLowerCase()==='iframe'){try{const d=el.contentDocument;if(d&&!docs.includes(d)){docs.push(d);roots.push(d)}}catch{}}}}return{roots,docs}};
const __nhdAll=(sel)=>{const out=[],seen=new Set();for(const r of __nhdRoots().roots){let a=[];try{a=[...r.querySelectorAll(sel)]}catch{};for(const el of a)if(!seen.has(el)){seen.add(el);out.push(el)}}return out};
const __nhdFind=(id)=>{for(const r of __nhdRoots().roots){try{const el=r.querySelector('[data-nhd-isolated-id="'+CSS.escape(id)+'"]');if(el)return el}catch{}}return null};
const __nhdVisible=(el)=>{try{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0&&r.width>0&&r.height>0}catch{return false}};
`;

async function browserStatus() {
  const running = await debugReachable(); let page=null;
  if (running) { try { const t=await pageTarget(); page={title:t.title||'',url:t.url||'',targetId:t.id}; } catch {} }
  return { running, executable:edgeExecutable(), debugPort:DEBUG_PORT, activePage:page, profileDir:resolve(STATE,'browser-profile-v2') };
}
async function browserNavigate(payload) {
  const url = new URL(String(payload.url||'')); if(!['http:','https:'].includes(url.protocol)) throw new Error('HTTP/HTTPS only.');
  const target=await pageTarget(); const session=await CdpSession.connect(target.webSocketDebuggerUrl);
  try { await session.send('Page.enable'); await session.send('Page.navigate',{url:url.toString()}); const page=await waitReady(session); selectors.clear(); return page; } finally { session.close(); }
}
async function browserSnapshot(payload) {
  const maxChars=Math.max(1000,Math.min(Number(payload.maxChars||50000),100000)); const target=await pageTarget(); const session=await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    const expression=`(()=>{${DEEP_HELPERS}const opened=__nhdRoots();const chunks=[];for(const [i,d] of opened.docs.entries()){try{const t=String(d.body?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim();if(t)chunks.push((i?'[frame '+i+']\\n':'')+t)}catch{}}const headings=__nhdAll('h1,h2,h3,h4,h5,h6').filter(__nhdVisible).slice(0,200).map(el=>({level:String(el.tagName||'').toLowerCase(),text:String(el.innerText||el.textContent||'').trim().slice(0,1000)}));const links=__nhdAll('a[href]').filter(__nhdVisible).slice(0,300).map(el=>({text:String(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,500),href:String(el.href||'').slice(0,5000)}));const text=chunks.join('\\n\\n').slice(0,${maxChars});return{title:document.title,url:location.href,readyState:document.readyState,text,textChars:text.length,headings,links,documents:opened.docs.length,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY,maxY:Math.max(0,document.documentElement.scrollHeight-innerHeight)}}})()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails)throw new Error('Snapshot evaluation failed.'); return r.result?.value||{};
  } finally { session.close(); }
}
async function browserInspect(payload) {
  const query=safeText(payload.query,500).toLowerCase(), limit=Math.max(1,Math.min(Number(payload.limit||200),500)); const target=await pageTarget(); const session=await CdpSession.connect(target.webSocketDebuggerUrl);
  try {
    const expression=`(()=>{${DEEP_HELPERS}const query=${JSON.stringify(query)},limit=${limit};const nodes=__nhdAll('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]').filter(__nhdVisible).slice(0,2500);const out=[];for(const el of nodes){let id=el.getAttribute('data-nhd-isolated-id');if(!id){id='iso-'+crypto.randomUUID();el.setAttribute('data-nhd-isolated-id',id)}const r=el.getBoundingClientRect(),tag=String(el.tagName||'').toLowerCase(),type=String(('type'in el?el.type:el.getAttribute?.('type'))||'').toLowerCase(),role=String(el.getAttribute?.('role')||''),name=String(el.getAttribute?.('aria-label')||el.getAttribute?.('title')||el.getAttribute?.('name')||el.getAttribute?.('placeholder')||'').trim().slice(0,300),text=String(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,500),href=String(el.href||'').slice(0,5000);const sensitive=type==='password'||type==='file'||/\\b(password|passcode|otp|cvv|cvc|card|bank|routing|secret|token)\\b/i.test(name+' '+text);const meta={selectorId:id,tag,role,name,text,type,href,value:sensitive?'':String(('value'in el?el.value:'')||'').slice(0,500),disabled:Boolean(el.disabled||el.getAttribute?.('aria-disabled')==='true'),formAssociated:Boolean('form'in el&&el.form),download:Boolean(el.hasAttribute?.('download')),bounds:{x:r.x,y:r.y,width:r.width,height:r.height}};const search=(tag+' '+role+' '+name+' '+text+' '+type+' '+href).toLowerCase();if(query&&!search.includes(query))continue;out.push(meta);if(out.length>=limit)break}return{page:{title:document.title,url:location.href},controls:out,total:nodes.length,truncated:nodes.length>out.length}})()`;
    const r=await session.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails)throw new Error('Inspect evaluation failed.'); const result=r.result?.value||{}; const expiresAt=Date.now()+SELECTOR_TTL_MS; for(const c of result.controls||[])selectors.set(String(c.selectorId),{targetId:target.id,expiresAt,meta:c}); pruneSelectors(); return result;
  } finally { session.close(); }
}
async function browserClick(payload) {
  const item=selector(payload.selectorId), target=await pageTarget(item.targetId), session=await CdpSession.connect(target.webSocketDebuggerUrl);
  try { const id=JSON.stringify(String(payload.selectorId)); const expression=`(()=>{${DEEP_HELPERS}const el=__nhdFind(${id});if(!el)throw new Error('Selector expired');el.scrollIntoView?.({block:'center',inline:'center'});el.click();return true})()`; const r=await session.send('Runtime.evaluate',{expression,returnByValue:true}); if(r.exceptionDetails)throw new Error('Click failed.'); await sleep(350); const page=await pageInfo(session); selectors.clear(); return{ok:true,page}; } finally { session.close(); }
}
async function browserFill(payload) {
  const item=selector(payload.selectorId),text=String(payload.text??'').slice(0,2000),target=await pageTarget(item.targetId),session=await CdpSession.connect(target.webSocketDebuggerUrl);
  try { const id=JSON.stringify(String(payload.selectorId)),value=JSON.stringify(text); const expression=`(()=>{${DEEP_HELPERS}const el=__nhdFind(${id});if(!el)throw new Error('Selector expired');const type=String(('type'in el?el.type:el.getAttribute?.('type'))||'').toLowerCase();if(type==='password'||type==='file')throw new Error('Sensitive field blocked');el.focus?.();const v=${value};if(el.isContentEditable)el.textContent=v;else if(String(el.tagName||'').toLowerCase()==='select')el.value=v;else{const p=Object.getPrototypeOf(el),d=Object.getOwnPropertyDescriptor(p,'value');if(d?.set)d.set.call(el,v);else el.value=v}try{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:v}))}catch{el.dispatchEvent(new Event('input',{bubbles:true}))}el.dispatchEvent(new Event('change',{bubbles:true}));return{value:type==='password'?'':String(el.value??el.textContent??'').slice(0,2000)}})()`; const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw new Error('Fill failed.');return{ok:true,selectorId:String(payload.selectorId),characters:text.length,value:r.result?.value?.value??''}; } finally { session.close(); }
}
async function browserPress(payload) {
  const key=String(payload.key||'').toUpperCase(),target=await pageTarget(),session=await CdpSession.connect(target.webSocketDebuggerUrl);
  try { const expression=`(()=>{const key=${JSON.stringify(key)},el=document.activeElement;const map={ESCAPE:'Escape',ENTER:'Enter',TAB:'Tab',SHIFT_TAB:'Tab',ARROW_UP:'ArrowUp',ARROW_DOWN:'ArrowDown',ARROW_LEFT:'ArrowLeft',ARROW_RIGHT:'ArrowRight',PAGE_UP:'PageUp',PAGE_DOWN:'PageDown',HOME:'Home',END:'End',SPACE:' '};const k=map[key];if(!k)throw new Error('Unsupported key');if(key==='PAGE_DOWN'){scrollBy(0,Math.max(200,innerHeight*.8));return true}if(key==='PAGE_UP'){scrollBy(0,-Math.max(200,innerHeight*.8));return true}if(key==='HOME'){scrollTo(0,0);return true}if(key==='END'){scrollTo(0,document.documentElement.scrollHeight);return true}if(!el)return false;if(key==='ENTER'&&String(el.tagName||'').toLowerCase()==='button')el.click();else if(key==='ENTER'&&String(el.tagName||'').toLowerCase()==='input'&&el.form)el.form.requestSubmit?.();else{el.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,shiftKey:key==='SHIFT_TAB'}));el.dispatchEvent(new KeyboardEvent('keyup',{key:k,bubbles:true,shiftKey:key==='SHIFT_TAB'}))}return true})()`; const r=await session.send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw new Error('Key action failed.');await sleep(250);return{ok:true,key,page:await pageInfo(session)}; } finally { session.close(); }
}
async function browserScreenshot() {
  const target=await pageTarget(),session=await CdpSession.connect(target.webSocketDebuggerUrl); try { await session.send('Page.enable');const r=await session.send('Page.captureScreenshot',{format:'jpeg',quality:72,fromSurface:true,captureBeyondViewport:false});if(!r.data)throw new Error('Screenshot empty');return{mimeType:'image/jpeg',data:String(r.data),page:await pageInfo(session)};} finally {session.close();}
}

class PersistentDesktopWorker {
  constructor(){this.process=null;this.buffer='';this.stderr='';this.ready=false;this.version=null;this.pid=null;this.starting=null;this.startupMs=null;this.lastRttMs=null;this.pending=new Map();}
  status(){return{persistent:true,online:Boolean(this.process&&this.ready&&this.process.exitCode==null),starting:Boolean(this.starting),pid:this.pid,version:this.version,startupMs:this.startupMs,lastRttMs:this.lastRttMs,pending:this.pending.size,stderrTail:this.stderr.slice(-500)}}
  async start(timeoutMs=8000){if(this.process&&this.ready&&this.process.exitCode==null)return;if(this.starting)return this.starting;this.starting=this._start(timeoutMs).finally(()=>{this.starting=null});return this.starting;}
  async _start(timeoutMs){
    if(!existsSync(DESKTOP_WORKER_SCRIPT))throw new Error('Persistent isolated desktop worker is missing.');
    this.stop(new Error('Replacing stale persistent desktop worker.'));this.buffer='';this.stderr='';this.ready=false;this.version=null;this.pid=null;
    const started=performance.now();
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',DESKTOP_WORKER_SCRIPT,'-ExchangeRoot',EXCHANGE],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.process=child;child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>this.consume(String(chunk)));child.stderr.on('data',chunk=>{this.stderr=(this.stderr+String(chunk)).slice(-8000)});
    child.once('exit',(code,signal)=>{if(this.process!==child)return;this.process=null;this.ready=false;this.pid=null;const error=new Error(`Persistent desktop UIA worker exited (code=${code??'null'}, signal=${signal??'null'}). Pending actions are not replayed.`);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear();});
    const bounded=Math.max(1500,Math.min(Number(timeoutMs)||8000,15000));
    while(performance.now()-started<bounded){if(this.ready&&this.process===child){this.startupMs=Number((performance.now()-started).toFixed(2));return}if(child.exitCode!=null)throw new Error('Persistent desktop UIA worker exited before ready: '+this.stderr.slice(-2000));await sleep(20);}
    this.stop(new Error('Persistent desktop UIA worker readiness timeout; no desktop command was sent.'));throw new Error(`Persistent desktop UIA worker did not become ready within ${bounded} ms.`);
  }
  consume(chunk){this.buffer+=chunk;while(true){const i=this.buffer.indexOf('\n');if(i<0)break;const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);if(!line)continue;let msg;try{msg=JSON.parse(line)}catch{this.stderr=(this.stderr+'\n[unparsed worker stdout] '+line).slice(-8000);continue}if(msg.kind==='ready'){this.ready=true;this.version=String(msg.version||'');this.pid=Number(msg.pid||0)||null;continue}if(msg.kind!=='response')continue;const id=String(msg.id||''),p=this.pending.get(id);if(!p)continue;this.pending.delete(id);clearTimeout(p.timer);this.lastRttMs=Number((performance.now()-p.started).toFixed(2));if(msg.ok)p.resolve(msg.result);else p.reject(new Error(String(msg.error||'Persistent desktop UIA worker command failed.')));}}
  async request(action,payload={},timeoutMs=12000){await this.start();const child=this.process;if(!child||!this.ready)throw new Error('Persistent desktop UIA worker is unavailable. Host desktop fallback is forbidden.');const id='uia-'+randomBytes(10).toString('hex');return new Promise((resolvePromise,reject)=>{const started=performance.now();const timer=setTimeout(()=>{if(!this.pending.delete(id))return;reject(new Error(`Persistent desktop UIA command timed out: ${action}. The command is not replayed automatically.`))},Math.max(1000,Math.min(Number(timeoutMs)||12000,20000)));this.pending.set(id,{resolve:resolvePromise,reject,timer,started,action});child.stdin.write(JSON.stringify({id,action,payload})+'\n','utf8',error=>{if(!error)return;const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(p.timer);reject(new Error(`Persistent desktop UIA transport write failed for ${action}; delivery may be ambiguous and is not replayed: ${error.message}`));});});}
  stop(reason=new Error('Persistent desktop UIA worker stopped.')){const child=this.process;this.process=null;this.ready=false;this.pid=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(reason)}this.pending.clear();if(child&&child.exitCode==null){try{child.kill()}catch{}}}
}
const desktopWorker=new PersistentDesktopWorker();
let desktopBridgeServer=null;
class DesktopBridgeClient {
  constructor(){this.socket=null;this.buffer='';this.ready=false;this.starting=null;this.pending=new Map();this.lastRttMs=null;this.remoteWorker=null;this.stderr='';}
  status(){return{persistent:true,via:'bootstrap-loopback',online:Boolean(this.socket&&this.ready&&!this.socket.destroyed),starting:Boolean(this.starting),lastRttMs:this.lastRttMs,pending:this.pending.size,remoteWorker:this.remoteWorker}}
  async start(timeoutMs=8000){if(this.socket&&this.ready&&!this.socket.destroyed)return;if(this.starting)return this.starting;this.starting=this._start(timeoutMs).finally(()=>{this.starting=null});return this.starting;}
  async _start(timeoutMs){this.stop(new Error('Replacing stale desktop bridge client.'));const started=performance.now(),bounded=Math.max(1500,Math.min(Number(timeoutMs)||8000,15000));let lastError=null;while(performance.now()-started<bounded){try{await this.connectOnce(Math.min(2500,bounded-(performance.now()-started)));return}catch(e){lastError=e;await sleep(100)}}throw new Error('Interactive desktop bridge unavailable: '+String(lastError?.message||lastError||'timeout'));}
  connectOnce(timeoutMs){return new Promise((resolvePromise,reject)=>{const socket=createConnection(DESKTOP_BRIDGE_PIPE);this.socket=socket;this.buffer='';let settled=false;const timer=setTimeout(()=>{if(settled)return;settled=true;try{socket.destroy()}catch{};reject(new Error('desktop bridge connect timeout'))},Math.max(300,timeoutMs));socket.setEncoding('utf8');socket.on('data',chunk=>this.consume(String(chunk)));socket.once('error',error=>{if(!settled){settled=true;clearTimeout(timer);if(this.socket===socket)this.socket=null;reject(error)}});socket.once('close',()=>{if(this.socket===socket){this.socket=null;this.ready=false;const error=new Error('Interactive desktop bridge disconnected. Pending actions are not replayed.');for(const q of this.pending.values()){clearTimeout(q.timer);q.reject(error)}this.pending.clear();}});const onReady=()=>{if(settled)return;settled=true;clearTimeout(timer);this.socket=socket;resolvePromise()};socket.__nhdReady=onReady;});}
  consume(chunk){this.buffer+=chunk;while(true){const i=this.buffer.indexOf('\n');if(i<0)break;const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);if(!line)continue;let msg;try{msg=JSON.parse(line)}catch{continue}if(msg.kind==='ready'){this.ready=true;this.remoteWorker=msg.worker||null;const fn=this.socket?.__nhdReady;if(fn){delete this.socket.__nhdReady;fn()}continue}if(msg.kind!=='response')continue;const id=String(msg.id||''),q=this.pending.get(id);if(!q)continue;this.pending.delete(id);clearTimeout(q.timer);this.lastRttMs=Number((performance.now()-q.started).toFixed(2));this.remoteWorker=msg.worker||this.remoteWorker;if(msg.ok)q.resolve(msg.result);else q.reject(new Error(String(msg.error||'Interactive desktop bridge command failed.')));}}
  async request(action,payload={},timeoutMs=12000){await this.start();const socket=this.socket;if(!socket||!this.ready||socket.destroyed)throw new Error('Interactive desktop bridge is unavailable. Host fallback is forbidden.');const id='bridge-'+randomBytes(10).toString('hex');return new Promise((resolvePromise,reject)=>{const started=performance.now();const timer=setTimeout(()=>{if(!this.pending.delete(id))return;reject(new Error(`Interactive desktop command timed out: ${action}. The command is not replayed automatically.`))},Math.max(1000,Math.min(Number(timeoutMs)||12000,20000)));this.pending.set(id,{resolve:resolvePromise,reject,timer,started});socket.write(JSON.stringify({id,action,payload})+'\n','utf8',error=>{if(!error)return;const q=this.pending.get(id);if(!q)return;this.pending.delete(id);clearTimeout(q.timer);reject(new Error('Interactive desktop bridge write failed; delivery may be ambiguous and is not replayed: '+error.message));});});}
  stop(reason=new Error('Interactive desktop bridge stopped.')){const socket=this.socket;this.socket=null;this.ready=false;for(const q of this.pending.values()){clearTimeout(q.timer);q.reject(reason)}this.pending.clear();if(socket){try{socket.destroy()}catch{}}}
}
const desktopBridge=new DesktopBridgeClient();
async function startDesktopBridgeServer(){
  await desktopWorker.start(12000);if(desktopBridgeServer)return;
  const allowed=new Set(['ping','list','inspect','action','screenshot']);
  const server=createServer(socket=>{socket.setEncoding('utf8');let buffer='',queue=Promise.resolve();socket.write(JSON.stringify({kind:'ready',version:'0.1.0',worker:desktopWorker.status()})+'\n');socket.on('data',chunk=>{buffer+=String(chunk);if(buffer.length>131072){socket.destroy();return}while(true){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;let req;try{req=JSON.parse(line)}catch{continue}queue=queue.then(async()=>{const id=String(req.id||'').slice(0,128),action=String(req.action||'').slice(0,40),payload=req.payload&&typeof req.payload==='object'?req.payload:{};if(!id||!allowed.has(action)){socket.write(JSON.stringify({kind:'response',id,ok:false,error:'Invalid bounded desktop bridge request.'})+'\n');return}try{const result=await desktopWorker.request(action,payload,action==='screenshot'?15000:12000);socket.write(JSON.stringify({kind:'response',id,ok:true,result,worker:desktopWorker.status()})+'\n')}catch(error){socket.write(JSON.stringify({kind:'response',id,ok:false,error:String(error?.message||error).slice(0,3000),worker:desktopWorker.status()})+'\n')}}).catch(()=>{})}});});
  await new Promise((resolvePromise,reject)=>{const onError=e=>reject(e);server.once('error',onError);server.listen(DESKTOP_BRIDGE_PIPE,()=>{server.off('error',onError);resolvePromise()})});desktopBridgeServer=server;
}
async function runDesktop(){throw new Error('Desktop UIA is routed by the host through WinApp UI workflow; guest raw-UIA fallback is disabled.');}
function desktopSurfaceStatus(){return {backend:'host-winapp-ui',active:false,guestRawUia:false};}

async function handle(command) {
  const type=String(command.type||''),payload=command.payload&&typeof command.payload==='object'?command.payload:{};
  if(type==='system.ping')return{version:VERSION,sessionId,at:new Date().toISOString()};
  if(type==='system.shutdown'){setTimeout(()=>{try{spawn('shutdown.exe',['/s','/t','0'],{detached:true,stdio:'ignore'}).unref()}catch{}},500);return{accepted:true};}
  if(type==='browser.status')return browserStatus();
  if(type==='browser.navigate')return browserNavigate(payload);
  if(type==='browser.snapshot')return browserSnapshot(payload);
  if(type==='browser.inspect')return browserInspect(payload);
  if(type==='browser.click')return browserClick(payload);
  if(type==='browser.fill')return browserFill(payload);
  if(type==='browser.press')return browserPress(payload);
  if(type==='browser.screenshot')return browserScreenshot();
  if(type==='desktop.list')return runDesktop('list',payload);
  if(type==='desktop.inspect')return runDesktop('inspect',payload);
  if(type==='desktop.action')return runDesktop('action',payload);
  if(type==='desktop.screenshot')return runDesktop('screenshot',payload);
  throw new Error(`Unsupported isolated command: ${type}`);
}

function heartbeatPayload(mode = MODE) {
  return { version:VERSION, sessionId, at:new Date().toISOString(), busy, pid:process.pid, mode, browser:{running:Boolean(browserProcess),activeTargetId}, desktopWorker:desktopSurfaceStatus() };
}
function writeFileHeartbeat(mode = MODE) { atomicJson(HEARTBEAT, heartbeatPayload(mode)); }
function protocolWrite(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function processFileCommand(path) {
  const name=path.split(/[\\/]/).pop(); if(!name?.endsWith('.json'))return;
  const working=path.replace(/\.json$/i,'.working');
  try{renameSync(path,working)}catch{return}
  let command=null;
  try{command=JSON.parse(readFileSync(working,'utf8'));}catch{try{rmSync(working,{force:true})}catch{};return}
  busy=true;writeFileHeartbeat('file-bus');
  try{const result=await handle(command);atomicJson(resolve(OUTBOX,`${command.id}.json`),{ok:true,result,completedAt:new Date().toISOString(),sessionId});}
  catch(error){atomicJson(resolve(OUTBOX,`${command.id}.json`),{ok:false,error:String(error?.message||error).slice(0,5000),completedAt:new Date().toISOString(),sessionId});}
  finally{busy=false;writeFileHeartbeat('file-bus');try{rmSync(working,{force:true})}catch{}}
}

function startFileCommandPolling(intervalMs=15) {
  let loopBusy=false;
  setInterval(async()=>{if(loopBusy||stopping)return;loopBusy=true;try{for(const name of readdirSync(INBOX).filter(x=>x.endsWith('.json')).sort().slice(0,20))await processFileCommand(resolve(INBOX,name));}catch{}finally{loopBusy=false}},Math.max(10,Math.min(Number(intervalMs)||15,250)));
}

function startBootstrap() {
  writeFileHeartbeat('bootstrap');
  setInterval(()=>writeFileHeartbeat('bootstrap'),1000);
}

function startFileBus() {
  writeFileHeartbeat('file-bus');
  setInterval(()=>writeFileHeartbeat('file-bus'),1000);
  startFileCommandPolling(15);
}

function startStdio() {
  process.stdin.setEncoding('utf8');
  let inputBuffer='';
  let queue=Promise.resolve();
  const emitHeartbeat=()=>protocolWrite({kind:'heartbeat',...heartbeatPayload('stdio')});
  protocolWrite({kind:'ready',...heartbeatPayload('stdio')});
  setInterval(emitHeartbeat,1000);
  const run=async(command)=>{
    busy=true;emitHeartbeat();
    const started=performance.now();
    try{
      const result=await handle(command);
      protocolWrite({kind:'response',id:String(command.id||''),ok:true,result,completedAt:new Date().toISOString(),sessionId,elapsedMs:Number((performance.now()-started).toFixed(3))});
    }catch(error){
      protocolWrite({kind:'response',id:String(command.id||''),ok:false,error:String(error?.message||error).slice(0,5000),completedAt:new Date().toISOString(),sessionId,elapsedMs:Number((performance.now()-started).toFixed(3))});
    }finally{busy=false;emitHeartbeat()}
  };
  process.stdin.on('data',chunk=>{
    inputBuffer+=chunk;
    while(true){
      const index=inputBuffer.indexOf('\n'); if(index<0)break;
      const line=inputBuffer.slice(0,index).trim(); inputBuffer=inputBuffer.slice(index+1); if(!line)continue;
      let command;
      try{command=JSON.parse(line)}catch(error){process.stderr.write(`[protocol] invalid JSON: ${String(error?.message||error)}\n`);continue}
      if(command?.kind!=='command'||!command.id||!command.type){process.stderr.write('[protocol] invalid command envelope\n');continue}
      queue=queue.then(()=>run(command)).catch(error=>process.stderr.write(`[protocol] queue error: ${String(error?.stack||error)}\n`));
    }
  });
  process.stdin.on('end',()=>{stopping=true;queue.finally(()=>{desktopBridge.stop();try{browserProcess?.kill()}catch{};process.exit(0)})});
}

if(MODE==='stdio')startStdio();
else if(MODE==='bootstrap')startBootstrap().catch(error=>{try{atomicJson(resolve(EXCHANGE,'agent-error.json'),{at:new Date().toISOString(),error:String(error?.stack||error),mode:MODE})}catch{}});
else startFileBus();

process.on('uncaughtException',error=>{
  try{if(MODE==='stdio')process.stderr.write(`[uncaught] ${String(error?.stack||error)}\n`);else atomicJson(resolve(EXCHANGE,'agent-error.json'),{at:new Date().toISOString(),error:String(error?.stack||error),mode:MODE})}catch{}
});
process.on('SIGTERM',()=>{stopping=true;desktopBridge.stop();if(MODE!=='stdio')desktopWorker.stop();try{desktopBridgeServer?.close()}catch{};try{browserProcess?.kill()}catch{};process.exit(0)});

