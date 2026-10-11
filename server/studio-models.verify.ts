import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'studio-models-'));
process.env.OPENCHATCUT_DATA_DIR = temp;
process.env.OPENCHATCUT_DEV_PROFILE_ID = 'bb000000-0000-4000-8000-000000000001';
process.env.OPENCUT_STUDIO_TOKEN = 'test-editor-service';
const keys = await import('./keystore.ts');
for (const key of keys.KEY_NAMES) delete process.env[key];
const models = await import('./studio-models.ts');
const migration = await import('./studio-model-migration.ts');
const { studioModelsPlugin } = await import('./plugins/studio-models.ts');
const codexReadiness = await import('./codex/studio-text.ts');
codexReadiness.primeCodexStudioReadiness({ ready: false, defaultModel: '', reason: 'test' });
const observed: Array<{ path: string; headers: IncomingMessage['headers']; body: unknown }> = [];
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  observed.push({ path: req.url || '', headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
  if (req.url?.endsWith('/audio/speech')) { res.setHeader('content-type', 'audio/mpeg'); res.end(Buffer.from([1, 2, 3])); }
  else if (req.url?.endsWith('/responses')) { res.setHeader('content-type', 'text/event-stream'); res.end('data: {"type":"done"}\n\n'); }
  else if (req.url?.endsWith(':generateContent')) { res.setHeader('content-type', 'application/json'); res.end('{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"mock-image"}}]}}]}'); }
  else { res.setHeader('content-type', 'application/json'); res.end('{"id":"fake-task"}'); }
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address() as { port: number };
const prefix = `http://127.0.0.1:${address.port}/provider/v1`;
keys.seedKeystore({ LLM_PROVIDER: 'openai', LLM_OPENAI_API_KEY: 'test-upstream-secret', LLM_OPENAI_BASE_URL: prefix, LLM_OPENAI_MODEL: 'fake-text',
  IMAGE_API_KEY: 'test-image-secret', IMAGE_BASE_URL: prefix, OPENAI_API_KEY: 'test-audio-secret', PREFERRED_IMAGE_VENDOR: 'gpt-image-2', PREFERRED_VOICE_VENDOR: 'openai',
  SEEDANCE_API_KEY: 'test-video-secret', SEEDANCE_BASE_URL: prefix, PREFERRED_VIDEO_VENDOR: 'seedance2',
  GEMINI_API_KEY: 'test-gemini-secret', GEMINI_BASE_URL: `http://127.0.0.1:${address.port}/provider`,
  AGENT_MODEL_CAPABILITY_OVERRIDES: JSON.stringify([{ backend: 'api', provider: 'openai', modelId: 'fake-text', contextWindowTokens: 65536, maxOutputTokens: 8192, supportsImages: false }]),
});
const catalog = models.studioModelCatalog();
assert.equal(Object.keys(catalog.defaults).length, 4);
assert.equal(catalog.models.find((row) => row.ref === catalog.defaults.text)?.contextWindowTokens, 65536);
assert.ok(!JSON.stringify(catalog).includes('secret'));
assert.ok(!JSON.stringify(catalog).includes(prefix));
let middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => unknown) | undefined;
const plugin = studioModelsPlugin();
if (typeof plugin.configureServer !== 'function') throw new Error('missing plugin hook');
plugin.configureServer.call(plugin, { middlewares: { use: (fn: typeof middleware) => { middleware = fn; } } } as never);
const editor = createServer((req, res) => { void middleware!(req, res, () => { res.statusCode = 404; res.end(); }); });
await new Promise<void>((resolve) => editor.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(editor.address() as { port: number }).port}/api/studio-bridge/models`;
try {
  assert.equal((await fetch(base)).status, 401);
  const paths: Record<string, string> = { text: '/responses', image: '/images/generations', video: '/contents/generations/tasks', audio: '/audio/speech' };
  for (const capability of ['text', 'image', 'video', 'audio']) {
    const selected = catalog.models.find((row) => row.ref === catalog.defaults[capability])!;
    const response = await fetch(`${base}/${selected.ref}/v1${paths[capability]}`, { method: 'POST', headers: { authorization: 'Bearer test-editor-service', cookie: 'private-cookie', 'x-studio-subject': 'private-user', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'attacker-selected-model', prompt: 'mock' }) });
    assert.equal(response.status, 200);
    assert.equal((observed.at(-1)?.body as { model: string }).model, selected.modelId);
    assert.equal(observed.at(-1)?.headers.cookie, undefined);
    assert.equal(observed.at(-1)?.headers['x-studio-subject'], undefined);
    assert.ok(!JSON.stringify(observed.at(-1)?.headers).includes('test-editor-service'));
    assert.ok(observed.at(-1)?.path.startsWith('/provider/v1/'));
    if (capability === 'text') assert.match(await response.text(), /data:/);
    else if (capability === 'audio') assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    else await response.text();
  }
  assert.equal((await fetch(`${base}/${catalog.defaults.text}/files`, { headers: { authorization: 'Bearer test-editor-service' } })).status, 403);
  const gemini = catalog.models.find((row) => row.provider === 'gemini' && row.capability === 'image')!;
  assert.equal(gemini.available, true);
  assert.equal(gemini.modelId, 'gemini-3.1-flash-image');
  const geminiPayload = { contents: [{ role: 'user', parts: [{ text: 'mock prompt' }, { inlineData: { mimeType: 'image/png', data: 'mock-reference' } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } } };
  const geminiResponse = await fetch(`${base}/${gemini.ref}/v1beta/models/${gemini.modelId}:generateContent`, {
    method: 'POST', headers: { authorization: 'Bearer test-editor-service', 'x-goog-api-key': 'attacker-key', cookie: 'private-cookie', 'content-type': 'application/json' },
    body: JSON.stringify({ ...geminiPayload, model: 'attacker-model' }),
  });
  assert.equal(geminiResponse.status, 200);
  assert.deepEqual(observed.at(-1)?.body, geminiPayload);
  assert.equal(observed.at(-1)?.path, `/provider/v1beta/models/${gemini.modelId}:generateContent`);
  assert.equal(observed.at(-1)?.headers['x-goog-api-key'], 'test-gemini-secret');
  assert.equal(observed.at(-1)?.headers.authorization, undefined);
  assert.equal(observed.at(-1)?.headers.cookie, undefined);
  assert.match(await geminiResponse.text(), /mock-image/);
  assert.equal((await fetch(`${base}/${gemini.ref}/v1beta/models/other-model:generateContent`, { method: 'POST', headers: { authorization: 'Bearer test-editor-service' } })).status, 403);
  await keys.setKeys({ PREFERRED_IMAGE_VENDOR: 'nano-banana' });
  assert.equal(models.studioModelCatalog().defaults.image, gemini.ref);
  const geminiText = models.studioModelCatalog().models.find((row) => row.provider === 'gemini' && row.capability === 'text')!;
  assert.equal(geminiText.protocol, 'chat-completion');
  assert.equal(geminiText.available, geminiText.configured);
  assert.equal(models.studioModelPathAllowed(geminiText, 'POST', '/chat/completions'), true);
  await keys.setKeys({
    LLM_STEPFUN_API_KEY: 'test-stepfun-secret', LLM_STEPFUN_BASE_URL: prefix,
    STEPFUN_IMAGE_MODEL: 'step-image-edit-2', PREFERRED_IMAGE_VENDOR: 'stepfun',
  });
  const stepfunCatalog = models.studioModelCatalog();
  const stepfunRows = stepfunCatalog.models.filter((row) => row.provider === 'stepfun' && row.capability === 'image');
  assert.equal(stepfunRows.length, 1);
  assert.equal(stepfunRows[0].available, true);
  assert.equal(stepfunCatalog.defaults.image, stepfunRows[0].ref);
  assert.ok(!JSON.stringify(stepfunCatalog).includes('test-stepfun-secret'));
  const stepfunResponse = await fetch(`${base}/${stepfunCatalog.defaults.image}/v1/images/generations`, {
    method: 'POST', headers: { authorization: 'Bearer test-editor-service', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'attacker', prompt: 'mock', n: 4, aspect_ratio: '16:9', quality: 'high', output_format: 'png' }),
  });
  assert.equal(stepfunResponse.status, 200);
  assert.deepEqual(observed.at(-1)?.body, { model: 'step-image-edit-2', prompt: 'mock', n: 1, size: '768x1360', response_format: 'b64_json' });
  assert.equal(observed.at(-1)?.headers.authorization, 'Bearer test-stepfun-secret');
  assert.match(observed.at(-1)?.path || '', /\/images\/generations$/);
  await stepfunResponse.text();
  const oldRevision = keys.keyRevision();
  await keys.setKeys({ LLM_OPENAI_MODEL: 'updated-text' }, oldRevision);
  await assert.rejects(keys.setKeys({ LLM_OPENAI_MODEL: 'stale-text' }, oldRevision));
  assert.equal(keys.getKey('LLM_OPENAI_MODEL'), 'updated-text');
  assert.throws(() => models.requireStudioModel(catalog.defaults.text));
  const channels = [{ id: 'old', name: 'Old Claude', apiFormat: 'claude', interfaceType: 'claude-api', apiKey: 'legacy-secret', baseUrl: prefix, models: ['fake-claude'] }];
  const preview = migration.previewStudioMigration({ channels });
  assert.equal(preview.candidates[0].conflict, false);
  assert.ok(!JSON.stringify(preview).includes('legacy-secret'));
  const result = await migration.commitStudioMigration({ channels, revision: preview.revision, selected: ['old'] });
  assert.equal(keys.getKey('LLM_ANTHROPIC_API_KEY'), 'legacy-secret');
  const backup = join(temp, 'studio-model-backups', `${result.backupId}.json`);
  assert.ok(!(await readFile(backup, 'utf8')).includes('legacy-secret'));
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.equal(migration.previewStudioMigration({ channels }).candidates[0].conflict, true);
  await migration.restoreStudioMigration(result.backupId, result.revision);
  assert.equal(keys.getKey('LLM_ANTHROPIC_API_KEY'), '');
  await keys.setKeys({ LLM_OPENAI_API_KEY: '' });
  codexReadiness.primeCodexStudioReadiness({ ready: false, defaultModel: '', reason: 'test' });
  assert.equal(models.studioModelCatalog().defaults.text, undefined);
  assert.equal(models.studioModelCatalog().models.find((row) => row.provider === 'openai' && row.capability === 'text')?.available, false);
  codexReadiness.primeCodexStudioReadiness({ ready: true, defaultModel: 'gpt-6.1-sol' });
  const withCodex = models.studioModelCatalog();
  const codexRow = withCodex.models.find((row) => row.ref === withCodex.defaults.text);
  assert.equal(codexRow?.provider, 'codex');
  assert.equal(codexRow?.modelId, 'gpt-6.1-sol');
  assert.equal(codexRow?.protocol, 'chat-completion');
  await keys.setKeys({ LLM_PROVIDER: 'codex', LLM_OPENAI_API_KEY: 'test-upstream-secret' });
  const routedCodex = models.studioModelCatalog();
  assert.equal(routedCodex.models.find((row) => row.ref === routedCodex.defaults.text)?.provider, 'codex');
  const { llmProviderForRequest } = await import('./plugins/llm-proxy.ts');
  assert.equal(llmProviderForRequest(), 'anthropic');
  console.log('studio models: catalog, 4 mocked capabilities, Gemini image protocol/default, credential boundary, revisions, migration and restore passed');
} finally {
  editor.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise<void>((resolve) => editor.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
}
