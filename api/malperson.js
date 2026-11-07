// api/malperson.js
// Fiche d'un auteur (photo, description, œuvres) — rapide et mise en cache.
// Jikan et la page MyAnimeList sont interrogés EN MÊME TEMPS ; on garde Jikan (plus complet)
// s'il répond vite, sinon la page MAL. Cache CDN Vercel : 1 jour.
//
// Utilisation : GET /api/malperson?id=1881
// Réponse : { mal_id, name, given, family, about, birthday, favorites, image, works:[{id,title,img,pos:[...]}], source }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function timedFetch(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

async function jikanJson(path) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await timedFetch('https://api.jikan.moe/v4' + path, { headers: { 'User-Agent': UA } }, 5500);
      if (r.ok) return await r.json();
      last = new Error('Jikan HTTP ' + r.status);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = e; break; }
    await sleep(500);
  }
  throw last;
}

async function fromJikan(id) {
  const [p, m] = await Promise.all([jikanJson(`/people/${id}`), jikanJson(`/people/${id}/manga`)]);
  const d = p.data || {};
  const map = new Map();
  (m.data || []).forEach(x => {
    const mg = x.manga; if (!mg || !mg.mal_id) return;
    if (!map.has(mg.mal_id)) map.set(mg.mal_id, { id: mg.mal_id, title: mg.title || '', img: (mg.images && mg.images.jpg && mg.images.jpg.image_url) || '', pos: [] });
    if (x.position) map.get(mg.mal_id).pos.push(x.position);
  });
  return {
    mal_id: d.mal_id || +id, name: d.name || '', given: d.given_name || '', family: d.family_name || '',
    about: d.about || '', birthday: d.birthday || '', favorites: d.favorites || 0,
    image: (d.images && d.images.jpg && d.images.jpg.image_url) || '',
    works: [...map.values()], source: 'jikan'
  };
}

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function fromMal(id) {
  const r = await timedFetch(`https://myanimelist.net/people/${id}`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.8' }
  }, 4500);
  if (!r.ok) throw new Error('MAL HTTP ' + r.status);
  const html = await r.text();
  const nameM = html.match(/<h1[^>]*class="title-name[^"]*"[^>]*>\s*(?:<strong>)?([^<]+)/i) || html.match(/<title>\s*([^<]+?)\s*-\s*MyAnimeList/i);
  const imgM = html.match(/<meta property="og:image" content="([^"]+)"/i);
  const i = html.search(/Published Manga/i);
  if (!nameM || i < 0) throw new Error('page MAL illisible');
  const part = html.slice(i);
  const re = /<img[^>]*?(?:data-src|src)="([^"]+)"[^>]*>[\s\S]{0,400}?href="https:\/\/myanimelist\.net\/manga\/(\d+)\/[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>[\s\S]{0,300}?<small>\s*([^<]*?)\s*<\/small>/gi;
  const map = new Map();
  let m;
  while ((m = re.exec(part))) {
    const wid = +m[2];
    if (!map.has(wid)) map.set(wid, { id: wid, title: decode(m[3]), img: m[1].replace(/\/r\/\d+x\d+\//, '/'), pos: [] });
    if (m[4]) map.get(wid).pos.push(decode(m[4]));
  }
  if (!map.size) throw new Error('aucune œuvre lue');
  return {
    mal_id: +id, name: decode(nameM[1]), given: '', family: '', about: '', birthday: '', favorites: 0,
    image: imgM ? imgM[1] : '', works: [...map.values()], source: 'mal'
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { id } = req.query;
  if (!/^\d+$/.test(String(id || ''))) { res.status(400).json({ error: 'Attendu : id numérique.' }); return; }

  const jP = fromJikan(id).then(v => ({ v }), err => ({ err }));
  const mP = fromMal(id).then(v => ({ v }), err => ({ err }));
  const tag = (p, k) => p.then(x => ({ k, ...x }));
  try {
    const first = await Promise.race([tag(jP, 'j'), tag(mP, 'm')]);
    let out = null;
    if (first.v) {
      out = first.v;
      // La page MAL a répondu en premier : on laisse 2 s à Jikan (plus complet : description, naissance…)
      if (first.k === 'm') {
        const j = await Promise.race([jP, sleep(2000).then(() => null)]);
        if (j && j.v) out = j.v;
      }
    } else {
      const other = await (first.k === 'j' ? mP : jP);
      if (other.v) out = other.v;
    }
    if (!out) throw new Error('indisponible');
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: 'Auteur indisponible pour le moment.' });
  }
}
