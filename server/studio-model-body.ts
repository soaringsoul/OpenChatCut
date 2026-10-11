import type { IncomingMessage } from 'node:http';

/** Pin the actual upstream model to the server-owned selection. Multipart
 * edits retain their binary bytes and must contain exactly that model field. */
export async function studioModelBody(req: IncomingMessage, modelId: string, modelInPath = false): Promise<Buffer | undefined> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new Error('模型请求过大');
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  const type = req.headers['content-type'] || '';
  if (type.startsWith('application/json')) {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { throw new Error('模型请求格式无效'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型请求格式无效');
    if (modelInPath) {
      const { model: _model, ...payload } = parsed as Record<string, unknown>;
      return Buffer.from(JSON.stringify(payload));
    }
    return Buffer.from(JSON.stringify({ ...parsed, model: modelId }));
  }
  if (type.startsWith('multipart/form-data')) {
    const boundary = type.match(/boundary=(?:"([^"]+)"|([^;\s]+))/)?.slice(1).find(Boolean);
    if (!boundary || boundary.length > 200) throw new Error('图片请求格式无效');
    const fields = body.toString('latin1').split(`--${boundary}`)
      .filter((part) => /^\r\nContent-Disposition: form-data; name="model"\r\n/i.test(part));
    if (fields.length !== 1 || fields[0].split('\r\n\r\n')[1]?.replace(/\r\n$/, '') !== modelId) {
      throw new Error('图片请求模型与选择不一致');
    }
    return body;
  }
  throw new Error('模型请求必须使用 JSON 或图片表单');
}
