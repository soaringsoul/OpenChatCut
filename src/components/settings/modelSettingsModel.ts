// Pure view model for the model-settings overview (「我在用的」/「已连接的服务」/添加服务).
// Everything is derived from the existing settings schema + GET /api/keys + the
// provider health store, so the overview never invents settings of its own: every
// change it makes is a normal staged patch against the same keys (.env.local /
// profile settings.env precedence is untouched).
import { llmProviderConfigNames, isLocalLlmProvider, LLM_PROVIDER_PRESETS } from '../../../shared/llm-providers';
import type { CodexAgentModel, CodexAgentStatus } from '../../../shared/codex-agent';
import type { CopilotAgentStatus } from '../../../shared/copilot-agent';
import type { ClaudeCodeAgentStatus } from '../../../shared/claude-code-agent';
import { ROUTE_NEEDS } from './settingsMediaProviders';
import {
  SETTINGS_CATEGORIES, findGroup, vendorConfigured,
  type KeyStatusResponse, type SettingsField, type SettingsGroup, type SettingsVendorPage,
} from './settingsSchema';
import type { PhosphorName } from './modelSettingsIcons';

export type HealthKind = 'ok' | 'invalid' | 'balance' | 'quota' | 'unavailable' | 'network' | 'config' | 'error';
export type Health = HealthKind | 'unknown' | 'none' | 'local';
export interface HealthRecord {
  readonly kind: HealthKind; readonly status?: number; readonly message: string;
  readonly at: number; readonly source: string; readonly lastOkAt?: number;
}
export type HealthMap = Readonly<Record<string, HealthRecord>>;

export const BAD_HEALTH: ReadonlySet<Health> = new Set(['invalid', 'balance', 'quota', 'unavailable', 'network', 'config', 'error']);
/** Badge text + tone for each health state. */
export const HEALTH_LABEL: Record<Health, { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' | 'info'; icon: PhosphorName }> = {
  ok: { text: '可用', tone: 'ok', icon: 'CheckCircle' },
  invalid: { text: '密钥无效', tone: 'bad', icon: 'XCircle' },
  balance: { text: '余额不足', tone: 'warn', icon: 'CreditCard' },
  quota: { text: '额度用尽', tone: 'warn', icon: 'Clock' },
  unavailable: { text: '服务异常', tone: 'warn', icon: 'WarningCircle' },
  network: { text: '网络不可达', tone: 'warn', icon: 'Globe' },
  config: { text: '配置有误', tone: 'bad', icon: 'WarningCircle' },
  error: { text: '调用失败', tone: 'bad', icon: 'XCircle' },
  unknown: { text: '未检测', tone: 'info', icon: 'Question' },
  none: { text: '未配置', tone: 'none', icon: 'Plus' },
  local: { text: '本地', tone: 'none', icon: 'Cpu' },
};

export interface PurposeDef {
  readonly key: string; readonly title: string; readonly desc: string; readonly icon: PhosphorName; readonly groupKey: string;
}
export const PURPOSES: readonly PurposeDef[] = [
  { key: 'agent', title: '对话 Agent', desc: '剪辑与动效 Agent 的大脑', icon: 'Sparkle', groupKey: 'llm' },
  { key: 'image', title: '生图', desc: '文生图 / 图生图', icon: 'Image', groupKey: 'image' },
  { key: 'video', title: '生视频', desc: '文 / 图生视频', icon: 'FilmSlate', groupKey: 'video' },
  { key: 'music', title: '配乐', desc: '文字 / 成片生成配乐', icon: 'MusicNotes', groupKey: 'music' },
  { key: 'voice', title: '配音', desc: '文字转语音', icon: 'SpeakerHigh', groupKey: 'voice' },
  { key: 'transcription', title: '转写', desc: '字幕与素材转写', icon: 'Subtitles', groupKey: 'transcription' },
  { key: 'stock', title: '在线图库', desc: '搜索可商用图片 / 视频', icon: 'Images', groupKey: 'stock' },
  { key: 'local', title: '本地模型', desc: '本地转写 · 节拍 · 画面搜索', icon: 'Cpu', groupKey: 'local' },
];

