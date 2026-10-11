import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CodexTurnRequest } from '../../shared/codex-agent.ts';
import { codexTurnFromChatCompletion, respondCodexChatCompletion } from './studio-text.ts';

const turn = codexTurnFromChatCompletion({ messages: [
  { role: 'system', content: '你是编剧' },
  { role: 'user', content: [{ type: 'text', text: '写一句台词' }] },
  { role: 'assistant', content: '好的' },
  { role: 'user', content: '再短一点' },
] }, 'gpt-6.1-sol');
assert.equal(turn.system, '你是编剧');
assert.equal(turn.model, 'gpt-6.1-sol');
assert.equal(turn.askOnly, true);
assert.deepEqual(turn.tools, []);
assert.match(turn.prompt, /用户：写一句台词[\s\S]*助手：好的[\s\S]*用户：再短一点/);
assert.equal(codexTurnFromChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }, 'codex').model, undefined);
assert.throws(() => codexTurnFromChatCompletion({ messages: [] }, 'codex'), /用户消息/);

const tooled = codexTurnFromChatCompletion({
  tools: [{ type: 'function', function: { name: 'create_node', description: '新建节点', parameters: { type: 'object', properties: { title: { type: 'string' } } } } }],
  messages: [
    { role: 'user', content: '建一个节点' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_node', arguments: '{"title":"开场"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
  ],
}, 'codex');
assert.equal(tooled.askOnly, false);
assert.deepEqual(tooled.tools, [{ name: 'create_node', description: '新建节点', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }]);
assert.match(tooled.prompt, /助手调用工具 create_node（call_1）：\{"title":"开场"\}[\s\S]*工具结果（call_1）：\{"ok":true\}[\s\S]*继续/);

let seen: CodexTurnRequest | null = null;
let mode: 'ok' | 'fail' | 'tool' = 'ok';
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    void respondCodexChatCompletion(res, JSON.parse(Buffer.concat(chunks).toString('utf8')), 'gpt-6.1-sol', async (request, emit, signal) => {
      seen = request;
      if (mode === 'fail') { emit({ type: 'error', message: 'Codex 调用失败：额度已用尽' }); return; }
      if (mode === 'tool') {
        emit({ type: 'text-delta', delta: '先建节点' });
        emit({ type: 'tool-start', callId: 'c1', name: 'create_node', args: { title: '开场', projectId: 'studio-assets' } });
        emit({ type: 'tool-start', callId: 'c2', name: 'create_node', args: { title: '结尾' } });
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        emit({ type: 'error', message: 'Codex turn cancelled.' });
        return;
      }
      emit({ type: 'thinking-delta', delta: '想' });
      emit({ type: 'text-delta', delta: '跑' });
      emit({ type: 'text-delta', delta: '通' });
      emit({ type: 'done' });
    });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
const post = (body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) });

const plain = await (await post({ messages: [{ role: 'user', content: 'hi' }] })).json() as { choices: Array<{ message: { content: string; reasoning_content?: string } }> };
assert.equal(plain.choices[0].message.content, '跑通');
assert.equal(plain.choices[0].message.reasoning_content, '想');
assert.deepEqual(seen!.tools, []);

const streamed = await (await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
assert.match(streamed, /"content":"跑"/);
assert.match(streamed, /"finish_reason":"stop"/);
assert.ok(streamed.trimEnd().endsWith('data: [DONE]'));

mode = 'fail';
const failed = await post({ messages: [{ role: 'user', content: 'hi' }] });
assert.equal(failed.status, 502);
assert.match(JSON.stringify(await failed.json()), /额度已用尽/);

mode = 'tool';
const tools = [{ type: 'function', function: { name: 'create_node', parameters: { type: 'object' } } }];
const called = await (await post({ tools, messages: [{ role: 'user', content: '建节点' }] })).json() as {
  choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
assert.equal(called.choices[0].finish_reason, 'tool_calls');
assert.equal(called.choices[0].message.content, '先建节点');
assert.deepEqual(called.choices[0].message.tool_calls?.map((call) => [call.id, call.function.name, JSON.parse(call.function.arguments).title]),
  [['c1', 'create_node', '开场'], ['c2', 'create_node', '结尾']]);
assert.equal(seen!.tools[0].name, 'create_node');
assert.equal('projectId' in JSON.parse(called.choices[0].message.tool_calls![0].function.arguments), false);

const calledStream = await (await post({ stream: true, tools, messages: [{ role: 'user', content: '建节点' }] })).text();
assert.match(calledStream, /"tool_calls":\[\{"index":0,"id":"c1"/);
assert.match(calledStream, /"finish_reason":"tool_calls"/);
assert.doesNotMatch(calledStream, /cancelled/);

server.close();
console.log('codex studio text: chat-completion mapping, streaming, tool calls, error passthrough passed');
