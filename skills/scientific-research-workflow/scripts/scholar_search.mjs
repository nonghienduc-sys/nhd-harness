import {writeFile} from 'node:fs/promises';

function arg(name,def=null){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:def;}
const action=process.argv[2]||'search';
const query=arg('--query','');
const doiInput=arg('--doi','');
const limit=Math.max(1,Math.min(Number(arg('--limit','8'))||8,25));
const outPath=arg('--out');
const timeoutMs=Math.max(1000,Math.min(Number(arg('--timeout-ms','15000'))||15000,30000));
const UA='NHD-MCP-Scholar/1.0 (local research metadata client)';

function cleanDoi(v){return String(v||'').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').toLowerCase();}
function cleanTitle(v){return String(v||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function yearFromDate(v){const m=String(v||'').match(/\b(19|20)\d{2}\b/);return m?Number(m[0]):null;}
function first(...xs){for(const x of xs)if(x!==undefined&&x!==null&&x!=='')return x;return null;}
function authorsToText(xs){return (xs||[]).map(x=>typeof x==='string'?x:[x?.given,x?.family].filter(Boolean).join(' ')||x?.author?.display_name||x?.name).filter(Boolean);}
async function getJson(url){
 const controller=new AbortController(); const t=setTimeout(()=>controller.abort(),timeoutMs);
 try{
   const r=await fetch(url,{headers:{'user-agent':UA,'accept':'application/json'},signal:controller.signal});
   if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
   return await r.json();
 }finally{clearTimeout(t)}
}

async function openAlexSearch(q,n){
 const url=`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}&select=id,doi,title,publication_year,publication_date,type,cited_by_count,is_retracted,authorships,primary_location,open_access`;
 const data=await getJson(url);
 return (data.results||[]).map(w=>({
   provider:'openalex', providerId:w.id, doi:cleanDoi(w.doi), title:w.title||'', year:w.publication_year||yearFromDate(w.publication_date),
   publicationDate:w.publication_date||null, venue:w.primary_location?.source?.display_name||null, type:w.type||null,
   authors:(w.authorships||[]).map(a=>a.author?.display_name).filter(Boolean), citationCount:Number(w.cited_by_count||0),
   isRetracted:!!w.is_retracted, url:first(w.primary_location?.landing_page_url,w.doi,w.id), oaUrl:first(w.open_access?.oa_url), abstract:null
 }));
}
async function crossrefSearch(q,n){
 const url=`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=${n}&select=DOI,title,author,published,created,container-title,type,URL,is-referenced-by-count`;
 const data=await getJson(url);
 return (data.message?.items||[]).map(w=>{
   const parts=w.published?.['date-parts']?.[0]||w.created?.['date-parts']?.[0]||[];
   const date=parts.length?parts.map((x,i)=>String(x).padStart(i?'2':'4','0')).join('-'):null;
   return {provider:'crossref',providerId:w.DOI||null,doi:cleanDoi(w.DOI),title:w.title?.[0]||'',year:parts[0]||null,publicationDate:date,
    venue:w['container-title']?.[0]||null,type:w.type||null,authors:authorsToText(w.author),citationCount:Number(w['is-referenced-by-count']||0),
    isRetracted:null,url:first(w.URL,w.DOI?`https://doi.org/${w.DOI}`:null),oaUrl:null,abstract:null};
 });
}
async function semanticScholarSearch(q,n){
 const fields='paperId,title,year,authors,venue,url,citationCount,externalIds,abstract,publicationDate,publicationTypes';
 const url=`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${n}&fields=${encodeURIComponent(fields)}`;
 const data=await getJson(url);
 return (data.data||[]).map(w=>({provider:'semanticscholar',providerId:w.paperId,doi:cleanDoi(w.externalIds?.DOI),title:w.title||'',year:w.year||yearFromDate(w.publicationDate),
   publicationDate:w.publicationDate||null,venue:w.venue||null,type:w.publicationTypes?.[0]||null,authors:(w.authors||[]).map(a=>a.name).filter(Boolean),
   citationCount:Number(w.citationCount||0),isRetracted:null,url:w.url||null,oaUrl:null,abstract:w.abstract||null}));
}

function mergeRows(rows){
 const map=new Map();
 for(const r of rows){
   const key=r.doi?`doi:${r.doi}`:`title:${cleanTitle(r.title)}`;
   if(!key||key==='title:')continue;
   const cur=map.get(key)||{doi:r.doi||null,title:r.title||'',year:r.year||null,publicationDate:r.publicationDate||null,venue:r.venue||null,type:r.type||null,
     authors:r.authors||[],citationCount:r.citationCount||0,isRetracted:r.isRetracted??null,url:r.url||null,oaUrl:r.oaUrl||null,abstract:r.abstract||null,providers:[],providerIds:{}};
   cur.doi=first(cur.doi,r.doi);cur.title=first(cur.title,r.title);cur.year=first(cur.year,r.year);cur.publicationDate=first(cur.publicationDate,r.publicationDate);
   cur.venue=first(cur.venue,r.venue);cur.type=first(cur.type,r.type);cur.authors=cur.authors?.length?cur.authors:(r.authors||[]);
   cur.citationCount=Math.max(Number(cur.citationCount||0),Number(r.citationCount||0));
   if(r.isRetracted===true)cur.isRetracted=true; else if(cur.isRetracted===null&&r.isRetracted===false)cur.isRetracted=false;
   cur.url=first(cur.url,r.url);cur.oaUrl=first(cur.oaUrl,r.oaUrl);cur.abstract=first(cur.abstract,r.abstract);
   if(!cur.providers.includes(r.provider))cur.providers.push(r.provider);cur.providerIds[r.provider]=r.providerId;
   map.set(key,cur);
 }
 return [...map.values()].sort((a,b)=>Number(b.citationCount||0)-Number(a.citationCount||0));
}
async function resolveDoi(doi){
 const q=cleanDoi(doi); if(!q)throw new Error('--doi is required');
 const rows=[];const errors=[];
 for(const [name,fn] of [
   ['openalex',async()=>{const w=await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(q)}`);return [{provider:'openalex',providerId:w.id,doi:cleanDoi(w.doi),title:w.title||'',year:w.publication_year||yearFromDate(w.publication_date),publicationDate:w.publication_date||null,venue:w.primary_location?.source?.display_name||null,type:w.type||null,authors:(w.authorships||[]).map(a=>a.author?.display_name).filter(Boolean),citationCount:Number(w.cited_by_count||0),isRetracted:!!w.is_retracted,url:first(w.primary_location?.landing_page_url,w.doi,w.id),oaUrl:first(w.open_access?.oa_url),abstract:null}]}],
   ['crossref',async()=>{const w=(await getJson(`https://api.crossref.org/works/${encodeURIComponent(q)}`)).message;const parts=w?.published?.['date-parts']?.[0]||w?.created?.['date-parts']?.[0]||[];const date=parts.length?parts.map((x,i)=>String(x).padStart(i?'2':'4','0')).join('-'):null;return [{provider:'crossref',providerId:w?.DOI||null,doi:cleanDoi(w?.DOI),title:w?.title?.[0]||'',year:parts[0]||null,publicationDate:date,venue:w?.['container-title']?.[0]||null,type:w?.type||null,authors:authorsToText(w?.author),citationCount:Number(w?.['is-referenced-by-count']||0),isRetracted:null,url:first(w?.URL,w?.DOI?`https://doi.org/${w.DOI}`:null),oaUrl:null,abstract:null}]}],
   ['semanticscholar',async()=>{const fields='paperId,title,year,authors,venue,url,citationCount,externalIds,abstract,publicationDate,publicationTypes';const d=await getJson(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(q)}?fields=${encodeURIComponent(fields)}`);return [{provider:'semanticscholar',providerId:d.paperId,doi:cleanDoi(d.externalIds?.DOI),title:d.title||'',year:d.year||yearFromDate(d.publicationDate),publicationDate:d.publicationDate||null,venue:d.venue||null,type:d.publicationTypes?.[0]||null,authors:(d.authors||[]).map(a=>a.name).filter(Boolean),citationCount:Number(d.citationCount||0),isRetracted:null,url:d.url||null,oaUrl:null,abstract:d.abstract||null}]}]
 ]){
   try{rows.push(...await fn())}catch(e){errors.push({provider:name,error:e instanceof Error?e.message:String(e)})}
 }
 const exact=mergeRows(rows).filter(r=>r.doi===q);
 return {schemaVersion:1,action:'resolve-doi',doi:q,results:exact,errors};
}

async function main(){
 let payload;
 if(action==='search'){
   if(!query)throw new Error('--query is required');
   const rows=[];const errors=[];
   const providers=[['openalex',openAlexSearch],['crossref',crossrefSearch],['semanticscholar',semanticScholarSearch]];
   const settled=await Promise.all(providers.map(async([name,fn])=>{try{return{name,rows:await fn(query,limit)}}catch(e){return{name,error:e instanceof Error?e.message:String(e)}}}));
   for(const x of settled){if(x.rows)rows.push(...x.rows);else errors.push({provider:x.name,error:x.error})}
   payload={schemaVersion:1,action:'search',query,providerCount:providers.length,results:mergeRows(rows).slice(0,limit),errors};
 }else if(action==='resolve-doi')payload=await resolveDoi(doiInput);
 else throw new Error('Usage: scholar_search.mjs <search|resolve-doi> --query TEXT|--doi DOI [--limit N] [--out file.json]');
 const text=JSON.stringify(payload,null,2); console.log(text); if(outPath)await writeFile(outPath,text,'utf8');
 if(!payload.results?.length)process.exitCode=2;
}
await main();