export interface ModelCtx {
  readonly status: KeyStatusResponse | null;
  readonly codexStatus: CodexAgentStatus | null;
  readonly copilotStatus: CopilotAgentStatus | null;
  readonly claudeCodeStatus: ClaudeCodeAgentStatus | null;
  readonly codexModels: readonly CodexAgentModel[];
  readonly health: HealthMap;
}

/** Provider identity shared by health records, connected-service chips and the detail drawer. */
export function healthKey(page: SettingsVendorPage): string {
  return page.key.split('/')[1] || page.vendor;
}

/** Pages holding a credential or account login: these are "connected services". */
export function isCredentialPage(page: SettingsVendorPage): boolean {
  if (page.kind === 'settings' || page.kind === 'local-models') return false;
  if (page.connection) return true;
  if (page.key.startsWith('llm/') && isLocalLlmProvider(page.vendor) && LLM_PROVIDER_PRESETS.some((p) => p.id === page.vendor)) return true;
  return page.fields.some((f) => f.kind === 'secret');
}

const MODEL_CATEGORIES = new Set(['agent', 'generation', 'assets']);
export const ALL_PAGES: readonly SettingsVendorPage[] = SETTINGS_CATEGORIES.flatMap((c) => c.groups.flatMap((g) => g.vendors));
export const MODEL_PAGES: readonly SettingsVendorPage[] = SETTINGS_CATEGORIES
  .filter((c) => MODEL_CATEGORIES.has(c.key)).flatMap((c) => c.groups.flatMap((g) => g.vendors))
  .filter((p) => p.vendor !== 'vision');

export function pagesFor(key: string): SettingsVendorPage[] {
  return ALL_PAGES.filter((p) => healthKey(p) === key && p.kind !== 'local-models');
}

export function pageConfigured(ctx: ModelCtx, page: SettingsVendorPage): boolean {
  return vendorConfigured(ctx.status, page, ctx.codexStatus, ctx.copilotStatus, ctx.claudeCodeStatus);
}

/** Service is connected when any credential page sharing its identity is configured. */
export function serviceConnected(ctx: ModelCtx, key: string): boolean {
  return pagesFor(key).some((p) => isCredentialPage(p) && pageConfigured(ctx, p));
}

/** Current model of a page ('' when the page has no model field). */
export function pageModel(ctx: ModelCtx, page: SettingsVendorPage): string {
  const models = ctx.status?.models ?? {};
  if (page.connection === 'codex') {
    return models.CODEX_MODEL || ctx.codexModels.find((m) => m.isDefault)?.id || 'Codex 默认模型';
  }
  if (page.key.startsWith('llm/') && LLM_PROVIDER_PRESETS.some((p) => p.id === page.vendor)) {
    const name = llmProviderConfigNames(page.vendor).model;
    return models[name] || page.fields.find((f) => f.name === name)?.defaultLabel || '';
  }
  const field = page.fields.find((f) => /MODEL$/.test(f.name) && f.kind !== 'secret');
  if (!field) return '';
  return models[field.name] || field.defaultLabel || '';
}

export interface HealthView { readonly kind: Health; readonly message: string; readonly at?: number; readonly status?: number }
export function serviceHealth(ctx: ModelCtx, key: string, configured: boolean): HealthView {
  if (!configured) return { kind: 'none', message: '尚未连接' };
  const record = ctx.health[key];
  if (record) return { kind: record.kind, message: record.message, at: record.at, status: record.status };
  return { kind: 'unknown', message: '尚未检测 · 可点「测试连接」' };
}

// ── purposes ───────────────────────────────────────────────────────────────

/** Route option value → vendor page id inside its group, where the two differ. */
const VALUE_VENDOR: Record<string, string> = {
  'gpt-image-2': 'openai', 'nano-banana': 'gemini', 'image-01': 'minimax', 'grok-imagine': 'xai',
  'grok-imagine-video': 'xai', seedance2: 'seedance', local: 'localasr',
};

export interface Choice {
  readonly value: string; readonly label: string; readonly page?: SettingsVendorPage;
  readonly service: string; readonly configured: boolean; readonly health: HealthView; readonly model: string;
}

function resolvePage(group: SettingsGroup, value: string): SettingsVendorPage | undefined {
  if (group.key === 'llm') return group.vendors.find((p) => p.key === `llm/${value}`);
  const vendor = VALUE_VENDOR[value] ?? value;
  return group.vendors.find((p) => p.vendor === vendor) ?? group.vendors.find((p) => p.key.endsWith(`/${value}`));
}

