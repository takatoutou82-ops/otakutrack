// api/malstats.js
// Répartition des notes (10 → 1) d'une œuvre MyAnimeList, rapide et mise en cache.
// L'API officielle MAL ne la fournit pas : on lit la page /stats de MAL ET on interroge Jikan
// EN MÊME TEMPS, et on renvoie la première réponse valide (Promise.any). Le résultat est ensuite
// gardé en cache sur le CDN Vercel (1 jour) : les ouvertures suivantes sont quasi instantanées.
//
// Utilisation depuis le front : GET /api/malstats?type=manga&id=2
// Réponse : { scores:[{score:10,votes:1234,percentage:33.4}, ...], total:12345, source:'mal'|'jikan' }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function timedFetch(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

function build(byScore, source) {
  const scores = [];
  let total = 0;
  for (let n = 10; n >= 1; n--) {
    const s = byScore[n] || { votes: 0, percentage: 0 };
    total += s.votes;
    scores.push({ score: n, votes: s.votes, percentage: s.percentage });
  }
  return { scores, total, source };
}

async function fromMal(type, id) {
  const r = await timedFetch(`https://myanimelist.net/${type}/${id}/_/stats`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.8' }
  }, 4500);
  if (!r.ok) throw new Error('MAL HTTP ' + r.status);
  const html = await r.text();
  const i = html.search(/Score Stats/i);
  const part = i >= 0 ? html.slice(i) : html;
  // Une ligne par note : <small>10</small> … 28.9% <span>(10,111 votes)</span>
  const re = /<small>\s*(10|[1-9])\s*<\/small>[\s\S]{0,700}?(\d{1,3}(?:\.\d+)?)%\s*(?:<span[^>]*>)?\s*\(\s*([\d,.\s]+?)\s*votes?\s*\)/gi;
  const byScore = {};
  let m;
  while ((m = re.exec(part))) {
    const n = parseInt(m[1], 10);
    if (byScore[n]) continue;
    byScore[n] = { votes: parseInt(m[3].replace(/[^\d]/g, ''), 10) || 0, percentage: parseFloat(m[2]) || 0 };
  }
  if (Object.keys(byScore).length < 5) throw new Error('page MAL illisible');
  return build(byScore, 'mal');
}

async function fromJikan(type, id) {
  const r = await timedFetch(`https://api.jikan.moe/v4/${type}/${id}/statistics`, { headers: { 'User-Agent': UA } }, 6000);
  if (!r.ok) throw new Error('Jikan HTTP ' + r.status);
  const d = await r.json();
  const raw = d && d.data && d.data.scores;
  if (!raw) throw new Error('Jikan sans stats');
  const byScore = {};
  if (Array.isArray(raw)) raw.forEach(s => { if (s && s.score != null) byScore[s.score] = { votes: s.votes || 0, percentage: s.percentage || 0 }; });
  else Object.entries(raw).forEach(([k, s]) => { byScore[k] = { votes: s.votes || 0, percentage: s.percentage || 0 }; });
  return build(byScore, 'jikan');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { type, id } = req.query;
  if (!['anime', 'manga'].includes(type) || !/^\d+$/.test(String(id || ''))) {
    res.status(400).json({ error: 'Attendu : type=anime|manga et id numérique.' });
    return;
  }
  try {
    const out = await Promise.any([fromMal(type, id), fromJikan(type, id)]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: 'Répartition indisponible pour le moment.' });
  }
}
