import type { IncomingMessage, ServerResponse } from 'node:http';
import { studioBridgeAuthorized, studioGrantSecret } from '../studio-bridge-auth.ts';
import { acceptStudioFile, applyStudioAssets, type StudioPoolAsset, type StudioProjectDoc } from './studio-bridge-media.ts';

export interface StudioBridgeProject {
  id: string;
  name: string;
  fps: number;
  assetIds: string[];
  timelineIds: string[];
}

export interface StudioBridgeDeps {
  authorized: (req: IncomingMessage) => boolean;
  listProjects: () => Promise<StudioBridgeProject[]>;
  getProject: (id: string) => Promise<(StudioBridgeProject & { doc: StudioProjectDoc }) | null>;
  createProject: (name: string) => Promise<StudioBridgeProject & { doc: StudioProjectDoc }>;
  saveProject: (projectId: string, doc: StudioProjectDoc) => Promise<boolean>;
  uploadDir: () => string;
  registerReference: (directory: string, name: string, sourcePath: string) => Promise<void>;
  grantSecret: () => string;
  confirmPairing?: (code: string) => Promise<{ pairingId: string }>;
  ingestExport?: (input: { pairingId: string; projectId: string; mode: string; targetAssetId?: string; bytes: Buffer; outputType: string; fileName: string }) => Promise<{ assetId: string; assetVersionId: string }>;
}

interface ReceiveItem {
  draft: StudioPoolAsset & { durationFps?: number };
  transport?: string;
  grant?: string | null;
  sha256?: string | null;
  filePath?: string | null;
}

export async function handleStudioBridge(req: IncomingMessage, res: ServerResponse, deps: StudioBridgeDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/\/$/, '');
  const browserAction = req.method === 'POST' && (path === '/api/studio-bridge/pairings/confirm' || path === '/api/studio-bridge/exports/return');
  if (!browserAction && !deps.authorized(req)) {
    send(res, 401, { error: { code: 'pairing_required', message: '剪辑端协作凭证无效', retryable: false } });
    return;
  }
  try {
    if (req.method === 'GET' && path === '/api/studio-bridge/capabilities') {
      send(res, 200, { data: { schemaVersion: 1, receive: true, exports: true } });
      return;
    }
    if (req.method === 'GET' && path === '/api/studio-bridge/projects') {
      send(res, 200, { data: await deps.listProjects() });
      return;
    }
    const project = path.match(/^\/api\/studio-bridge\/projects\/([^/]+)$/);
    if (req.method === 'GET' && project) {
      const found = await deps.getProject(decodeURIComponent(project[1]));
      if (!found) {
        send(res, 404, { error: { code: 'project_missing', message: '工程不存在', retryable: false } });
        return;
      }
      send(res, 200, { data: { id: found.id, name: found.name, fps: found.fps, assetIds: found.assetIds, timelineIds: found.timelineIds } });
      return;
    }
    if (req.method === 'POST' && path === '/api/studio-bridge/projects') {
      const body = await readJson(req);
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '工作室交接';
      const created = await deps.createProject(name);
      send(res, 200, { data: { id: created.id, name: created.name, fps: created.fps, assetIds: created.assetIds, timelineIds: created.timelineIds } });
      return;
    }
    if (req.method === 'POST' && path === '/api/studio-bridge/receive') {
      const body = await readJson(req);
      const items = Array.isArray(body.items) ? body.items as ReceiveItem[] : [];
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      const createName = typeof body.createProjectName === 'string' ? body.createProjectName : '';
      const current = projectId ? await deps.getProject(projectId) : null;
      if (projectId && !current) {
        send(res, 404, { error: { code: 'project_missing', message: '工程不存在', retryable: false } });
        return;
      }
      const project = current ?? await deps.createProject(createName || '工作室交接');
      const placed: StudioPoolAsset[] = [];
      const errors: { id: string; message: string }[] = [];
      for (const item of items) {
        try {
          const src = await acceptStudioFile({
            uploadDir: deps.uploadDir(),
            storedName: `${item.draft.id}${extensionOf(item.draft.sourceFilename || item.draft.name)}`,
            filePath: item.filePath,
            grant: item.grant,
            sha256: item.sha256 ?? null,
            grantSecret: deps.grantSecret(),
            registerReference: deps.registerReference,
          });
          const { durationFps: _durationFps, ...asset } = item.draft;
          placed.push({ ...asset, src });
        } catch (error) {
          errors.push({ id: item.draft?.id ?? '', message: error instanceof Error ? error.message : 'receive failed' });
        }
      }
      if (errors.length === items.length) {
        send(res, 409, { error: { code: 'media_hash_mismatch', message: errors.map((item) => item.message).join('; '), retryable: true } });
        return;
      }
      const applied = applyStudioAssets(project.doc, placed);
      const persisted = await deps.saveProject(project.id, applied.doc);
      if (!persisted) {
        send(res, 409, { error: { code: 'project_busy', message: '工程正在编辑，素材尚未保存', retryable: true } });
        return;
      }
      send(res, 200, { data: { persisted: true, projectId: project.id, assetIds: applied.doc.assets.map((asset) => asset.id), errors } });
      return;
    }
    if (req.method === 'POST' && path === '/api/studio-bridge/pairings/confirm') {
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code || !deps.confirmPairing) {
        send(res, 409, { error: { code: 'pairing_required', message: '还没有连接资产端', retryable: true } });
        return;
      }
      send(res, 200, { data: await deps.confirmPairing(code) });
      return;
    }
    if (req.method === 'POST' && path === '/api/studio-bridge/exports/return') {
      const body = await readJson(req);
      const encoded = typeof body.fileBase64 === 'string' ? body.fileBase64 : '';
      const bytes = Buffer.from(encoded, 'base64');
      if (!encoded || bytes.length === 0) {
        send(res, 409, { error: { code: 'export_incomplete', message: '未完成或空的导出不能回库', retryable: false } });
        return;
      }
      if (!deps.ingestExport) {
        send(res, 409, { error: { code: 'pairing_required', message: '还没有连接资产端', retryable: true } });
        return;
      }
      const saved = await deps.ingestExport({
        pairingId: typeof body.pairingId === 'string' ? body.pairingId : '',
        projectId: typeof body.projectId === 'string' ? body.projectId : '',
        mode: body.mode === 'new-version' ? 'new-version' : 'new-asset',
        targetAssetId: typeof body.targetAssetId === 'string' ? body.targetAssetId : undefined,
        bytes,
        outputType: typeof body.outputType === 'string' ? body.outputType : 'video',
        fileName: typeof body.fileName === 'string' ? body.fileName : 'export.mp4',
      });
      send(res, 200, { data: saved });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '剪辑端协作失败';
    send(res, 400, { error: { code: 'validation_failed', message, retryable: false } });
  }
}

function extensionOf(name: string): string {
  const match = /\.[a-z0-9]{1,8}$/i.exec(name);
  return match ? match[0] : '';
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65 * 1024 * 1024) { reject(new Error('单文件回库暂支持 48 MB 以内的文件')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) reject(new Error('body must be an object'));
        else resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function authorizedDeps(req: IncomingMessage): boolean {
  return studioBridgeAuthorized(req);
}

export { studioGrantSecret };
