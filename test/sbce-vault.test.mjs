import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import{join}from'node:path';import{tmpdir}from'node:os';
import{SbceVault}from'../dist/sbce-vault.js';
test('DPAPI CurrentUser encrypts and decrypts with no plaintext on disk',{skip:process.platform!=='win32'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sbce-vault-'));try{
  const vault=new SbceVault(dir),fake='test-ephemeral-0123456789-not-real';
  assert.equal(await vault.load(),null);
  await vault.save(fake);
  const ciphertext=readFileSync(vault.path,'utf8');
  assert.ok(ciphertext.length>40);
  assert.equal(ciphertext.includes(fake),false);
  assert.equal(await vault.load(),fake);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
