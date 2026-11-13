import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {scanCatalog,scanText,summarize} from './security_core.mjs';

function arg(name,def=null){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:def;}
const catalogPath=resolve(arg('--catalog','docs/generated/capability-catalog.json'));
const skillsRoot=resolve(arg('--skills','skills'));
const catalog=JSON.parse(await readFile(catalogPath,'utf8'));
let findings=scanCatalog(catalog);
for(const e of await readdir(skillsRoot,{withFileTypes:true})){
  if(!e.isDirectory())continue;
  if(['mcp-security-audit','agent-security-regression'].includes(e.name))continue;
  const p=join(skillsRoot,e.name,'SKILL.md');
  try{const text=await readFile(p,'utf8');findings.push(...scanText(text,{source:`skill:${e.name}`}));}catch{}
}
const summary=summarize(findings);
console.log(JSON.stringify({schemaVersion:1,catalog:catalogPath,skillsRoot,summary,findings},null,2));
process.exitCode=summary.pass?0:2;
