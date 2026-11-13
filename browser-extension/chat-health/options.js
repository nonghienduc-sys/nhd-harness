const endpoint = document.getElementById('endpoint');
const status = document.getElementById('status');
const benchmarkStatus = document.getElementById('benchmarkStatus');
const benchmarkEnabled = document.getElementById('benchmarkEnabled');
const modelLabel = document.getElementById('modelLabel');
const workloadLabel = document.getElementById('workloadLabel');
const benchmarkStats = document.getElementById('benchmarkStats');
const SAMPLES_KEY = 'nhdResponseSpeedSamples';
const CSV_FIELDS = [
  "sampleId","measuredAtUtc","modelLabel","workloadLabel","timingOrigin",
  "completionSignal","quality","visibilityState","visibleChars","wordCount",
  "sampleCount","timeToFirstVisibleMs","observedDecodeMs","totalVisibleElapsedMs",
  "estimatedOutputTokens","estimatedTokensPerSecond","visibleCharsPerSecond","serverSaved","detectorVersion"
];

async function maybeMaintenanceReload() {
  const params = new URLSearchParams(location.search);
  const nonce = params.get('nhd_reload');
  if (!nonce || !/^[a-zA-Z0-9_-]{6,80}$/.test(nonce)) return;
  const key = 'nhdMaintenanceReloadNonce';
  const stored = await chrome.storage.local.get([key]);
  if (stored[key] === nonce) return;
  await chrome.storage.local.set({ [key]: nonce });
  status.textContent = 'Đang tải lại NHD MCP Cốc Cốc Agent…';
  setTimeout(() => chrome.runtime.reload(), 150);
}
function estimateTokens(chars){return Math.max(1,Math.round(Number(chars)/4));}
function speed(sample) {
  const ms=Number(sample.observedDecodeMs);
  return ms>=250 && Number(sample.sampleCount)>=2 ? Math.round(estimateTokens(sample.visibleChars)*100000/ms)/100 : null;
}
function median(values) {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor((sorted.length-1)*.5)];
}
async function refreshBenchmark() {
  const result=await chrome.storage.local.get([
    SAMPLES_KEY,'nhdResponseSpeedEnabled','nhdResponseSpeedModelLabel','nhdResponseSpeedWorkloadLabel'
  ]);
  benchmarkEnabled.checked=result.nhdResponseSpeedEnabled!==false;
  modelLabel.value=result.nhdResponseSpeedModelLabel||'ChatGPT Plus - model unverified';
  workloadLabel.value=result.nhdResponseSpeedWorkloadLabel||'general';
  const rows=Array.isArray(result[SAMPLES_KEY])?result[SAMPLES_KEY]:[];
  const valid=rows.filter(v=>v.quality==='observed' && v.visibilityState==='visible')
    .map(speed).filter(n=>n!==null);
  const ttfv=rows.filter(v=>v.visibilityState==='visible' && v.timeToFirstVisibleMs!=null)
    .map(v=>Number(v.timeToFirstVisibleMs)).filter(Number.isFinite);
  const saved=rows.filter(v=>v.serverSaved===true).length;
  const formatted=n=>n==null?'Chưa đủ dữ liệu':String(n);
  benchmarkStats.textContent=
    'Số phản hồi đã lưu: '+rows.length+
    '\nMẫu đo tốc độ đủ điều kiện: '+valid.length+
    '\nTrung vị tok/s ước tính: '+formatted(median(valid))+
    '\nTrung vị thời gian đến chữ đầu tiên: '+formatted(median(ttfv))+(ttfv.length?' ms':'')+
    '\nĐã lưu về NHD/ổ D: '+saved+'/'+rows.length+
    '\nLưu ý: token ước tính từ ký tự / 4; không phải token API.';
}
function csvCell(v) {
  const s=String(v==null?'':v);
  return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}
function exportRows(rows,format) {
  if(!rows.length){benchmarkStatus.textContent='Chưa có mẫu để xuất. Hãy gửi một câu hỏi mới trên ChatGPT sau khi tải lại extension.';return;}
  const output=format==='csv'
    ? [CSV_FIELDS.join(','),...rows.map(sample=>{
        const decorated={...sample,
          estimatedOutputTokens:estimateTokens(sample.visibleChars),
          estimatedTokensPerSecond:speed(sample),
          visibleCharsPerSecond:Number(sample.observedDecodeMs)>=250
            ?Math.round(Number(sample.visibleChars)*100000/Number(sample.observedDecodeMs))/100:null
        };
        return CSV_FIELDS.map(k=>csvCell(decorated[k])).join(',');
      })].join('\r\n')+'\r\n'
    : rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  const blob=new Blob([output],{type:format==='csv'?'text/csv;charset=utf-8':'application/x-ndjson;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='nhd-chatgpt-plus-speed-'+new Date().toISOString().slice(0,10)+'.'+(format==='csv'?'csv':'jsonl');
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  benchmarkStatus.textContent='Đã tạo file '+format.toUpperCase()+' ('+rows.length+' mẫu).';
}
chrome.storage.local.get(['endpoint']).then(data=>{
  if(data.endpoint) endpoint.value=data.endpoint;
});
document.getElementById('save').addEventListener('click',async()=>{
  const value=endpoint.value.trim().replace(/\/$/,'');
  if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(value)){
    status.textContent='Chỉ chấp nhận endpoint localhost, ví dụ http://127.0.0.1:39100';
    return;
  }
  await chrome.storage.local.set({endpoint:value});
  status.textContent='Đã lưu endpoint.';
});
document.getElementById('saveBenchmark').addEventListener('click',async()=>{
  await chrome.storage.local.set({
    nhdResponseSpeedEnabled:benchmarkEnabled.checked,
    nhdResponseSpeedModelLabel:modelLabel.value.trim().slice(0,90)||'ChatGPT Plus - model unverified',
    nhdResponseSpeedWorkloadLabel:workloadLabel.value.trim().slice(0,90)||'general'
  });
  benchmarkStatus.textContent='Đã lưu. Cấu hình áp dụng cho các câu trả lời tiếp theo.';
  await refreshBenchmark();
});
document.getElementById('refreshBenchmark').addEventListener('click',refreshBenchmark);
document.getElementById('exportBenchmarkCsv').addEventListener('click',async()=>{
  const data=await chrome.storage.local.get([SAMPLES_KEY]);exportRows(data[SAMPLES_KEY]||[],'csv');
});
document.getElementById('exportBenchmarkJsonl').addEventListener('click',async()=>{
  const data=await chrome.storage.local.get([SAMPLES_KEY]);exportRows(data[SAMPLES_KEY]||[],'jsonl');
});
document.getElementById('syncBenchmark').addEventListener('click',async()=>{
  benchmarkStatus.textContent='Đang gửi các mẫu chưa đồng bộ về NHD...';
  try{
    const result=await chrome.runtime.sendMessage({type:'NHD_RESPONSE_SPEED_SYNC'});
    benchmarkStatus.textContent=result?.ok?
      'Đồng bộ '+result.synced+' mẫu. Chưa đồng bộ: '+result.notSynced+'.':
      'Không thể đồng bộ: '+String(result?.error||'NHD chưa sẵn sàng.');
  }catch(e){benchmarkStatus.textContent='Không thể đồng bộ: '+String(e.message||e);}
  await refreshBenchmark();
});
void refreshBenchmark();
void maybeMaintenanceReload();
