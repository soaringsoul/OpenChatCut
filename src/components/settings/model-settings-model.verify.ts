// Overview view-model: purposes map to the same route keys, health comes from provider records,
// and the add flow only ever proposes route patches for existing keys.
import assert from 'node:assert/strict';
import {
  PURPOSES, addCatalog, fallbackChoice, impactGroups, maskedKey, purposeState, purposeTargets, services,
  type HealthMap, type ModelCtx,
} from './modelSettingsModel';
import { KEY_NAMES } from '../../../server/keystore-names';
import type { KeyStatusResponse } from './settingsSchema';

const key = (configured: boolean) => ({ configured, source: configured ? 'runtime' as const : 'none' as const });
const keys = Object.fromEntries(KEY_NAMES.map((n) => [n, key(false)]));
for (const n of ['LLM_ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'LLM_GEMINI_API_KEY', 'LLM_STEPFUN_API_KEY']) keys[n] = key(true);
const status: KeyStatusResponse = {
  keys, caps: {}, hints: { LLM_ANTHROPIC_API_KEY: 'Qw12', GEMINI_API_KEY: '' },
  models: { LLM_PROVIDER: 'codex', CODEX_MODEL: 'gpt-6-luna', PREFERRED_IMAGE_VENDOR: 'nano-banana', PREFERRED_MUSIC_VENDOR: 'stepfun', PREFERRED_VOICE_VENDOR: 'stepfun', PREFERRED_TRANSCRIPTION_PROVIDER: 'stepfun' },
};
const health: HealthMap = {
  codex: { kind: 'ok', message: '可用', at: 1, source: 'codex' },
  gemini: { kind: 'quota', status: 429, message: '额度用尽或限流（HTTP 429）', at: 2, source: 'studio' },
  stepfun: { kind: 'balance', status: 402, message: '账户余额不足（HTTP 402）', at: 3, source: 'test' },
  anthropic: { kind: 'invalid', status: 401, message: '密钥无效或无权限（HTTP 401）', at: 4, source: 'agent' },
};
const ctx: ModelCtx = {
  status, health, codexModels: [],
  codexStatus: { installed: true, version: '1', account: { type: 'chatgpt' } as never, loginPending: false },
  copilotStatus: null, claudeCodeStatus: null,
};

const states = PURPOSES.map((def) => purposeState(ctx, def));
const by = (k: string) => states.find((s) => s.def.key === k)!;
assert.equal(by('agent').choice?.service, 'codex');
assert.equal(by('agent').summary, 'gpt-6-luna');
assert.equal(by('agent').health.kind, 'ok');
assert.equal(by('image').choice?.service, 'gemini');
assert.equal(by('image').health.kind, 'quota');
assert.ok(by('image').affected);
for (const k of ['music', 'voice', 'transcription']) {
  assert.equal(by(k).choice?.service, 'stepfun', k);
  assert.equal(by(k).health.kind, 'balance', k);
}
assert.equal(by('video').choice, undefined);
assert.equal(by('video').health.kind, 'none');

const impacts = impactGroups(states);
assert.deepEqual(impacts.map((g) => g.service).sort(), ['gemini', 'stepfun']);
assert.deepEqual(impacts.find((g) => g.service === 'stepfun')!.purposes, ['配乐', '配音', '转写']);

// Claude is configured but failing: never suggested as the agent fallback.
const agentFallback = fallbackChoice(by('agent'));
assert.notEqual(agentFallback?.service, 'anthropic');
assert.equal(fallbackChoice(by('image')), undefined, 'no other usable image provider is configured');

const all = services(ctx, states);
const connected = all.filter((s) => s.connected).map((s) => s.key).sort();
for (const k of ['anthropic', 'codex', 'gemini', 'stepfun']) assert.ok(connected.includes(k), `${k} connected`);
assert.deepEqual(all.find((s) => s.key === 'stepfun')!.usedBy, ['配乐', '配音', '转写']);

const catalog = addCatalog(all, '');
assert.equal(catalog[0].key, 'popular');
assert.ok(catalog.find((g) => g.key === 'login')!.items.some((s) => s.key === 'xai-oauth'));
assert.ok(addCatalog(all, 'deepseek').flatMap((g) => g.items).every((s) => /deepseek/i.test(`${s.label}${s.key}`)));

// Route patches only target existing route keys with existing option values.
const targets = purposeTargets(ctx, 'stepfun');
assert.deepEqual(targets.map((x) => x.routeName).sort(), ['LLM_PROVIDER', 'PREFERRED_IMAGE_VENDOR', 'PREFERRED_MUSIC_VENDOR', 'PREFERRED_TRANSCRIPTION_PROVIDER', 'PREFERRED_VOICE_VENDOR'].sort());
for (const x of targets) assert.ok((KEY_NAMES as readonly string[]).includes(x.routeName));
assert.ok(targets.find((x) => x.routeName === 'PREFERRED_MUSIC_VENDOR')!.current);

assert.equal(maskedKey(status, 'LLM_ANTHROPIC_API_KEY'), '••••Qw12');
assert.equal(maskedKey(status, 'GEMINI_API_KEY'), '已设置');
assert.equal(maskedKey(status, 'FAL_KEY'), '');
console.log('model-settings-model ok');
