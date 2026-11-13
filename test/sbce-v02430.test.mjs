// 0.24.30: the SBCE board script actually renders (0.24.29 shipped a variable that shadowed status(), so rows never drew).
import test from 'node:test';import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';import vm from'node:vm';
const job={id:'job-1b2c3d4e-0000-4000-8000-123456789abc',title:'Checklist <b>x</b>',kind:'doc_write',status:'ready_for_review',createdAt:'2026-11-13T01:00:00Z',spentVnd:3,budgetVnd:20,attempts:1,writers:['writer-a'],judges:['judge-b'],calls:[{modelId:'writer-a',role:'writer',state:'settled',costVnd:2,at:'2026-11-13T01:00:00Z'},{modelId:'judge-b',role:'judge',state:'settled',costVnd:1,at:'2026-11-13T01:00:01Z'}],review:{summary:'ok',checks:[{name:'L0_artifact_shape',ok:true},{name:'L1_cross_family_judge',ok:true}],risks:[],tokensIn:10,tokensOut:5}};
function harness(){
 const els={};const el=id=>els[id]??=({id,innerHTML:'',textContent:'',hidden:true,disabled:false,classList:{contains:c=>id==='sbce'&&c==='active',toggle(){},remove(){}},onclick:null,addEventListener(){}});
 const requests=[];
 const fetch=async(url,opt={})=>{requests.push({url,opt});
  const body=url==='/api/sbce/status'?{status:'online',mode:'shadow',modelCount:5}:url.startsWith('/api/sbce/jobs?')?{mode:'shadow',jobs:[job],totals:{jobCount:1,spentVnd:3},budget:{usedVnd:3,limitVnd:300000}}:url.endsWith('/review')?{...job,status:'accepted'}:{...job,draft:{text:'<script>alert(1)</script> nội dung',totalChars:30,truncated:false}};
  return {ok:true,json:async()=>body};};
 const confirms=[];
 const ctx={window:{},document:{readyState:'complete',getElementById:el,querySelectorAll:()=>[],addEventListener(){}},fetch,setInterval:()=>1,clearInterval(){},console};
 ctx.window.prompt=()=>'ghi chú';ctx.window.confirm=m=>{confirms.push(m);return true;};
 vm.createContext(ctx);vm.runInContext(readFileSync('dashboard/sbce-panel.js','utf8'),ctx);
 return {els,el,requests,confirms,ctx};
}
const tick=()=>new Promise(r=>setTimeout(r,20));
test('board renders metrics and job rows with writer/judge/cost/checks, escaping titles',async()=>{
 const h=harness();await h.ctx.window.loadSbceBoard();
 assert.match(h.el('sbceBoardStatus').textContent,/^Cập nhật/);
 assert.match(h.el('sbceMetrics').innerHTML,/Online/);
 const rows=h.el('sbceJobRows').innerHTML;
 assert.match(rows,/Chờ duyệt/);assert.match(rows,/writer-a/);assert.match(rows,/judge-b/);assert.match(rows,/L1 judge chéo họ/);
 assert.match(rows,/Checklist &lt;b&gt;x&lt;\/b&gt;/);assert.equal(rows.includes('<b>x</b>'),false);
});
test('review button needs confirmation and sends confirmed:true',async()=>{
 const h=harness();await tick();
 const draftHolder=h.el('sbceDraft');
 const rows=[];h.ctx.document.querySelectorAll=sel=>{if(sel.includes('tr[data-job]')){const r={dataset:{job:job.id},classList:{toggle(){}}};rows.push(r);return [r];}return[];};
 await h.ctx.window.loadSbceBoard();await rows[0].onclick();await tick();
 assert.equal(draftHolder.textContent.includes('<script>alert(1)</script>'),true,'draft goes to textContent, not HTML');
 assert.equal(h.el('sbceAccept').disabled,false);
 await h.el('sbceAccept').onclick();await tick();
 assert.equal(h.confirms.length,1);
 const post=h.requests.find(r=>r.url.endsWith('/review'));
 assert.deepEqual(JSON.parse(post.opt.body),{decision:'accept',note:'ghi chú',confirmed:true});
});
