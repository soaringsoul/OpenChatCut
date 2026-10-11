import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Agent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { StudioBridgeDeps } from './studio-bridge-http.ts';

type ReturnInput = Parameters<NonNullable<StudioBridgeDeps['ingestExport']>>[0];

export async function returnStudioExport(input: ReturnInput, getProject: StudioBridgeDeps['getProject']): Promise<{ assetId: string; assetVersionId: string }> {
  const base = process.env.STUDIO_BASE_URL;
  const token = process.env.STUDIO_SERVICE_TOKEN;
  if (!input.pairingId || !base || !token) throw new Error('请先连接工作室素材库');
  if (!input.bytes.length || input.bytes.length > 48 * 1024 * 1024) throw new Error('请选择 48 MB 以内的已完成导出');
  const project = await getProject(input.projectId);
  if (!project) throw new Error('回库工程不存在');
  if (input.mode === 'new-version' && !input.targetAssetId?.trim()) throw new Error('请选择要追加版本的素材');
  if (!['new-asset', 'new-version'].includes(input.mode) || !['video', 'audio', 'subtitle'].includes(input.outputType)) throw new Error('回库类型无效');
  const hash = createHash('sha256').update(input.bytes).digest('hex');
  const snapshotRevision = createHash('sha256').update(JSON.stringify(project.doc)).digest('hex');
  const fileName = basename(input.fileName).replace(/[\r\n]/g, '').slice(0, 200) || 'export.mp4';
  const identity = createHash('sha256').update(JSON.stringify([input.pairingId, input.projectId, snapshotRevision, hash, input.outputType, input.mode, input.targetAssetId || '', fileName])).digest('hex');
  const directory = await mkdtemp(join(tmpdir(), 'studio-media-'));
  try {
    const file = join(directory, 'export');
    await writeFile(file, input.bytes, { mode: 0o600 });
    const sources = project.doc.assets.flatMap((asset) => {
      const source = asset.props?.studioSource;
      const ref = source && typeof source === 'object' ? (source as { ref?: unknown }).ref : null;
      return ref ? [ref] : [];
    });
    const payload = {
      pairingId: input.pairingId, idempotencyKey: `return:${identity}`,
      receipt: { schemaVersion: 1, exportId: identity, projectId: input.projectId, timelineId: project.doc.activeTimelineId,
        snapshotRevision,
        outputType: input.outputType, outputHash: hash, size: input.bytes.length, width: null, height: null, duration: null,
        sourceRefs: sources, mode: input.mode, ...(input.targetAssetId ? { targetAssetId: input.targetAssetId } : {}), fileName, title: fileName },
      files: [{ role: 'master', path: file, sha256: hash, bytes: input.bytes.length }],
    };
    const result = await post(new URL('/api/studio/v1/exports/ingest', base), token, payload);
    if (result.status !== 'completed' || !result.result?.assetId) throw new Error(result.items?.[0]?.errorMessage || '成片回库尚未完成');
    return result.result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function post(url: URL, token: string, body: unknown): Promise<{ status: string; result?: { assetId: string; assetVersionId: string }; items?: { errorMessage?: string }[] }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request({ protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      agent: url.protocol === 'https:' ? new HttpsAgent() : new Agent(),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if ((res.statusCode ?? 500) >= 300 || response.error || !response.data) reject(new Error(response.error?.message || '回库请求失败'));
          else resolve(response.data);
        } catch { reject(new Error('回库响应无效')); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('回库请求超时')));
    req.on('error', reject); req.end(payload);
  });
}
