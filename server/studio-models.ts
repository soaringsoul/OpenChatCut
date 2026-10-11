import { createHash, randomUUID } from 'node:crypto';
import { getKey, keyStatus, type KeyName } from './keystore.ts';
import { runtimeProfile } from './runtime-profile.ts';
import { LLM_PROVIDER_PRESETS, llmProviderConfigNames } from '../shared/llm-providers.ts';
import { resolveLlmProviderConfig } from './llm-config.ts';
import { resolveModelCapabilities, parseModelCapabilityOverrides } from '../shared/model-capabilities.ts';
import { versionedApiBaseUrl } from './plugins/media-provider-config.ts';
import { codexStudioReadiness } from './codex/studio-text.ts';

export interface StudioModel {
  ref: string;
  provider: string;
  label: string;
  modelId: string;
  capability: 'text' | 'image' | 'video' | 'audio';
  protocol: string;
  configured: boolean;
  available: boolean;
  reason?: string;
  settingsRoute: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsTools?: boolean;
}
interface ModelConnection extends StudioModel { baseUrl: string; headers: Record<string, string> }
const boot = randomUUID();
const read = (name: string): string => getKey(name as KeyName);
const profileIdentity = (): string => {
  const profile = runtimeProfile();
  return `${profile.id}:${createHash('sha256').update(profile.rootDir + '\0' + profile.keystorePath).digest('hex').slice(0, 24)}`;
};
const identity = (capability: string, provider: string, model: string): string =>
  Buffer.from(JSON.stringify([profileIdentity(), capability, provider, model])).toString('base64url');

