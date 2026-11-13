(function(){
  function q(id){return document.getElementById(id)}
  function safe(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function relative(input){if(!input)return '—';var t=new Date(input).getTime();if(!Number.isFinite(t))return '—';var s=Math.max(0,Math.round((Date.now()-t)/1000));if(s<60)return s+'s trước';if(s<3600)return Math.round(s/60)+' phút trước';if(s<86400)return Math.round(s/3600)+' giờ trước';return new Date(t).toLocaleDateString('vi-VN')}
  function fmtTokens(v){var n=Number(v);if(!Number.isFinite(n))return '—';if(n>=1000000)return (Math.round(n/100000)/10)+'M';if(n>=1000)return (Math.round(n/100)/10)+'K';return String(Math.round(n))}
  function text(id,value){var el=q(id);if(el)el.textContent=value}

  var sidebar=document.querySelector('.sidebar');
  if(sidebar){
    sidebar.innerHTML=[
      '<div class="brand">',
        '<div class="brand-mark" aria-hidden="true"><span></span></div>',
        '<div class="brand-copy"><strong>NHD Workstation MCP</strong><span id="versionBadge">v—</span></div>',
      '</div>',
      '<nav aria-label="Điều hướng chính">',
        '<button class="active" data-tab="overview"><span aria-hidden="true">⌂</span><b>Tổng quan</b></button>',
        '<button data-tab="projects"><span aria-hidden="true">□</span><b>Dự án</b></button>',
        '<button data-tab="automation"><span aria-hidden="true">↯</span><b>Task Runs</b></button>',
        '<button data-tab="chat-health"><span aria-hidden="true">◉</span><b>Token & Chat Health</b><em class="new-chip">Live</em></button>',
        '<button data-tab="workspace"><span aria-hidden="true">▤</span><b>Office & Files</b></button>',
        '<button data-tab="memory"><span aria-hidden="true">◎</span><b>Memory</b></button>',
        '<button data-tab="desktop"><span aria-hidden="true">▣</span><b>Desktop & Intake</b></button>',
        '<button data-tab="sbce"><span aria-hidden="true">⚖</span><b>Bảng SBCE</b><em class="new-chip">Mới</em></button>',
        '<div class="nav-group">HỆ THỐNG</div>',
        '<button data-tab="connections"><span aria-hidden="true">⌘</span><b>Kết nối</b></button>',
        '<button data-tab="skills"><span aria-hidden="true">◇</span><b>Skills & Tools</b></button>',
        '<button data-tab="activity"><span aria-hidden="true">◷</span><b>Hoạt động</b></button>',
        '<button data-tab="security"><span aria-hidden="true">♢</span><b>Bảo mật</b></button>',
        '<button data-tab="settings"><span aria-hidden="true">⚙</span><b>Cài đặt</b></button>',
      '</nav>',
      '<div class="sidebar-footer">',
        '<div class="local-storage-row"><span class="storage-icon" aria-hidden="true">▱</span><div><strong>Bộ nhớ cục bộ</strong><span id="sidebarStorageMeta">MCP workspace</span></div><span>›</span></div>',
        '<div class="storage-track"><i></i></div>',
        '<div class="quick-links"><small>KẾT NỐI NHANH</small><button data-goto="workspace">Word / Excel / PowerPoint</button><button data-goto="desktop">Windows Explorer</button></div>',
      '</div>'
    ].join('');
  }

  var overview=q('overview');
  if(overview){
    overview.className='tab active dashboard-home';
    overview.innerHTML=[
      '<div class="dashboard-heading">',
        '<div><h1>Trung tâm điều khiển</h1><p>Quản lý dự án, công cụ, bộ nhớ và tự động hóa trên MCP Workstation.</p></div>',
        '<div class="heading-meta"><span id="dashboardClock">—</span><span class="system-stable"><i></i><span id="overallStatus">Đang kiểm tra</span></span></div>',
      '</div>',

      '<div class="overview-kpis">',
        '<button class="kpi-card" data-goto="skills"><span class="kpi-icon layers" aria-hidden="true">◇</span><span class="kpi-copy"><small>Tools & Skills</small><strong id="overviewToolsValue">—</strong><em id="overviewCapabilitiesMeta">Đang đồng bộ</em></span><span class="kpi-arrow">›</span></button>',
        '<button class="kpi-card" data-goto="automation"><span class="kpi-icon task" aria-hidden="true">▷</span><span class="kpi-copy"><small>Task đang chạy</small><strong id="overviewTasksValue">—</strong><em id="overviewTasksMeta">Đang đồng bộ</em></span><span class="kpi-arrow">›</span></button>',
        '<button class="kpi-card token-kpi" data-goto="chat-health"><span class="kpi-icon token" aria-hidden="true">◉</span><span class="kpi-copy"><small>Token thời gian thực <span id="overviewTokenLive" class="token-live-badge">CONNECTING</span></small><strong><span id="overviewTokenCount">—</span> <span id="overviewTokenBudget">/ 128K</span></strong><em id="overviewTokenStatus">Đang chờ sensor</em></span><span class="kpi-arrow">›</span><span class="mini-progress"><i id="overviewTokenBar"></i></span></button>',
        '<button class="kpi-card" data-goto="chat-health"><span class="kpi-icon health" aria-hidden="true">♡</span><span class="kpi-copy"><small>Sức khỏe tab chat</small><strong id="chatTabsLowest">—</strong><em><span id="chatTabsActive">—</span> tab đang hoạt động</em></span><span class="kpi-arrow">›</span></button>',
      '</div>',

      '<div class="home-grid"><div class="home-main">',
        '<article class="workspace-section project-workspace">',
          '<div class="section-bar"><div><h2>Dự án đang làm</h2><p>Công việc được nối với project và memory tương ứng.</p></div><button class="primary compact-primary" data-goto="projects">＋ Dự án</button></div>',
          '<div id="overviewProjectCards" class="project-card-grid"><article class="work-project-card active-project"><div class="project-card-top"><span class="folder-chip">▰</span><span class="project-state active">Đang tải</span></div><h3 id="activeProjectName">Đang tải project...</h3><p id="activeProjectRoot" class="project-root">—</p><div class="project-task-line"><small>Task hiện tại</small><strong id="overviewCurrentTask">Đang đồng bộ...</strong></div><div class="project-card-foot"><span id="projectCheckpoint">Checkpoint —</span><span id="projectUpdated">—</span></div><span id="projectUnresolved" class="sr-only">0 unresolved</span></article></div>',
        '</article>',


        '<article id="planOverviewCard" class="workspace-section plan-overview-card">',
          '<div class="section-bar"><div><p class="eyebrow">DURABLE PLAN</p><h2>Lộ trình nhiều giai đoạn</h2><p>Phase hiện tại được giữ xuyên chat và restart.</p></div><span id="planOverviewBadge" class="badge neutral">—</span></div>',
          '<div id="planOverviewBody" class="plan-state-empty"><strong>Đang đọc Plan State...</strong></div>',
        '</article>',
        '<article id="dailyProgressCard" class="workspace-section daily-progress-card">',
          '<div class="section-bar"><div><p class="eyebrow">TIẾN ĐỘ HÔM NAY</p><h2>Hôm nay đã xong chưa?</h2><p id="dailyProgressProject">Đang đồng bộ project...</p></div><span id="dailyProgressStatus" class="daily-progress-status not-started"><i></i> Đang tải</span></div>',
          '<div id="dailyProgressBody" class="daily-progress-empty"><strong>Đang đọc kế hoạch hôm nay...</strong></div>',
        '</article>',

        '<div class="analytics-grid">',
          '<article class="workspace-section token-chart-card"><div class="section-bar"><div><h2>Token realtime</h2><p id="overviewTokenChat">Chưa có telemetry token từ tab ChatGPT</p></div><button class="link-button" data-goto="chat-health">Chi tiết ›</button></div><div class="token-chart-layout"><div id="overviewTokenChart" class="overview-token-chart"><div class="chart-empty">Đang chờ dữ liệu realtime…</div></div><div class="token-legend"><div><span class="dot user"></span><small>User</small><strong id="overviewUserTokens">—</strong></div><div><span class="dot assistant"></span><small>Assistant</small><strong id="overviewAssistantTokens">—</strong></div><div><span class="dot total"></span><small>Tổng</small><strong id="overviewTokenTotalMirror">—</strong></div><div class="budget-row"><small>Context budget</small><strong id="overviewTokenPercent">—</strong></div><span id="overviewTextChars" class="sr-only">—</span></div></div></article>',
          '<article class="workspace-section task-progress-card"><div class="section-bar"><div><h2>Tiến độ task</h2><p>Trạng thái runtime hiện tại.</p></div><button class="link-button" data-goto="automation">Xem tất cả ›</button></div><div id="overviewTaskProgress" class="task-progress-list"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div></article>',
        '</div>',

        '<div class="bottom-grid">',
          '<article class="workspace-section memory-resume-card"><div class="section-bar"><div><h2>Memory & Resume</h2><p id="overviewMemoryUpdated">Bộ nhớ dự án đang được đồng bộ.</p></div><button class="link-button" data-goto="memory">Xem tất cả ›</button></div><div class="memory-resume-body"><span class="memory-icon" aria-hidden="true">◎</span><div><small>Checkpoint mới nhất</small><strong id="overviewMemoryCheckpoint">—</strong><p id="overviewMemorySummary">Khôi phục ngữ cảnh và tiếp tục từ checkpoint gần nhất.</p></div><button class="primary" data-goto="projects">▶ Tiếp tục công việc</button></div></article>',
          '<article class="workspace-section video-card"><div class="section-bar"><div><h2>Video Intelligence</h2><p>Hiểu video theo transcript, scene và keyframe.</p></div><button class="link-button" data-goto="skills">Mở công cụ ›</button></div><div class="video-actions"><div><span>▤</span><b>Transcript</b><small id="videoTranscriptStatus">Sẵn sàng</small></div><div><span>▦</span><b>Scenes</b><small id="videoSceneStatus">Tự động nhận cảnh</small></div><div><span>▧</span><b>Keyframes</b><small>Trích xuất khung hình</small></div><div><span>⌕</span><b>Tìm kiếm video</b><small>Theo nội dung</small></div></div></article>',
        '</div>',
      '</div>',

      '<aside class="home-rail">',
        '<article class="workspace-section activity-card"><div class="section-bar"><div><h2>Hoạt động gần đây</h2><p>Dòng thời gian thao tác trên MCP.</p></div><button class="link-button" data-goto="activity">Tất cả</button></div><div id="recentActivity" class="recent-activity-list"><p>Đang tải…</p></div></article>',
        '<article class="workspace-section chat-rail-card"><div class="section-bar"><div><h2>Tình trạng chat tabs</h2><p>Các tab cần chú ý trước khi handoff.</p></div><button class="link-button" data-goto="chat-health">Xem tất cả ›</button></div><div id="chatWorstList" class="chat-worst-list"><p>Chưa có dữ liệu tab.</p></div><div id="chatTabsCardState" class="rail-note"><strong>Đang chờ telemetry</strong><p>Mỗi tab được đo độc lập.</p></div><span id="chatTabsHandoff" class="sr-only">—</span><span id="chatTabsTotal" class="sr-only">—</span><span id="chatTabsTokens" class="sr-only">—</span></article>',
      '</aside></div>'
    ].join('');
  }

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
    chart.innerHTML='<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="nhdTokenArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1677ff" stop-opacity=".13"/><stop offset="100%" stop-color="#1677ff" stop-opacity="0"/></linearGradient></defs><polygon points="'+p+','+(h-p)+' '+poly+' '+(w-p)+','+(h-p)+'" fill="url(#nhdTokenArea)"/><polyline class="line-total" points="'+poly+'"/><polyline class="line-assistant" points="'+assist+'"/></svg>'
  }
  var tokenEl=q('overviewTokenCount');if(tokenEl)new MutationObserver(drawTokenChart).observe(tokenEl,{childList:true,subtree:true,characterData:true});

  function renderProjects(projects,health){
    var wrap=q('overviewProjectCards');if(!wrap||!projects||!projects.length)return;
    var activeRoot=health&&health.context&&health.context.activeProjectRoot?health.context.activeProjectRoot:'';
    var sorted=projects.slice().sort(function(a,b){return Number((b.root||'')===activeRoot)-Number((a.root||'')===activeRoot)}).slice(0,3);
    wrap.innerHTML=sorted.map(function(p,i){
      var task=p.activeTask||p.lastTask||{};var active=!!p.activeTask||p.root===activeRoot||i===0;var paused=task.state==='paused';
      var label=active?'Đang làm':paused?'Tạm dừng':task.state==='completed'?'Hoàn thành':'Gần đây';
      return '<article class="work-project-card '+(active?'active-project':'')+'"><div class="project-card-top"><span class="folder-chip">▰</span><span class="project-state '+(active?'active':paused?'paused':'')+'">'+safe(label)+'</span></div><h3 '+(active?'id="activeProjectName"':'')+'>'+safe(p.name||'Project')+'</h3><p '+(active?'id="activeProjectRoot"':'')+' class="project-root">'+safe(p.root||'')+'</p><div class="project-task-line"><small>Task hiện tại</small><strong '+(active?'id="overviewCurrentTask"':'')+'>'+safe(task.objective||task.id||'Chưa có task')+'</strong></div><div class="project-card-foot"><span '+(active?'id="projectCheckpoint"':'')+'>'+(active?'Memory '+safe(health&&health.context?health.context.checkpoints||0:0)+' checkpoints':safe(task.state||'idle'))+'</span><span '+(active?'id="projectUpdated"':'')+'>'+safe(relative(p.updatedAt||task.updatedAt))+'</span></div>'+(active?'<span id="projectUnresolved" class="sr-only">0 unresolved</span>':'')+'</article>'
    }).join('')
  }

  function renderHealth(health,tools){
    if(!health)return;
    var skills=health.skills||{};var skillTotal=Number(skills.total||0),skillEnabled=Number(skills.enabled||skills.valid||0);
    var toolTotal=Number(tools&&tools.total||0),toolEnabled=Number(tools&&tools.enabled||0),toolPartial=Number(tools&&tools.partial||0);
    text('overviewToolsValue',toolTotal?toolEnabled+'/'+toolTotal+' Tools':'—');
    text('overviewCapabilitiesMeta',toolTotal?(skillEnabled+'/'+skillTotal+' Skills'+(toolPartial?' · '+toolPartial+' partial':' · tất cả ổn')):(skillTotal?skillEnabled+'/'+skillTotal+' Skills':'Chưa có dữ liệu tools'));
    var tasks=health.tasks||{};var active=Number(tasks.active||0),paused=Number(tasks.paused||0);text('overviewTasksValue',active);text('overviewTasksMeta',paused?paused+' đang tạm dừng':active?'Đang xử lý':'Không có task chạy');
    text('sidebarStorageMeta',health.root&&health.root[0]?health.root[0]:'MCP workspace');
    var ctx=health.context||{};text('overviewMemoryCheckpoint',ctx.checkpoints?(ctx.checkpoints+' checkpoint'+(ctx.checkpoints===1?'':'s')):'Chưa có checkpoint');text('overviewMemoryUpdated',ctx.available?'Memory dự án đang sẵn sàng.':'Memory chưa khả dụng.');
    var video=health.video||{};text('videoTranscriptStatus',video.localAsr?'Local ASR sẵn sàng':video.available?'Caption / transcript':'Chưa sẵn sàng');text('videoSceneStatus',video.available?'FFmpeg scene scan':'Video tools chưa sẵn sàng');
    var rows=[['Task đang chạy',active,active?'running':'idle'],['Task tạm dừng',paused,paused?'paused':'idle'],['Pending actions',Number(health.index&&health.index.pendingActions||0),Number(health.index&&health.index.pendingActions||0)?'paused':'verified'],['Terminal',health.terminalEnabled?'Sẵn sàng':'Khóa',health.terminalEnabled?'verified':'paused'],['Video Intelligence',video.available?'Sẵn sàng':'Chưa sẵn sàng',video.available?'verified':'idle']];
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