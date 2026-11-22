import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PlaybookRunner } from "../dist/playbook-runner.js";

function fixture() {
  const root=mkdtempSync(join(tmpdir(),"p6-runner-"));
  const publicDir=join(root,"public"),localDir=join(root,"local"),dataDir=join(root,"state");
  mkdirSync(join(localDir,"quy_trinh"),{recursive:true});mkdirSync(publicDir);
  const process = (id,steps) => {
    const rows=steps.map((s,i)=>"  - so: "+(i+1)+"\n    viec: "+s.viec+(s.cong?"\n    cong: ["+s.cong.join(", ")+"]":"")).join("\n");
    writeFileSync(join(localDir,"quy_trinh",id+".md"),
      "---\nid: "+id+"\nten: Test\ntu_khoa: [test]\nkhi_nao: test\nbuoc:\n"+rows+"\n---\nTest\n","utf8");
  };
  const gates = value=>writeFileSync(join(localDir,"cong.json"),JSON.stringify(value),"utf8");
  const executeGate=async(command,cwd,timeout)=>{
    const match=/^node -e "([^"]+)"$/.exec(command);
    if(!match) throw Error("TEST_ONLY_COMMAND_NOT_ALLOWED");
    const out=spawnSync(processExec(),["-e",match[1]],{cwd,encoding:"utf8",timeout:timeout*1000});
    return {code:out.status,stdout:out.stdout??"",stderr:out.stderr??"",timedOut:Boolean(out.error?.code==="ETIMEDOUT")};
  };
  const options={dataDir,knowledge:{publicDir,localDir},executeGate};
  return {root,process,gates,runner:()=>new PlaybookRunner(options)};
}
function processExec(){return process.execPath;}
async function runFixture(fn){const x=fixture();try{await fn(x)}finally{rmSync(x.root,{recursive:true,force:true})}}
test("a: start -> next returns first step",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"Prepare"},{viec:"Run"}]);
  const r=await f.runner().handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  const n=await f.runner().handle({op:"next",run_id:r.run_id});
  assert.equal(n.buoc.so,1);assert.equal(n.buoc.viec,"Prepare");
}));
test("b: no gate advances immediately",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"Prepare"},{viec:"Run"}]);
  const runner=f.runner(),r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  const done=await runner.handle({op:"done_step",run_id:r.run_id,so:1});
  assert.equal(done.dat,true);assert.equal(done.buoc_hien_tai,2);
}));
test("c: failed gate stays on step and stores error",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"Fail",cong:["fail"]}]);f.gates({fail:{cmd:'node -e "process.exit(3)"',expect_exit:0}});
  const runner=f.runner(),r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  const done=await runner.handle({op:"done_step",run_id:r.run_id,so:1});
  assert.equal(done.dat,false);assert.equal(done.buoc_hien_tai,1);assert.equal(done.ket_qua_cong[0].exit,3);
}));
test("d: passing gate advances and finishes; regex checked",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"Pass",cong:["ok"]}]);f.gates({ok:{cmd:'node -e "console.log(\'DAT\')"',expect_exit:0,expect_regex:"DAT"}});
  const runner=f.runner(),r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  const done=await runner.handle({op:"done_step",run_id:r.run_id,so:1});
  assert.equal(done.dat,true);assert.equal(done.trang_thai,"completed");assert.match(done.ket_qua_cong[0].output_tail,/DAT/);
}));
test("e: skipping step is rejected",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"A"},{viec:"B"}]);
  const runner=f.runner(),r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  await assert.rejects(runner.handle({op:"done_step",run_id:r.run_id,so:2}),/OUT_OF_ORDER/);
}));
test("f: new runner on same data dir resumes",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"A"},{viec:"B"}]);
  const r=await f.runner().handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  await f.runner().handle({op:"done_step",run_id:r.run_id,so:1});
  assert.equal((await f.runner().handle({op:"status",run_id:r.run_id})).buoc_hien_tai,2);
}));
test("g: unresolved gate variable blocks before execution",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"Gate",cong:["needs"]}]);f.gates({needs:{cmd:'node -e "console.log(\'{marker}\')"'}});
  const runner=f.runner(),r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  await assert.rejects(runner.handle({op:"done_step",run_id:r.run_id,so:1}),/MISSING_VARIABLES/);
  assert.equal((await runner.handle({op:"status",run_id:r.run_id})).buoc_hien_tai,1);
}));
test("h: brain cannot supply executable command or inject via variables",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"Gate",cong:["ok"]}]);f.gates({ok:{cmd:'node -e "process.exit(0)"'}});
  const runner=f.runner(),r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  await assert.rejects(runner.handle({op:"done_step",run_id:r.run_id,so:1,bien:{tep:'x"; exit 1; "'}}),/INVALID_VARIABLE/);
  const done=await runner.handle({op:"done_step",run_id:r.run_id,so:1,bien:{command:"do something"}});
  assert.equal(done.dat,true);assert.equal(done.ket_qua_cong[0].cmd,'node -e "process.exit(0)"');
}));
test("i: timeout is a failed gate",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"Slow",cong:["slow"]}]);f.gates({slow:{cmd:'node -e "while(true){}"',timeout_s:1}});
  const runner=f.runner(),r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  const done=await runner.handle({op:"done_step",run_id:r.run_id,so:1});
  assert.equal(done.dat,false);assert.equal(done.ket_qua_cong[0].timed_out,true);assert.equal(done.buoc_hien_tai,1);
}));
test("list and abort retain history",async()=>runFixture(async f=>{
  f.process("demo",[{viec:"A"}]);const runner=f.runner();
  const r=await runner.handle({op:"start",quy_trinh_id:"demo",muc_tieu:"Task"});
  const a=await runner.handle({op:"abort",run_id:r.run_id,ly_do:"Stop"});assert.equal(a.trang_thai,"aborted");
  const l=await runner.handle({op:"list",trang_thai:"aborted"});assert.equal(l.runs.length,1);
}));
