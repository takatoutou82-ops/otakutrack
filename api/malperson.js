// api/malperson.js
// Fiche d'un auteur (photo, description, œuvres) lue sur sa page MyAnimeList.
// MyAnimeList bloque les requêtes directes venant des serveurs (vérification anti-robot) :
// on essaie donc EN MÊME TEMPS (1) la page directement et (2) la même page via le service
// « reader » r.jina.ai, qui charge la page comme un vrai navigateur. La première réponse valide gagne.
// Résultat gardé en cache sur le CDN Vercel (1 jour).
//
// GET /api/malperson?id=1881
// → { mal_id, name, given, family, about, birthday, favorites, image, works:[{id,title,img,pos:[...]}] }
// En cas d'échec : 502 { error, detail } où "detail" dit exactement ce qui s'est passé.

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
const stripTags = s => decode(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));

function parsePerson(html, id, label) {
  const nameM = html.match(/<h1[^>]*class="[^"]*title-name[^"]*"[^>]*>\s*(?:<strong>)?\s*([^<]+)/i)
             || html.match(/<title>\s*([^<]+?)\s*-\s*MyAnimeList/i);
  if (!nameM) {
    const title = (html.match(/<title>([^<]{0,80})/i) || [])[1] || '?';
    const blocked = /just a moment|verify you are human|unusual traffic|access denied/i.test(html.slice(0, 8000)) ? ' — ressemble à une page de vérification anti-robot' : '';
    throw new Error(`${label}: contenu reçu (${html.length} caractères, titre « ${title.trim()} ») mais nom de l'auteur introuvable${blocked}`);
  }
  const imgM = html.match(/<meta property="og:image" content="([^"]+)"/i);
  const field = (lbl) => {
    const m = html.match(new RegExp('<span[^>]*class="dark_text"[^>]*>\\s*' + lbl + ':?\\s*</span>\\s*([^<]*)', 'i'));
    return m ? decode(m[1]) : '';
  };
  const given = field('Given name'), family = field('Family name'), birthdayTxt = field('Birthday');
  let birthday = '';
  if (birthdayTxt) { const d = new Date(birthdayTxt + ' UTC'); if (!isNaN(d)) birthday = d.toISOString().slice(0, 10); }
  const favorites = parseInt((field('Member Favorites') || '').replace(/[^\d]/g, ''), 10) || 0;
  const aboutM = html.match(/<div class="people-informantion-more[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  let about = aboutM ? stripTags(aboutM[1]) : '';
  if (!about) { const d = html.match(/<meta property="og:description" content="([^"]*)"/i); about = d ? decode(d[1]) : ''; }

  // Œuvres : section « Published Manga »
  const i = html.search(/Published Manga/i);
  const works = [], seen = new Map();
  const add = (wid, title, img, role) => {
    if (!seen.has(wid)) { seen.set(wid, { id: wid, title: decode(title), img: String(img || '').replace(/\/r\/\d+x\d+\//, '/'), pos: [] }); works.push(seen.get(wid)); }
    if (role) seen.get(wid).pos.push(decode(role));
  };
  if (i >= 0) {
    const part = html.slice(i);
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(part))) {
      const b = row[1];
      const link = b.match(/href="https:\/\/myanimelist\.net\/manga\/(\d+)\/[^"]*"[^>]*>\s*(?:<strong>)?\s*([^<]+?)\s*(?:<\/strong>)?\s*<\/a>/i);
      if (!link) continue;
      add(+link[1], link[2], (b.match(/<img[^>]*?(?:data-src|src)="([^"]+)"/i) || [])[1], (b.match(/<small>\s*([^<]*?)\s*<\/small>/i) || [])[1]);
    }
  }
  if (!works.length) {
    const j = html.search(/Published Manga/i);
    throw new Error(`${label}: nom « ${decode(nameM[1])} » lu (${html.length} caractères) mais aucune œuvre lue — section « Published Manga » ${j >= 0 ? 'présente, extrait : ' + JSON.stringify(html.slice(j, j + 400).replace(/\s+/g, ' ')) : 'absente'}`);
  }
  return { mal_id: +id, name: decode(nameM[1]), given, family, about, birthday, favorites, image: imgM ? imgM[1] : '', works };
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

  const { id } = req.query;
  if (!/^\d+$/.test(String(id || ''))) { res.status(400).json({ error: 'Attendu : id numérique.' }); return; }
  const page = `https://myanimelist.net/people/${id}`;
  const direct = async () => parsePerson(await get(page, {
    'User-Agent': CHROME, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://myanimelist.net/'
  }, 5000, 'direct'), id, 'direct');
  const reader = async () => parsePerson(await get('https://r.jina.ai/' + page, {
    'Accept': 'text/html', 'X-Return-Format': 'html', 'X-Timeout': '8'
  }, 9000, 'reader'), id, 'reader');
  try {
    const out = await Promise.any([direct(), reader()]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Auteur indisponible pour le moment.', detail });
  }
}
