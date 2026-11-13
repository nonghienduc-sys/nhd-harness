(function(){
  function q(id){return document.getElementById(id)}
  function safe(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function relative(input){if(!input)return '—';var t=new Date(input).getTime();if(!Number.isFinite(t))return '—';var s=Math.max(0,Math.round((Date.now()-t)/1000));if(s<60)return s+'s trước';if(s<3600)return Math.round(s/60)+' phút trước';if(s<86400)return Math.round(s/3600)+' giờ trước';return new Date(t).toLocaleDateString('vi-VN')}
  function fmtTokens(v){var n=Number(v);if(!Number.isFinite(n))return '—';if(n>=1000000)return (Math.round(n/100000)/10)+'M';if(n>=1000)return (Math.round(n/100)/10)+'K';return String(Math.round(n))}
  function text(id,value){var el=q(id);if(el)el.textContent=value}

  // Khung Tabler (sidebar, header, Tổng quan) nay nằm tĩnh trong index.html:
  // <button class="nav-link" data-tab="sbce">, <div id="planOverviewCard" class="card">.
  // Tệp này chỉ còn logic dữ liệu + đổi giao diện sáng/tối.
  var themeBtn=q('themeToggle');
  if(themeBtn)themeBtn.addEventListener('click',function(){
    var root=document.documentElement;var next=root.getAttribute('data-bs-theme')==='dark'?'light':'dark';
    root.setAttribute('data-bs-theme',next);try{localStorage.setItem('nhdTheme',next)}catch(_){}
  });
  // Đóng menu trên di động sau khi chọn trang.
  document.addEventListener('click',function(e){
    var b=e.target&&e.target.closest&&e.target.closest('#sidebar-menu [data-tab],#sidebar-menu [data-goto]');if(!b)return;
    var m=q('sidebar-menu');if(m&&m.classList.contains('show')&&window.bootstrap&&bootstrap.Collapse)bootstrap.Collapse.getOrCreateInstance(m).hide();
  });

  var tokenSamples=[];
  function chartPointValue(value){
    var raw=String(value||'').trim().toUpperCase().replace(/,/g,'.');
    var n=parseFloat(raw.replace(/[^0-9.]/g,''));if(!Number.isFinite(n))return null;
    if(raw.indexOf('M')>=0)n*=1000000;else if(raw.indexOf('K')>=0)n*=1000;return n
  }
  function drawTokenChart(){
    var chart=q('overviewTokenChart'),totalEl=q('overviewTokenCount');if(!chart||!totalEl)return;
    var total=chartPointValue(totalEl.textContent);var assistant=chartPointValue(q('overviewAssistantTokens')&&q('overviewAssistantTokens').textContent);
    if(total==null||total<=0)return;
    tokenSamples.push({total:total,assistant:assistant||0});if(tokenSamples.length>48)tokenSamples.shift();text('overviewTokenTotalMirror',totalEl.textContent);
    if(tokenSamples.length<2)return;
    var w=600,h=150,p=8,max=Math.max.apply(null,tokenSamples.map(function(x){return x.total}));if(max<=0)max=1;
    function pts(key){return tokenSamples.map(function(x,i){var px=p+(i/Math.max(1,tokenSamples.length-1))*(w-2*p);var py=h-p-(x[key]/max)*(h-2*p);return px.toFixed(1)+','+py.toFixed(1)}).join(' ')}
    var poly=pts('total'),assist=pts('assistant');
    chart.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="nhdTokenArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity=".13"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><polygon points="'+p+','+(h-p)+' '+poly+' '+(w-p)+','+(h-p)+'" fill="url(#nhdTokenArea)"/><polyline class="line-total" points="'+poly+'"/><polyline class="line-assistant" points="'+assist+'"/></svg>'
  }
  var tokenEl=q('overviewTokenCount');if(tokenEl)new MutationObserver(drawTokenChart).observe(tokenEl,{childList:true,subtree:true,characterData:true});

  function renderProjects(projects,health){
    var wrap=q('overviewProjectCards');if(!wrap||!projects||!projects.length)return;
    var activeRoot=health&&health.context&&health.context.activeProjectRoot?health.context.activeProjectRoot:'';
    var sorted=projects.slice().sort(function(a,b){return Number((b.root||'')===activeRoot)-Number((a.root||'')===activeRoot)}).slice(0,3);
    wrap.innerHTML=sorted.map(function(p,i){
      var task=p.activeTask||p.lastTask||{};var active=!!p.activeTask||p.root===activeRoot||i===0;var paused=task.state==='paused';
      var label=active?'Đang làm':paused?'Tạm dừng':task.state==='completed'?'Hoàn thành':'Gần đây';
      return '<article class="work-project-card '+(active?'active-project':'')+'"><div class="project-card-top"><span class="folder-chip">▰</span><span class="project-state '+(active?'active':paused?'paused':'')+'">'+safe(label)+'</span></div><h3 '+(active?'id="activeProjectName"':'')+'>'+safe(p.name||'Dự án')+'</h3><p '+(active?'id="activeProjectRoot"':'')+' class="project-root">'+safe(p.root||'')+'</p><div class="project-task-line"><small>Tác vụ hiện tại</small><strong '+(active?'id="overviewCurrentTask"':'')+'>'+safe(task.objective||task.id||'Chưa có tác vụ')+'</strong></div><div class="project-card-foot"><span '+(active?'id="projectCheckpoint"':'')+'>'+(active?'Bộ nhớ '+safe(health&&health.context?health.context.checkpoints||0:0)+' checkpoints':safe(task.state||'idle'))+'</span><span '+(active?'id="projectUpdated"':'')+'>'+safe(relative(p.updatedAt||task.updatedAt))+'</span></div>'+(active?'<span id="projectUnresolved" class="sr-only">0 unresolved</span>':'')+'</article>'
    }).join('')
  }

  function renderHealth(health,tools){
    if(!health)return;
    var skills=health.skills||{};var skillTotal=Number(skills.total||0),skillEnabled=Number(skills.enabled||skills.valid||0);
    var toolTotal=Number(tools&&tools.total||0),toolEnabled=Number(tools&&tools.enabled||0),toolPartial=Number(tools&&tools.partial||0);
    text('overviewToolsValue',toolTotal?toolEnabled+'/'+toolTotal:'—');
    text('overviewCapabilitiesMeta',toolTotal?('công cụ · '+skillEnabled+'/'+skillTotal+' kỹ năng'+(toolPartial?' · '+toolPartial+' một phần':' · tất cả ổn')):(skillTotal?skillEnabled+'/'+skillTotal+' kỹ năng':'Chưa có dữ liệu công cụ'));
    var tasks=health.tasks||{};var active=Number(tasks.active||0),paused=Number(tasks.paused||0);text('overviewTasksValue',active);text('overviewTasksMeta',paused?paused+' đang tạm dừng':active?'Đang xử lý':'Không có tác vụ chạy');
    text('sidebarStorageMeta',health.root&&health.root[0]?health.root[0]:'MCP workspace');
    var ctx=health.context||{};text('overviewMemoryCheckpoint',ctx.checkpoints?(ctx.checkpoints+' checkpoint'+(ctx.checkpoints===1?'':'s')):'Chưa có checkpoint');text('overviewMemoryUpdated',ctx.available?'Bộ nhớ dự án đang sẵn sàng.':'Bộ nhớ chưa khả dụng.');
    var video=health.video||{};text('videoTranscriptStatus',video.localAsr?'Local ASR sẵn sàng':video.available?'Caption / transcript':'Chưa sẵn sàng');text('videoSceneStatus',video.available?'FFmpeg scene scan':'Công cụ video chưa sẵn sàng');
    var rows=[['Tác vụ đang chạy',active,active?'running':'idle'],['Tác vụ tạm dừng',paused,paused?'paused':'idle'],['Thao tác chờ duyệt',Number(health.index&&health.index.pendingActions||0),Number(health.index&&health.index.pendingActions||0)?'paused':'verified'],['Terminal',health.terminalEnabled?'Sẵn sàng':'Khóa',health.terminalEnabled?'verified':'paused'],['Phân tích video',video.available?'Sẵn sàng':'Chưa sẵn sàng',video.available?'verified':'idle']];
    var progress=q('overviewTaskProgress');if(progress)progress.innerHTML=rows.map(function(row,i){return '<div class="task-progress-row"><span class="task-step-index">'+(i+1)+'</span><span><strong>'+safe(row[0])+'</strong><small>'+safe(row[1])+'</small></span><span class="task-badge '+(row[2]==='paused'?'paused':'')+'">'+safe(row[2])+'</span></div>'}).join('')
  }

  function tick(){text('dashboardClock',new Date().toLocaleString('vi-VN',{weekday:'short',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}))}
  tick();setInterval(tick,30000);

  var designRefreshInFlight=false;
  async function refreshDesignData(){
    if(document.hidden || designRefreshInFlight)return;
    designRefreshInFlight=true;
    try{
      var responses=await Promise.all([
        fetch('/api/health/fast').then(function(r){return r.json()}).then(function(snapshot){return snapshot.data||{}}),
        fetch('/api/projects?limit=10').then(function(r){return r.json()}).catch(function(){return {projects:[]}}),
        fetch('/api/tools').then(function(r){return r.json()}).catch(function(){return {total:0,enabled:0,partial:0}})
      ]);
      renderHealth(responses[0],responses[2]);renderProjects(responses[1].projects||[],responses[0])
    }catch(_){}finally{designRefreshInFlight=false}
  }
  setTimeout(refreshDesignData,250);setInterval(refreshDesignData,10000);
})();