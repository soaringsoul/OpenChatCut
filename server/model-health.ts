// Per-provider health for the settings overview: the last real call outcome of
// each provider (agent /llm proxy, studio model bridge, Codex, "测试连接").
// Only status codes, a classified kind and a sanitized short message are kept;
// request/response bodies and key values never enter this store.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runtimeProfile } from './runtime-profile.ts';
import { sanitizeProbeText } from './key-probe-result.ts';

export type HealthKind = 'ok' | 'invalid' | 'balance' | 'quota' | 'unavailable' | 'network' | 'config' | 'error';
export interface ProviderHealth {
  readonly kind: HealthKind;
  readonly status?: number;
  readonly message: string;
  readonly at: number;
  readonly source: 'agent' | 'studio' | 'test' | 'codex';
  readonly lastOkAt?: number;
}

const FILE = join(runtimeProfile().rootDir, 'model-health-v1.json');
const health = new Map<string, ProviderHealth>();
try {
  if (existsSync(FILE)) {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, ProviderHealth>;
    for (const [k, v] of Object.entries(raw)) if (v && typeof v.kind === 'string') health.set(k, v);
  }
} catch { /* a corrupt file only loses history */ }

let writing: Promise<void> = Promise.resolve();
function persist(): void {
  const snapshot = JSON.stringify(Object.fromEntries(health), null, 2);
  writing = writing.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, snapshot, { mode: 0o600 });
    await rename(`${FILE}.tmp`, FILE);
  }).catch(() => {});
}

/** Map an HTTP status (and optional provider text) to a user-facing kind. */
export function classifyHealth(status: number | undefined, text = ''): HealthKind {
  const body = text.toLowerCase();
  if (status && status >= 200 && status < 300) return 'ok';
  if (status === 402 || /insufficient[_ ]?(balance|funds|quota)|余额不足|欠费|balance|credit/.test(body)) return 'balance';
  if (status === 401 || status === 403 || /invalid[_ ]?api[_ ]?key|unauthori[sz]ed|authentication/.test(body)) return 'invalid';
  if (status === 429 || /quota|rate.?limit|usage limit|resource_exhausted|额度|限流/.test(body)) return 'quota';
  if (status === 404 || status === 400) return 'config';
  if (status && status >= 500) return 'unavailable';
  if (!status) return /timeout|econn|enotfound|fetch failed|network|网络|超时/.test(body) ? 'network' : 'error';
  return 'error';
}

const KIND_TEXT: Record<HealthKind, string> = {
  ok: '可用', invalid: '密钥无效或无权限', balance: '账户余额不足', quota: '额度用尽或限流',
  unavailable: '服务暂时不可用', network: '网络不可达', config: '接口或模型配置有误', error: '调用失败',
};

export function recordHealth(provider: string, status: number | undefined, source: ProviderHealth['source'], detail = '', known?: HealthKind): void {
  if (!provider) return;
  const kind = known ?? classifyHealth(status, detail);
  const previous = health.get(provider);
  const now = Date.now();
  // Successful calls refresh lastOkAt but keep the file quiet when nothing changed recently.
  if (kind === 'ok' && previous?.kind === 'ok' && now - previous.at < 60_000) return;
  const message = kind === 'ok' ? KIND_TEXT.ok
    : `${KIND_TEXT[kind]}${status ? `（HTTP ${status}）` : ''}${reason(detail) ? ` · ${reason(detail)}` : ''}`;
  health.set(provider, { kind, status, message, at: now, source, lastOkAt: kind === 'ok' ? now : previous?.lastOkAt });
  persist();
}

export function healthSnapshot(): Record<string, ProviderHealth> {
  return Object.fromEntries(health);
}

export async function flushHealth(): Promise<void> { await writing; }

/** Vendors wrap the useful sentence in JSON; surface just that sentence (already sanitized). */
export function upstreamReason(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; msg?: unknown };
    const err = body.error;
    const pick = typeof err === 'string' ? err
      : err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message
      : typeof body.message === 'string' ? body.message : typeof body.msg === 'string' ? body.msg : '';
    return pick ? pick.slice(0, 200) : text;
  } catch { return text; }
}

// The kind label already names the HTTP status; keep only the vendor's sentence.
function reason(detail: string): string {
  return sanitizeProbeText(upstreamReason(detail.replace(/^HTTP \d{3}\s*·\s*/, ''))).slice(0, 120);
}
