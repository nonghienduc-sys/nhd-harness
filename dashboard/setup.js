'use strict';
const $=id=>document.getElementById(id);
const status=(message,kind='')=>{const x=$('status');x.textContent=message;x.className='status '+kind;};
async function api(path,body){const options=body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};const r=await fetch(path,options);const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'HTTP '+r.status);return data;}
const plan=()=>({domain:$('domain').value.trim(),subdomain:$('subdomain').value.trim()||'mcp'});
function updatePreview(){const {domain,subdomain}=plan();const hostname=(subdomain||'mcp')+'.'+(domain||'example.com');$('previewUrl').textContent='https://'+hostname+'/mcp';$('confirmHostname').textContent=hostname;}
$('domain').addEventListener('input',updatePreview);$('subdomain').addEventListener('input',updatePreview);
const toggle=(cloudflare)=>{$('cloudflareMode').hidden=!cloudflare;$('openaiMode').hidden=cloudflare;$('cloudflareTab').classList.toggle('active',cloudflare);$('openaiTab').classList.toggle('active',!cloudflare);status('Chọn các bước cấu hình, NHD không tự thay đổi DNS khi chưa xác nhận.');};
$('cloudflareTab').onclick=()=>toggle(true);$('openaiTab').onclick=()=>toggle(false);
async function action(button,work){button.disabled=true;try{const result=await work();status(typeof result==='string'?result:JSON.stringify(result,null,2),'success');return result;}catch(e){status(e.message,'error');}finally{button.disabled=false;}}
$('login').onclick=()=>action($('login'),()=>api('/api/setup/cloudflare/login',{}));
$('check').onclick=()=>action($('check'),async()=>{const [s,p]=await Promise.all([api('/api/setup/status'),api('/api/setup/cloudflare/plan',plan())]);return 'cloudflared: '+(s.cloudflare.cloudflaredReady?'đã có':'chưa có')+'; Đã đăng nhập: '+(s.cloudflare.loggedIn?'có':'chưa')+'; URL: '+p.mcpUrl;});
$('provision').onclick=()=>action($('provision'),async()=>{if(!$('confirmed').checked)throw Error('Hãy đọc và đánh dấu ô đồng ý tạo tunnel/DNS.');const r=await api('/api/setup/cloudflare/provision',{...plan(),confirmed:true});$('finalUrl').value=r.mcpUrl;return 'Đã tạo '+r.mcpUrl+'. '+(r.startRequested?'NHD đã gửi lệnh bật tunnel.':'Chưa bật được tunnel: '+(r.startError||'chưa rõ')+'. Bấm Bật lại tunnel.')+' Không cần khởi động lại. Hãy bấm Kiểm tra kết nối khi DNS đã hoạt động.';});
$('start').onclick=()=>action($('start'),async()=>{const s=await api('/api/tunnel/start',{});return 'Tunnel '+(s.running?'đang chạy':'đang kết nối')+'. Kiểm tra lại sau khi trạng thái Online.';});
$('verify').onclick=()=>action($('verify'),async()=>{const r=await api('/api/setup/cloudflare/verify',{});if(r.ok){$('finalUrl').value=r.mcpUrl;return 'HTTPS và OAuth metadata hợp lệ: '+r.mcpUrl;}throw Error('Chưa xác thực được HTTPS/OAuth: '+(r.error||'HTTP '+r.httpStatus));});
$('openaiStatus').onclick=()=>action($('openaiStatus'),async()=>api('/api/openai-tunnel/status'));
$('openaiDoctor').onclick=()=>action($('openaiDoctor'),async()=>api('/api/openai-tunnel/doctor',{}));
$('openaiStart').onclick=()=>action($('openaiStart'),async()=>api('/api/openai-tunnel/start',{}));
$('copy').onclick=async()=>{try{const url=$('finalUrl').value;if(!url)throw Error('Chưa có URL đã xác minh.');await navigator.clipboard.writeText(url);status('Đã sao chép URL MCP. Tự thêm plugin trong ChatGPT và xác thực.','success');}catch(e){status(e.message,'error');}};
(async()=>{try{const s=await api('/api/setup/status');$('finalUrl').value=s.cloudflare.mcpUrl||'';status('cloudflared '+(s.cloudflare.cloudflaredReady?'đã sẵn sàng':'chưa có')+'; Cloudflare login '+(s.cloudflare.loggedIn?'đã xác thực':'chưa xác thực')+'; kết nối '+(s.cloudflare.tunnelEnabled?'bật':'tắt'));}catch(e){status('Không kết nối được NHD backend: '+e.message,'error');}})();

document.getElementById('finish').onclick=()=>action(document.getElementById('finish'),async()=>{if(!confirm('Bạn đã tự thêm plugin, xác thực và gọi thử một công cụ đọc trong ChatGPT?'))return 'Chưa đánh dấu hoàn tất.';await api('/api/setup/complete',{confirmed:true});location.href='/';return 'Hoàn tất';});
