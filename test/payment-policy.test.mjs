import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPaymentAction, assertPaymentAction, assertPaymentTool } from '../dist/payment-policy.js';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { TerminalService } from '../dist/terminal.js';

test('Unicode, tokens, camelCase, snake_case, URL and non-payment checkout exceptions', () => {
  for (const s of ['Thanh toán','THANH TOAN','chuyển khoản','CHUYEN_TIEN','nạp tiền','đặt hàng','giao dịch tài chính','ＰＡＹＭＥＮＴ','payNow','place-order','wireTransfer','internet_banking','Vietcombank','https://momo.vn','https://example.test/%74hanh%20toan','VNPay','ZaloPay','Stripe']) {
    assert.throws(() => assertPaymentAction(s), /PAYMENT_BLOCKED/, s);
  }
  for (const s of ['momentum','striped','checkoutable','git checkout main','actions/checkout@v4','npm test']) {
    assert.equal(isPaymentAction(s, 'command'), false, s);
  }
  assert.throws(() => assertPaymentAction('git checkout main; pay now', 'command'), /PAYMENT_BLOCKED/);
});
test('only action metadata is checked, never document content or prompt', () => {
  assert.doesNotThrow(() => assertPaymentTool('fs_preview_write', {path:'test.md',content:'Hồ sơ thanh toán'}));
  assert.doesNotThrow(() => assertPaymentTool('receipt_write', {receipt:{task:'payment',checks:[{cmd:'payment'}]}}));
  assert.doesNotThrow(() => assertPaymentTool('office_preview_edit', {operation:'replace', text:'thanh toán'}));
  assert.doesNotThrow(() => assertPaymentTool('code_run',{code:'return "payment"'}));
  assert.throws(() => assertPaymentTool('bank_payment',{}), /PAYMENT_BLOCKED/);
  assert.throws(() => assertPaymentTool('isolated_browser_act',{op:'navigate',url:'https://paypal.com'}), /PAYMENT_BLOCKED/);
  assert.throws(() => assertPaymentTool('browser_batch',{steps:[{action:'click',selectorId:'payNow'}]}), /PAYMENT_BLOCKED/);
  assert.throws(() => assertPaymentTool('terminal_preview',{command:'pay now',task_run_id:'approved',confirmation_token:'approved'}), /PAYMENT_BLOCKED/);
});
test('terminal preview and execute block directly invoked scripts, including changes after preview', async () => {
  const dir=await mkdtemp(join(tmpdir(),'nhd-policy-'));
  const backupDir=join(dir,'backups'); await mkdir(backupDir);
  const config={instanceId:'test',roots:[dir],dataDir:dir,backupDir,writeEnabled:true,terminalEnabled:true,emergencyStop:false};
  const store=new Store(join(dir,'test.sqlite'));
  const files=new FileService(config,store);
  const terminal=new TerminalService(config,store,files,{spawnProcess:()=>{throw new Error('must never spawn');}});
  assert.throws(()=>terminal.preview('pay now',dir,10,{},'approved'),/PAYMENT_BLOCKED/);
  const script=join(dir,'test.ps1');
  const cmd="& '"+script+"'";
  await writeFile(script,"Write-Output 'thanh toán'",'utf8');
  assert.throws(()=>terminal.preview(cmd,dir,10),/PAYMENT_BLOCKED/);
  await writeFile(script,"Write-Output 'ok'",'utf8');
  const p=terminal.preview(cmd,dir,10);
  await writeFile(script,"Write-Output 'chuyển khoản'",'utf8');
  await assert.rejects(terminal.execute(p.actionId,p.commandHash,p.confirmationToken,p.criticalConfirmation),/PAYMENT_BLOCKED/);
});

test('A2: literal data paths and git global options are not payment actions', () => {
  const allowed = [
    'python -I x.py "D:\\Ho so\\Đề nghị thanh toán.docx"',
    'Set-Location "D:\\a\\quyen_thanh_toan"',
    'Get-Content D:\\x\\billing.csv',
    'python wise.py',
    'git -C D:\\x checkout main',
    'git -C "D:\\x\\quyen_thanh_toan" checkout main',
    'git -c k=v checkout main',
    'git -C D:\\x -c k=v checkout main',
    'git add src/payment-policy.ts',
    'npm test',
    'cd "D:\\a\\quyen_thanh_toan"',
    'tool --cwd "D:\\a\\quyen_thanh_toan"',
    "Get-Content 'D:\\Ho so\\Đề nghị thanh toán.docx'"
  ];
  for (const cmd of allowed) assert.equal(isPaymentAction(cmd, 'command'), false, cmd);
});
test('A2: non-data tokens, actual payment commands and URL domains remain blocked', () => {
  const blocked = [
    'echo payment','pay now','curl https://api.stripe.com/v1/charges',
    'python payment.py','D:\\x\\paypal.exe','npm run payment',
    'Start-Process https://vnpay.vn','git checkout main; pay now',
    'git -C D:\\x checkout main; pay now','git -c payment=1 checkout main',
    'payment.ts','echo --payment','echo payment --cwd D:\\x',
    'curl https://example.test/payment.json','python "D:\\x\\payment.ps1"',
    'echo "$(pay now).docx"', 'cd https://paypal.com'
  ];
  for (const cmd of blocked) assert.throws(() => assertPaymentAction(cmd, 'command'), /PAYMENT_BLOCKED/, cmd);
  for (const [word,domain] of [['wise','wise.com'],['vib','vib.com.vn'],['ocb','ocb.com.vn'],['acb','acb.com.vn'],['msb','msb.com.vn'],['shb','shb.com.vn']]) {
    assert.equal(isPaymentAction(word), false, word);
    assert.equal(isPaymentAction('python '+word+'.py','command'), false, word);
    assert.throws(()=>assertPaymentAction('https://'+domain+'/'),/PAYMENT_BLOCKED/);
    assert.throws(()=>assertPaymentAction('curl https://api.'+domain+'/','command'),/PAYMENT_BLOCKED/);
  }
});
