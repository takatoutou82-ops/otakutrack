// api/malmagazine.js
// Page d'un magazine de prépublication sur MyAnimeList (nom, nombre d'œuvres, liste des mangas avec
// type, année, statut, volumes/chapitres, note, membres, couverture), page par page.
// Même méthode que les autres relais : page directe ET service « reader » r.jina.ai en parallèle,
// la première réponse valide gagne. Cache CDN : 1 jour.
//
// GET /api/malmagazine?id=83&page=1
// → { id, name, total, page, lastPage, works:[{id,title,img,type,year,status,volumes,chapters,score,members}] }
// En cas d'échec : 502 { error, detail }.

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
  .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
const stripTags = x => decode(String(x || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();

function parseMagazine(html, id, page, label) {
  // Les œuvres : liens vers /manga/ID/… (balise <a> « link-title » dans la mise en page actuelle)
  const tagRe = /<a\b[^>]*>/gi;
  let items = [], seen = new Set(), m;
  const collect = (needClass) => {
    items = []; seen = new Set(); tagRe.lastIndex = 0;
    while ((m = tagRe.exec(html))) {
      const tag = m[0];
      const hm = tag.match(/href="(?:https:\/\/myanimelist\.net)?\/manga\/(\d+)\/[^"#?]*"/i);
      if (!hm) continue;
      if (needClass && !/link-title|fw-b/.test(tag)) continue;
      const wid = +hm[1];
      if (seen.has(wid)) continue;
      const end = html.indexOf('</a>', m.index);
      const title = end > 0 ? stripTags(html.slice(m.index, end)) : '';
      if (!title) continue;
      seen.add(wid);
      items.push({ id: wid, title, at: m.index });
    }
  };
  collect(true);
  if (!items.length) collect(false);
  if (!items.length) {
    const t = (html.match(/<title>([^<]{0,80})/i) || [])[1] || '?';
    if (page > 1 && new RegExp(`/manga/magazine/${id}`, 'i').test(html)) return { works: [], name: '', total: null, lastPage: page };
    throw new Error(`${label}: contenu reçu (${html.length} caractères, titre « ${String(t).trim()} ») mais aucune œuvre lue`);
  }
  const works = items.map((it, k) => {
    const seg = html.slice(it.at, Math.min(k + 1 < items.length ? items[k + 1].at : it.at + 6000, it.at + 6000));
    const text = stripTags(seg);
    let img = '';
    for (const tag of (seg.match(/<img[^>]*>/gi) || [])) {
      const u = (tag.match(/data-src="([^"]+)"/i) || tag.match(/\ssrc="([^"]+)"/i) || [])[1] || '';
      if (/\/images\/manga\//i.test(u)) { img = u; break; }
    }
    img = img.replace(/\/r\/\d+x\d+\//, '/').replace(/\?.*$/, '');
    const tm = text.match(/\b(Manga|Novel|Light Novel|One-shot|Doujinshi|Manhwa|Manhua|OEL)\b,?\s*((?:19|20)\d{2})?/);
    const st = text.match(/\b(Finished|Publishing|On Hiatus|Discontinued|Not yet published)\b/i);
    const vol = text.match(/(\d[\d,]*)\s*vols?\b/i), chp = text.match(/(\d[\d,]*)\s*chp\b/i);
    const sc = seg.match(/title="Score"[^>]*>\s*([\d.]+|N\/A)\s*</i) || seg.match(/score-label[^>]*>\s*([\d.]+|N\/A)\s*</i);
    const mem = seg.match(/title="Members"[^>]*>\s*([\d,]+)\s*</i);
    const num = x => (x ? parseInt(String(x).replace(/[^\d]/g, ''), 10) : null);
    return {
      id: it.id, title: it.title, img,
      type: tm ? tm[1] : '', year: tm && tm[2] ? +tm[2] : null,
      status: st ? st[1] : '',
      volumes: vol ? num(vol[1]) : null, chapters: chp ? num(chp[1]) : null,
      score: sc && sc[1] !== 'N/A' ? parseFloat(sc[1]) : null,
      members: num(mem && mem[1])
    };
  });
  // Nom + nombre d'œuvres (« Shounen Magazine (Weekly) (397) »)
  let name = '', total = null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = stripTags(h1[1]);
    const nm = t.match(/^(.*?)\s*\((\d[\d,]*)\)\s*$/);
    if (nm) { name = nm[1]; total = parseInt(nm[2].replace(/,/g, ''), 10); } else name = t;
  }
  if (!name) name = stripTags((html.match(/<title>([^<]*)/i) || [])[1] || '').replace(/\s*-\s*MyAnimeList.*$/i, '').replace(/\s*Manga$/i, '');
  let lastPage = page;
  for (const pm of html.matchAll(/[?&]page=(\d+)/g)) lastPage = Math.max(lastPage, +pm[1]);
  return { id: +id, name, total, page, lastPage, works };
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
  const { id } = req.query;
  const page = Math.max(1, Math.min(200, parseInt(req.query.page, 10) || 1));
  if (!/^\d+$/.test(String(id || ''))) { res.status(400).json({ error: 'Attendu : id numérique.' }); return; }
  const url = `https://myanimelist.net/manga/magazine/${id}/_${page > 1 ? '?page=' + page : ''}`;
  const direct = async () => parseMagazine(await get(url, { 'User-Agent': CHROME, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://myanimelist.net/' }, 5000, 'direct'), id, page, 'direct');
  const reader = async () => parseMagazine(await get('https://r.jina.ai/' + url, { 'Accept': 'text/html', 'X-Return-Format': 'html', 'X-Timeout': '8' }, 9000, 'reader'), id, page, 'reader');
  try {
    const out = await Promise.any([direct(), reader()]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Magazine indisponible pour le moment.', detail });
  }
}
