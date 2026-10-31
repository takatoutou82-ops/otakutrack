// api/mal.js
// Proxy vers l'API officielle MyAnimeList (v2).
// Nécessaire car MAL n'autorise pas les requêtes directes depuis un navigateur (CORS)
// et parce que le Client ID ne doit pas être visible dans le code source public du site.
//
// Utilisation depuis le front : GET /api/mal?type=anime&id=1535  (ou type=manga)

export default async function handler(req, res) {
  // CORS : autorise ton site GitHub Pages à appeler ce proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { type, id, q, ranking, limit, offset, withgenres } = req.query;

  if (!type || !['anime', 'manga'].includes(type)) {
    res.status(400).json({ error: 'Paramètre "type" invalide. Attendu: anime|manga' });
    return;
  }

  const CLIENT_ID = process.env.MAL_CLIENT_ID;
  if (!CLIENT_ID) {
    res.status(500).json({ error: "Variable d'environnement MAL_CLIENT_ID manquante sur Vercel." });
    return;
  }

  const detailFields = type === 'anime'
    ? 'id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,num_scoring_users,genres,media_type,status,num_episodes,start_season,broadcast,source,average_episode_duration,studios,rating,recommendations'
    : 'id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,num_scoring_users,genres,media_type,status,num_volumes,num_chapters,authors{first_name,last_name},serialization,recommendations';

  const listFields = type === 'anime'
    ? 'id,title,main_picture,alternative_titles,mean,studios,media_type,status'
    : 'id,title,main_picture,alternative_titles,mean,authors{first_name,last_name},media_type,status';

  // Option « withgenres » : ajoute les genres dans les listes (sert aux filtres par genre du catalogue)
  const fieldsList = withgenres ? listFields + ',genres' : listFields;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 500);
  const off = /^\d+$/.test(String(offset || '')) ? String(offset) : '0';

  let url;
  if (q) {
    // Recherche texte : GET /v2/{type}?q=...
    url = `https://api.myanimelist.net/v2/${type}?q=${encodeURIComponent(q)}&limit=${lim}&fields=${fieldsList}`;
  } else if (ranking) {
    // Classement : GET /v2/{type}/ranking?ranking_type=...
    url = `https://api.myanimelist.net/v2/${type}/ranking?ranking_type=${encodeURIComponent(ranking)}&limit=${lim}&offset=${off}&fields=${fieldsList}`;
  } else if (id && /^\d+$/.test(String(id))) {
    // Fiche unique : GET /v2/{type}/{id}
    url = `https://api.myanimelist.net/v2/${type}/${id}?fields=${detailFields}`;
  } else {
    res.status(400).json({ error: 'Fournir "id" (fiche), "q" (recherche) ou "ranking" (classement).' });
    return;
  }

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 9000);
    const r = await fetch(url, {
      headers: { 'X-MAL-CLIENT-ID': CLIENT_ID },
      signal: controller.signal
    });
    clearTimeout(tid);

    const data = await r.json();

    // Petit cache côté CDN Vercel : soulage MAL et accélère les visites suivantes
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Impossible de contacter MyAnimeList pour le moment.' });
  }
}
