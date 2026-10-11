import type { AgentToolSchema } from '../../tool-schema';

export const RUN_AGENT_MOTION_TOOL_NAMES = new Set(['run_agent_motion_script']);

export const RUN_AGENT_MOTION_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'run_agent_motion_script',
    description: '在本机 Agent Motion 工程根目录执行白名单命令（与 run_skill_script 相同安全策略）。用于 motion-craft / srt-reference-to-three 要求的 node scripts/read-stage.mjs、npm run doctor、python3 scripts/matte.py 等。需配置 AGENT_MOTION_ROOT。不要用 bash/sh -c 或 && 链式 shell；把素材池视频/SRT 写入工程请用 files（url=/media/uploads/… 或 content=字幕全文）。超时默认 120s、上限 600s。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '如 node scripts/read-stage.mjs --stage srt --kind talking-head' },
        timeout: { type: 'number', description: '可选：超时毫秒，默认 120000，上限 600000' },
        files: {
          type: 'array',
          description: '执行前写入 AGENT_MOTION_ROOT 的文件。每项：path（相对根目录）+ url（素材池 /media/uploads/… 或 https）或 content（如 SRT 文本）。大视频请用 url，不要 cp /media/uploads。',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              url: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path'],
          },
        },
      },
      required: ['command'],
    },
  },
];