function routeConfigured(ctx: ModelCtx, group: SettingsGroup, value: string, page?: SettingsVendorPage): boolean {
  if (group.key === 'llm') return page ? pageConfigured(ctx, page) : false;
  const needs = ROUTE_NEEDS[value];
  if (needs) return needs.some((set) => set.every((n) => Boolean(ctx.status?.keys[n]?.configured)));
  return page ? pageConfigured(ctx, page) : false;
}

export function purposeChoices(ctx: ModelCtx, def: PurposeDef): Choice[] {
  const group = findGroup(def.groupKey);
  if (group.key !== def.groupKey) return [];
  if (!group.route) {
    return group.vendors.map((page) => {
      const configured = def.key === 'local' ? true : pageConfigured(ctx, page);
      const service = healthKey(page);
      return {
        value: page.key, label: page.title, page, service, configured, model: pageModel(ctx, page),
        health: def.key === 'local' ? { kind: 'local', message: '数据不出本机，按需安装' } : serviceHealth(ctx, service, configured),
      };
    });
  }
  return (group.route.options ?? []).filter((o) => o.value !== '').map((option) => {
    const page = resolvePage(group, option.value);
    const configured = routeConfigured(ctx, group, option.value, page);
    const service = option.value === 'local' ? 'localasr' : page ? healthKey(page) : option.value;
    const health: HealthView = option.value === 'local'
      ? { kind: 'local', message: '本地模型 · 免费离线' }
      : serviceHealth(ctx, service, configured);
    return { value: option.value, label: option.label, page, service, configured, health, model: page ? pageModel(ctx, page) : '' };
  });
}

export interface PurposeState {
  readonly def: PurposeDef;
  readonly routeName?: string;
  /** Saved route value ('' = 每次询问 / 任务中选择). */
  readonly current: string;
  readonly choice?: Choice;
  readonly choices: readonly Choice[];
  /** Health shown on the card. */
  readonly health: HealthView;
  /** Second line of the card. */
  readonly summary: string;
  readonly affected: boolean;
}

export function purposeState(ctx: ModelCtx, def: PurposeDef): PurposeState {
  const group = findGroup(def.groupKey);
  const choices = purposeChoices(ctx, def);
  if (!group.route) {
    if (def.key === 'local') {
      return { def, current: '', choices, health: { kind: 'local', message: '数据不出本机，按需安装' }, summary: '数据不出本机，按需安装', affected: false };
    }
    const on = choices.filter((c) => c.configured);
    const bad = on.find((c) => BAD_HEALTH.has(c.health.kind));
    return {
      def, current: '', choices, choice: on[0],
      health: on.length === 0 ? { kind: 'none', message: '尚未连接' } : bad ? bad.health : on[0].health,
      summary: on.length ? on.map((c) => c.label).join(' · ') : `可选 ${choices.slice(0, 3).map((c) => c.label).join('、')}…`,
      affected: Boolean(bad),
    };
  }
  const routeName = group.route.name;
  const saved = ctx.status?.models?.[routeName] ?? '';
  // Transcription's empty route means AssemblyAI (its labelled default).
  const current = saved || (def.key === 'transcription' ? 'assemblyai' : '');
  const choice = choices.find((c) => c.value === current);
  if (!choice) {
    const any = choices.filter((c) => c.configured);
    const askLabel = def.key === 'agent' ? '任务中选择模型' : '每次询问';
    return {
      def, routeName, current, choices,
      health: any.length ? { kind: 'unknown', message: `未指定默认 · ${askLabel}` } : { kind: 'none', message: '尚未连接' },
      summary: any.length ? `未指定默认 · ${askLabel}` : `可选 ${choices.slice(0, 4).map((c) => c.label).join('、')}…`,
      affected: false,
    };
  }
  const health = choice.configured ? choice.health : { kind: 'none' as const, message: `${choice.label} 尚未连接` };
  return {
    def, routeName, current, choices, choice, health,
    summary: choice.model,
    affected: !choice.configured || BAD_HEALTH.has(health.kind),
  };
}

