// "测试连接" for the settings overview: one REAL minimal call per provider page.
// Agent LLM pages send a 1-token completion (so missing balance / exhausted quota
// shows up, which a model-list probe cannot detect); other pages reuse the
// per-vendor probe table. The outcome feeds model-health. Never returns key values.
import { proxyDispatcher } from './outbound-proxy.ts';
import { makeGetter, probeUrlError, runProbe } from './key-probes.ts';
import { networkMessage, sanitizeProbeText } from './key-probe-result.ts';
import { resolveLlmProviderConfig } from './llm-config.ts';
import { LLM_PROVIDER_PRESETS, isLocalLlmProvider, protocolForProvider } from '../shared/llm-providers.ts';
import { xaiOauthAccessToken } from './xai-oauth-session.ts';
import { classifyHealth, recordHealth, upstreamReason, type HealthKind } from './model-health.ts';
import { codexModels, codexStatus } from './plugins/codex-agent.ts';

export interface CheckResult {
  ok: boolean; kind: HealthKind; message: string; status?: number; latencyMs?: number; models?: string[];
}

const LLM_IDS = new Set<string>(LLM_PROVIDER_PRESETS.map((p) => p.id));
const TIMEOUT_MS = 25_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const unsafe = probeUrlError(url);
  if (unsafe) throw new Error(unsafe);
  return fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS), dispatcher: proxyDispatcher(),
  } as RequestInit);
}

/** Minimal completion against the provider's own wire protocol (max 1 output token). */
async function llmMinimalCall(provider: string, overrides: Record<string, unknown>): Promise<CheckResult> {
  const get = makeGetter(overrides);
  const config = resolveLlmProviderConfig(provider, (name) => get(name as never));
  const key = provider === 'xai-oauth' ? xaiOauthAccessToken() : config.apiKey;
  if (!key && !isLocalLlmProvider(provider)) return { ok: false, kind: 'invalid', message: provider === 'xai-oauth' ? '尚未导入 Grok 订阅登录' : '尚未填写 API Key' };
  const protocol = protocolForProvider(provider);
  const base = config.baseUrl.replace(/\/+$/, '');
  const ping = [{ role: 'user', content: 'ping' }];
  const started = Date.now();
  let response: Response;
  try {
    if (protocol === 'anthropic') {
      response = await post(`${base}/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { model: config.model, max_tokens: 1, messages: ping });
    } else if (protocol === 'google') {
      response = await post(`${base}/models/${encodeURIComponent(config.model)}:generateContent`, { 'x-goog-api-key': key },
        { contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } });
    } else {
      const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
      response = await post(`${base}/chat/completions`, auth, { model: config.model, messages: ping, max_tokens: 1 });
      // Newer OpenAI reasoning models reject max_tokens; retry once with the replacement field.
      if (response.status === 400) {
        const text = await response.clone().text().catch(() => '');
        if (/max_tokens|max_completion_tokens/.test(text)) {
          response = await post(`${base}/chat/completions`, auth, { model: config.model, messages: ping, max_completion_tokens: 16 });
        }
      }
    }
  } catch (error) {
    return { ok: false, kind: 'network', latencyMs: Date.now() - started, message: networkMessage(error) };
  }
  const latencyMs = Date.now() - started;
  const text = response.ok ? '' : sanitizeProbeText(upstreamReason(await response.text().catch(() => '')));
  const kind = classifyHealth(response.status, text);
  if (kind === 'ok') return { ok: true, kind, status: response.status, latencyMs, message: `连接成功 · ${config.model} 已应答 · ${latencyMs}ms` };
  return { ok: false, kind, status: response.status, latencyMs, message: `HTTP ${response.status}${text ? ` · ${text}` : ''}` };
}

async function codexCheck(): Promise<CheckResult> {
  const started = Date.now();
  try {
    const status = await codexStatus();
    if (!status.installed) return { ok: false, kind: 'config', message: '本机未安装 OpenAI Codex CLI' };
    if (status.error) return { ok: false, kind: 'error', message: sanitizeProbeText(status.error) };
    if (status.account?.type !== 'chatgpt') return { ok: false, kind: 'invalid', message: '尚未登录 ChatGPT（Codex）' };
    const models = await codexModels();
    const ids = models.models.map((m) => m.id);
    return { ok: true, kind: 'ok', latencyMs: Date.now() - started, models: ids, message: `ChatGPT 已登录 · 可用 ${ids.length} 个模型 · ${Date.now() - started}ms` };
  } catch (error) {
    return { ok: false, kind: 'error', latencyMs: Date.now() - started, message: sanitizeProbeText(error instanceof Error ? error.message : String(error)) };
  }
}

/** page = settings page key (e.g. llm/gemini, image/stepfun, llm/codex). provider = health key. */
export async function checkProvider(page: string, overrides: Record<string, unknown>): Promise<CheckResult & { provider: string }> {
  const [group, vendor = ''] = page.split('/');
  let result: CheckResult;
  if (group === 'llm' && vendor === 'codex') result = await codexCheck();
  else if (group === 'llm' && LLM_IDS.has(vendor)) result = await llmMinimalCall(vendor, overrides);
  else {
    const probe = await runProbe(page, overrides);
    result = { ...probe, kind: probe.ok ? 'ok' : classifyHealth(probe.status, probe.message) };
  }
  // A failing unsaved candidate key must not mark the saved account unhealthy;
  // a passing one is saved right after by the add flow.
  const usesOverrides = Object.values(overrides).some((v) => String(v ?? '').trim() !== '');
  if (vendor && (result.ok || !usesOverrides)) {
    recordHealth(vendor, result.ok ? 200 : result.status, 'test', result.ok ? '' : result.message, result.kind);
  }
  return { ...result, provider: vendor };
}

