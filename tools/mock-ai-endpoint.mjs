/**
 * 本地 AI 端点探针：模拟 OpenAI 兼容接口，用来验证 App 的请求链路
 * （CapacitorHttp 是否生效、base_url 拼接是否正确）。
 * 启动：node tools/mock-ai-endpoint.mjs
 * 然后 App 里把「接口地址」填 http://10.0.2.2:8799/v1（模拟器）或 http://<你的局域网IP>:8799/v1（真机）
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8799);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  console.log(`\n[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  console.log('  headers:', JSON.stringify({
    'content-type': req.headers['content-type'],
    authorization: req.headers.authorization ? 'Bearer ***' + String(req.headers.authorization).slice(-4) : '(none)',
    origin: req.headers.origin,
  }));
  if (body) console.log('  body:', body.slice(0, 200));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url.includes('/chat/completions')) {
    const auth = req.headers.authorization || '';
    if (!/^Bearer sk-/.test(auth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-1',
      object: 'chat.completion',
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '可用' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock AI endpoint listening on http://0.0.0.0:${PORT}`);
  console.log(`  模拟器访问：http://10.0.2.2:${PORT}/v1`);
  console.log(`  真机访问：  http://<本机局域网IP>:${PORT}/v1`);
});
