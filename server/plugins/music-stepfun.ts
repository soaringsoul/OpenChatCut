import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { uploadDir } from '../media-dir.ts';
import { proxyDispatcher } from '../outbound-proxy.ts';
import { musicProviderError } from './music-media.ts';
import type { MusicOptions, ValidMusicRequest } from './music-types.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

const POLL_MS = 5_000;
const MAX_WAIT_MS = 10 * 60_000;

interface StepfunSubmitResponse {
  task_id?: string;
  error?: { message?: string; type?: string };
}

interface StepfunQueryResponse {
  status?: string;
  audio?: string;
  response_format?: string;
  error?: { stage?: string; message?: string };
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error('unable to probe generated StepFun music'));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveAudioBytes(bytes: Buffer, format: string): Promise<{ path: string; durationSeconds: number }> {
  const ext = ['wav', 'pcm', 'flac', 'opus'].includes(format) ? format : 'mp3';
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  const file = join(dir, filename);
  const partial = join(dir, `.${filename}.part`);
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    const size = (await stat(partial)).size;
    if (!size) throw new Error('StepFun returned empty audio');
    const durationSeconds = await probeDuration(partial);
    await rename(partial, file);
    return { path: `/media/uploads/${filename}`, durationSeconds };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function generateStepfunMusic(
  options: MusicOptions,
  input: ValidMusicRequest,
  registerProviderTask: (provider: string, taskId: string) => Promise<void> | void,
  providerTaskId?: string,
): Promise<{ path: string; durationSeconds: number }> {
  if (!options.stepfunApiKey) {
    throw new Error('StepFun is not configured. Set LLM_STEPFUN_API_KEY in .env.local or 设置面板.');
  }
  const root = options.stepfunBaseUrl.replace(/\/$/, '');
  let taskId = providerTaskId?.trim() || '';
  if (!taskId) {
    const body: Record<string, unknown> = {
      task: 'text_to_music',
      model_id: options.stepfunModel,
      caption: input.prompt,
      instrumental: input.isInstrumental === true,
      response_format: input.audioFormat === 'wav' || input.audioFormat === 'flac' || input.audioFormat === 'pcm'
        ? input.audioFormat
        : 'mp3',
    };
    if (!input.isInstrumental && input.lyrics) body.lyrics = input.lyrics;
    const response = await fetchWithProxy(`${root}/audio/music/submit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.stepfunApiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await musicProviderError(response));
    const submitted = await response.json() as StepfunSubmitResponse;
    if (!submitted.task_id) throw new Error(submitted.error?.message || 'StepFun music submit returned no task_id');
    taskId = submitted.task_id;
    await registerProviderTask('stepfun', taskId);
  }

  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const query = await fetchWithProxy(`${root}/audio/music/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.stepfunApiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ task_id: taskId }),
    });
    if (!query.ok) throw new Error(await musicProviderError(query));
    const result = await query.json() as StepfunQueryResponse;
    if (result.status === 'SUCCESS') {
      if (!result.audio) throw new Error('StepFun music succeeded without audio');
      const format = result.response_format || input.audioFormat || 'mp3';
      return saveAudioBytes(Buffer.from(result.audio, 'base64'), format);
    }
    if (result.status === 'FAILED') {
      throw new Error(result.error?.message || `StepFun music failed (${result.error?.stage ?? 'unknown'})`);
    }
    await sleep(POLL_MS);
  }
  throw new Error('StepFun music generation timed out');
}
