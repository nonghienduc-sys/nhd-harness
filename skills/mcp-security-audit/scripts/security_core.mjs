const CONTROL_RE=/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;
const URL_RE=/https?:\/\/[^\s)\]}>"']+/giu;
const RULES=[
  {id:'ignore-authority',severity:'high',re:/\b(ignore|disregard|override)\b.{0,80}\b(system|developer|previous(?:\s+instructions?)?|safety|policy)\b/iu,reason:'Attempts to override higher-priority instructions.'},
  {id:'safety-bypass',severity:'critical',re:/\b(disable|bypass|circumvent|turn off|evade)\b.{0,80}\b(safety|guardrail|authorization|confirmation|policy|security)\b/iu,reason:'Explicit safety or authorization bypass language.'},
  {id:'secret-exfiltration',severity:'critical',re:/\b(send|upload|post|exfiltrat|transmit|share)\w*\b.{0,120}\b(secret|token|password|credential|cookie|api[ _-]?key|private key)\b/iu,reason:'Requests transfer of secrets or credentials.'},
  {id:'tool-poisoning',severity:'high',re:/\b(tool|function|mcp)\b.{0,100}\b(must|always|before|instead)\b.{0,120}\b(call|execute|run|invoke)\b/iu,reason:'Tool metadata appears to instruct unrelated tool execution.'},
  {id:'destructive-side-effect',severity:'high',re:/\b(delete|remove|erase|wipe|send|submit|purchase|pay|transfer|upload)\b.{0,100}\b(without|no need|do not ask|skip)\b.{0,80}\b(confirm|permission|approval|user)\b/iu,reason:'Requests side effects while suppressing confirmation.'},
  {id:'shell-instruction',severity:'medium',re:/\b(powershell|cmd\.exe|bash|sh -c|invoke-expression|\biex\b|curl\s+[^\n]+\|\s*(?:sh|bash))\b/iu,reason:'Contains shell execution language requiring review.'},
  {id:'credential-language',severity:'medium',re:/\b(password|credential|cookie|bearer token|api[ _-]?key|private key)\b/iu,reason:'References credential-like material.'}
];

export function scanText(text,{source='text'}={}){
  const value=String(text??'').replace(/^\uFEFF/,'');
  const findings=[];
  const isNegated=(index)=>/(?:never|not|cannot|can't|must not|do not|does not|without)\s+[^\n]{0,32}$/iu.test(value.slice(Math.max(0,index-60),index));
  if(CONTROL_RE.test(value)) findings.push({id:'hidden-unicode',severity:'high',source,reason:'Contains bidirectional/zero-width control characters.'});
  for(const rule of RULES){
    const match=value.match(rule.re);
    if(match){
      const index=value.indexOf(match[0]);
      if((rule.id==='safety-bypass'||rule.id==='ignore-authority'||rule.id==='destructive-side-effect') && isNegated(index)) continue;
      findings.push({id:rule.id,severity:rule.severity,source,reason:rule.reason,evidence:String(match[0]).slice(0,220)});
    }
  }
  const urls=[...new Set(value.match(URL_RE)??[])];
  for(const url of urls){
    let host=''; try{host=new URL(url).hostname.toLowerCase();}catch{}
    if(host && !['github.com','arxiv.org','openai.com','www.openai.com','modelcontextprotocol.io'].includes(host)) findings.push({id:'remote-url',severity:'medium',source,reason:`References remote host ${host}.`,evidence:url.slice(0,220)});
  }
  return findings;
}

export function scanCatalog(catalog){
  const rows=Array.isArray(catalog)?catalog:(Array.isArray(catalog?.tools)?catalog.tools:[]);
  const findings=[]; const seen=new Map();
  for(const row of rows){
    const name=String(row?.name??'').trim();
    if(name){
      const n=(seen.get(name)??0)+1; seen.set(name,n);
      if(n>1) findings.push({id:'duplicate-tool-name',severity:'high',source:`tool:${name}`,reason:'Duplicate MCP tool name can enable shadowing/confusion.'});
    }
    findings.push(...scanText([row?.name,row?.description,JSON.stringify(row?.inputSchema??{})].filter(Boolean).join('\n'),{source:`tool:${name||'<unnamed>'}`}));
  }
  return findings;
}

export function summarize(findings){
  const order={critical:4,high:3,medium:2,low:1,info:0};
  const counts={critical:0,high:0,medium:0,low:0,info:0};
  for(const f of findings) counts[f.severity]=(counts[f.severity]??0)+1;
  const max=findings.reduce((a,f)=>Math.max(a,order[f.severity]??0),0);
  const severity=Object.entries(order).find(([,n])=>n===max)?.[0]??'info';
  return {severity,counts,total:findings.length,pass:(counts.critical+counts.high)===0};
}
