import test from 'node:test';
import assert from 'node:assert/strict';
import { HhtechProvider, containsSecret } from '../dist/sbce-provider.js';
const model=(protocol='openai')=>({id:'m',model:'test-model',provider:'hhtech',protocol,family:'test',tier:'T1',roles:['writer'],enabled:true,vndPerM:350});
test('Secret egress and no vault key fail closed without HTTP',async()=>{
 let calls=0;
 const p=new HhtechProvider(async()=>null,async()=>{calls++;throw Error('should not call');});
 await assert.rejects(p.generate({model:model(),system:'You are a writer',prompt:'normal writing instruction',maxTokens:100}),/VAULT_NOT_CONFIGURED/);
 await assert.rejects(p.generate({model:model(),system:'safe',prompt:'Authorization: Bearer abcdefghijklmnopq',maxTokens:100}),/SECRET_EGRESS_BLOCKED/);
 assert.equal(calls,0);assert.equal(containsSecret('-----BEGIN PRIVATE KEY-----'),true);
});
test('OpenAI compatible adapter sends only to fixed HTTPS endpoint and parses usage',async()=>{
 let seen;
 const p=new HhtechProvider(async()=>'private-test-key-123',async(url,opts)=>{
  seen={url,body:JSON.parse(opts.body),authorization:opts.headers.authorization};
  return new Response(JSON.stringify({choices:[{message:{content:'Hello'}}],usage:{prompt_tokens:40,completion_tokens:8,prompt_tokens_details:{cached_tokens:10}}}),{status:200});
 });
 const out=await p.generate({model:model(),system:'Writer',prompt:'Write concise answer',maxTokens:250});
 assert.equal(seen.url,'https://hhtechapi.com/v1/chat/completions');
 assert.equal(seen.body.max_tokens,250);assert.equal(out.text,'Hello');
 assert.deepEqual(out.usage,{input:40,output:8,cached:10});
});
test('Anthropic adapter parses text blocks and never echoes HTTP response error content',async()=>{
 const p=new HhtechProvider(async()=>'private-test-key-123',async(url,opts)=>{
  assert.equal(url,'https://hhtechapi.com/v1/messages');
  assert.equal(opts.headers['anthropic-version'],'2023-06-01');
  return new Response(JSON.stringify({content:[{type:'text',text:'Approved'}],usage:{input_tokens:30,output_tokens:2}}),{status:200});
 });
 const o=await p.generate({model:model('anthropic'),system:'Judge',prompt:'Check artifact',maxTokens:100});
 assert.equal(o.text,'Approved');
 const bad=new HhtechProvider(async()=>'private-test-key-123',async()=>new Response('secret in error body',{status:500}));
 await assert.rejects(bad.generate({model:model(),system:'s',prompt:'p',maxTokens:1}),/SBCE_PROVIDER_HTTP_500/);
});
