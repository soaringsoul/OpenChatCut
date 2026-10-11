import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

import {
  consumeStepfunAsrSse,
  detectStepfunAudioFormat,
  expandTimedChunk,
  stepfunAsrLanguage,
  transcribeStepfunAudio,
} from './transcription-stepfun.ts';
import type { TranscriptionOptions } from './transcription-types.ts';

assert.equal(detectStepfunAudioFormat(new Uint8Array([0x49, 0x44, 0x33, 0x04])), 'mp3');
assert.equal(detectStepfunAudioFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), 'wav');
assert.equal(stepfunAsrLanguage('auto'), 'zh');
assert.equal(stepfunAsrLanguage('en-US'), 'en');

assert.deepEqual(expandTimedChunk('你好', 0, 400), [
  { text: '你', start: 0, end: 200, speaker: null },
  { text: '好', start: 200, end: 400, speaker: null },
]);

const sseBody = new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(
      'data: {"type":"transcript.text.delta","delta":"你好","start_time":0,"end_time":400}\n\n',
    ));
    controller.enqueue(encoder.encode(
      'data: {"type":"transcript.text.done","text":"你好"}\n\n',
    ));
    controller.close();
  },
});
const parsed = await consumeStepfunAsrSse(sseBody);
assert.equal(parsed.text, '你好');
assert.deepEqual(parsed.words, [
  { text: '你', start: 0, end: 200, speaker: null },
  { text: '好', start: 200, end: 400, speaker: null },
]);

const options: TranscriptionOptions = {
  openaiBaseUrl: '',
  openaiApiKey: '',
  openaiModel: '',
  mistralBaseUrl: '',
  mistralApiKey: '',
  mistralModel: '',
  deepgramApiKey: '',
  deepgramModel: '',
  groqBaseUrl: '',
  groqApiKey: '',
  groqModel: '',
  elevenApiKey: '',
  elevenModel: '',
  cartesiaApiKey: '',
  cartesiaModel: '',
  stepfunBaseUrl: 'https://api.stepfun.test/v1',
  stepfunApiKey: 'stepfun-test-key',
  stepfunModel: 'stepaudio-2.5-asr',
  language: 'zh',
  diarization: false,
};

const originalFetch = globalThis.fetch;
try {
  let seenUrl = '';
  let seenBody: unknown;
  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenBody = JSON.parse(String(init?.body ?? '{}'));
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"transcript.text.delta","delta":"测","start_time":0,"end_time":120}\n\n'
          + 'data: {"type":"transcript.text.done","text":"测"}\n\n',
        ));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  const result = await transcribeStepfunAudio(options, new Uint8Array([0x49, 0x44, 0x33, 0x04]), 'zh');
  assert.equal(seenUrl, 'https://api.stepfun.test/v1/audio/asr/sse');
  const body = seenBody as {
    audio: { input: { transcription: { model: string; enable_timestamp: boolean; language: string }; format: { type: string } } };
  };
  assert.equal(body.audio.input.transcription.model, 'stepaudio-2.5-asr');
  assert.equal(body.audio.input.transcription.enable_timestamp, true);
  assert.equal(body.audio.input.transcription.language, 'zh');
  assert.equal(body.audio.input.format.type, 'mp3');
  assert.equal(result.text, '测');
  assert.deepEqual(result.words, [{ text: '测', start: 0, end: 120, speaker: null }]);
  assert.deepEqual(result.utterances, []);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('transcription-stepfun.verify: ok');
