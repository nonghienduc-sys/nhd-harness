import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
function recoveryHarness() {
  let now=0, next=0;
  const jobs=new Map(), starts=[], logs=[];
  const context=vm.createContext({ shuttingDown:false, backendRecoveryTimer:null, backendRestartAttempt:9,
    backendRecoveryDelayMs:()=>30400,
    bridgeLog:(...args)=>logs.push(args),
    ensureProcesses:async reason=>{starts.push({at:now,reason})},
    setTimeout:(fn,delay)=>{const id=++next;jobs.set(id,{fn,at:now+delay});return id},
    clearTimeout:id=>jobs.delete(id),
  });
  const start=source.indexOf('function scheduleBackendRecovery(');
  const end=source.indexOf('\nasync function waitUntilAvailable',start);
  vm.runInContext(source.slice(start,end),context);
  return {context,jobs,starts,logs,schedule(reason){context.scheduleBackendRecovery(reason)},async advance(ms){const target=now+ms;for(;;){const due=[...jobs.entries()].filter(([,j])=>j.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;jobs.delete(due[0]);due[1].fn();await Promise.resolve()}now=target}};
}
test('watchdog cannot postpone a pending maximum-backoff restart every 30 seconds',async()=>{
  const h=recoveryHarness();h.schedule('backend-exit-recovery');
  await h.advance(30000);h.schedule('watchdog-recovery');
  assert.equal(h.jobs.size,1);assert.equal(h.logs.length,1);
  await h.advance(400);assert.equal(h.starts.length,1);assert.equal(h.starts[0].at,30400);
  assert.equal(h.context.backendRecoveryTimer,null);
  h.schedule('next-failure');await h.advance(30400);assert.equal(h.starts.length,2);
});
test('shutdown suppresses restart scheduling',()=>{const h=recoveryHarness();h.context.shuttingDown=true;h.schedule('exit');assert.equal(h.jobs.size,0)});
test('health probes consume response bodies and keep the HTTP connection reusable',async()=>{
  let consumed=0;const context=vm.createContext({AbortSignal,fetch:async()=>({ok:true,arrayBuffer:async()=>{consumed++}})});
  const a=source.indexOf('async function available('),b=source.indexOf('\nfunction sleep(',a);
  vm.runInContext(source.slice(a,b),context);assert.equal(await context.available('http://localhost/health'),true);assert.equal(consumed,1);
});
