export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing OPENROUTER_API_KEY' });

  try {
    const { system, messages, max_tokens } = req.body;

    const orMessages = [];
    if (system) orMessages.push({ role: 'system', content: system });
    orMessages.push(...messages.map(m => ({ role: m.role, content: m.content })));

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://otakutrack-seven.vercel.app',
        'X-Title': 'OtakuTrack'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        messages: orMessages,
        max_tokens: max_tokens || 1000,
        temperature: 0.9
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });

    const text = data.choices?.[0]?.message?.content || '';
    res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
