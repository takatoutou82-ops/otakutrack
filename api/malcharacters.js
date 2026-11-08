// api/malcharacters.js
// Personnages d'une œuvre (nom, rôle principal/secondaire, image, doubleurs pour les animés)
// lus sur la page /characters de MyAnimeList. Même méthode que malstats : page directe ET service
// « reader » r.jina.ai en parallèle, la première réponse valide gagne. Cache CDN : 1 jour.
//
// GET /api/malcharacters?type=anime&id=1535
// → { characters:[{id,name,role,img,favorites,va:[{id,name,lang}]}] } (dans l'ordre de MyAnimeList)

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

const stripTags = x => decode(String(x || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

function parseCharacters(html, type, id, label) {
  // Si la page balise la liste des personnages, on ne lit que cette zone (évite le bandeau / le pied de page)
  const zone = html.search(/detail-characters-list/i);
  if (zone >= 0) html = html.slice(zone);
  const re = /href="(?:https:\/\/myanimelist\.net)?\/character\/(\d+)\/([^"]*)"/gi;
  const starts = [], seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    const cid = +m[1];
    if (seen.has(cid)) continue;
    seen.add(cid);
    starts.push({ id: cid, slug: m[2], at: m.index });
  }
  if (!starts.length) {
    // Page de l'œuvre bien chargée mais sans aucun personnage : liste vide (rien à afficher)
    if (new RegExp(`/${type}/${id}`, 'i').test(html)) return { characters: [] };
    const title = (html.match(/<title>([^<]{0,80})/i) || [])[1] || '?';
    throw new Error(`${label}: contenu reçu (${html.length} caractères, titre « ${String(title).trim()} ») mais ce n'est pas la page des personnages`);
  }
  const characters = [];
  starts.forEach((st, k) => {
    const seg = html.slice(st.at, Math.min(k + 1 < starts.length ? starts[k + 1].at : st.at + 6000, st.at + 4000));

    // Nom : <h3>, sinon texte d'un lien du personnage, sinon alt de l'image, sinon le nom dans l'adresse
    let name = '';
    const h3 = seg.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (h3) name = stripTags(h3[1]);
    if (!name) {
      const are = /<a[^>]*href="[^"]*\/character\/\d+\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      let am;
      while ((am = are.exec(seg))) { const t = stripTags(am[1]); if (t) { name = t; break; } }
    }
    if (!name) { const alt = seg.match(/<img[^>]*\salt="([^"]+)"/i); if (alt) name = decode(alt[1]); }
    if (!name) { try { name = decodeURIComponent(st.slug.split(/[?#]/)[0]).replace(/_/g, ' '); } catch (e) { name = st.slug.replace(/_/g, ' '); } }
    // MyAnimeList écrit « Famille, Prénom » : on garde l'ordre et on retire juste la virgule
    name = name.replace(/,\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) return;

    const role = ((seg.match(/>\s*(Main|Supporting)\s*</i) || [])[1] || '').toLowerCase();
    // Un vrai personnage de l'œuvre a TOUJOURS un rôle (Main / Supporting) : sans rôle, c'est un lien du
    // bandeau ou du pied de page de MyAnimeList (« personnages populaires »…), on l'ignore.
    if (!role) return;

    // Image du personnage : data-src d'abord (src peut être un pixel vide), uniquement /images/characters/
    let img = '';
    for (const tag of (seg.match(/<img[^>]*>/gi) || [])) {
      const cands = [(tag.match(/data-src="([^"]+)"/i) || [])[1], (tag.match(/\ssrc="([^"]+)"/i) || [])[1], (tag.match(/data-srcset="([^"\s]+)/i) || [])[1]];
      const u = cands.find(x => x && /\/images\/characters\//i.test(x));
      if (u) { img = u; break; }
    }
    if (!img) { const md = seg.match(/https:\/\/cdn\.myanimelist\.net\/[^\s"')]*\/images\/characters\/[^\s"')]+/i); if (md) img = md[0]; }
    img = img.replace(/\/r\/\d+x\d+\//, '/').replace(/\?.*$/, ''); // lien simple, sans signature

    const favM = seg.match(/([\d,]+)\s*favorites?/i);
    const va = [];
    const vre = /href="(?:https:\/\/myanimelist\.net)?\/people\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let v;
    while ((v = vre.exec(seg))) {
      let vn = stripTags(v[2]);
      if (!vn) continue;
      const q = vn.split(', ');
      if (q.length === 2) vn = q[1] + ' ' + q[0];
      const lang = (seg.slice(vre.lastIndex, vre.lastIndex + 300).match(/<small>\s*([^<]*?)\s*<\/small>/i) || [])[1] || '';
      va.push({ id: +v[1], name: vn, lang: decode(lang) });
    }
    characters.push({ id: st.id, name, role, img, favorites: favM ? parseInt(favM[1].replace(/[^\d]/g, ''), 10) : null, va });
  });
  if (!characters.length) {
    throw new Error(`${label}: ${starts.length} lien(s) de personnage trouvé(s) mais aucun avec un rôle Main/Supporting — page lue (${html.length} caractères) : ${JSON.stringify(html.slice(starts[0].at, starts[0].at + 300).replace(/\s+/g, ' '))}`);
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
  const direct = async () => parseCharacters(await get(page, { 'User-Agent': CHROME, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://myanimelist.net/' }, 5000, 'direct'), type, id, 'direct');
  const reader = async () => parseCharacters(await get('https://r.jina.ai/' + page, { 'Accept': 'text/html', 'X-Return-Format': 'html', 'X-Timeout': '8' }, 9000, 'reader'), type, id, 'reader');
  try {
    const out = await Promise.any([direct(), reader()]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Personnages indisponibles pour le moment.', detail });
  }
}
