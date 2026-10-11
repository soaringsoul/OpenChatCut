import type { Plugin } from 'vite';
import { studioBridgeAuthorized } from '../studio-bridge-auth.ts';
import { proxyMiddleware } from '../proxy.ts';
import { requireStudioModel, studioModelCatalog, studioModelPathAllowed } from '../studio-models.ts';
import { studioModelBody } from '../studio-model-body.ts';
import { stepfunImageGenerationBody } from './image-provider-clients.ts';
import { refreshCodexStudioReadiness, respondCodexChatCompletion } from '../codex/studio-text.ts';
import { previewStudioMigration, commitStudioMigration, restoreStudioMigration } from '../studio-model-migration.ts';

export function studioModelsPlugin(): Plugin {
  return {
    name: 'openchatcut-studio-models',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/studio-bridge/models')) { next(); return; }
        res.setHeader('cache-control', 'no-store');
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!studioBridgeAuthorized(req)) { send(401, { error: '模型协作凭证无效' }); return; }
        try {
          await refreshCodexStudioReadiness();
          const catalog = studioModelCatalog();
          if (req.method === 'POST' && url.pathname.startsWith('/api/studio-bridge/models/migration/')) {
            let bytes = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 256_000) throw new Error('迁移数据过大'); chunks.push(Buffer.from(chunk)); }
            const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const action = url.pathname.split('/').at(-1);
            const result = action === 'preview' ? previewStudioMigration(input) : action === 'commit' ? await commitStudioMigration(input)
              : action === 'restore' ? await restoreStudioMigration(input.backupId, input.revision) : null;
            if (!result) { send(404, { error: '迁移操作不存在' }); return; }
            send(200, { data: result }); return;
          }
          if (req.method === 'GET' && url.pathname === '/api/studio-bridge/models') { send(200, { data: catalog }); return; }
          const route = url.pathname.match(/^\/api\/studio-bridge\/models\/([^/]+)(\/.*)?$/);
          if (!route) { send(404, { error: '模型接口不存在' }); return; }
          const connection = requireStudioModel(route[1]);
          const { baseUrl: _url, headers: _headers, ...model } = connection;
          if (req.method === 'GET' && !route[2]) { send(200, { data: { ...model, revision: catalog.revision, profileId: catalog.profileId } }); return; }
          let path = (route[2] || '/') + url.search;
          // Asset adapters append /v1 to an API prefix without a version suffix.
          // The connection itself is the authoritative prefix, so consume that
          // transport decoration exactly once rather than duplicating /v1.
          if (path.startsWith('/v1/')) path = path.slice(3);
          if (connection.protocol === 'gemini-image' && path.startsWith('/v1beta/')) path = path.slice(7);
          if (!studioModelPathAllowed(connection, req.method || 'GET', path)) { send(403, { error: '当前模型不允许此操作' }); return; }
          let body = await studioModelBody(req, connection.modelId, connection.protocol === 'gemini-image');
          if (connection.provider === 'codex') {
            try {
              await respondCodexChatCompletion(res, JSON.parse(body?.toString('utf8') || '{}') as Record<string, unknown>, connection.modelId);
            } catch (error) {
              if (!res.headersSent) send(400, { error: error instanceof Error ? error.message : 'Codex 请求无效' });
              else res.end();
            }
            return;
          }
          if (connection.protocol === 'stepfun-image' && body) {
            body = Buffer.from(JSON.stringify(stepfunImageGenerationBody(JSON.parse(body.toString('utf8')) as Record<string, unknown>, connection.modelId)));
          }
          req.url = path;
          req.headers = { ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
            ...(req.headers.accept ? { accept: req.headers.accept } : {}) };
          return proxyMiddleware({ target: () => connection.baseUrl, headers: () => connection.headers, body, suppressErrorDetails: true,
            errorMessage: (status) => status === 402
              ? '上游账户额度不足，或该模型未开通付费（HTTP 402）。请到对应厂商控制台检查余额，或更换已开通的模型。'
              : status === 429
                ? '上游额度已用尽或触发限流（HTTP 429）。若使用免费层 Key，该模型可能没有免费额度，请在厂商控制台开通计费或更换模型。'
                : `模型调用失败（HTTP ${status}），请检查 OpenChatCut 模型设置` })(req, res, next);
        } catch { send(409, { error: '模型未配置或目录已变化，请打开 OpenChatCut 模型设置' }); }
      });
    },
  };
}
