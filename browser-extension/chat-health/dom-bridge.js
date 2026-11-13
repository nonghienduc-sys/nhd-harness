(() => {
  const BRIDGE_VERSION = '0.4.1';
  if ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && location.port === '39100') return;
  const root = document.documentElement;
  if (!root || root.dataset.nhdCocCocDomBridgeVersion === BRIDGE_VERSION) return;
  root.dataset.nhdCocCocDomBridgeVersion = BRIDGE_VERSION;
  const PULSE_MS = 600, SELECTOR_TTL_MS = 5 * 60 * 1000;
  const selectors = new Map(); let pulseInFlight = false;
  const safeText = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function openRoots() {
    const roots = [document], docs = [document];
    for (let cursor = 0; cursor < roots.length; cursor += 1) {
      const current = roots[cursor]; let nodes = [];
      try { nodes = [...current.querySelectorAll('*')]; } catch {}
      for (const node of nodes) {
        if (node.shadowRoot && !roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
        if (String(node.tagName || '').toLowerCase() === 'iframe') {
          try { const doc = node.contentDocument; if (doc && !docs.includes(doc)) { docs.push(doc); roots.push(doc); } } catch {}
        }
      }
    }
    return { roots, docs };
  }
  function deepQueryAll(selector) { const seen = new Set(), found = []; for (const current of openRoots().roots) { let nodes=[]; try { nodes=[...current.querySelectorAll(selector)]; } catch {} for (const node of nodes) if (!seen.has(node)) { seen.add(node); found.push(node); } } return found; }
  function visible(el) { try { const style=getComputedStyle(el), rect=el.getBoundingClientRect(); return style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity||1)>0 && rect.width>0 && rect.height>0; } catch { return false; } }
  function randomSelectorId() { const bytes=new Uint8Array(12); crypto.getRandomValues(bytes); return 'cocsel-'+[...bytes].map(v=>v.toString(16).padStart(2,'0')).join(''); }
  function pruneSelectors() { const now=Date.now(); for (const [key,item] of selectors) if (item.expiresAt<now || !item.element?.isConnected) selectors.delete(key); }
  function controlMeta(el, selectorId) {
    const rect=el.getBoundingClientRect(), tag=String(el.tagName||'').toLowerCase(), type=String(('type' in el ? el.type : el.getAttribute?.('type'))||'').toLowerCase(), role=safeText(el.getAttribute?.('role'),100), name=safeText(el.getAttribute?.('aria-label')||el.getAttribute?.('title')||el.getAttribute?.('name')||el.getAttribute?.('placeholder'),300), text=safeText(el.innerText||el.textContent,500), href=safeText(el.href||'',5000);
    const sensitive=type==='password'||type==='file'||/\b(password|passcode|otp|cvv|cvc|card|bank|routing|secret|token)\b/i.test(`${name} ${text}`); const value=sensitive?'':safeText(('value' in el ? el.value : ''),500);
    return { selectorId,tag,role,name,text,type,href,value,disabled:Boolean(el.disabled||el.getAttribute?.('aria-disabled')==='true'),formAssociated:Boolean('form' in el&&el.form),download:Boolean(el.hasAttribute?.('download')),contentEditable:Boolean(el.isContentEditable),bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height} };
  }
  function inspect(payload={}) {
    pruneSelectors(); const query=safeText(payload.query,500).toLowerCase(), limit=Math.max(1,Math.min(Number(payload.limit||200),500)); const nodes=deepQueryAll('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]').filter(visible).slice(0,2500); const matches=[];
    for (const el of nodes) { const selectorId=randomSelectorId(), meta=controlMeta(el,selectorId), searchable=`${meta.tag} ${meta.role} ${meta.name} ${meta.text} ${meta.type} ${meta.href}`.toLowerCase(); if (query&&!searchable.includes(query)) continue; selectors.set(selectorId,{element:el,expiresAt:Date.now()+SELECTOR_TTL_MS,identity:{tag:meta.tag,type:meta.type,name:meta.name,href:meta.href}}); matches.push(meta); if(matches.length>=limit)break; }
    return { page:pageInfo(),controls:matches,total:query?matches.length:nodes.length,truncated:query?false:nodes.length>matches.length };
  }
  function resolveSelector(selectorId) { pruneSelectors(); const cached=selectors.get(String(selectorId||'')); if(!cached?.element?.isConnected)throw new Error('Cốc Cốc selector expired; inspect the tab again.'); const current=controlMeta(cached.element,String(selectorId)); if(current.tag!==cached.identity.tag||current.type!==cached.identity.type||(cached.identity.href&&current.href!==cached.identity.href)||(cached.identity.name&&current.name!==cached.identity.name)){selectors.delete(String(selectorId));throw new Error('Cốc Cốc selector identity changed; inspect the tab again.');} return cached.element; }
  function click(payload={}) { const selectorId=String(payload.selectorId||''),el=resolveSelector(selectorId); el.scrollIntoView?.({block:'center',inline:'center'}); el.click(); selectors.clear(); return {ok:true,page:pageInfo(),selectorId}; }
  function editableText(el) { return String(el?.innerText ?? el?.textContent ?? '').replace(/\r\n/g,'\n').trim(); }
  function findSemanticEditable(el, expected='') {
    if (el?.isContentEditable && visible(el)) return el;
    const wanted = String(expected || editableText(el)).trim();
    try { const direct = [...(el?.querySelectorAll?.('[contenteditable="true"]') || [])].find(visible); if (direct) return direct; } catch {}
    const active = document.activeElement;
    if (active?.isContentEditable && visible(active)) return active;
    const candidates = deepQueryAll('[contenteditable="true"]').filter(visible);
    if (!candidates.length) return null;
    const exact = candidates.find(node => editableText(node) === wanted); if (exact) return exact;
    const fuzzy = wanted && candidates.find(node => { const t=editableText(node); return t && (t.includes(wanted)||wanted.includes(t)); }); if (fuzzy) return fuzzy;
    let parent=el?.parentElement||null;
    for(let depth=0;parent&&depth<8;depth+=1,parent=parent.parentElement){ const local=candidates.find(node=>parent.contains(node)); if(local)return local; }
    if(candidates.length===1)return candidates[0];
    try { const r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2; return candidates.map(node=>{const q=node.getBoundingClientRect();const dx=(q.left+q.width/2)-cx,dy=(q.top+q.height/2)-cy;return{node,d:dx*dx+dy*dy};}).sort((a,b)=>a.d-b.d)[0]?.node||null; } catch { return null; }
  }
  function dispatchMouse(el,type,detail=1){ try{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:x,clientY:y,detail,button:0,buttons:type==='mousedown'?1:0}));}catch{} }
  async function enterCanvaTextEditor(el, expected='') {
    let target=findSemanticEditable(el,expected); if(target)return target;
    el.scrollIntoView?.({block:'center',inline:'center',behavior:'auto'}); el.focus?.();
    try{el.click?.();}catch{} await sleep(35); target=findSemanticEditable(el,expected); if(target)return target;
    dispatchMouse(el,'mousedown',1); dispatchMouse(el,'mouseup',1); dispatchMouse(el,'click',1); dispatchMouse(el,'mousedown',2); dispatchMouse(el,'mouseup',2); dispatchMouse(el,'click',2); dispatchMouse(el,'dblclick',2);
    await sleep(90); target=findSemanticEditable(el,expected); if(target)return target;
    try{el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));}catch{}
    await sleep(75); return findSemanticEditable(el,expected);
  }
  function replaceEditableText(target,value) {
    target.focus?.(); const doc=target.ownerDocument||document; let inserted=false;
    try{const selection=doc.getSelection?.(),range=doc.createRange?.();if(selection&&range){range.selectNodeContents(target);selection.removeAllRanges();selection.addRange(range);inserted=Boolean(doc.execCommand?.('insertText',false,value));}}catch{}
    if(!inserted){try{target.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertReplacementText',data:value}));}catch{} target.textContent=value; try{target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText',data:value}));}catch{target.dispatchEvent(new Event('input',{bubbles:true}));}}
    try{target.dispatchEvent(new Event('change',{bubbles:true}));}catch{}
    return editableText(target);
  }
  async function editText(payload={}) {
    const selectorId=String(payload.selectorId||''),value=String(payload.text||'').slice(0,2000),el=resolveSelector(selectorId);
    if(!el.isContentEditable&&!/(^|\.)canva\.com$/i.test(location.hostname))throw new Error('Semantic text editing is currently limited to contenteditable controls and Canva.');
    const before=editableText(el); const target=el.isContentEditable?el:await enterCanvaTextEditor(el,before);
    if(!target)throw new Error('Canva text element was selected but text-edit mode could not be entered without visual fallback.');
    let current=replaceEditableText(target,value); await sleep(40);
    const refreshed=findSemanticEditable(el,value); if(refreshed)current=editableText(refreshed);
    const verified=current===value || editableText(el)===value;
    return {ok:true,selectorId,characters:value.length,value:current,semantic:true,verified,strategy:'contenteditable-semantic-v2'};
  }
  async function fill(payload={}) {
    const selectorId=String(payload.selectorId||''),value=String(payload.text||'').slice(0,2000),el=resolveSelector(selectorId),type=String(('type'in el?el.type:el.getAttribute?.('type'))||'').toLowerCase(),tag=String(el.tagName||'').toLowerCase();
    if(type==='password'||type==='file')throw new Error('Sensitive field is blocked by the Cốc Cốc bridge.');
    if(el.isContentEditable||!['input','textarea','select'].includes(tag))return editText({selectorId,text:value});
    el.focus?.(); if(tag==='select'){el.value=value;}else{const proto=Object.getPrototypeOf(el),descriptor=Object.getOwnPropertyDescriptor(proto,'value');if(descriptor?.set)descriptor.set.call(el,value);else el.value=value;}
    try{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));}catch{el.dispatchEvent(new Event('input',{bubbles:true}));} el.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:true,selectorId,characters:value.length,value:String(el.value??'').slice(0,2000),semantic:false,verified:String(el.value??'')===value};
  }
  function pageInfo(){return{title:document.title,url:location.href,readyState:document.readyState,visibilityState:document.visibilityState,focused:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY,maxY:Math.max(0,document.documentElement.scrollHeight-innerHeight)}};}
  function snapshot(payload={}) { const maxChars=Math.max(1000,Math.min(Number(payload.maxChars||50000),100000)), opened=openRoots(); const chunks=[]; for(const [i,doc] of opened.docs.entries()){try{const text=String(doc.body?.innerText||'').replace(/\n{3,}/g,'\n\n').trim(); if(text)chunks.push(`${i?`[frame ${i}]\n`:''}${text}`);}catch{}} const joined=chunks.join('\n\n').slice(0,maxChars); const headings=deepQueryAll('h1,h2,h3,h4,h5,h6').filter(visible).slice(0,200).map(el=>({level:String(el.tagName||'').toLowerCase(),text:safeText(el.innerText||el.textContent,1000)})); const links=deepQueryAll('a[href]').filter(visible).slice(0,300).map(el=>({text:safeText(el.innerText||el.textContent,500),href:safeText(el.href,5000)})); return{page:pageInfo(),text:joined,textChars:joined.length,headings,links,documents:opened.docs.length}; }
  function scrollAction(payload={}) { const selectorId=String(payload.selectorId||''); if(selectorId){const el=resolveSelector(selectorId);el.scrollIntoView({block:'center',inline:'center',behavior:'auto'});}else window.scrollBy({left:Number(payload.deltaX||0),top:Number(payload.deltaY||0),behavior:'auto'}); return{ok:true,page:pageInfo(),selectorId:selectorId||null}; }
  function focusAction(payload={}) { const el=resolveSelector(String(payload.selectorId||'')); el.scrollIntoView?.({block:'center',inline:'center'});el.focus?.();return{ok:true,focused:true}; }
  function hoverAction(payload={}) { const el=resolveSelector(String(payload.selectorId||''));el.scrollIntoView?.({block:'center',inline:'center'});for(const type of ['mouseover','mouseenter','mousemove'])el.dispatchEvent(new MouseEvent(type,{bubbles:true,view:window}));return{ok:true,hovered:true}; }
  function selectAction(payload={}) { const selectorId=String(payload.selectorId||''),wanted=String(payload.value??''),el=resolveSelector(selectorId); if(String(el.tagName||'').toLowerCase()!=='select')throw new Error('Select action requires a native select control.'); const options=[...el.options],match=options.find(o=>o.value===wanted)||options.find(o=>String(o.textContent||'').trim()===wanted); if(!match)throw new Error('Requested select option was not found.'); el.value=match.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true,selectorId,value:el.value,selectedText:String(match.textContent||'').trim().slice(0,500)}; }
  function focusTraversal(reverse=false){const nodes=deepQueryAll('a[href],button,input,textarea,select,[contenteditable="true"],[tabindex]').filter(el=>visible(el)&&!el.disabled&&Number(el.getAttribute?.('tabindex')||0)>=0);if(!nodes.length)return;const idx=nodes.indexOf(document.activeElement),next=reverse?(idx<=0?nodes.length-1:idx-1):(idx<0||idx===nodes.length-1?0:idx+1);nodes[next]?.focus?.();}
  function pressAction(payload={}) { const key=String(payload.key||'').toUpperCase(),selectorId=String(payload.selectorId||''),el=selectorId?resolveSelector(selectorId):document.activeElement; const map={ESCAPE:'Escape',ENTER:'Enter',TAB:'Tab',SHIFT_TAB:'Tab',ARROW_UP:'ArrowUp',ARROW_DOWN:'ArrowDown',ARROW_LEFT:'ArrowLeft',ARROW_RIGHT:'ArrowRight',PAGE_UP:'PageUp',PAGE_DOWN:'PageDown',HOME:'Home',END:'End',SPACE:' '}; const domKey=map[key];if(!domKey)throw new Error(`Unsupported key ${key}`); if(key==='TAB'||key==='SHIFT_TAB'){focusTraversal(key==='SHIFT_TAB');return{ok:true,key,focusedTag:String(document.activeElement?.tagName||'').toLowerCase()};} if(key==='PAGE_DOWN'){window.scrollBy(0,Math.max(200,innerHeight*.8));return{ok:true,key,page:pageInfo()};} if(key==='PAGE_UP'){window.scrollBy(0,-Math.max(200,innerHeight*.8));return{ok:true,key,page:pageInfo()};} if(key==='HOME'&&!selectorId){window.scrollTo(0,0);return{ok:true,key,page:pageInfo()};} if(key==='END'&&!selectorId){window.scrollTo(0,document.documentElement.scrollHeight);return{ok:true,key,page:pageInfo()};} if(!el)throw new Error('No focused/selected element for key action.'); el.focus?.(); const tag=String(el.tagName||'').toLowerCase(),type=String(el.type||'').toLowerCase(); if(key==='ENTER'&&(tag==='button'||tag==='a'))el.click(); else if(key==='ENTER'&&tag==='input'&&el.form)el.form.requestSubmit?.(); else if(key==='SPACE'&&(tag==='button'||type==='checkbox'||type==='radio'))el.click(); else {el.dispatchEvent(new KeyboardEvent('keydown',{key:domKey,bubbles:true,shiftKey:key==='SHIFT_TAB'}));el.dispatchEvent(new KeyboardEvent('keyup',{key:domKey,bubbles:true,shiftKey:key==='SHIFT_TAB'}));} return{ok:true,key,selectorId:selectorId||null,page:pageInfo()}; }
  function conditionMatches(condition={}) { const kind=String(condition.kind||''); if(kind==='url'){return(!condition.equals||location.href===condition.equals)&&(!condition.contains||location.href.includes(condition.contains));} if(kind==='title'){return(!condition.equals||document.title===condition.equals)&&(!condition.contains||document.title.includes(condition.contains));} if(kind==='text'){const needle=String(condition.contains||'');return openRoots().docs.some(doc=>String(doc.body?.innerText||'').includes(needle));} if(kind==='value'){const el=resolveSelector(String(condition.selectorId||''));return String(el.value??el.innerText??el.textContent??'')===String(condition.equals??'');} if(kind==='ready')return condition.state==='interactive'?(document.readyState==='interactive'||document.readyState==='complete'):document.readyState==='complete'; if(kind==='no-navigation')return location.href===String(condition.url||''); throw new Error(`Unsupported wait condition: ${kind}`); }
  async function waitFor(payload={}) { const condition=payload.condition||{},timeoutMs=Math.max(100,Math.min(Number(payload.timeoutMs||5000),15000)),started=Date.now();let lastError='';while(Date.now()-started<=timeoutMs){try{if(conditionMatches(condition))return{ok:true,condition,page:pageInfo(),waitedMs:Date.now()-started};}catch(error){lastError=String(error?.message||error);}await sleep(100);}throw new Error(`Condition not met within ${timeoutMs} ms${lastError?`: ${lastError}`:''}`); }
  async function execute(command){try{let result;if(command.type==='inspect')result=inspect(command.payload);else if(command.type==='click')result=click(command.payload);else if(command.type==='fill')result=await fill(command.payload);else if(command.type==='edit_text')result=await editText(command.payload);else if(command.type==='page_info')result=pageInfo();else if(command.type==='snapshot')result=snapshot(command.payload);else if(command.type==='scroll')result=scrollAction(command.payload);else if(command.type==='focus')result=focusAction(command.payload);else if(command.type==='hover')result=hoverAction(command.payload);else if(command.type==='select')result=selectAction(command.payload);else if(command.type==='press')result=pressAction(command.payload);else if(command.type==='wait_for')result=await waitFor(command.payload);else throw new Error(`Unsupported Cốc Cốc bridge command: ${command.type}`);await chrome.runtime.sendMessage({type:'NHD_COC_COC_DOM_RESULT',payload:{id:command.id,ok:true,result}});}catch(error){try{await chrome.runtime.sendMessage({type:'NHD_COC_COC_DOM_RESULT',payload:{id:command.id,ok:false,error:String(error?.message||error)}});}catch{}}}
  async function pulse(){if(pulseInFlight)return;pulseInFlight=true;try{const response=await chrome.runtime.sendMessage({type:'NHD_COC_COC_DOM_PULSE',payload:{bridgeVersion:BRIDGE_VERSION,pageUrl:location.href,pageTitle:document.title,visible:document.visibilityState==='visible',focused:document.hasFocus()}});for(const command of response?.commands||[])await execute(command);}catch{}finally{pulseInFlight=false;}}
  document.addEventListener('visibilitychange',()=>{void pulse();});window.addEventListener('focus',()=>{void pulse();});setTimeout(()=>{void pulse();},150);setInterval(()=>{void pulse();},PULSE_MS);
})();
