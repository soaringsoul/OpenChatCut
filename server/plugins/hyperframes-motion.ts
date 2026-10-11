// Editor-side HyperFrames motion bridge: forwards a fixed set of /v1 routes to the local
// hyperframes_worker (dtb_media_studio/hyperframes_worker, default 127.0.0.1:8794) with the
// worker token, and imports finished renders into the upload directory so the agent can add
// them to the media pool. The worker owns projects, rendering and Studio sessions.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getKey } from '../keystore.ts';
import { uploadDir } from '../media-dir.ts';

export const HYPERFRAMES_OWNER = 'opencut-local';
const MAX_BODY = 8 * 1024 * 1024;
const ID = '[0-9a-f-]{36}';

/** Routes the editor may reach on the worker; anything else is refused before forwarding. */
export const FORWARD_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/v1\/(status|catalog|library|projects|jobs)$/],
  ['POST', /^\/v1\/projects$/],
  ['GET', new RegExp(`^/v1/projects/${ID}(/files)?$`)],
  ['PATCH', new RegExp(`^/v1/projects/${ID}$`)],
  ['PUT', new RegExp(`^/v1/projects/${ID}/files$`)],
  ['POST', new RegExp(`^/v1/projects/${ID}/(renders|editor)$`)],
  ['DELETE', new RegExp(`^/v1/projects/${ID}/editor$`)],
  ['GET', new RegExp(`^/v1/jobs/${ID}$`)],
  ['POST', new RegExp(`^/v1/jobs/${ID}/cancel$`)],
];

export function allowedRoute(method: string, pathname: string): boolean {
  return FORWARD_ROUTES.some(([m, re]) => m === method && re.test(pathname));
}

function workerConfig(): { url: string; token: string } | null {
  const url = (getKey('HYPERFRAMES_WORKER_URL') || process.env.HYPERFRAMES_WORKER_URL || 'http://127.0.0.1:8794').trim().replace(/\/$/, '');
  const token = (getKey('HYPERFRAMES_WORKER_TOKEN') || process.env.HYPERFRAMES_WORKER_TOKEN || '').trim();
  return token ? { url, token } : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'x-motion-owner': HYPERFRAMES_OWNER });

/** Copy a delivered MP4 from the worker into the upload dir; returns the /media/uploads path. */
async function importRender(cfg: { url: string; token: string }, jobId: string): Promise<Record<string, unknown>> {
  const jobRes = await fetch(`${cfg.url}/v1/jobs/${jobId}`, { headers: headers(cfg.token) });
  const job = (await jobRes.json()) as Record<string, any>;
  if (!jobRes.ok) throw Object.assign(new Error(job?.error || `worker ${jobRes.status}`), { status: jobRes.status });
  if (job.kind !== 'delivery' || !['rendered', 'completed'].includes(job.status)) {
    throw Object.assign(new Error('只有已完成的 delivery 渲染可以导入素材池'), { status: 409 });
  }
  const name = `hyperframes-${jobId}.mp4`;
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const dest = join(dir, name);
  const exists = await stat(dest).then((s) => s.size > 0, () => false);
  if (!exists) {
    const media = await fetch(`${cfg.url}/v1/jobs/${jobId}/files/master`, { headers: headers(cfg.token) });
    if (!media.ok || !media.body) throw Object.assign(new Error(`下载成片失败 (${media.status})`), { status: 502 });
    const tmp = `${dest}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(media.body as any), createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }
  return { ok: true, path: `/media/uploads/${name}`, filename: name, name: job.name, media: job.media ?? null, revision: job.revision };
}

export function hyperframesMotionPlugin(): Plugin {
  return {
    name: 'openchatcut-hyperframes-motion',
    configureServer(server) {
      server.middlewares.use('/api/hyperframes-motion', (req, res) => {
        void (async () => {
          const cfg = workerConfig();
          const url = new URL(req.url ?? '/', 'http://local');
          if (!cfg) {
            sendJson(res, 409, { error: { code: 'not_configured', message: '尚未配置 HYPERFRAMES_WORKER_TOKEN，请运行 dtb_media_studio/scripts/setup-hyperframes.sh 并重启剪辑端' } });
            return;
          }
          const imp = url.pathname.match(new RegExp(`^/import/(${ID})$`));
          if (imp && req.method === 'POST') {
            sendJson(res, 200, await importRender(cfg, imp[1]));
            return;
          }
          const method = req.method ?? 'GET';
          if (!allowedRoute(method, url.pathname)) {
            sendJson(res, 404, { error: { code: 'route_not_allowed', message: `不支持的动效接口 ${method} ${url.pathname}` } });
            return;
          }
          const body = method === "GET" || method === "DELETE" ? undefined : (await readBody(req)).toString("utf8");
          const upstream = await fetch(`${cfg.url}${url.pathname}${url.search}`, {
            method,
            headers: { ...headers(cfg.token), ...(body ? { 'content-type': 'application/json' } : {}) },
            body,
          });
          const text = await upstream.text();
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
          res.end(text);
        })().catch((error: any) => {
          const unreachable = error?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(String(error?.message));
          const message = unreachable ? 'HyperFrames 动效服务未启动（dtb_media_studio/launch.sh start motion）' : error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[hyperframes-motion] ${message}`);
          if (!res.headersSent) sendJson(res, error?.status || (unreachable ? 503 : 400), { error: { code: unreachable ? 'worker_unreachable' : 'request_failed', message } });
        });
      });
    },
  };
}
