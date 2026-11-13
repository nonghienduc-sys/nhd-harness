import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultPayloadGatewayService, scalarDigest } from '../dist/result-payload-gateway.js';

test('scalarDigest surfaces key status fields from nested health payloads', () => {
  const digest = scalarDigest({ available: true, state: 'healthy', failureCount: 0, data: { version: '0.24.11', tunnel: { running: true, url: 'https://x' }, noise: 'zzz' } });
  assert.match(digest, /state=healthy/);
  assert.match(digest, /failureCount=0/);
  assert.match(digest, /data\.version=0\.24\.11/);
  assert.match(digest, /data\.tunnel\.running=true/);
  assert.equal(digest.includes('noise'), false);
});

test('compacted health text carries the status summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'nhd-dot1-'));
  try {
    const gateway = new ResultPayloadGatewayService({ enabled: true, artifactRoot: root, thresholdChars: 16000, safeTools: ['workstation_health_fast'] });
    const big = { available: true, state: 'healthy', failureCount: 0, data: { version: '0.24.11', blob: 'x'.repeat(40000) } };
    const decision = gateway.process('workstation_health_fast', { structuredContent: big, content: [{ type: 'text', text: JSON.stringify(big) }] }, {}, { readOnlyHint: true });
    assert.equal(decision.compacted, true);
    const text = decision.output.content[0].text;
    assert.match(text, /Summary: .*state=healthy/);
    assert.ok(text.length < 2000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
