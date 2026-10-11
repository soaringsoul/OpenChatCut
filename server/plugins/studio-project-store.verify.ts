import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'studio-persist-'));
process.env.OPENCHATCUT_DATA_DIR = directory;
try {
  const { createStudioProject, saveStudioProject } = await import('./studio-bridge.ts');
  const { getStoredEntry } = await import('./project-store.ts');
  const { claimBrowserProjectOwnership, releaseProjectEditOwnership } = await import('../external-agent/project-edit-ownership.ts');
  const { runProjectMigrations } = await import('../../src/persist/migrations/index.ts');
  const { revisionOf } = await import('../../src/agent/external-edit-session.ts');
  const project = await createStudioProject('isolated studio regression');
  const before = runProjectMigrations((await getStoredEntry(`project:${project.id}`)).value)!.doc;
  const asset = { id: 'studio-test', kind: 'video', name: 'sample.mp4', src: '/sample.mp4', durationInFrames: 30 };
  assert.equal(await saveStudioProject(project.id, { ...before, assets: [asset] }), true);
  const saved = runProjectMigrations((await getStoredEntry(`project:${project.id}`)).value)!.doc;
  assert.equal(saved.assets.length, 1);
  assert.deepEqual(saved.timelines, before.timelines);
  const claim = await claimBrowserProjectOwnership(project.id, 'browser-test', revisionOf(saved));
  assert.equal(claim.status, 'claimed');
  assert.equal(await saveStudioProject(project.id, { ...saved, assets: [asset, { ...asset, id: 'blocked' }] }), false);
  if (claim.status === 'claimed') await releaseProjectEditOwnership(claim.claim);
  assert.equal(runProjectMigrations((await getStoredEntry(`project:${project.id}`)).value)!.doc.assets.length, 1);
  console.log('studio offline persistence and browser ownership protection passed');
} finally { await rm(directory, { recursive: true, force: true }); }
