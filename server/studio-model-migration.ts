import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getKey, keyRevision, setKeys, KEY_NAMES, type KeyName } from './keystore.ts';
import { runtimeProfile } from './runtime-profile.ts';
import { atomicWriteFile } from './plugins/project-store-durable.ts';
import { invalidateStudioModels } from './studio-models.ts';

interface LegacyChannel { id: string; name: string; scope?: string; interfaceType?: string; apiFormat?: string; baseUrl?: string; apiKey?: string; headers?: unknown[]; models?: string[] }
interface MigrationInput { channels: LegacyChannel[]; snapshot?: unknown; selected?: string[]; revision?: string }
interface Candidate { id: string; name: string; supported: boolean; conflict: boolean; reason: string; patch: Record<string, string> }

function candidates(input: MigrationInput): Candidate[] {
  if (!Array.isArray(input.channels) || input.channels.length > 100) throw new Error('迁移数据格式无效');
  return input.channels.filter((row) => row.scope !== 'system').map((row) => {
    const patch: Record<string, string> = {};
    const protocol = row.interfaceType || (row.apiFormat === 'claude' ? 'claude-api' : row.apiFormat === 'openai' ? 'chat-completion' : '');
    const model = row.models?.[0] || '';
    let reason = '此专有协议暂未承接；凭证只存入受限备份，不启用旧渠道';
    const assign = (key: string, base: string, modelKey: string) => {
      patch[key] = row.apiKey || '';
      patch[base] = row.baseUrl || '';
      patch[modelKey] = model;
    };
    if (['chat-completion', 'openai-response', 'claude-api'].includes(protocol)) {
      const prefix = protocol === 'claude-api' ? 'LLM_ANTHROPIC' : 'LLM_OPENAI';
      assign(`${prefix}_API_KEY`, `${prefix}_BASE_URL`, `${prefix}_MODEL`);
      if (patch[`${prefix}_BASE_URL`] && !/\/v\d+(?:beta)?$/.test(patch[`${prefix}_BASE_URL`])) patch[`${prefix}_BASE_URL`] += '/v1';
      if (prefix === 'LLM_OPENAI') patch.LLM_OPENAI_API_MODE = protocol === 'openai-response' ? 'responses' : 'chat';
    } else if (protocol === 'openai-image' && model === 'gpt-image-2') {
      patch.IMAGE_API_KEY = row.apiKey || ''; patch.IMAGE_BASE_URL = row.baseUrl || '';
    } else if (protocol === 'openai-audio') {
      assign('OPENAI_API_KEY', 'IMAGE_BASE_URL', 'OPENAI_TTS_MODEL');
    } else if (protocol === 'volcengine-ark-image') {
      assign('BYTEPLUS_API_KEY', 'BYTEPLUS_BASE_URL', 'BYTEPLUS_IMAGE_MODEL');
    } else if (protocol === 'volcengine-ark-video') {
      const provider = row.baseUrl?.includes('byteplus') ? 'BYTEPLUS' : 'SEEDANCE';
      assign(`${provider}_API_KEY`, `${provider}_BASE_URL`, `${provider}_VIDEO_MODEL`);
    } else if (protocol === 'minimax-video') {
      assign('MINIMAX_API_KEY', 'MINIMAX_BASE_URL', 'MINIMAX_VIDEO_MODEL');
    }
    let supported = Object.keys(patch).length > 0 && Boolean(row.apiKey) && Boolean(model);
    if ((row.headers?.length || 0) > 0 || (row.models?.length || 0) !== 1) {
      supported = false; reason = '自定义认证 Header 或多模型连接需要人工拆分到统一设置，不能自动改变其语义';
    }
    if (row.baseUrl) {
      try { const url = new URL(row.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) supported = false; }
      catch { supported = false; }
    }
    const conflict = supported && Object.keys(patch).some((key) => Boolean(getKey(key as KeyName)));
    if (supported) reason = conflict ? 'OpenChatCut 已有配置，保留现有配置；请在统一设置中手动处理' : '可导入统一设置；不会改动现有默认厂商';
    return { id: row.id, name: row.name || row.id, supported, conflict, reason, patch };
  });
}

export function previewStudioMigration(input: MigrationInput) {
  return { revision: keyRevision(), candidates: candidates(input).map(({ patch: _patch, ...item }) => item) };
}

const directory = () => join(dirname(runtimeProfile().keystorePath), 'studio-model-backups');
async function backupKey(): Promise<Buffer> {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const path = join(directory(), '.key');
  try { await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error('迁移备份密钥无效');
  return key;
}

export async function commitStudioMigration(input: MigrationInput) {
  if (!input.revision || input.revision !== keyRevision()) throw new Error('统一配置已变化，请重新预览迁移');
  const rows = candidates(input);
  const selected = new Set(input.selected || []);
  if (selected.size !== (input.selected || []).length || [...selected].some((id) => !rows.some((row) => row.id === id && row.supported && !row.conflict))) throw new Error('迁移选择已失效');
  const patch: Record<string, string> = {};
  for (const row of rows.filter((row) => selected.has(row.id))) {
    if (Object.keys(row.patch).some((key) => key in patch && patch[key] !== row.patch[key])) throw new Error('所选渠道写入同一连接，请每次只选择一个');
    Object.assign(patch, row.patch);
  }
  const before = Object.fromEntries(KEY_NAMES.map((name) => [name, getKey(name)]));
  const id = randomUUID();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await backupKey(), iv);
  cipher.setAAD(Buffer.from(runtimeProfile().id));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ legacy: input.channels, snapshot: input.snapshot, before, imported: Object.keys(patch) })), cipher.final()]);
  await atomicWriteFile(join(directory(), `${id}.json`), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') }), { mode: 0o600 });
  await setKeys(patch, input.revision);
  invalidateStudioModels();
  return { backupId: id, imported: [...selected], archived: rows.filter((row) => !selected.has(row.id)).map((row) => row.id), revision: keyRevision() };
}

/** Roll back imported OpenChatCut fields in-place; never send secrets back to a
 * browser or reactivate the old asset-side configuration. */
export async function restoreStudioMigration(id: string, revision: string) {
  if (!revision || revision !== keyRevision()) throw new Error('统一配置已变化，不能覆盖后续修改');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('备份标识无效');
  const saved = JSON.parse(await readFile(join(directory(), `${id}.json`), 'utf8'));
  const decipher = createDecipheriv('aes-256-gcm', await backupKey(), Buffer.from(saved.iv, 'base64'));
  decipher.setAAD(Buffer.from(runtimeProfile().id)); decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
  const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.encrypted, 'base64')), decipher.final()]).toString('utf8'));
  const patch = Object.fromEntries((parsed.imported as string[]).map((key) => [key, parsed.before[key]]));
  await setKeys(patch, revision);
  invalidateStudioModels();
  return { restored: true };
}
