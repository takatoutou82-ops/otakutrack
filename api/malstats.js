// api/malstats.js
// Répartition des notes (10 → 1) d'une œuvre, lue sur la page /stats de MyAnimeList.
// MyAnimeList bloque les requêtes directes venant des serveurs (vérification anti-robot) :
// on essaie donc EN MÊME TEMPS (1) la page directement et (2) la même page via le service
// « reader » r.jina.ai, qui charge la page comme un vrai navigateur. La première réponse valide gagne.
// Résultat gardé en cache sur le CDN Vercel (1 jour).
//
// GET /api/malstats?type=manga&id=2
// → { scores:[{score:10,votes:1234,percentage:33.4}, ...], total:12345, source }
// En cas d'échec : 502 { error, detail } où "detail" dit exactement ce qui s'est passé.

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Les 10 lignes « 28.9% (10,111 votes) » dans l'ordre du tableau (10 puis 9 … puis 1),
// quel que soit le format (HTML ou texte/markdown).
function parseScores(text, label) {
  const i = text.search(/Score Stats/i);
  const part = i >= 0 ? text.slice(i) : text;
  const re = /(\d{1,3}(?:\.\d+)?)\s*%[^()\n]{0,60}?\(\s*([\d,.\s]+?)\s*votes?\s*\)/gi;
  const rows = [];
  let m;
  while (rows.length < 10 && (m = re.exec(part))) {
    rows.push({ percentage: parseFloat(m[1]) || 0, votes: parseInt(m[2].replace(/[^\d]/g, ''), 10) || 0 });
  }
  const sum = rows.reduce((a, r) => a + r.percentage, 0);
  if (rows.length < 10 || sum < 90 || sum > 110) {
    const title = (text.match(/<title>([^<]{0,80})/i) || text.match(/Title:\s*([^\n]{0,80})/i) || [])[1] || '?';
    throw new Error(`${label}: contenu reçu (${text.length} caractères, « ${String(title).trim()} ») mais ${rows.length} ligne(s) de répartition lue(s)`);
  }
  const scores = rows.map((r, k) => ({ score: 10 - k, votes: r.votes, percentage: r.percentage }));
  return { scores, total: scores.reduce((a, s) => a + s.votes, 0), summary: parseSummary(text) };
}

// « Summary Stats » : Reading/Watching, Completed, On-Hold, Dropped, Plan to Read/Watch, Total
function parseSummary(text) {
  const flat = String(text).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  const num = re => { const m = flat.match(re); return m ? parseInt(m[1].replace(/[^\d]/g, ''), 10) : null; };
  const sm = {
    current: num(/\b(?:Reading|Watching):\s*([\d,]+)/i),
    completed: num(/\bCompleted:\s*([\d,]+)/i),
    on_hold: num(/\bOn-Hold:\s*([\d,]+)/i),
    dropped: num(/\bDropped:\s*([\d,]+)/i),
    planned: num(/\bPlan to (?:Read|Watch):\s*([\d,]+)/i),
    total: num(/\bTotal:\s*([\d,]+)/i)
  };
  return (sm.completed == null || sm.total == null) ? null : sm;
}

async function get(url, headers, ms, label) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  let r;
  try { r = await fetch(url, { headers, signal: c.signal, redirect: 'follow' }); }
  catch (e) { throw new Error(`${label}: ${e && e.name === 'AbortError' ? 'délai dépassé' : 'connexion impossible'}`); }
  finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  return await r.text(); // pas de détection « anti-robot » ici : c'est la lecture des données qui décide
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
  const page = `https://myanimelist.net/${type}/${id}/_/stats`;
  const direct = async () => parseScores(await get(page, {
    'User-Agent': CHROME, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://myanimelist.net/'
  }, 5000, 'direct'), 'direct');
  const reader = async () => parseScores(await get('https://r.jina.ai/' + page, {
    'Accept': 'text/plain', 'X-Timeout': '8'
  }, 9000, 'reader'), 'reader');
  try {
    const out = await Promise.any([direct(), reader()]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Répartition indisponible pour le moment.', detail });
  }
}
