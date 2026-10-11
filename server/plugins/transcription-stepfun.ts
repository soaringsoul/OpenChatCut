import { proxyDispatcher } from '../outbound-proxy.ts';
import type {
  NormalizedTranscriptResult,
  NormalizedTranscriptWord,
  TranscriptionOptions,
} from './transcription-types.ts';

type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);

export type StepfunAudioFormat = 'ogg' | 'mp3' | 'wav' | 'pcm' | 'm4a';

/** Sniff container type from magic bytes; default mp3 (common extracted audio). */
export function detectStepfunAudioFormat(audio: Uint8Array): StepfunAudioFormat {
  if (audio.length >= 4) {
    if (audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53) return 'ogg';
    if (audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46 && audio[3] === 0x46) return 'wav';
    if (audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) return 'ogg';
  }
  if (audio.length >= 12) {
    const brand = String.fromCharCode(audio[4]!, audio[5]!, audio[6]!, audio[7]!);
    if (brand === 'ftyp') return 'm4a';
  }
  if (audio.length >= 3
    && ((audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0)
      || (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33))) {
    return 'mp3';
  }
  return 'mp3';
}

/** Prefer zh/en for StepFun ASR; other codes fall back to zh. */
export function stepfunAsrLanguage(language: string): string {
  const code = language.trim().toLowerCase();
  if (!code || code === 'auto') return 'zh';
  if (code === 'en' || code.startsWith('en-')) return 'en';
  if (code === 'zh' || code.startsWith('zh-')) return 'zh';
  return 'zh';
}

/** Split a timed chunk into CJK chars / latin tokens for talking-head edits. */
export function expandTimedChunk(
  text: string,
  start: number,
  end: number,
): NormalizedTranscriptWord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const tokens = trimmed.match(
    /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9]+(?:'[A-Za-z]+)?|[^\s]/gu,
  )?.filter((token) => token.trim()) ?? [trimmed];
  if (tokens.length <= 1) {
    return [{ text: trimmed, start, end: Math.max(start, end), speaker: null }];
  }
  const span = Math.max(1, end - start);
  return tokens.map((token, index) => {
    const tokenStart = start + Math.round((index / tokens.length) * span);
    const tokenEnd = start + Math.round(((index + 1) / tokens.length) * span);
    return {
      text: token,
      start: tokenStart,
      end: Math.max(tokenStart, tokenEnd),
      speaker: null,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseSseJson(data: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(data));
  } catch {
    return null;
  }
}

export async function consumeStepfunAsrSse(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ text: string; words: NormalizedTranscriptWord[] }> {
  if (!body) throw new Error('StepFun ASR returned an empty stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const words: NormalizedTranscriptWord[] = [];

  const handleEvent = (raw: string): void => {
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const event = parseSseJson(dataLines.join('\n'));
    if (!event) return;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'error') {
      const message = typeof event.message === 'string' ? event.message : 'StepFun ASR failed';
      throw new Error(message);
    }
    if (type === 'transcript.text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (!delta.trim()) return;
      const start = typeof event.start_time === 'number' && Number.isFinite(event.start_time)
        ? Math.max(0, Math.round(event.start_time))
        : null;
      const end = typeof event.end_time === 'number' && Number.isFinite(event.end_time)
        ? Math.max(0, Math.round(event.end_time))
        : null;
      if (start != null && end != null) {
        words.push(...expandTimedChunk(delta, start, Math.max(start, end)));
      }
      return;
    }
    if (type === 'transcript.text.done' && typeof event.text === 'string') {
      text = event.text;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let splitAt = buffer.search(/\r?\n\r?\n/);
    while (splitAt >= 0) {
      const match = buffer.match(/\r?\n\r?\n/);
      const sepLen = match?.[0]?.length ?? 2;
      const chunk = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + sepLen);
      if (chunk.trim()) handleEvent(chunk);
      splitAt = buffer.search(/\r?\n\r?\n/);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleEvent(buffer);

  if (!text && words.length) {
    text = words.map((word) => word.text).join(' ')
      .replace(/\s+([,.;:!?，。；：！？])/gu, '$1')
      .replace(/([\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff])/gu, '$1');
  }
  if (!text) throw new Error('StepFun ASR returned no transcript text');
  if (!words.length) {
    words.push(...expandTimedChunk(text, 0, Math.max(1, text.length * 80)));
  }
  return { text, words };
}

export async function transcribeStepfunAudio(
  options: TranscriptionOptions,
  audio: Uint8Array,
  language: string,
): Promise<NormalizedTranscriptResult> {
  if (!options.stepfunApiKey) {
    throw new Error('StepFun API key is not configured');
  }
  const root = options.stepfunBaseUrl.replace(/\/+$/, '');
  const format = detectStepfunAudioFormat(audio);
  const response = await fetchWithProxy(`${root}/audio/asr/sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${options.stepfunApiKey}`,
    },
    body: JSON.stringify({
      audio: {
        data: Buffer.from(audio).toString('base64'),
        input: {
          transcription: {
            model: options.stepfunModel,
            language: stepfunAsrLanguage(language),
            enable_itn: true,
            enable_timestamp: true,
          },
          format: { type: format },
        },
      },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`StepFun ASR HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const { text, words } = await consumeStepfunAsrSse(response.body);
  return { text, words, utterances: [] };
}
