// api/mangacollec.js
// Relais LECTURE SEULE vers l'API (non officielle) de MangaCollec, pour OtakuTrack.
//
// Comme le site mangacollec.com pour un visiteur non connecté : session anonyme
// (POST /session/app {client:"web"}) → jeton valable 1 h → appels GET avec ce jeton.
// Aucun compte, aucun identifiant, aucun secret.
//
// Utilisation depuis le front :
//   /api/mangacollec?path=planning&month=2026-10
//   /api/mangacollec?path=publishers
//   /api/mangacollec?path=series&id=<uuid>      → une série (éditions, tomes, coffrets…)
//   /api/mangacollec?path=series                → liste de toutes les séries (pour la recherche par titre)
//   /api/mangacollec?path=editions&id=<uuid>    → une édition
//
// Réponses mises en cache par le CDN Vercel pour ne pas solliciter MangaCollec inutilement.
// Non officiel : si MangaCollec change son API, le relais renvoie une erreur propre (502).

const API = 'https://api.mangacollec.com';
const UA = 'OtakuTrack-personal-relay/1.1 (usage personnel, cache actif)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _token = null;
let _tokenExp = 0;

async function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 9000);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function getToken(force) {
  const now = Date.now();
  if (!force && _token && now < _tokenExp) return _token;
  const r = await fetchTimeout(API + '/session/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client: 'web' })
  });
  if (!r.ok) throw new Error('session/app HTTP ' + r.status);
  const d = await r.json();
  if (!d || !d.access_token) throw new Error('session/app : pas de jeton');
  _token = d.access_token;
  _tokenExp = now + Math.max(60, (Number(d.expires_in) || 3600) - 300) * 1000;
  return _token;
}

function callApi(path, token) {
  return fetchTimeout(API + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': UA }
  }, 15000);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { path, month, id } = req.query;

  // Liste blanche stricte
  let target, cache;
  if (path === 'planning') {
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      res.status(400).json({ error: 'Paramètre "month" invalide. Attendu : AAAA-MM' });
      return;
    }
    target = '/v2/planning?month=' + month;
    cache = 's-maxage=3600, stale-while-revalidate=86400';
  } else if (path === 'publishers') {
    target = '/v2/publishers';
    cache = 's-maxage=86400, stale-while-revalidate=604800';
  } else if (path === 'series' || path === 'editions') {
    if (id === undefined) {
      if (path !== 'series') { res.status(400).json({ error: 'Paramètre "id" requis' }); return; }
      target = '/v2/series';                                          // liste complète (recherche par titre)
      cache = 's-maxage=86400, stale-while-revalidate=604800';
    } else {
      if (typeof id !== 'string' || !UUID_RE.test(id)) { res.status(400).json({ error: 'Paramètre "id" invalide (UUID attendu)' }); return; }
      target = '/v2/' + path + '/' + id.toLowerCase();
      cache = 's-maxage=21600, stale-while-revalidate=604800';        // 6 h frais, 7 j de secours
    }
  } else {
    res.status(400).json({ error: 'Paramètre "path" invalide. Attendu : planning | publishers | series | editions' });
    return;
  }

  try {
    let token = await getToken(false);
    let r = await callApi(target, token);
    if (r.status === 401) { token = await getToken(true); r = await callApi(target, token); }
    if (!r.ok) { res.status(502).json({ error: 'MangaCollec a répondu HTTP ' + r.status }); return; }
    const data = await r.json();
    res.setHeader('Cache-Control', cache);
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Impossible de contacter MangaCollec pour le moment.' });
  }
}
