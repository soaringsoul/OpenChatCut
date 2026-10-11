import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);

export const ALLOWED_BINARIES = new Set([
  'bash', 'sh', 'node', 'npm', 'npx', 'python3', 'python', 'uv', 'uvx',
  'ffmpeg', 'ffprobe', 'mkdir', 'cp', 'chmod',
]);

const INTERPRETERS = new Set(['bash', 'sh', 'node', 'python3', 'python']);
const INLINE_EXEC_FLAGS: Record<string, RegExp> = {
  bash: /^-[A-Za-z]*c/,
  sh: /^-[A-Za-z]*c/,
  node: /^(-[A-Za-z]*[ep]|--eval(=|$)|--print(=|$))/,
  python: /^(-[A-Za-z]*[cm]|--command(=|$))/,
  python3: /^(-[A-Za-z]*[cm]|--command(=|$))/,
};

export interface LocalCommandRequest {
  command: string;
  args?: string[];
  timeout?: number;
}

export interface LocalCommandResult {
  ok?: boolean;
  exitCode?: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  cwd?: string;
}

export const MAX_LOCAL_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_AGENT_MOTION_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

/** Reject interpreter invocations that execute anything but an in-dir script file. */
export function interpreterGuardError(dir: string, binary: string, args: string[]): string | null {
  if (!INTERPRETERS.has(binary)) return null;
  const pattern = INLINE_EXEC_FLAGS[binary]!;
  let script: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith('-') || arg === '-') { script = arg === '-' ? undefined : arg; break; }
    if (pattern.test(arg)) return `inline execution flag not allowed for ${binary}: ${arg}`;
  }
  if (!script) return `${binary} requires a script file inside the working directory`;
  const resolved = resolve(dir, script);
  if (resolved !== dir && !resolved.startsWith(dir + sep)) {
    return `script path escapes the working directory: ${script}`;
  }
  return null;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]`;
}

export interface WhitelistedCommandOptions {
  transformArgs?: (binary: string, args: string[]) => string[];
}

export async function runWhitelistedCommand(
  cwd: string,
  body: LocalCommandRequest,
  maxTimeoutMs = MAX_LOCAL_COMMAND_TIMEOUT_MS,
  options?: WhitelistedCommandOptions,
): Promise<LocalCommandResult> {
  const binary = body.command.split(/\s+/)[0] ?? '';
  if (!ALLOWED_BINARIES.has(binary)) {
    return { error: `command not allowed: "${binary}" — whitelist: ${[...ALLOWED_BINARIES].sort().join(', ')}` };
  }
  const rest = body.command.slice(binary.length).trim();
  let args = rest ? rest.split(/\s+/) : [];
  if (body.args?.length) args.push(...body.args);
  if (options?.transformArgs) args = options.transformArgs(binary, args);
  const guardError = interpreterGuardError(cwd, binary, args);
  if (guardError) return { error: guardError };
  const timeout = Math.min(Math.max(body.timeout ?? 60_000, 1_000), maxTimeoutMs);
  try {
    const result = await execFileAsync(binary, args, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
      cwd,
    };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message?: string };
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : (err.killed ? -9 : -1),
      killed: err.killed === true,
      stdout: truncateOutput(err.stdout ?? ''),
      stderr: truncateOutput(err.stderr ?? ''),
      error: err.message ?? String(error),
      cwd,
    };
  }
}
