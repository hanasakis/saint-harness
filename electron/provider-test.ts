import type { ProviderConfig, ConnectionTestResult } from '../shared/types';

const defaults = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  custom: '',
};

export async function testProviderConnection(provider: ProviderConfig, apiKey: string, timeoutMs = 15_000): Promise<ConnectionTestResult> {
  const started = performance.now();
  const result = (ok: boolean, message: string, modelCount?: number): ConnectionTestResult => ({ ok, message, elapsedMs: Math.round(performance.now() - started), ...(modelCount === undefined ? {} : { modelCount }) });
  const base = provider.baseUrl?.trim() || defaults[provider.id];
  let url: URL;
  try {
    url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return result(false, '请填写有效的 HTTP 或 HTTPS API 地址，不包含账号、查询参数或片段。'); }
  if (!apiKey && provider.id !== 'custom') return result(false, '请填写 API Key，或先保存此服务商的密钥。');
  if (provider.id === 'custom' && !provider.modelId?.trim()) return result(false, '请填写模型 ID 后再测试。');
  // Use the same base-URL conventions as Pi's Anthropic/OpenAI SDK clients.
  url.pathname = url.pathname.replace(/\/+$/, '') + (provider.id === 'anthropic' ? '/v1/models' : '/models');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider.id === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = apiKey;
  } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // Do not forward credentials to a redirect target or return remote error bodies.
    const response = await fetch(url, { headers, signal, redirect: 'manual' });
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        401: '鉴权失败（401）：请检查 API Key 是否正确或已过期。',
        403: '访问被拒绝（403）：请检查密钥权限、账号状态或服务区域。',
        404: '未找到模型列表接口（404）：请检查 API 基础地址；部分兼容服务未提供此接口。',
        405: '服务不支持读取模型列表（405），本次无法确认连接。',
        429: '请求受限（429）：请检查额度或稍后重试。',
      };
      return result(false, response.status >= 300 && response.status < 400
        ? 'API 地址发生重定向，请直接填写最终的服务地址后重试。'
        : messages[response.status] || `服务返回 HTTP ${response.status}，请检查服务状态后重试。`);
    }
    const reader = response.body?.getReader();
    if (!reader) return result(false, '服务返回空响应，无法读取模型列表。');
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) { await reader.cancel(); return result(false, '模型列表响应过大，请检查 API 地址。'); }
      chunks.push(value);
    }
    let body: { data?: unknown };
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return result(false, '服务未返回有效的 JSON 模型列表，请检查是否填写了 API 地址。'); }
    if (!body || !Array.isArray(body.data) || body.data.some(m => !m || typeof m.id !== 'string')) return result(false, '响应不包含有效的模型列表，请检查服务的 API 兼容性。');
    if (!body.data.length) return result(false, '接口已连通，但没有返回可用模型，请检查账号权限或服务配置。', 0);
    if (provider.id === 'custom' && !body.data.some(m => m.id === provider.modelId?.trim())) return result(false, '接口已连通，但列表中未找到填写的模型 ID，请核对后重试。', body.data.length);
    return result(true, provider.id === 'custom' ? '连接成功，已找到指定模型。' : '连接成功，已读取模型列表。', body.data.length);
  } catch (error) {
    if (signal.aborted) return result(false, '连接超时，请检查网络、代理或服务地址后重试。');
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return result(false, '无法解析服务域名，请检查 API 地址或 DNS。');
    if (code === 'ECONNREFUSED') return result(false, '连接被拒绝，请检查服务是否启动，以及地址和端口是否正确。');
    return result(false, '无法连接服务，请检查网络、代理及 HTTPS 证书后重试。');
  }
}
