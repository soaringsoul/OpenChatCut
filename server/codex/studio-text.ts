import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { CodexAgentToolSpec, CodexTurnRequest, CodexTurnStreamEvent } from '../../shared/codex-agent.ts';
import { codexModels, codexStatus, runServerCodexTurn } from '../plugins/codex-agent.ts';

const READINESS_TTL_MS = 30_000;
const TOOL_HANDOFF_MS = 150;

export interface CodexStudioReadiness {
  readonly ready: boolean;
  readonly defaultModel: string;
  readonly reason?: string;
}

let readiness: CodexStudioReadiness = { ready: false, defaultModel: '', reason: '正在检查 Codex 登录状态' };
let checkedAt = 0;
let inflight: Promise<void> | null = null;

export function codexStudioReadiness(): CodexStudioReadiness {
  return readiness;
}

export function primeCodexStudioReadiness(value: CodexStudioReadiness): void {
  readiness = value;
  checkedAt = Date.now();
}

/** Subscription credentials stay inside the local Codex app-server; only readiness is cached here. */
export async function refreshCodexStudioReadiness(force = false): Promise<void> {
  if (!force && Date.now() - checkedAt < READINESS_TTL_MS) return;
  inflight ??= (async () => {
    try {
      const status = await codexStatus();
      if (!status.installed) readiness = { ready: false, defaultModel: '', reason: '本机未安装 OpenAI Codex CLI' };
      else if (status.error) readiness = { ready: false, defaultModel: '', reason: status.error };
      else if (status.account?.type !== 'chatgpt') readiness = { ready: false, defaultModel: '', reason: '请先在模型设置里登录 ChatGPT（Codex）' };
      else {
        const models = await codexModels();
        const preferred = models.models.find((model) => model.isDefault) ?? models.models[0];
        readiness = { ready: true, defaultModel: preferred?.id ?? '' };
      }
    } catch {
      readiness = { ready: false, defaultModel: '', reason: 'Codex 暂不可用，请在剪辑端模型设置中检查登录' };
    } finally {
      checkedAt = Date.now();
      inflight = null;
    }
  })();
  await inflight;
}

type ChatToolCall = { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
type ChatMessage = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown; name?: unknown };

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).filter(Boolean).join('\n');
}

function chatTools(value: unknown): CodexAgentToolSpec[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    const fn = tool && typeof tool === 'object' ? (tool as { type?: unknown; function?: Record<string, unknown> }) : null;
    if (fn?.type !== 'function' || typeof fn.function?.name !== 'string') return [];
    const parameters = fn.function.parameters;
    return [{
      name: fn.function.name,
      ...(typeof fn.function.description === 'string' ? { description: fn.function.description } : {}),
      inputSchema: parameters && typeof parameters === 'object' ? parameters as Record<string, unknown> : { type: 'object', properties: {} },
    }];
  });
}

function toolCallsOf(message: ChatMessage): ChatToolCall[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls as ChatToolCall[] : [];
}

function transcriptLine(message: ChatMessage): string {
  if (message.role === 'user') return `用户：${messageText(message.content)}`;
  if (message.role === 'tool') return `工具结果（${String(message.tool_call_id ?? '')}）：${messageText(message.content)}`;
  const text = messageText(message.content);
  const calls = toolCallsOf(message).map((call) =>
    `助手调用工具 ${String(call.function?.name ?? '')}（${String(call.id ?? '')}）：${typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})}`);
  return [text ? `助手：${text}` : '', ...calls].filter(Boolean).join('\n');
}

export function codexTurnFromChatCompletion(body: Record<string, unknown>, modelId: string): CodexTurnRequest {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
  const system = messages.filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => messageText(message.content)).filter(Boolean).join('\n\n');
  const dialogue = messages.filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'tool');
  const last = dialogue.at(-1)?.role;
  if (!dialogue.length || (last !== 'user' && last !== 'tool')) throw new Error('请求缺少用户消息');
  const prompt = dialogue.length === 1 ? messageText(dialogue[0].content)
    : [...dialogue.map(transcriptLine), last === 'tool' ? '请根据以上工具结果继续。' : ''].filter(Boolean).join('\n\n');
  const tools = chatTools(body.tools);
  return {
    requestId: `studio-${randomUUID()}`, system, prompt, projectId: 'studio-assets',
    ...(modelId && modelId !== 'codex' ? { model: modelId } : {}), askOnly: tools.length === 0, tools,
  };
}

/** The Codex runtime tells the model its project id, so it tends to echo `projectId` into calls whose schema never declared it. */
function toolArguments(request: CodexTurnRequest, name: string, args: unknown): string {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object' || Array.isArray(args) || !('projectId' in args)) return JSON.stringify(args ?? {});
  const properties = request.tools.find((tool) => tool.name === name)?.inputSchema.properties;
  if (properties && typeof properties === 'object' && 'projectId' in properties) return JSON.stringify(args);
  const { projectId: _projectId, ...rest } = args as Record<string, unknown>;
  return JSON.stringify(rest);
}

type TurnRunner = (request: CodexTurnRequest, emit: (event: CodexTurnStreamEvent) => void, signal: AbortSignal) => Promise<void>;

export async function respondCodexChatCompletion(
  res: ServerResponse, body: Record<string, unknown>, modelId: string, run: TurnRunner = runServerCodexTurn,
): Promise<void> {
  const request = codexTurnFromChatCompletion(body, modelId);
  const stream = body.stream === true;
  const id = `chatcmpl-${request.requestId}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  let text = '';
  let reasoning = '';
  let failure = '';
  let handoff: ReturnType<typeof setTimeout> | undefined;
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (stream) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  await run(request, (event) => {
    if (event.type === 'text-delta') { text += event.delta; if (stream) chunk({ content: event.delta }); }
    else if (event.type === 'thinking-delta') { reasoning += event.delta; if (stream) chunk({ reasoning_content: event.delta }); }
    else if (event.type === 'tool-start') {
      // Chat Completions is stateless: the caller executes the tool and resends the history,
      // so the Codex turn ends here. The short delay keeps parallel calls from the same step.
      toolCalls.push({ id: event.callId, type: 'function', function: { name: event.name, arguments: toolArguments(request, event.name, event.args) } });
      handoff ??= setTimeout(() => controller.abort(), TOOL_HANDOFF_MS);
    } else if (event.type === 'error') failure = event.message;
  }, controller.signal);
  clearTimeout(handoff);
  if (toolCalls.length) failure = '';
  const finish = toolCalls.length ? 'tool_calls' : 'stop';
  if (stream) {
    if (failure) res.write(`data: ${JSON.stringify({ error: { message: failure } })}\n\n`);
    else {
      if (toolCalls.length) chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) });
      chunk({}, finish);
    }
    res.end('data: [DONE]\n\n');
    return;
  }
  if (failure) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: failure } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id, object: 'chat.completion', created, model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: toolCalls.length && !text ? null : text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish }] }));
}
