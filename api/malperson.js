// api/malperson.js
// Fiche d'un auteur (photo, description, œuvres) lue directement sur sa page MyAnimeList.
// (L'API officielle MAL n'a pas de page auteur.) Cache CDN Vercel : 1 jour.
//
// GET /api/malperson?id=1881
// → { mal_id, name, given, family, about, birthday, favorites, image, works:[{id,title,img,pos:[...]}] }
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

const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
const stripTags = s => decode(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));

async function readPerson(id, ua, label) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  let r;
  try {
    r = await fetch(`https://myanimelist.net/people/${id}`, { headers: headers(ua), signal: c.signal, redirect: 'follow' });
  } catch (e) {
    throw new Error(`${label}: ${e && e.name === 'AbortError' ? 'MyAnimeList ne répond pas (délai dépassé)' : 'connexion impossible'}`);
  } finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`${label}: MyAnimeList répond HTTP ${r.status}`);
  const html = await r.text();
  if (/just a moment|captcha|access denied|unusual traffic/i.test(html.slice(0, 6000)))
    throw new Error(`${label}: MyAnimeList affiche une vérification anti-robot`);

  const nameM = html.match(/<h1[^>]*class="[^"]*title-name[^"]*"[^>]*>\s*(?:<strong>)?\s*([^<]+)/i)
             || html.match(/<title>\s*([^<]+?)\s*-\s*MyAnimeList/i);
  if (!nameM) {
    const title = (html.match(/<title>([^<]{0,80})/i) || [])[1] || '?';
    throw new Error(`${label}: page lue (${html.length} octets, titre « ${title.trim()} ») mais nom de l'auteur introuvable`);
  }
  const imgM = html.match(/<meta property="og:image" content="([^"]+)"/i);

  // Détails : « Given name: … », « Family name: … », « Birthday: … », « Member Favorites: … »
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
  const works = [];
  if (i >= 0) {
    const part = html.slice(i);
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const seen = new Map();
    let row;
    while ((row = rowRe.exec(part))) {
      const b = row[1];
      const link = b.match(/href="https:\/\/myanimelist\.net\/manga\/(\d+)\/[^"]*"[^>]*>\s*(?:<strong>)?\s*([^<]+?)\s*(?:<\/strong>)?\s*<\/a>/i);
      if (!link) continue;
      const wid = +link[1];
      const img = (b.match(/<img[^>]*?(?:data-src|src)="([^"]+)"/i) || [])[1] || '';
      const role = (b.match(/<small>\s*([^<]*?)\s*<\/small>/i) || [])[1] || '';
      if (!seen.has(wid)) { seen.set(wid, { id: wid, title: decode(link[2]), img: img.replace(/\/r\/\d+x\d+\//, '/'), pos: [] }); works.push(seen.get(wid)); }
      if (role) seen.get(wid).pos.push(decode(role));
    }
  }
  if (!works.length) {
    throw new Error(`${label}: page lue (${html.length} octets) mais aucune œuvre trouvée dedans`);
  }
  return { mal_id: +id, name: decode(nameM[1]), given, family, about, birthday, favorites, image: imgM ? imgM[1] : '', works };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const { id } = req.query;
  if (!/^\d+$/.test(String(id || ''))) { res.status(400).json({ error: 'Attendu : id numérique.' }); return; }
  try {
    const out = await Promise.any([readPerson(id, CHROME, 'PC'), readPerson(id, IPHONE, 'mobile')]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Auteur indisponible pour le moment.', detail });
  }
}
