// api/malcharacter.js
// Fiche d'un personnage MyAnimeList (description, nom japonais, favoris, image) lue sur sa page
// https://myanimelist.net/character/ID. Même méthode que les autres relais : page directe ET service
// « reader » r.jina.ai en parallèle, la première réponse valide gagne. Cache CDN : 1 jour.
//
// GET /api/malcharacter?id=40
// → { id, name, native, favorites, about, image }
// En cas d'échec : 502 { error, detail }.

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
  .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');

function toLines(html) {
  const t = decode(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|tr|h\d|li|table|ul)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
  return t.split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
}

function parseCharacter(html, id, label) {
  const og = p => (html.match(new RegExp('<meta[^>]*property="og:' + p + '"[^>]*content="([^"]*)"', 'i')) || html.match(new RegExp('<meta[^>]*content="([^"]*)"[^>]*property="og:' + p + '"', 'i')) || [])[1];
  let name = decode(og('title') || '').trim() || decode((html.match(/<title>\s*([^<]+?)\s*-\s*MyAnimeList/i) || [])[1] || '').trim();
  if (!name) {
    const title = (html.match(/<title>([^<]{0,80})/i) || [])[1] || '?';
    throw new Error(`${label}: contenu reçu (${html.length} caractères, titre « ${String(title).trim()} ») mais ce n'est pas une fiche de personnage`);
  }
  const image = (og('image') || '').replace(/\/r\/\d+x\d+\//, '/').replace(/\?.*$/, '');
  const text = toLines(html);
  const fm = text.match(/Member Favorites:\s*([\d,]+)/i);
  const favorites = fm ? parseInt(fm[1].replace(/[^\d]/g, ''), 10) : null;

  let about = '', native = '';
  if (fm) {
    let rest = text.slice(fm.index + fm[0].length).replace(/^[\s|]+/, '');
    const cut = rest.search(/\n\s*(Voice Actors|Recent Featured Articles|Recent Forum Discussion|Reviews|Recommendations)\b/i);
    if (cut >= 0) rest = rest.slice(0, cut);
    const lines = rest.split('\n');
    // 1re ligne = « Nom (名前) » : on en tire le nom japonais, le reste est la description
    const first = (lines[0] || '').trim();
    if (first && first.length < 160) {
      const jp = first.match(/\(([^()]*[\u3000-\u9fff\uff00-\uffef][^()]*)\)/);
      if (jp) native = jp[1].trim();
      lines.shift();
    }
    about = lines.join('\n').trim().slice(0, 5000);
  }
  return { id: +id, name, native, favorites, about, image };
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
  if (!/^\d+$/.test(String(id || ''))) { res.status(400).json({ error: 'Attendu : id numérique.' }); return; }
  const page = `https://myanimelist.net/character/${id}`;
  const direct = async () => parseCharacter(await get(page, { 'User-Agent': CHROME, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://myanimelist.net/' }, 5000, 'direct'), id, 'direct');
  const reader = async () => parseCharacter(await get('https://r.jina.ai/' + page, { 'Accept': 'text/html', 'X-Return-Format': 'html', 'X-Timeout': '8' }, 9000, 'reader'), id, 'reader');
  try {
    const out = await Promise.any([direct(), reader()]);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(out);
  } catch (e) {
    const detail = (e && e.errors ? e.errors : [e]).map(x => x.message).join(' | ');
    res.status(502).json({ error: 'Personnage indisponible pour le moment.', detail });
  }
}
