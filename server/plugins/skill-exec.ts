// Skill script execution on the LOCAL machine — the equivalent of omp's
// "[Skill directory: baseDir] + terminal" for installed skills, but narrowed:
// whitelisted binaries only, no shell (execFile, so args never hit a shell),
// cwd locked to the skill directory, timeout, output cap, no env inheritance
// beyond PATH/HOME. Runs the deterministic scripts shipped with a skill
// (render.mjs, check-deps.sh, …) that a cloud sandbox cannot reach.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { skillDirFor, skillFilesRoot } from '../skills-files.ts';
import { interpreterGuardError, runWhitelistedCommand, type LocalCommandRequest } from '../local-command-exec.ts';

export { interpreterGuardError };

function readJson(req: IncomingMessage): Promise<LocalCommandRequest> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) { rejectPromise(new Error('request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Partial<ExecRequest>;
        if (typeof parsed.command !== 'string' || !parsed.command.trim()) {
          rejectPromise(new Error('command is required'));
          return;
        }
        resolvePromise({
          command: parsed.command.trim(),
          args: Array.isArray(parsed.args)
            ? parsed.args.filter((a): a is string => typeof a === 'string')
            : undefined,
          timeout: typeof parsed.timeout === 'number' ? parsed.timeout : 60_000,
        });
      } catch { rejectPromise(new Error('invalid JSON')); }
    });
    req.on('error', rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Run one whitelisted binary inside the skill directory. */
async function runInSkillDir(slug: string, body: LocalCommandRequest): Promise<unknown> {
  const root = skillFilesRoot();
  const dir = skillDirFor(root, slug);
  if (!dir) return { error: `invalid skill slug "${slug}"` };
  try {
    await access(join(dir, 'SKILL.md'));
  } catch {
    return { error: `skill "${slug}" is not installed (no SKILL.md in ${dir})` };
  }
  return runWhitelistedCommand(dir, body);
}

export function skillExecPlugin(): Plugin {
  return {
    name: 'openchatcut-skill-exec',
    configureServer(server) {
      server.middlewares.use('/api/skills', (req, res, next) => {
        // /api/skills/install and /api/skills/<slug>/exec are owned by their own plugins.
        if (req.url?.startsWith('/install')) { next(); return; }
        const execMatch = req.url?.match(/^\/([A-Za-z0-9_-]{1,120})\/exec$/);
        if (execMatch && req.method === 'POST') {
          void (async () => {
            try {
              const body = await readJson(req);
              const result = await runInSkillDir(execMatch[1]!, body);
              sendJson(res, 200, result);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              server.config.logger.error(`[api/skills/exec] ${message}`);
              if (!res.headersSent) sendJson(res, 400, { error: message });
            }
          })();
          return;
        }
        next();
      });
    },
  };
}
