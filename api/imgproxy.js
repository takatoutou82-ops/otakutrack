// api/imgproxy.js
// Récupère une image côté serveur et la renvoie avec les en-têtes CORS nécessaires,
// pour permettre au navigateur de lire ses pixels (extraction de couleur dominante).
// Utilisation : /api/imgproxy?url=https%3A%2F%2Fcdn.myanimelist.net%2F...

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Paramètre "url" requis' });
    return;
  }

  // Sécurité minimale : seulement des URLs http(s), pour éviter un usage détourné du proxy
  let target;
  try { target = new URL(url); } catch (e) {
    res.status(400).json({ error: 'URL invalide' });
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    res.status(400).json({ error: 'Protocole non autorisé' });
    return;
  }

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 9000);
    const r = await fetch(target.toString(), { signal: controller.signal });
    clearTimeout(tid);

    if (!r.ok) {
      res.status(r.status).json({ error: 'Image introuvable' });
      return;
    }

    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await r.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).send(buffer);
  } catch (e) {
    res.status(502).json({ error: 'Impossible de récupérer l\'image' });
  }
}
