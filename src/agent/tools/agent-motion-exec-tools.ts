export { RUN_AGENT_MOTION_TOOL_SCHEMAS, RUN_AGENT_MOTION_TOOL_NAMES } from './schemas/agent-motion-exec-tools';

interface ExecResult {
  ok?: boolean;
  exitCode?: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  cwd?: string;
}

export async function execRunAgentMotionScriptTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'run_agent_motion_script') return { error: `unknown tool ${name}` };
  const command = String(args.command ?? '').trim();
  if (!command) return { error: 'command is required' };
  try {
    const response = await fetch('/api/agent-motion/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        timeout: typeof args.timeout === 'number' ? args.timeout : undefined,
        files: Array.isArray(args.files) ? args.files : undefined,
      }),
    });
    const data = (await response.json().catch(() => null)) as ExecResult & { error?: { code?: string; message?: string } } | null;
    if (!data) return { error: `exec failed (HTTP ${response.status})` };
    if (data.error && typeof data.error === 'object' && data.error.message) {
      if (data.error.code === 'not_configured') {
        return { error: 'Agent Motion 未配置 AGENT_MOTION_ROOT。请运行 dtb_media_studio/scripts/setup-agent-motion.sh 并重启剪辑端。' };
      }
      return { error: data.error.message };
    }
    if (data.error && typeof data.error === 'string' && data.ok !== true) {
      return { error: data.error, stdout: data.stdout, stderr: data.stderr, exitCode: data.exitCode };
    }
    return data;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