function connections(): ModelConnection[] {
  const rows: ModelConnection[] = LLM_PROVIDER_PRESETS.map((preset): ModelConnection => {
    const config = resolveLlmProviderConfig(preset.id, read);
    const local = preset.id === 'ollama' || preset.id === 'lmstudio';
    const configured = local ? Boolean(read(llmProviderConfigNames(preset.id).model)) : Boolean(config.apiKey);
    const google = preset.protocol === 'google';
    const supported = preset.id !== 'xai-oauth';
    const caps = resolveModelCapabilities({ backend: 'api', provider: preset.id, modelId: config.model }, parseModelCapabilityOverrides(read('AGENT_MODEL_CAPABILITY_OVERRIDES')));
    return {
      ref: identity('text', preset.id, config.model), provider: preset.id, label: preset.label,
      modelId: config.model, capability: 'text', protocol: preset.protocol === 'anthropic' ? 'claude-api'
        : preset.id === 'openai' && read('LLM_OPENAI_API_MODE') !== 'chat' ? 'openai-response' : 'chat-completion',
      configured, available: configured && supported,
      ...(!supported ? { reason: '资产端尚未适配此调用协议；剪辑端配置保持可用' } : !configured ? { reason: '尚未配置连接' } : {}),
      settingsRoute: `llm/${preset.id}`, baseUrl: google ? `${versionedApiBaseUrl(config.baseUrl, 'v1beta')}/openai` : config.baseUrl,
      headers: preset.protocol === 'anthropic' ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
        : config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      contextWindowTokens: caps.contextWindowTokens.value, maxOutputTokens: caps.maxOutputTokens.value,
      supportsImages: caps.supportsImages.value, supportsTools: caps.supportsTools.value,
    };
  });
  const add = (capability: StudioModel['capability'], provider: string, label: string, modelId: string,
    protocol: string, baseUrl: string, key: string, settingsRoute: string) => {
    rows.push({ ref: identity(capability, provider, modelId), capability, provider, label, modelId, protocol,
      configured: Boolean(key), available: Boolean(key), ...(!key ? { reason: '尚未配置连接' } : {}),
      baseUrl, headers: { authorization: `Bearer ${key}` }, settingsRoute });
  };
  add('image', 'openai', 'OpenAI · 生图', 'gpt-image-2', 'openai-image', versionedApiBaseUrl(read('IMAGE_BASE_URL') || 'https://api.openai.com', 'v1'),
    read('IMAGE_API_KEY') || read('OPENAI_API_KEY'), 'image/openai');
  const geminiModel = read('GEMINI_IMAGE_MODEL') || 'gemini-3.1-flash-image';
  const geminiKey = read('GEMINI_API_KEY');
  const geminiModelValid = /^[A-Za-z0-9._-]+$/.test(geminiModel);
  rows.push({ ref: identity('image', 'gemini', geminiModel), capability: 'image', provider: 'gemini', label: 'Google Gemini · 生图',
    modelId: geminiModel, protocol: 'gemini-image', configured: Boolean(geminiKey), available: Boolean(geminiKey) && geminiModelValid,
    ...(!geminiKey ? { reason: '尚未配置连接' } : !geminiModelValid ? { reason: '请填写 Gemini 模型 ID，不包含 models/ 前缀或 URL' } : {}),
    settingsRoute: 'image/gemini', baseUrl: versionedApiBaseUrl(read('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com', 'v1beta'),
    headers: { 'x-goog-api-key': geminiKey } });
  add('image', 'byteplus', 'BytePlus · Seedream', read('BYTEPLUS_IMAGE_MODEL') || 'seedream-4-5-251128', 'volcengine-ark-image',
    read('BYTEPLUS_BASE_URL') || 'https://ark.ap-southeast.bytepluses.com/api/v3', read('BYTEPLUS_API_KEY'), 'image/byteplus');
  const stepfunImageModel = read('STEPFUN_IMAGE_MODEL') || 'step-image-edit-2';
  const stepfunKey = read('LLM_STEPFUN_API_KEY');
  const stepfunImageValid = /^[A-Za-z0-9._-]+$/.test(stepfunImageModel);
  rows.push({ ref: identity('image', 'stepfun', stepfunImageModel), capability: 'image', provider: 'stepfun', label: 'StepFun · 生图',
    modelId: stepfunImageModel, protocol: 'stepfun-image', configured: Boolean(stepfunKey), available: Boolean(stepfunKey) && stepfunImageValid,
    ...(!stepfunKey ? { reason: '尚未配置连接' } : !stepfunImageValid ? { reason: '请填写 StepFun 生图模型 ID' } : {}),
    settingsRoute: 'image/stepfun', baseUrl: versionedApiBaseUrl(read('LLM_STEPFUN_BASE_URL') || 'https://api.stepfun.com/v1', 'v1'),
    headers: { authorization: `Bearer ${stepfunKey}` } });
  add('video', 'byteplus', 'BytePlus · Seedance', read('BYTEPLUS_VIDEO_MODEL') || 'seedance-1-5-pro-251215', 'volcengine-ark-video',
    read('BYTEPLUS_BASE_URL') || 'https://ark.ap-southeast.bytepluses.com/api/v3', read('BYTEPLUS_API_KEY'), 'video/byteplus');
  add('video', 'seedance', 'Seedance', read('SEEDANCE_VIDEO_MODEL') || 'doubao-seedance-2-0-260128', 'volcengine-ark-video',
    read('SEEDANCE_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3', read('SEEDANCE_API_KEY'), 'video/seedance');
  add('video', 'minimax', 'MiniMax · 视频', read('MINIMAX_VIDEO_MODEL') || 'MiniMax-Hailuo-02', 'minimax-video',
    versionedApiBaseUrl(read('MINIMAX_BASE_URL') || 'https://api.minimaxi.com', 'v1'), read('MINIMAX_API_KEY'), 'video/minimax');
  add('audio', 'openai', 'OpenAI · 语音', read('OPENAI_TTS_MODEL') || 'gpt-4o-mini-tts', 'openai-audio',
    versionedApiBaseUrl(read('IMAGE_BASE_URL') || 'https://api.openai.com', 'v1'), read('OPENAI_API_KEY'), 'voice/openai');
  const pending: Array<[StudioModel['capability'], string, string, string, string]> = [
    ['image', 'minimax', 'MiniMax', 'MINIMAX_API_KEY', 'MINIMAX_IMAGE_MODEL'],
    ['image', 'wavespeed', 'WaveSpeed', 'WAVESPEED_API_KEY', 'WAVESPEED_IMAGE_MODEL'],
    ['image', 'fal', 'Fal.ai', 'FAL_KEY', 'FAL_IMAGE_MODEL'],
    ['video', 'fal', 'Fal.ai', 'FAL_KEY', 'FAL_VIDEO_MODEL'],
    ['video', 'kling', '可灵', 'KLING_API_KEY', 'KLING_VIDEO_MODEL'],
    ['audio', 'minimax', 'MiniMax', 'MINIMAX_API_KEY', 'MINIMAX_TTS_MODEL'],
    ['audio', 'elevenlabs', 'ElevenLabs', 'ELEVENLABS_API_KEY', 'ELEVENLABS_TTS_MODEL'],
    ['audio', 'doubao', '豆包', 'DOUBAO_TTS_ACCESS_KEY', 'DOUBAO_TTS_MODEL'],
    ['audio', 'inworld', 'Inworld', 'INWORLD_TTS_API_KEY', 'INWORLD_TTS_MODEL'],
    ['audio', 'fishaudio', 'Fish Audio', 'FISHAUDIO_TTS_API_KEY', 'FISHAUDIO_TTS_MODEL'],
    ['audio', 'speechify', 'Speechify', 'SPEECHIFY_TTS_API_KEY', 'SPEECHIFY_TTS_MODEL'],
    ['audio', 'cartesia', 'Cartesia', 'CARTESIA_API_KEY', 'CARTESIA_TTS_MODEL'],
    ['audio', 'gemini', 'Gemini', 'GEMINI_API_KEY', 'GEMINI_TTS_MODEL'],
  ];
  for (const [capability, provider, label, key, modelKey] of pending) {
    const modelId = read(modelKey) || provider;
    rows.push({ ref: identity(capability, provider, modelId), capability, provider, label, modelId,
      protocol: 'unsupported', configured: Boolean(read(key)), available: false,
      reason: '配置由 OpenChatCut 统一维护；此能力目前仅剪辑端可用', settingsRoute: `${capability === 'audio' ? 'voice' : capability}/${provider}`,
      baseUrl: '', headers: {} });
  }
  const codex = codexStudioReadiness();
  const codexModel = read('CODEX_MODEL') || codex.defaultModel || 'codex';
  rows.push({ ref: identity('text', 'codex', codexModel), capability: 'text', provider: 'codex', label: 'OpenAI · Codex（ChatGPT 订阅）',
    modelId: codexModel, protocol: 'chat-completion', configured: codex.ready, available: codex.ready,
    ...(!codex.ready ? { reason: codex.reason } : {}), settingsRoute: 'llm/codex', baseUrl: '', headers: {}, supportsImages: false, supportsTools: true });
  for (const [provider, label, modelKey] of [['copilot', 'GitHub Copilot', 'COPILOT_MODEL'], ['claude-code', 'Claude Code', 'CLAUDE_CODE_MODEL']]) {
    const modelId = read(modelKey) || provider;
    rows.push({ ref: identity('text', provider, modelId), capability: 'text', provider, label, modelId,
      protocol: 'subscription', configured: Boolean(read(modelKey)), available: false,
      reason: '订阅后端仅剪辑端可用，不作为素材端通用 API；登录状态在剪辑端确认', settingsRoute: `llm/${provider}`, baseUrl: '', headers: {} });
  }
  return rows;
}

export function studioModelCatalog() {
  const models = connections().map(({ baseUrl: _url, headers: _headers, ...model }) => model);
  // Never hash credentials into a public revision. A save notification rotates
  // this process revision even if the key's configured boolean stays true.
  const revision = createHash('sha256').update(boot + JSON.stringify(keyStatus()) + settingsRevision).digest('hex');
  const defaults: Record<string, string> = {};
  const routes: Record<string, string> = {
    text: read('LLM_PROVIDER'), image: read('PREFERRED_IMAGE_VENDOR'),
    video: read('PREFERRED_VIDEO_VENDOR'), audio: read('PREFERRED_VOICE_VENDOR'),
  };
  const aliases: Record<string, string> = { 'gpt-image-2': 'openai', 'nano-banana': 'gemini', seedance2: 'seedance', hailuo: 'minimax' };
  for (const [capability, route] of Object.entries(routes)) {
    const pick = (provider: string) => models.find((row) => row.capability === capability && row.available && row.provider === provider);
    const chosen = pick(aliases[route] || route) || (capability === 'text' && route === 'openai' ? pick('codex') : undefined);
    if (chosen) defaults[capability] = chosen.ref;
  }
  return { source: 'opencut' as const, profileId: profileIdentity(), revision, defaults, models };
}
let settingsRevision = 0;
export function invalidateStudioModels(): void { settingsRevision += 1; }

export function requireStudioModel(ref: string): ModelConnection {
  const connection = connections().find((row) => row.ref === ref);
  if (!connection?.available) throw new Error(connection?.reason || '模型配置已变化，请刷新模型目录');
  return connection;
}

export function studioModelPathAllowed(model: StudioModel, method: string, path: string): boolean {
  if (path.includes('..') || path.includes('%') || path.includes('://') || path.includes('//')) return false;
  if (model.capability === 'text') return method === 'POST' && (
    model.protocol === 'claude-api' ? path === '/messages' : model.protocol === 'openai-response' ? path === '/responses' : path === '/chat/completions');
  if (model.capability === 'image') {
    if (model.protocol === 'gemini-image') return method === 'POST' && path === `/models/${model.modelId}:generateContent`;
    if (model.protocol === 'stepfun-image') return method === 'POST' && path === '/images/generations';
    return method === 'POST' && ['/images/generations', '/images/edits'].includes(path);
  }
  if (model.capability === 'audio') return method === 'POST' && path === '/audio/speech';
  if (model.protocol === 'minimax-video') return method === 'POST' && path === '/video_generation'
    || method === 'GET' && /^\/(?:query\/video_generation|files\/retrieve)\?/.test(path);
  return method === 'POST' && path === '/contents/generations/tasks'
    || ['GET', 'DELETE'].includes(method) && /^\/contents\/generations\/tasks\/[A-Za-z0-9_-]+$/.test(path);
}