/** A usable alternative for the purpose (configured, not failing, not the current one). */
export function fallbackChoice(state: PurposeState): Choice | undefined {
  const usable = state.choices.filter((c) => c.configured && c.value !== state.current && !BAD_HEALTH.has(c.health.kind) && c.health.kind !== 'local');
  return usable.find((c) => c.health.kind === 'ok') ?? usable[0];
}

export interface ImpactGroup { readonly service: string; readonly label: string; readonly health: HealthView; readonly purposes: readonly string[] }
/** Affected purposes grouped by the failing service, for the warning bar. */
export function impactGroups(states: readonly PurposeState[]): ImpactGroup[] {
  const groups = new Map<string, { label: string; health: HealthView; purposes: string[] }>();
  for (const state of states) {
    if (!state.affected || !state.choice) continue;
    const key = state.choice.service;
    const entry = groups.get(key) ?? { label: serviceLabel(key, state.choice.label), health: state.health, purposes: [] };
    entry.purposes.push(state.def.title);
    groups.set(key, entry);
  }
  return [...groups.entries()].map(([service, g]) => ({ service, ...g }));
}

// ── services ───────────────────────────────────────────────────────────────

const SERVICE_LABEL: Record<string, string> = {
  codex: 'OpenAI · Codex', openai: 'OpenAI', gemini: 'Google · Gemini', anthropic: 'Anthropic · Claude', stepfun: 'StepFun 阶跃星辰',
  'xai-oauth': 'xAI · Grok 订阅', xai: 'xAI · Grok', minimax: 'MiniMax', hailuo: 'MiniMax 海螺', 'claude-code': 'Claude Code 订阅',
  copilot: 'GitHub Copilot', seedance: 'Seedance · 火山', kling: '可灵 Kling', fal: 'Fal.ai', localasr: '本地模型',
};
export function serviceLabel(key: string, fallback = key): string {
  return SERVICE_LABEL[key] ?? pagesFor(key)[0]?.title ?? fallback;
}
/** Representative page (icon, primary fields): prefer the agent page. */
export function servicePage(key: string): SettingsVendorPage | undefined {
  const pages = pagesFor(key);
  return pages.find((p) => p.key.startsWith('llm/')) ?? pages.find(isCredentialPage) ?? pages[0];
}

/** Capability tags per service, from the purposes its pages appear in. */
export function serviceCaps(key: string): string[] {
  const caps: string[] = [];
  for (const def of PURPOSES) {
    if (def.key === 'local') continue;
    const group = findGroup(def.groupKey);
    if (group.key === def.groupKey && group.vendors.some((p) => healthKey(p) === key)) caps.push(def.key === 'agent' ? '对话' : def.title);
  }
  return caps;
}

export interface ServiceView {
  readonly key: string; readonly label: string; readonly page: SettingsVendorPage;
  readonly connected: boolean; readonly health: HealthView; readonly usedBy: readonly string[]; readonly caps: readonly string[];
}
export function services(ctx: ModelCtx, states: readonly PurposeState[]): ServiceView[] {
  const keys = [...new Set(MODEL_PAGES.filter(isCredentialPage).map(healthKey))];
  return keys.map((key) => {
    const page = servicePage(key)!;
    const connected = serviceConnected(ctx, key);
    return {
      key, label: serviceLabel(key, page.title), page, connected,
      health: serviceHealth(ctx, key, connected),
      usedBy: states.filter((s) => s.choice?.service === key || (s.def.key === 'stock' && s.choices.some((c) => c.service === key && c.configured))).map((s) => s.def.title),
      caps: serviceCaps(key),
    };
  });
}

// ── add flow catalog ───────────────────────────────────────────────────────

const POPULAR = ['codex', 'anthropic', 'gemini', 'deepseek', 'qwen', 'stepfun', 'kimi', 'glm'];
const DOMESTIC = new Set(['minimax', 'xiaomi', 'byteplus', 'seedance', 'kling', 'doubao', 'hailuo']);
const ASSETS = new Set(['pexels', 'pixabay', 'unsplash', 'freesound', 'assemblyai', 'deepgram', 'groq', 'elevenlabs', 'cartesia', 'inworld', 'fishaudio', 'speechify']);

