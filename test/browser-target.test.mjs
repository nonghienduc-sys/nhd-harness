import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBrowserTarget } from '../dist/browser.js';

const target=(id,url,title='')=>({id,type:'page',title,url,webSocketDebuggerUrl:`ws://127.0.0.1/${id}`});

test('browser target affinity prefers an explicit selector target',()=>{
  const pages=[target('sync','edge://sync-confirmation-dialog/'),target('active','https://example.com/'),target('preferred','https://preferred.test/')];
  assert.equal(selectBrowserTarget(pages,'preferred','active')?.id,'preferred');
});

test('browser target affinity keeps the currently controlled target',()=>{
  const pages=[target('sync','edge://sync-confirmation-dialog/'),target('active','https://example.com/')];
  assert.equal(selectBrowserTarget(pages,null,'active')?.id,'active');
});

test('unbound browser target selection prefers about:blank over Edge internal pages',()=>{
  const pages=[target('sync','edge://sync-confirmation-dialog/'),target('blank','about:blank'),target('web','https://example.com/')];
  assert.equal(selectBrowserTarget(pages)?.id,'blank');
});

test('unbound browser target selection prefers HTTP(S) when about:blank is absent',()=>{
  const pages=[target('sync','edge://sync-confirmation-dialog/'),target('web','https://example.com/')];
  assert.equal(selectBrowserTarget(pages)?.id,'web');
});

test('browser target selector never chooses an internal-only Edge or Chrome target',()=>{
  const pages=[target('sync','edge://sync-confirmation-dialog/'),target('settings','chrome://settings/')];
  assert.equal(selectBrowserTarget(pages),null);
});

test('missing active target safely falls back to a controlled web target',()=>{
  const pages=[target('sync','edge://sync-confirmation-dialog/'),target('web','https://example.com/')];
  assert.equal(selectBrowserTarget(pages,null,'missing')?.id,'web');
});
