import type { Plugin } from 'vite';
import { Agent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { returnStudioExport } from './studio-export-return.ts';
import { commitOfflineStoredProject } from '../external-agent/offline-project-store.ts';
import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import { uploadDir } from '../media-dir.ts';
import { registerMediaReference } from '../media-references.ts';
import {
  claimOfflineProjectOwnership,
  releaseProjectEditOwnership,
} from '../external-agent/project-edit-ownership.ts';
import { studioBridgeAuthorized, studioGrantSecret } from '../studio-bridge-auth.ts';
import { getStoredEntry, setStoredEntry, writeProjectDocument } from './project-store.ts';
import { handleStudioBridge, type StudioBridgeProject } from './studio-bridge-http.ts';
import { applyStudioAssets, type StudioProjectDoc } from './studio-bridge-media.ts';

export function studioBridgePlugin(): Plugin {
  return {
    name: 'openchatcut-studio-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/studio-bridge/')) {
          next();
          return;
        }
        void handleStudioBridge(req, res, {
          authorized: (request) => studioBridgeAuthorized(request),
          listProjects,
          getProject,
          createProject: createStudioProject,
          saveProject: saveStudioProject,
          uploadDir,
          registerReference: registerMediaReference,
          grantSecret: studioGrantSecret,
          confirmPairing,
          ingestExport: (input) => returnStudioExport(input, getProject),
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'studio bridge failed';
          server.config.logger.error(`[studio-bridge] ${message}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: { code: 'peer_unavailable', message: '剪辑端协作失败', retryable: true } }));
          }
        });
      });
    },
  };
}

async function confirmPairing(code: string): Promise<{ pairingId: string }> {
  const base = process.env.STUDIO_BASE_URL ?? '';
  const serviceToken = process.env.STUDIO_SERVICE_TOKEN ?? '';
  const opencutToken = process.env.OPENCUT_STUDIO_TOKEN ?? '';
  if (!base || !serviceToken || !opencutToken) throw new Error('还没有连接资产端');
  const payload = JSON.stringify({
    code,
    opencutBaseUrl: process.env.OPENCUT_PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.OPENCUT_PORT || '5200'}`,
    opencutSubjectId: 'local',
    opencutToken,
  });
  const target = new URL('/api/studio/v1/pairings/confirm', base);
  const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      path: `${target.pathname}${target.search}`, method: 'POST',
      agent: target.protocol === 'https:' ? new HttpsAgent() : new Agent(),
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  const body = JSON.parse(response.text) as { data?: { pairingId: string }; error?: { message?: string } };
  if (response.status >= 300 || !body.data?.pairingId) throw new Error(body.error?.message || '配对确认失败');
  return body.data;
}

async function listProjects(): Promise<StudioBridgeProject[]> {
  const entry = await getStoredEntry('projects');
  const rows = Array.isArray(entry.value) ? entry.value : [];
  const projects: StudioBridgeProject[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') continue;
    const record = row as { id: string; name?: string; deletedAt?: number };
    if (record.deletedAt) continue;
    const project = await getProject(record.id);
    if (project) projects.push({ id: project.id, name: record.name?.trim() || project.name, fps: project.fps, assetIds: project.assetIds, timelineIds: project.timelineIds });
  }
  return projects;
}

async function getProject(id: string) {
  const entry = await getStoredEntry(`project:${id}`);
  const doc = asDoc(entry.value);
  if (!entry.found || !doc) return null;
  const timeline = doc.timelines[0] as { id?: string; fps?: number } | undefined;
  return {
    id,
    name: id,
    fps: typeof timeline?.fps === 'number' ? timeline.fps : 30,
    assetIds: doc.assets.map((asset) => asset.id),
    timelineIds: doc.timelines.map((item) => String((item as { id?: string }).id ?? '')),
    doc,
  };
}

export async function createStudioProject(name: string) {
  const id = `p${randomBytes(8).toString('hex')}`;
  const timelineId = `tl_${id}`;
  const doc: StudioProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    timelines: [{ id: timelineId, name: '序列 1', order: 0, fps: 30, width: 1920, height: 1080, items: [], selectedId: null }],
    activeTimelineId: timelineId,
  };
  const saved = await saveStudioProject(id, doc, name);
  if (!saved) throw new Error('failed to create project');
  return { id, name, fps: 30, assetIds: [], timelineIds: [timelineId], doc };
}

export async function saveStudioProject(projectId: string, doc: StudioProjectDoc, name = '工作室交接'): Promise<boolean> {
  const existing = await getStoredEntry(`project:${projectId}`);
  if (!existing.found) {
    const written = await writeProjectDocument({
      operation: 'project-document-write',
      key: `project:${projectId}`,
      expectedRevision: null,
      value: doc,
    });
    if (!written.accepted) return false;
    await rememberProject(projectId, name);
    return true;
  }
  const claimed = await claimOfflineProjectOwnership(projectId, 'studio-bridge');
  if (claimed.status !== 'claimed') return false;
  try {
    const merged = applyStudioAssets(claimed.doc, doc.assets).doc;
    const normalized = runProjectMigrations(merged)?.doc;
    if (!normalized) throw new Error('交接工程格式无效');
    const written = await commitOfflineStoredProject({
      projectId, expectedRevision: claimed.revision, ownership: claimed.claim,
      doc: normalized, canCommit: () => true,
    });
    return written.status === 'applied';
  } finally { await releaseProjectEditOwnership(claimed.claim); }
}

async function rememberProject(id: string, name: string): Promise<void> {
  const entry = await getStoredEntry('projects');
  const rows = Array.isArray(entry.value) ? [...entry.value] : [];
  if (rows.some((item) => item && typeof item === 'object' && (item as { id?: string }).id === id)) return;
  rows.push({ id, name, updatedAt: Date.now() });
  await setStoredEntry('projects', rows);
}

function asDoc(value: unknown): StudioProjectDoc | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const doc = value as Partial<StudioProjectDoc>;
  if (!Array.isArray(doc.assets) || !Array.isArray(doc.timelines) || typeof doc.activeTimelineId !== 'string') return null;
  return doc as StudioProjectDoc;
}
