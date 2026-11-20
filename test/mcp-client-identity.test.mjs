import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  resolveMcpClientIdentityKey,
  rememberMcpClient,
  getMcpClient,
  observedMcpClients
} from '../dist/mcp-client-identity.js';

test('identity key precedence: session, authenticated bearer SHA256 prefix, then explicit connection', () => {
 const bearer = 'Bearer example-local-only-test-credential';
 const hash = createHash('sha256').update('example-local-only-test-credential').digest('hex').slice(0,16);
 const bearerKey = resolveMcpClientIdentityKey({authorization:bearer,authenticatedBearer:true,connectionKey:'legacy:one'});
 assert.equal(bearerKey,'bearer:'+hash);
 assert.equal(bearerKey.length,23);
 assert.notEqual(resolveMcpClientIdentityKey({authorization:'Bearer different',authenticatedBearer:true}),bearerKey);
 assert.equal(resolveMcpClientIdentityKey({sessionId:'session-1',authorization:bearer,authenticatedBearer:true,connectionKey:'legacy:one'}),
   'session:'+createHash('sha256').update('session-1').digest('hex').slice(0,16));
 assert.equal(resolveMcpClientIdentityKey({authorization:bearer,authenticatedBearer:false,connectionKey:'legacy:one'}),'legacy:one');
 assert.equal(resolveMcpClientIdentityKey({authorization:bearer}),null);
 assert.equal(resolveMcpClientIdentityKey({connectionKey:'legacy:one'}),'legacy:one');
 rememberMcpClient(bearerKey,{name:'thin-client',version:'1'});
 assert.deepEqual(getMcpClient(bearerKey),{name:'thin-client',version:'1'});
 assert.equal(getMcpClient('bearer:unrelated'),null);
 const observed=observedMcpClients();
 assert.ok(observed.some(x=>x.name==='thin-client'&&x.version==='1'));
 assert.ok(observed.length<=20);
 assert.ok(observed.every(x=>Object.keys(x).sort().join(',')==='name,version'));
 assert.doesNotMatch(JSON.stringify(observed),/example-local-only-test-credential|bearer:|session:|127\.0\.0\.1/);
});
