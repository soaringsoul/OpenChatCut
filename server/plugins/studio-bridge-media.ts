import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { verifyStudioGrant } from './studio-grant.ts';

export interface StudioPoolAsset {
  id: string;
  name: string;
  kind: string;
  src: string;
  durationInFrames: number;
  sourceContentHash?: string;
  sourceSize?: number;
  width?: number;
  height?: number;
  sourceFilename?: string;
  sourceRevision?: string;
  props?: Record<string, unknown>;
}

export interface StudioProjectDoc {
  version: number;
  assets: StudioPoolAsset[];
  mediaFolders: unknown[];
  timelines: unknown[];
  activeTimelineId: string;
}

export function applyStudioAssets(doc: StudioProjectDoc, incoming: StudioPoolAsset[]): { doc: StudioProjectDoc; added: string[]; existing: string[] } {
  const timelines = JSON.stringify(doc.timelines);
  const activeTimelineId = doc.activeTimelineId;
  const assets = [...doc.assets];
  const added: string[] = [];
  const existing: string[] = [];
  for (const asset of incoming) {
    if (assets.some((item) => item.id === asset.id)) {
      existing.push(asset.id);
      continue;
    }
    assets.push(stampSource(asset));
    added.push(asset.id);
  }
  const next = { ...doc, assets };
  if (JSON.stringify(next.timelines) !== timelines || next.activeTimelineId !== activeTimelineId) {
    throw new Error('studio import changed the timeline');
  }
  return { doc: next, added, existing };
}

export function stampSource(asset: StudioPoolAsset): StudioPoolAsset {
  const hash = asset.sourceContentHash?.toLowerCase();
  if (!hash) return asset;
  return { ...asset, sourceContentHash: hash, sourceRevision: asset.sourceRevision ?? `source-sha256-${hash}` };
}

export async function acceptStudioFile(options: {
  uploadDir: string;
  storedName: string;
  filePath?: string | null;
  grant?: string | null;
  sha256: string | null;
  grantSecret: string;
  registerReference: (directory: string, name: string, sourcePath: string) => Promise<void>;
}): Promise<string> {
  const storedName = safeStoredName(options.storedName);
  if (options.grant) {
    const payload = verifyStudioGrant(options.grantSecret, options.grant);
    if (!payload) throw new Error('media grant expired or invalid');
    if (options.sha256 && payload.sha256 && options.sha256 !== payload.sha256) throw new Error('media hash mismatch');
    const info = await stat(payload.path);
    if (!info.isFile()) throw new Error('media grant is not a file');
    await options.registerReference(options.uploadDir, storedName, payload.path);
    return `/media/uploads/${storedName}`;
  }
  if (!options.filePath || !isStudioTempFile(options.filePath)) throw new Error('refusing a media path outside the studio temp directory');
  const bytes = await readFile(options.filePath);
  if (bytes.length === 0) throw new Error('incomplete media');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (options.sha256 && actual !== options.sha256) throw new Error('media hash mismatch');
  await mkdir(options.uploadDir, { recursive: true });
  const finalPath = join(options.uploadDir, storedName);
  const temporary = join(options.uploadDir, `.${storedName}.partial`);
  try {
    await copyFile(options.filePath, temporary);
    const copied = await readFile(temporary);
    if (createHash('sha256').update(copied).digest('hex') !== actual) throw new Error('copied media changed');
    await rename(temporary, finalPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return `/media/uploads/${storedName}`;
}

export function isStudioTempFile(filePath: string): boolean {
  if (!isAbsolute(filePath)) return false;
  const directory = resolve(filePath, '..');
  const root = resolve(tmpdir());
  return directory.startsWith(root) && basename(directory).startsWith('studio-media-');
}

function safeStoredName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!base || base.startsWith('.')) return `studio${extname(name) || '.bin'}`;
  return base;
}
