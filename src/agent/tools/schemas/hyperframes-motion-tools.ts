import type { AgentToolSchema } from '../../tool-schema';

export const HYPERFRAMES_MOTION_TOOL_NAMES = new Set(['hyperframes_motion']);

export const HYPERFRAMES_MOTION_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'hyperframes_motion',
    description: [
      '本机 HyperFrames 动效服务（HTML+GSAP → Chrome 逐帧 → MP4，离线，思源黑体）。',
      'status 自检；catalog 列区块模板（china-map 全国地图、province-map 省级地图、title-card、blank）；library 读 skills/hyperframes/SKILL.md、docs/*.md、blocks/<id>/README.md。',
      'create 建工程（starter+props，地图模板给 data/highlight/routes 即可出片）；get/update（按 revision 改 props）；files 读、write_files 写 index.html/compositions/assets（返回 lint）。',
      'render kind=preview 出指定帧 PNG，kind=delivery 出 MP4；job 查进度；cancel 取消；editor 返回本机 Studio 地址。',
      'import 把 delivery 成片导入当前工程素材池（返回 assetId），之后再按需上时间线。',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'catalog', 'library', 'create', 'get', 'list', 'update', 'files', 'write_files', 'render', 'job', 'cancel', 'editor', 'import'] },
        projectId: { type: 'string', description: '工程 ID（get/update/files/write_files/render/editor）' },
        jobId: { type: 'string', description: '任务 ID（job/cancel/import）' },
        revision: { type: 'integer', description: 'update/write_files/render 必填的当前 revision' },
        name: { type: 'string' },
        starter: { type: 'string', enum: ['blank', 'title-card', 'china-map', 'province-map'] },
        width: { type: 'integer' }, height: { type: 'integer' }, fps: { type: 'integer' }, durationInFrames: { type: 'integer' },
        props: { type: 'object', additionalProperties: true, description: 'title/subtitle/accent；地图另有 data（{"广东":1280}）、unit、highlight、routes（[["北京","上海"]]）、topN' },
        path: { type: 'string', description: 'library 或 files 的路径' },
        query: { type: 'string', description: 'catalog 关键词' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        kind: { type: 'string', enum: ['preview', 'delivery'] },
        frame: { type: 'integer', description: 'preview 帧号' },
        idempotencyKey: { type: 'string', description: 'render 幂等键；同键同输入复用任务' },
      },
      required: ['action'],
    },
  },
];
