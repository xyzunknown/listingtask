// Vercel Serverless Function：把周报 digest 交给 Gemini 写成成段周报
// GEMINI_API_KEY 存在 Vercel 项目环境变量里（Settings → Environment Variables），不进代码库
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_INSTRUCTION = `你是加密货币交易所上币（Listing）运营团队的周报撰写助手。
用户会给你一份结构化 JSON（本周任务按站点分组的小结），请把它写成一段可直接发给团队的中文周报。

要求：
1. 用简体中文，输出纯文本：用换行分节，可以用「一、二、」或「【】」做小标题，但不要使用 Markdown 记号（不要 **、#、- 列表符号以外的装饰）。
2. 结构：【本周概览】用一两句话汇总数字（完成/推进/卡住/新增）；然后按站点分节写进展，每个站点下用「已完成 / 推进中 / 卡住 / 新增」归类；最后【下周计划】。
3. 卡住的事项必须写清楚卡在哪、需要谁支持，放到显眼位置。
4. 保留数据里的具体 Token 名、负责人、日期、子步骤数量，不要泛化，更不要编造数据里没有的内容。
5. 语言简洁专业，面向团队和管理层，整体控制在 500 字以内（内容多时可适当放宽）。
6. 某个板块没有内容就直接跳过，不要写"无"。`;

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// 模型降级链：主模型过载（503/429）时自动换用旧一档的 flash 模型，保证功能可用
const MODEL_FALLBACKS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGemini(apiKey, primaryModel, prompt) {
  const chain = [primaryModel, ...MODEL_FALLBACKS.filter(m => m !== primaryModel)];
  let lastErr = '';
  for (const model of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(1200);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents: [{
              role: 'user',
              parts: [{ text: '以下是本周周报数据 JSON，请据此撰写周报：\n\n' + prompt }],
            }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
          }),
        }
      );
      if (r.ok) {
        const data = await r.json();
        const block = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
        if (block) return block;
        const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || '未知原因';
        throw new Error(`Gemini 未返回内容（${reason}）`);
      }
      const errBody = await r.text();
      let msg = errBody;
      try { msg = JSON.parse(errBody).error?.message || errBody; } catch {}
      lastErr = `Gemini API 错误（${r.status}）：${String(msg).slice(0, 300)}`;
      // 404（模型不可用）与 429/500/503（过载/限流）→ 换下一个模型重试；鉴权/参数错误直接抛出
      if (![404, 429, 500, 503].includes(r.status)) throw new Error(lastErr);
    }
  }
  throw new Error(lastErr);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_HEADERS['Access-Control-Allow-Origin']);
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS['Access-Control-Allow-Headers']);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // GET ?list=1：列出当前 KEY 可用的 Gemini 模型（key 只在服务端使用）
  if (req.method === 'GET') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: '服务端未配置 GEMINI_API_KEY' });
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
      headers: { 'x-goog-api-key': apiKey },
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: j?.error?.message || '查询模型列表失败' });
    const models = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
    return res.status(200).json({ models });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 手动读原始请求体：Vercel 的 req.body 自动解析层在较大请求体上会损坏内容（Invalid JSON），不可依赖
    const raw = await readRawBody(req);
    let digest;
    try {
      digest = JSON.parse(raw.toString('utf8')).digest;
    } catch (e) {
      const preview = raw.toString('utf8').slice(0, 80).replace(/[^\x20-\x7e]/g, '·');
      return res.status(400).json({ error: `请求体解析失败（收到 ${raw.length} 字节，开头内容：${preview}）` });
    }
    if (!digest) return res.status(400).json({ error: '缺少 digest 数据' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: '服务端未配置 GEMINI_API_KEY（请在 Vercel 项目环境变量中添加并重新部署）' });
    }
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

    const text = await callGemini(apiKey, model, JSON.stringify(digest, null, 2));
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: '服务端异常：' + (e && e.message ? e.message : String(e)) });
  }
};
