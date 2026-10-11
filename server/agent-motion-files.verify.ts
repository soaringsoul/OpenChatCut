import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageAgentMotionFile, rewriteMediaUploadArgs } from './agent-motion-files.ts';
import { uploadDir } from './media-dir.ts';

const uploads = uploadDir();
await mkdir(uploads, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'agent-motion-stage-'));
const name = `stage-test-${Date.now()}.txt`;
const uploadPath = join(uploads, name);
await writeFile(uploadPath, 'pool-bytes', 'utf8');

try {
  const dest = await stageAgentMotionFile(root, {
    path: 'inputs/demo/source.txt',
    url: `/media/uploads/${name}`,
  });
  assert.equal(dest, join(root, 'inputs/demo/source.txt'));
  const text = await (await import('node:fs/promises')).readFile(dest, 'utf8');
  assert.equal(text, 'pool-bytes');

  const rewritten = rewriteMediaUploadArgs(['cp', `/media/uploads/${name}`, 'inputs/x.mp4']);
  assert.equal(rewritten[1], uploadPath);
  console.log('agent-motion-files: OK');
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(uploadPath, { force: true });
}