export interface CatalogGroup { readonly key: string; readonly title: string; readonly items: readonly ServiceView[] }
export function addCatalog(all: readonly ServiceView[], query: string): CatalogGroup[] {
  const q = query.trim().toLowerCase();
  const match = (s: ServiceView) => !q || `${s.label} ${s.key} ${s.page.title} ${s.caps.join(' ')}`.toLowerCase().includes(q);
  const items = all.filter(match);
  const taken = new Set<string>();
  const pick = (pred: (s: ServiceView) => boolean) => items.filter((s) => !taken.has(s.key) && pred(s)).map((s) => { taken.add(s.key); return s; });
  const popular = POPULAR.map((k) => items.find((s) => s.key === k)).filter((s): s is ServiceView => Boolean(s));
  popular.forEach((s) => taken.add(s.key));
  const groups: CatalogGroup[] = [
    { key: 'popular', title: '常用', items: popular },
    { key: 'login', title: '订阅登录 · 无需密钥', items: pick((s) => Boolean(s.page.connection)) },
    { key: 'domestic', title: '国内模型', items: pick((s) => DOMESTIC.has(s.key)) },
    { key: 'local', title: '本地模型', items: pick((s) => isLocalLlmProvider(s.key) && LLM_PROVIDER_PRESETS.some((p) => p.id === s.key)) },
    { key: 'assets', title: '素材图库 · 语音与转写', items: pick((s) => ASSETS.has(s.key)) },
    { key: 'global', title: '海外模型与聚合网关', items: pick(() => true) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Route patches that make `service` the default for each purpose it can serve. */
export function purposeTargets(ctx: ModelCtx, key: string): Array<{ def: PurposeDef; routeName: string; value: string; current: boolean }> {
  const out: Array<{ def: PurposeDef; routeName: string; value: string; current: boolean }> = [];
  for (const def of PURPOSES) {
    const group = findGroup(def.groupKey);
    if (!group.route || group.key !== def.groupKey) continue;
    const choice = purposeChoices(ctx, def).find((c) => c.service === key);
    if (!choice) continue;
    const saved = ctx.status?.models?.[group.route.name] ?? '';
    out.push({ def, routeName: group.route.name, value: choice.value, current: saved === choice.value });
  }
  return out;
}

/** Vendor console URLs for "去充值 / 获取 Key" actions. */
export const CONSOLE_URL: Record<string, string> = {
  stepfun: 'https://platform.stepfun.com/account-overview', gemini: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys', openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys', qwen: 'https://bailian.console.aliyun.com/', kimi: 'https://platform.moonshot.cn/console/api-keys',
  glm: 'https://open.bigmodel.cn/usercenter/apikeys', minimax: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  xai: 'https://console.x.ai/', openrouter: 'https://openrouter.ai/keys', mistral: 'https://console.mistral.ai/api-keys',
  fal: 'https://fal.ai/dashboard/keys', kling: 'https://app.klingai.com/global/dev', seedance: 'https://console.volcengine.com/ark',
  byteplus: 'https://console.byteplus.com/ark', xiaomi: 'https://platform.xiaomimimo.com/', elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
  pexels: 'https://www.pexels.com/api/', pixabay: 'https://pixabay.com/api/docs/', unsplash: 'https://unsplash.com/developers',
  assemblyai: 'https://www.assemblyai.com/app/api-keys', deepgram: 'https://console.deepgram.com/', groq: 'https://console.groq.com/keys',
};

/** Masked hint for a saved secret: '••••abcd', '已设置' or ''. */
export function maskedKey(status: KeyStatusResponse | null, name: string): string {
  if (!status?.keys[name]?.configured) return '';
  const tail = status.hints?.[name];
  return tail ? `••••${tail}` : '已设置';
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/** Every secret field in the schema, once (shared keys such as MINIMAX_API_KEY appear on several pages). */
export function allSecretFields(): Array<SettingsField & { page: SettingsVendorPage }> {
  const seen = new Map<string, SettingsField & { page: SettingsVendorPage }>();
  for (const page of ALL_PAGES) for (const field of page.fields) {
    if (field.kind === 'secret' && !seen.has(field.name)) seen.set(field.name, { ...field, page });
  }
  return [...seen.values()];
}


export function effortLabel(value: string, t: (s: string) => string): string {
  const map: Record<string, string> = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高' };
  return map[value] ? t(map[value]) : value;
}
