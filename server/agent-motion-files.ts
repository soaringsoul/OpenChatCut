import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { isSafeUploadName, resolveUploadFile, uploadNameOfSource } from './media-dir.ts';
import { resolveProductAsset } from './product-assets.ts';
import { safePublicFetch } from './safe-public-fetch.ts';

const MAX_FETCH_BYTES = 200_000_000;

export interface AgentMotionFileInput {
  path: string;
  content?: string;
  url?: string;
}

export function resolvePathUnderAgentMotionRoot(root: string, relativePath: string): string {
  const dest = resolve(root, relativePath);
  if (dest !== root && !dest.startsWith(root + sep)) {
    throw new Error(`path escapes Agent Motion root: ${relativePath}`);
  }
  return dest;
}

/** Copy pool media or write inline text into AGENT_MOTION_ROOT (no shell). */
export async function stageAgentMotionFile(root: string, file: AgentMotionFileInput): Promise<string> {
  const dest = resolvePathUnderAgentMotionRoot(root, file.path);
  await mkdir(dirname(dest), { recursive: true });
  if (file.content !== undefined) {
    await writeFile(dest, file.content, 'utf8');
    return dest;
  }
  const url = file.url?.trim();
  if (!url) throw new Error(`file ${file.path} needs content or url`);
  if (url.startsWith('/')) {
    const uploadName = uploadNameOfSource(url);
    if (uploadName) {
      if (!isSafeUploadName(uploadName)) throw new Error(`illegal upload path ${url}`);
      const hit = resolveUploadFile(uploadName);
      if (!hit) throw new Error(`素材池文件不存在: ${uploadName}（请先上传并 finalize）`);
      await copyFile(hit, dest);
      return dest;
    }
    const clean = url.replace(/^\/+/, '');
    const product = resolveProductAsset('/' + clean);
    if (product) {
      await copyFile(product, dest);
      return dest;
    }
    throw new Error(`local path not found: ${url}`);
  }
  if (!/^https?:\/\//.test(url)) throw new Error(`unsupported url ${url}`);
  const response = await safePublicFetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > MAX_FETCH_BYTES) throw new Error(`fetched file too large (${buf.byteLength} bytes)`);
  await writeFile(dest, buf);
  return dest;
}

export async function stageAgentMotionFiles(root: string, files: AgentMotionFileInput[]): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    if (!file.path?.trim()) throw new Error('each file needs path');
    written.push(await stageAgentMotionFile(root, file));
  }
  return written;
}

/** Rewrite `/media/uploads/…` tokens in whitelisted cp args to on-disk upload paths. */
export function rewriteMediaUploadArgs(args: string[]): string[] {
  return args.map((arg) => {
    const name = uploadNameOfSource(arg);
    if (!name || !isSafeUploadName(name)) return arg;
    return resolveUploadFile(name) ?? arg;
  });
}
