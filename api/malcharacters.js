// api/malcharacters.js
// Personnages d'une œuvre (nom, rôle principal/secondaire, image, doubleurs pour les animés)
// lus sur la page /characters de MyAnimeList. Même méthode que malstats : page directe ET service
// « reader » r.jina.ai en parallèle, la première réponse valide gagne. Cache CDN : 1 jour.
//
// GET /api/malcharacters?type=anime&id=1535
// → { characters:[{id,name,role,img,favorites,va:[{id,name,lang}]}] } (dans l'ordre de MyAnimeList)

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

function parseCharacters(html, label) {
  const re = /href="https:\/\/myanimelist\.net\/character\/(\d+)\/[^"]*"/gi;
  const starts = [], seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    const id = +m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    starts.push({ id, at: m.index });
  }
  const characters = [];
  starts.forEach((st, k) => {
    const seg = html.slice(st.at, k + 1 < starts.length ? starts[k + 1].at : st.at + 6000);
    const nameM = seg.match(/href="https:\/\/myanimelist\.net\/character\/\d+\/[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/i);
    if (!nameM) return;
    // MyAnimeList écrit « Famille, Prénom » : on garde l'ordre et on retire juste la virgule (ex. « Monkey D. Luffy »)
    const name = decode(nameM[1]).replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const role = ((seg.match(/<small>\s*(Main|Supporting)\s*<\/small>/i) || [])[1] || '').toLowerCase();
    // Image du personnage : on regarde chaque <img> (data-src d'abord, car src peut être un pixel vide)
    // et on garde la première qui pointe vers /images/characters/ (pas les photos des doubleurs).
    let img = '';
    const tags = seg.match(/<img[^>]*>/gi) || [];
    for (const tag of tags) {
      const u = (tag.match(/data-src="([^"]+)"/i) || tag.match(/\ssrc="([^"]+)"/i) || [])[1] || '';
      if (/\/images\/characters\//i.test(u)) { img = u; break; }
    }
    if (!img) { const md = seg.match(/https:\/\/cdn\.myanimelist\.net\/[^\s"')]*\/images\/characters\/[^\s"')]+/i); if (md) img = md[0]; }
    // URL sans redimensionnement ni signature : https://cdn.myanimelist.net/images/characters/9/310307.jpg
    img = img.replace(/\/r\/\d+x\d+\//, '/').replace(/\?.*$/, '');
    const favM = seg.match(/([\d,]+)\s*(?:favorites?|Favorites?)/i);
    const va = [];
    const vre = /href="https:\/\/myanimelist\.net\/people\/(\d+)\/[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>[\s\S]{0,300}?<small>\s*([^<]*?)\s*<\/small>/gi;
    let v;
    while ((v = vre.exec(seg))) {
      let vn = decode(v[2]);
      const q = vn.split(', ');
      if (q.length === 2) vn = q[1] + ' ' + q[0];
      va.push({ id: +v[1], name: vn, lang: decode(v[3]) });
    }
    characters.push({
      id: st.id, name, role,
      img,
      favorites: favM ? parseInt(favM[1].replace(/[^\d]/g, ''), 10) : null,
      va
    });
  });
  if (!characters.length) {
    const title = (html.match(/<title>([^<]{0,80})/i) || [])[1] || '?';
    throw new Error(`${label}: contenu reçu (${html.length} caractères, titre « ${String(title).trim()} ») mais aucun personnage lu`);
  }
  return { characters };
}

async function get(url, headers, ms, label) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  let r;
  try { r = await fetch(url, { headers, signal: c.signal, redirect: 'follow' }); }
  catch (e) { throw new Error(`${label}: ${e && e.name === 'AbortError' ? 'délai dépassé' : 'connexion impossible'}`); }
  finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  return await r.text();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const { type, id } = req.query;
  if (!['anime', 'manga'].includes(type) || !/^\d+$/.test(String(id || ''))) {
    res.status(400).json({ error: 'Attendu : type=anime|manga et id numérique.' }); return;
  }
  const page = `https://myanimelist.net/${type}/${id}/_/characters`;
  const direct = async () => parseCharacters(await get(page, { 'User-Agent': CHROME, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://myanimelist.net/' }, 5000, 'direct'), 'direct');
  const reader = async () => parseCharacters(await get('https://r.jina.ai/' + page, { 'Accept': 'text/html', 'X-Return-Format': 'html', 'X-Timeout': '8' }, 9000, 'reader'), 'reader');
  try {
    const out = await Promise.any([direct(), reader()]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Personnages indisponibles pour le moment.', detail });
  }
}
