import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, Agent } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { studioBridgeRequestAllowed } from '../studio-bridge-auth.ts';
import { verifyStudioGrant } from './studio-grant.ts';
import { acceptStudioFile, applyStudioAssets, isStudioTempFile, type StudioProjectDoc } from './studio-bridge-media.ts';
import { handleStudioBridge, type StudioBridgeDeps } from './studio-bridge-http.ts';

const GRANT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6InN0dWRpby1ncmFudCIsInYiOjF9.eyJieXRlcyI6MywiZXhwaXJlc0F0IjoiMjA5OS0wMS0wMVQwMDowMDowMC4wMDBaIiwicGF0aCI6Ii92aWRlb3MvYS5tcDQiLCJzaGEyNTYiOm51bGwsInYiOjF9.eYYrTOxXgj3vcIu_uotZjg6dxy_KFfjAXWdFsmDY--I';

test('grant fixture matches the studio signer and import does not touch the timeline', async () => {
  assert.equal(verifyStudioGrant('test-secret', GRANT, Date.parse('2026-10-03T00:00:00Z'))?.path, '/videos/a.mp4');
  assert.equal(verifyStudioGrant('test-secret', GRANT, Date.parse('2100-01-01T00:00:00Z')), null);
  const clip = { id: 'clip', track: 'V1', startFrame: 0, durationInFrames: 10 };
  const doc: StudioProjectDoc = {
    version: 3, assets: [], mediaFolders: [], activeTimelineId: 'tl',
    timelines: [{ id: 'tl', name: '序列 1', order: 0, fps: 30, width: 1920, height: 1080, items: [clip], selectedId: null }],
  };
  const asset = { id: 'studioabc', name: 'take.mp4', kind: 'video', src: '', durationInFrames: 60, sourceContentHash: 'ABC', props: { studioSource: { ref: { assetVersionId: 'v1' }, title: 'take.mp4' } } };
  const first = applyStudioAssets(doc, [asset]);
  assert.deepEqual(first.doc.timelines, doc.timelines);
  assert.equal(first.added.length, 1);
  assert.equal(first.doc.assets[0].sourceRevision, 'source-sha256-abc');
  const second = applyStudioAssets(first.doc, [asset]);
  assert.equal(second.doc.assets.length, 1);
  assert.deepEqual(second.existing, ['studioabc']);
});

test('copy rejects a bad hash and does not leave the file, reference accepts a grant', async () => {
  assert.equal(isStudioTempFile('/etc/passwd'), false);
  const root = await mkdtemp(join(tmpdir(), 'studio-media-'));
  const source = join(root, 'payload');
  await writeFile(source, 'video-bytes');
  const upload = await mkdtemp(join(tmpdir(), 'uploads-'));
  await assert.rejects(() => acceptStudioFile({
    uploadDir: upload, storedName: 'take.mp4', filePath: source, sha256: 'nope', grantSecret: 'test-secret',
    registerReference: async () => undefined,
  }));
  await assert.rejects(() => readFile(join(upload, 'take.mp4')));
  const src = await acceptStudioFile({
    uploadDir: upload, storedName: 'take.mp4', filePath: source,
    sha256: hashOf('video-bytes'),
    grantSecret: 'test-secret', registerReference: async () => undefined,
  });
  assert.equal(src, '/media/uploads/take.mp4');
  assert.equal(await readFile(join(upload, 'take.mp4'), 'utf8'), 'video-bytes');
});

test('receive endpoint saves the pool once and refuses an empty export', async () => {
  const docs = new Map<string, StudioProjectDoc>();
  const deps: StudioBridgeDeps = {
    authorized: () => true,
    listProjects: async () => [],
    getProject: async (id) => docs.has(id) ? { id, name: id, fps: 30, assetIds: [], timelineIds: ['tl'], doc: docs.get(id)! } : null,
    createProject: async (name) => {
      const doc: StudioProjectDoc = { version: 3, assets: [], mediaFolders: [], timelines: [{ id: 'tl', fps: 30, items: [{ id: 'keep' }] }], activeTimelineId: 'tl' };
      docs.set('made', doc);
      return { id: 'made', name, fps: 30, assetIds: [], timelineIds: ['tl'], doc };
    },
    saveProject: async (id, doc) => { docs.set(id, doc); return true; },
    uploadDir: () => join(tmpdir(), 'unused-upload'),
    registerReference: async () => undefined,
    grantSecret: () => 'test-secret',
  };
  const server = createServer((req, res) => { void handleStudioBridge(req, res, deps); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'studio-media-'));
  await writeFile(join(root, 'payload'), 'video-bytes');
  const response = await postJson(base, '/api/studio-bridge/receive', {
    createProjectName: '新工程',
    items: [{ draft: { id: 'studio1', name: 'a.mp4', kind: 'video', src: '', durationInFrames: 30 }, filePath: join(root, 'payload'), sha256: hashOf('video-bytes') }],
  });
  const body = JSON.parse(response.text) as { data: { persisted: boolean; assetIds: string[] } };
  assert.equal(response.status, 200);
  assert.equal(body.data.persisted, true);
  assert.equal(docs.get('made')?.timelines[0] && (docs.get('made')?.timelines[0] as { items: unknown[] }).items.length, 1);
  const empty = await postJson(base, '/api/studio-bridge/exports/return', { fileBase64: '' });
  assert.equal(empty.status, 409);
  assert.equal(JSON.parse(empty.text).error.code, 'export_incomplete');
  server.close();
});

test('shared studio credential can only confirm a connection, not read projects or receive media', (t) => {
  const old = process.env.STUDIO_SERVICE_TOKEN;
  process.env.STUDIO_SERVICE_TOKEN = 'shared-token';
  t.after(() => { if (old === undefined) delete process.env.STUDIO_SERVICE_TOKEN; else process.env.STUDIO_SERVICE_TOKEN = old; });
  const req = (url: string, token: string) => ({ url, headers: { authorization: `Bearer ${token}` } }) as never;
  assert.equal(studioBridgeRequestAllowed(req('/api/studio-bridge/pairings/confirm', 'shared-token')), true);
  assert.equal(studioBridgeRequestAllowed(req('/api/studio-bridge/receive', 'shared-token')), false);
  assert.equal(studioBridgeRequestAllowed(req('/api/studio-bridge/projects', 'shared-token')), false);
  assert.equal(studioBridgeRequestAllowed(req('/api/studio-bridge/pairings/confirm', 'wrong')), false);
});

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function postJson(base: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent: new Agent(),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
