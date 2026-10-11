import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_AGENT_MOTION_TIMEOUT_MS,
  runWhitelistedCommand,
  type LocalCommandRequest,
} from '../local-command-exec.ts';
import {
  rewriteMediaUploadArgs,
  stageAgentMotionFiles,
  type AgentMotionFileInput,
} from '../agent-motion-files.ts';
import { getKey } from '../keystore.ts';

interface AgentMotionExecRequest extends LocalCommandRequest {
  files?: AgentMotionFileInput[];
}

function agentMotionRoot(): string | null {
  const raw = (getKey('AGENT_MOTION_ROOT') || process.env.AGENT_MOTION_ROOT || '').trim();
  if (!raw) return null;
  return resolve(raw);
}

const MAX_EXEC_BODY = 2 * 1024 * 1024;

function parseFiles(raw: unknown): AgentMotionFileInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: AgentMotionFileInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.path !== 'string' || !row.path.trim()) continue;
    files.push({
      path: row.path.trim(),
      content: typeof row.content === 'string' ? row.content : undefined,
      url: typeof row.url === 'string' ? row.url : undefined,
    });
  }
  return files.length ? files : undefined;
}

function readJson(req: IncomingMessage): Promise<AgentMotionExecRequest> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_EXEC_BODY) { rejectPromise(new Error('request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Partial<AgentMotionExecRequest>;
        const files = parseFiles(parsed.files);
        if (!files && (typeof parsed.command !== 'string' || !parsed.command.trim())) {
          rejectPromise(new Error('command is required'));
          return;
        }
        resolvePromise({
          command: typeof parsed.command === 'string' ? parsed.command.trim() : '',
          args: Array.isArray(parsed.args)
            ? parsed.args.filter((a): a is string => typeof a === 'string')
            : undefined,
          timeout: typeof parsed.timeout === 'number' ? parsed.timeout : 120_000,
          files,
        });
      } catch {
        rejectPromise(new Error('invalid JSON'));
      }
    });
    req.on('error', rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function motionStatus(): Promise<Record<string, unknown>> {
  const root = agentMotionRoot();
  if (!root) {
    return {
      configured: false,
      hint: '在 opencut_os/.env.local 设置 AGENT_MOTION_ROOT，或运行 dtb_media_studio/scripts/setup-agent-motion.sh',
    };
  }
  const markers = ['package.json', 'scripts/read-stage.mjs', '.agents/skills/motion-craft/SKILL.md'];
  const checks: Record<string, boolean> = {};
  for (const marker of markers) {
    try {
      await access(join(root, marker));
      checks[marker] = true;
    } catch {
      checks[marker] = false;
    }
  }
  return {
    configured: true,
    root,
    ready: markers.every((marker) => checks[marker]),
    checks,
    previewUrl: 'http://127.0.0.1:8793/',
  };
}

export function agentMotionPlugin(): Plugin {
  return {
    name: 'openchatcut-agent-motion',
    configureServer(server) {
      server.middlewares.use('/api/agent-motion', (req, res, next) => {
        const url = req.url ?? '/';
        if (req.method === 'GET' && (url === '/' || url === '/status')) {
          void motionStatus().then((data) => sendJson(res, 200, { data }));
          return;
        }
        if (req.method === 'POST' && (url === '/exec' || url === '/stage')) {
          void (async () => {
            const root = agentMotionRoot();
            if (!root) {
              sendJson(res, 409, { error: { code: 'not_configured', message: '尚未配置 AGENT_MOTION_ROOT' } });
              return;
            }
            try {
              await access(join(root, 'package.json'));
            } catch {
              sendJson(res, 409, { error: { code: 'invalid_root', message: 'AGENT_MOTION_ROOT 不是有效的 Agent Motion 目录' } });
              return;
            }
            const body = await readJson(req);
            if (url === '/stage') {
              if (!body.files?.length) {
                sendJson(res, 400, { error: { message: 'files is required' } });
                return;
              }
              const staged = await stageAgentMotionFiles(root, body.files);
              sendJson(res, 200, { ok: true, staged, cwd: root });
              return;
            }
            let stagedPaths: string[] | undefined;
            if (body.files?.length) {
              stagedPaths = await stageAgentMotionFiles(root, body.files);
            }
            if (!body.command) {
              sendJson(res, 400, { error: { message: 'command is required' } });
              return;
            }
            const result = await runWhitelistedCommand(root, body, MAX_AGENT_MOTION_TIMEOUT_MS, {
              transformArgs: (binary, args) => (binary === 'cp' ? rewriteMediaUploadArgs(args) : args),
            });
            sendJson(res, 200, stagedPaths ? { ...result, staged: stagedPaths } : result);
          })().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            server.config.logger.error(`[agent-motion] ${message}`);
            if (!res.headersSent) sendJson(res, 400, { error: { message } });
          });
          return;
        }
        next();
      });
    },
  };
}
