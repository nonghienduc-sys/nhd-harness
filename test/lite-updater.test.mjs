import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
const require=createRequire(import.meta.url);
const core=require("../electron/lite-update-core.cjs");
const { createLiteUpdater }=require("../electron/lite-updater.cjs");
const hash=x=>createHash("sha256").update(x).digest("hex");
const sample=(version,data)=>{
 const b=Buffer.from(data);
 return {tag_name:"lite-v"+version,draft:false,prerelease:false,assets:[{
   name:core.EXE,size:b.length,digest:"sha256:"+hash(b),
   browser_download_url:"https://github.com/nonghienduc-sys/nhd-harness-downloads/releases/download/lite-v"+version+"/"+core.EXE
 }]};
};
const bytes=Buffer.alloc(1_012_000,0x52);
test("semver rejects downgrade and malformed inputs",()=>{
 assert.equal(core.compareVersions("0.24.8","0.24.7"),1);
 assert.equal(core.compareVersions("0.24.7","0.24.7"),0);
 assert.equal(core.compareVersions("0.9.9","0.10.0"),-1);
 for(const s of ["main","0.24.8-beta.1","0.24","0.24.8.exe","999999.0.0"])assert.throws(()=>core.compareVersions(s,"0.24.7"));
});
test("release metadata accepts only stable exact GitHub digest and installer",()=>{
 const ok=core.parseRelease(sample("0.24.8",bytes));
 assert.equal(ok.version,"0.24.8");assert.equal(ok.sha256,hash(bytes));assert.equal(ok.size,bytes.length);
 for(const mutate of [
  x=>x.draft=true,x=>x.prerelease=true,x=>x.tag_name="v0.24.8",
  x=>x.assets[0].digest="sha256:deadbeef",
  x=>x.assets[0].name="evil.exe",
  x=>x.assets[0].browser_download_url="https://evil.example/a.exe",
  x=>x.assets[0].browser_download_url="http://github.com/a.exe",
  x=>x.assets[0].browser_download_url="https://github.com/other/repo/releases/download/lite-v0.24.8/NHD-Harness-Lite-Setup.exe",
  x=>x.assets.push({...x.assets[0]}),
  x=>x.assets[0].size=999_000_000
 ]){const d=sample("0.24.8",bytes);mutate(d);assert.throws(()=>core.parseRelease(d));}
});
test("rejects unapproved redirect origins and traversal",()=>{
 for(const uri of ["http://github.com/x","https://github.com.evil.org/x","https://user:pass@github.com/x","file:///etc/passwd","https://localhost/"]){
   assert.throws(()=>core.safeUrl(uri));
 }
 assert.throws(()=>core.safeTarget("C:\\update","..\\secrets"));
 assert.throws(()=>core.safeTarget("C:\\update","../secrets"));
});
test("fetchChecked refuses untrusted CDN redirects",async()=>{
 let called=0;
 const fake=async()=>{called++;return new Response("",{status:302,headers:{location:"https://malicious.example/evil.exe"}})};
 await assert.rejects(core.fetchChecked("https://github.com/nonghienduc-sys/nhd-harness-downloads/releases/download/lite-v0.24.8/NHD-Harness-Lite-Setup.exe",{fetchImpl:fake}),/Untrusted/);
 assert.equal(called,1);
});
test("verified download accepts exact bytes, fails closed on mismatch and cleans temporary file",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"nhd-updater-bytes-"));
 try{
  const info=core.parseRelease(sample("0.24.8",bytes));
  let count=0;
  const mock=async()=>{count++;return new Response(bytes,{status:200,headers:{"content-length":String(bytes.length)}})};
  const local=await core.downloadVerified(info,dir,{fetchImpl:mock});
  assert.equal(await core.sha256File(local),info.sha256);
  const same=await core.downloadVerified(info,dir,{fetchImpl:mock});
  assert.equal(same,local);assert.equal(count,1);
  writeFileSync(local,"corrupted");
  const fail=async()=>new Response(Buffer.alloc(bytes.length,0x13),{status:200,headers:{"content-length":String(bytes.length)}});
  await assert.rejects(core.downloadVerified(info,dir,{fetchImpl:fail}),/SHA-256/);
  assert(!existsSync(local));assert(!require("node:fs").readdirSync(dir).some(x=>x.endsWith(".partial")));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("backs up only allowlisted configuration, preserves SHA256 and refuses symlink file",()=>{
 const home=mkdtempSync(join(tmpdir(),"nhd-updater-config-"));
 try{
  const bridge=join(home,"bridge-data");mkdirSync(join(bridge,"cloudflare"),{recursive:true});
  writeFileSync(join(bridge,"config.json"),'{"name":"owner"}');
  writeFileSync(join(bridge,"cloudflare","config.yml"),"tunnel: example\n");
  writeFileSync(join(bridge,"secret.dump"),"must not copy");
  const out=join(home,"nhd-updates","transactions","one","backup");
  const manifest=core.backupConfig(home,out);
  assert.equal(manifest.files.length,2);
  assert.equal(manifest.files[0].sha256,hash('{"name":"owner"}'));
  assert(!existsSync(join(out,"secret.dump")));
  assert.equal(readFileSync(join(out,"config.json"),"utf8"),'{"name":"owner"}');
 }finally{rmSync(home,{recursive:true,force:true});}
});
test("transaction stages old and new installers, backups config, blocks stale release, starts only on approved call",{
 skip:process.platform!=="win32"?"Windows package-only service":false
},async()=>{
 const home=mkdtempSync(join(tmpdir(),"nhd-updater-transaction-"));
 try{
  let installed="0.24.7",spawnCount=0,mutated=false;
  const oldBuffer=Buffer.from("old installer"),newBuffer=Buffer.from("new installer");
  const old={version:"0.24.7",tag:"lite-v0.24.7",size:oldBuffer.length,sha256:hash(oldBuffer)};
  const next={version:"0.24.8",tag:"lite-v0.24.8",size:newBuffer.length,sha256:hash(newBuffer)};
  const release=async tag=>{
    if(tag==="lite-v0.24.7")return old;
    return {...next,sha256:mutated?"f".repeat(64):next.sha256};
  };
  const download=async info=>{
    const folder=join(home,"nhd-updates","cache");mkdirSync(folder,{recursive:true});
    const file=join(folder,"cache-"+info.tag+".exe");
    if(!existsSync(file))writeFileSync(file,info.version==="0.24.7"?oldBuffer:newBuffer);
    return file;
  };
  mkdirSync(join(home,"bridge-data"),{recursive:true});
  writeFileSync(join(home,"bridge-data","config.json"),'{"a":1}');
  const updater=createLiteUpdater({
    app:{isPackaged:true,getPath:()=>home,getVersion:()=>installed},
    currentVersion:()=>installed,
    stateRoot:join(home,"nhd-updates"),
    fetchLatest:release,
    download,
    execPath:()=>join(home,"mock-app.exe"),
    spawnGuardian:(_exe,args)=>{spawnCount++;const payload=JSON.parse(Buffer.from(args.at(-1),"base64").toString("utf8"));writeFileSync(join(payload.transactionDir,"guardian-receipt.json"),JSON.stringify({id:payload.id,phase:"waiting-for-exit"}));return {pid:12345,unref(){},kill(){}};},
    healthRequiredSamples:1,
    healthFetch:async()=>new Response(JSON.stringify({version:"0.24.8"}),{status:200,headers:{"content-type":"application/json"}})
  });
  const checked=await updater.check();assert.equal(checked.isNewer,true);assert.equal(checked.latestVersion,"0.24.8");
  const prepared=await updater.prepare();assert.equal(prepared.verified,true);assert.equal(prepared.backupCount,1);
  assert.equal(spawnCount,0,"prepare must never execute installer");
  mutated=true;
  await assert.rejects(updater.install(),/changed/);
  assert.equal(spawnCount,0,"remote digest change must refuse install");
  mutated=false;
  const started=await updater.install();assert.equal(started.started,true);assert.equal(spawnCount,1);
  assert.equal(updater.status().phase,"waiting-for-exit");
  assert.equal(JSON.parse(readFileSync(join(home,"nhd-updates","state.json"),"utf8")).phase,"installing");
  installed="0.24.8";
  assert.equal(await updater.confirmHealthy(),true);
  const state=JSON.parse(readFileSync(join(home,"nhd-updates","state.json"),"utf8"));
  const marker=JSON.parse(readFileSync(join(state.transactionDir,"health-ok.json"),"utf8"));
  assert.equal(marker.backendVersion,"0.24.8");
  assert.equal(marker.id,state.id);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test("Electron integration is opt-in and trusted-origin gated",()=>{
 const main=readFileSync(new URL("../electron/main.cjs",import.meta.url),"utf8");
 assert.match(main,/contextIsolation:\s*true,\s*nodeIntegration:\s*false/);
 assert.match(main,/trustedUpdaterRenderer/);assert.match(main,/event\.senderFrame\.url/);
 assert.match(main,/Check for Updates/);
 assert.match(main,/app\.quit\(\)/);
 const html=readFileSync(new URL("../dashboard/index.html",import.meta.url),"utf8");
 assert.match(html,/id="checkLiteUpdate"/);
 const preload=readFileSync(new URL("../electron/lite-update-preload.cjs",import.meta.url),"utf8");
 assert.match(preload,/127\.0\.0\.1:39100/);
 assert.doesNotMatch(preload,/nodeIntegration:\s*true/);
});
