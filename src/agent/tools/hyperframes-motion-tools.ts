export { HYPERFRAMES_MOTION_TOOL_NAMES, HYPERFRAMES_MOTION_TOOL_SCHEMAS } from './schemas/hyperframes-motion-tools';
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';

type Args = Record<string, unknown>;
const BASE = '/api/hyperframes-motion';
const enc = (v: unknown) => encodeURIComponent(String(v ?? ''));
const pick = (args: Args, keys: string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error?.message ?? data?.error ?? `HTTP ${res.status}`;
    return { error: typeof message === 'string' ? message : JSON.stringify(message), status: res.status, code: data?.error?.code ?? data?.code };
  }
  return data;
}

function need(args: Args, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function importRender(jobId: string, ctx: AgentContext): Promise<unknown> {
  const out = await call('POST', `/import/${enc(jobId)}`, {});
  if (out?.error) return out;
  const fps = ctx.getState().fps;
  const durationMs = Number(out.media?.durationMs) || 0;
  const asset: MediaAsset = {
    id: crypto.randomUUID(),
    name: String(out.name || out.filename),
    sourceFilename: String(out.filename),
    kind: 'video',
    src: String(out.path),
    durationInFrames: Math.max(1, Math.round((durationMs / 1000) * fps)) || Math.round(5 * fps),
    width: Number(out.media?.width) || undefined,
    height: Number(out.media?.height) || undefined,
  };
  ctx.commands.addAsset(asset);
  return { success: true, assetId: asset.id, name: asset.name, src: asset.src, durationInFrames: asset.durationInFrames, note: '已加入素材池，未自动上时间线' };
}

export async function execHyperframesMotionTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'hyperframes_motion') return { error: `unknown tool ${name}` };
  const action = String(args.action ?? '');
  const pid = need(args, 'projectId');
  const jid = need(args, 'jobId');
  const needP = () => (pid ? null : { error: `${action} 需要 projectId` });
  const needJ = () => (jid ? null : { error: `${action} 需要 jobId` });
  switch (action) {
    case 'status': return call('GET', '/v1/status');
    case 'catalog': return call('GET', `/v1/catalog${args.query ? `?q=${enc(args.query)}` : ''}`);
    case 'library': return need(args, 'path') ? call('GET', `/v1/library?path=${enc(args.path)}`) : { error: 'library 需要 path' };
    case 'list': return call('GET', '/v1/projects');
    case 'create': return call('POST', '/v1/projects', pick(args, ['name', 'starter', 'width', 'height', 'fps', 'durationInFrames', 'props']));
    case 'get': return needP() ?? call('GET', `/v1/projects/${enc(pid)}`);
    case 'update': return needP() ?? call('PATCH', `/v1/projects/${enc(pid)}`, pick(args, ['revision', 'name', 'width', 'height', 'fps', 'durationInFrames', 'props']));
    case 'files': return needP() ?? call('GET', `/v1/projects/${enc(pid)}/files${args.path ? `?path=${enc(args.path)}` : ''}`);
    case 'write_files': return needP() ?? call('PUT', `/v1/projects/${enc(pid)}/files`, pick(args, ['revision', 'files']));
    case 'render':
      return needP() ?? call('POST', `/v1/projects/${enc(pid)}/renders`, {
        ...pick(args, ['revision', 'kind', 'frame']),
        idempotencyKey: need(args, 'idempotencyKey') ?? crypto.randomUUID(),
      });
    case 'job': return needJ() ?? call('GET', `/v1/jobs/${enc(jid)}`);
    case 'cancel': return needJ() ?? call('POST', `/v1/jobs/${enc(jid)}/cancel`, {});
    case 'editor': return needP() ?? call('POST', `/v1/projects/${enc(pid)}/editor`, {});
    case 'import': return needJ() ?? importRender(jid!, ctx);
    default: return { error: `unknown action ${action}` };
  }
}
