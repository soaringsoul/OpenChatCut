import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Health is persisted under the runtime profile; keep this check out of the real data dir.
process.env.OPENCHATCUT_DATA_DIR = mkdtempSync(join(tmpdir(), 'model-health-verify-'));
const { classifyHealth } = await import('./model-health.ts');

assert.equal(classifyHealth(200), 'ok');
assert.equal(classifyHealth(401), 'invalid');
assert.equal(classifyHealth(403), 'invalid');
assert.equal(classifyHealth(402), 'balance');
assert.equal(classifyHealth(400, 'Insufficient balance, please recharge'), 'balance');
assert.equal(classifyHealth(429), 'quota');
assert.equal(classifyHealth(undefined, "You've hit your usage limit"), 'quota');
assert.equal(classifyHealth(503), 'unavailable');
assert.equal(classifyHealth(undefined, 'fetch failed ECONNREFUSED'), 'network');
assert.equal(classifyHealth(404), 'config');
console.log('model-health ok');

// Vendor JSON collapses to its sentence; the duplicated "HTTP 402 ·" prefix is dropped.
{
  const { upstreamReason, recordHealth: rec, healthSnapshot: snap } = await import('./model-health.ts');
  if (upstreamReason('{"error":{"message":"quota gone"}}') !== 'quota gone') throw new Error('upstreamReason object');
  if (upstreamReason('{"error":"bad key"}') !== 'bad key') throw new Error('upstreamReason string');
  if (upstreamReason('plain text') !== 'plain text') throw new Error('upstreamReason passthrough');
  rec('verify-dup', 402, 'check', 'HTTP 402 · {"error":{"message":"You exceeded your current quota"}}');
  const m = snap()['verify-dup']?.message ?? '';
  if ((m.match(/HTTP 402/g) ?? []).length !== 1 || !m.includes('You exceeded')) throw new Error(`dedupe: ${m}`);
  console.log('model-health reason ok');
}
