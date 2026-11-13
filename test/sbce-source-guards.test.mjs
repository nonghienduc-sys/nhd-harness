import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
test('Emergency stop halts executor and startup cannot bypass it',()=>{
 const server=read('src/server.ts');
 assert.match(server,/if \(config\.emergencyStop\) \{[\s\S]*?sbceExecutor\.stop\(\)/);
 assert.match(server,/if\(!config\.emergencyStop\)try \{ sbceExecutor\.start\(\)/);
 assert.match(server,/SBCE_EMERGENCY_STOP/);
});
test('Model enabling requires authenticated owner-approved pricing audit',()=>{
 const catalog=read('src/sbce-catalog.ts');
 assert.match(catalog,/account_usage/);assert.match(catalog,/billing_statement/);
 assert.match(catalog,/approvedByOwner/);assert.match(catalog,/SBCE_MODEL_UNCALIBRATED/);
 const model=JSON.parse(read('registry/sbce-model-catalog.template.json'));
 assert.ok(model.models.length>=5);
 assert.ok(model.models.every(m=>m.enabled===false&&m.priceAudit===undefined));
});
test('SBCE handler never exposes unowned job-list/status in worker',()=>{
 const worker=read('src/sbce-worker.ts');
 assert.doesNotMatch(worker,/app\.get\("\/jobs"/);
 assert.doesNotMatch(worker,/app\.get\("\/jobs\/:id"/);
 assert.match(worker,/store\.listOwned/);assert.match(worker,/store\.getOwned/);
 const facade=read('src/mcp-registries/delegation-tools.ts');
 assert.match(facade,/SBCE_TASK_RUN_REQUIRED/);
});
