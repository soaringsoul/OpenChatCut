import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

const require = createRequire(import.meta.url);
const ffmpegStatic = require('ffmpeg-static') as string | null;
const ffprobeInstaller = require('@ffprobe-installer/ffprobe') as { path?: string };

const ASAR_SEGMENT = `${sep}app.asar${sep}`;
const UNPACKED_SEGMENT = `${sep}app.asar.unpacked${sep}`;

/**
 * The on-disk twin of a path inside the packaged app archive.
 *
 * Electron's fs shim reads files inside app.asar transparently, but nothing can be
 * executed or dlopen'ed from there: spawn needs a real file. electron-builder keeps the
 * modules listed in asarUnpack as real files under app.asar.unpacked with the same
 * layout, so a resolved path is rewritten to that twin when it exists. Dev builds and
 * paths outside the archive come back unchanged.
 */
export function unpackedPath(path: string): string {
  const index = path.indexOf(ASAR_SEGMENT);
  if (index < 0) return path;
  const twin = `${path.slice(0, index)}${UNPACKED_SEGMENT}${path.slice(index + ASAR_SEGMENT.length)}`;
  return existsSync(twin) ? twin : path;
}

/**
 * ffmpeg-static's postinstall writes the binary then chmod 0755, but it also
 * exits early when the file already exists. A cached 0644 download, umask, or
 * copy without the execute bit then makes every spawn fail with EACCES — which
 * surfaces as "video compatibility processing failed" on media import.
 * Restore the execute bits on a real file before handing the path to spawn.
 */
export function ensureSpawnableBinary(path: string): string {
  if (process.platform === 'win32' || !isAbsolute(path)) return path;
  try {
    const info = statSync(path);
    if (!info.isFile() || (info.mode & 0o111) !== 0) return path;
    chmodSync(path, info.mode | 0o111);
  } catch {
    // Leave the path as-is; the next spawn will report the real OS error.
  }
  return path;
}

function isWorkingMediaBinary(path: string): boolean {
  try {
    const result = spawnSync(path, ['-version'], {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return false;
    return /ffmpeg|ffprobe/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } catch {
    return false;
  }
}

function firstWorkingBinary(candidates: readonly (string | null | undefined)[]): string {
  const names = candidates.filter((value): value is string => Boolean(value));
  for (const candidate of names) {
    const path = ensureSpawnableBinary(candidate);
    if (isWorkingMediaBinary(path)) return path;
  }
  return ensureSpawnableBinary(names[0] ?? 'ffmpeg');
}

let resolvedFfmpeg: string | undefined;
let resolvedFfprobe: string | undefined;

/**
 * Prefer explicit overrides for developers who need a custom FFmpeg build.
 * Packaged desktop builds fall back to the platform binaries shipped through
 * production dependencies, so media import does not depend on the user's PATH.
 * If the bundled binary is missing execute bits or fails macOS Mach-O
 * validation (EBADMACHO / -88), fall back to Homebrew or a PATH install.
 */
export function ffmpegBin(): string {
  const override = process.env.OPENCHATCUT_FFMPEG ?? process.env.FFMPEG_PATH;
  if (override) return ensureSpawnableBinary(override);
  if (resolvedFfmpeg) return resolvedFfmpeg;
  resolvedFfmpeg = firstWorkingBinary([
    ffmpegStatic ? unpackedPath(ffmpegStatic) : null,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ]);
  return resolvedFfmpeg;
}

export function ffprobeBin(): string {
  const override = process.env.OPENCHATCUT_FFPROBE ?? process.env.FFPROBE_PATH;
  if (override) return ensureSpawnableBinary(override);
  if (resolvedFfprobe) return resolvedFfprobe;
  resolvedFfprobe = firstWorkingBinary([
    ffprobeInstaller.path ? unpackedPath(ffprobeInstaller.path) : null,
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    'ffprobe',
  ]);
  return resolvedFfprobe;
}

/**
 * whisper.cpp CLI used by the desktop native-ASR worker (Metal/CPU). Dev and
 * packaged builds resolve from public/whisper-cli/<platform>/ (provisioned by
 * scripts/sync-whisper-cli.mjs and shipped through extraResources); an
 * explicit override wins for locally compiled binaries.
 */
export function whisperCliBin(): string {
  const override = process.env.OPENCHATCUT_WHISPER_CLI;
  if (override) return override;
  const platformKey = `${process.platform}-${process.arch}`;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const relative = join('whisper-cli', platformKey, `whisper-cli${suffix}`);
  const candidates = [
    join(import.meta.dirname, '..', 'public', relative),
    join(process.resourcesPath ?? '', 'dist', relative),
    join(process.resourcesPath ?? '', relative),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(candidates[0]!);
}
