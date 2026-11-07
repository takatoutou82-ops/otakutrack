// api/malstats.js
// Répartition des notes (10 → 1) d'une œuvre, lue directement sur la page /stats de MyAnimeList.
// (L'API officielle MAL ne la fournit pas.) Résultat gardé en cache sur le CDN Vercel (1 jour).
//
// GET /api/malstats?type=manga&id=2
// → { scores:[{score:10,votes:1234,percentage:33.4}, ...], total:12345 }
// En cas d'échec : 502 { error, detail } où "detail" dit exactement ce que MyAnimeList a répondu.

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

function headers(ua) {
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://myanimelist.net/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0'
  };
}

async function readStats(type, id, ua, label) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 5500);
  let r;
  try {
    r = await fetch(`https://myanimelist.net/${type}/${id}/_/stats`, { headers: headers(ua), signal: c.signal, redirect: 'follow' });
  } catch (e) {
    throw new Error(`${label}: ${e && e.name === 'AbortError' ? 'MyAnimeList ne répond pas (délai dépassé)' : 'connexion impossible'}`);
  } finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`${label}: MyAnimeList répond HTTP ${r.status}`);
  const html = await r.text();
  if (/just a moment|captcha|access denied|unusual traffic/i.test(html.slice(0, 6000)))
    throw new Error(`${label}: MyAnimeList affiche une vérification anti-robot`);

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
  if (Object.keys(byScore).length < 5) {
    const title = (html.match(/<title>([^<]{0,80})/i) || [])[1] || '?';
    throw new Error(`${label}: page lue (${html.length} octets, titre « ${title.trim()} ») mais pas de répartition trouvée dedans`);
  }
  const scores = [];
  let total = 0;
  for (let n = 10; n >= 1; n--) {
    const s = byScore[n] || { votes: 0, percentage: 0 };
    total += s.votes;
    scores.push({ score: n, votes: s.votes, percentage: s.percentage });
  }
  return { scores, total };
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
    // Deux « identités » de navigateur en parallèle : la première qui obtient la page gagne
    const out = await Promise.any([readStats(type, id, CHROME, 'PC'), readStats(type, id, IPHONE, 'mobile')]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Répartition indisponible pour le moment.', detail });
  }
}
