// Spawnable binaries must resolve to real files once the app ships as an asar archive.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ensureSpawnableBinary, ffmpegBin, ffprobeBin, unpackedPath } from './media-binaries.ts';

const root = mkdtempSync(join(tmpdir(), 'media-binaries-'));
try {
  const archived = join(root, 'Resources', 'app.asar', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  const twin = join(root, 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  assert.equal(unpackedPath(archived), archived, 'without an unpacked twin the path is left alone');
  mkdirSync(join(root, 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static'), { recursive: true });
  writeFileSync(twin, 'binary');
  assert.equal(unpackedPath(archived), twin, 'a path inside app.asar is rewritten to its app.asar.unpacked twin');
  const plain = join(root, 'dev', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  assert.equal(unpackedPath(plain), plain, 'dev paths are untouched');
  const lookalike = join(root, 'my-app.asar-notes', 'ffmpeg');
  assert.equal(unpackedPath(lookalike), lookalike, `only a full ${sep}app.asar${sep} segment counts`);

  if (process.platform !== 'win32') {
    const binary = join(root, 'ffmpeg-no-x');
    writeFileSync(binary, '#!/bin/sh\n');
    chmodSync(binary, 0o644);
    assert.equal(statSync(binary).mode & 0o111, 0, 'fixture starts without execute bits');
    assert.equal(ensureSpawnableBinary(binary), binary);
    assert.ok((statSync(binary).mode & 0o111) !== 0, 'a 0644 bundled binary is made spawnable');
    assert.equal(ensureSpawnableBinary('ffmpeg'), 'ffmpeg', 'PATH names are left alone');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The resolved dev binaries are real files that can be spawned (an explicit override wins).
assert.ok(!ffmpegBin().includes(`${sep}app.asar${sep}`));
assert.ok(!ffprobeBin().includes(`${sep}app.asar${sep}`));
{
  const probe = spawnSync(ffmpegBin(), ['-version'], { encoding: 'utf8', timeout: 8_000, windowsHide: true });
  assert.equal(probe.status, 0, `ffmpegBin() must resolve a working ffmpeg (${probe.error?.message ?? probe.stderr})`);
}
process.env.OPENCHATCUT_FFPROBE = '/custom/ffprobe';
assert.equal(ffprobeBin(), '/custom/ffprobe');
delete process.env.OPENCHATCUT_FFPROBE;

console.log('media-binaries checks passed (asar twin rewrite, overrides, execute bit)');
