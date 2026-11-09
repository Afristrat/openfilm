// @ts-check
/**
 * Recherche libre AI-MPower : les quatre verbes de recherche sans clé ni service payant, pour Studio sur le DGX spark-1540.
 *   web-search    OpenSERP de serveuria (Bing, et DuckDuckGo quand Bing échoue ; Google et Yandex y sont bloqués par
 *                 captcha, mesuré le 2026-11-09), joint en direct par Tailscale, sans Cloudflare.
 *   web-fetch     la page lue depuis cette machine, sans service (web.mjs `readPage`, pages publiques seulement).
 *   image-search  Wikimedia Commons : photos sous licence libre (CC BY, CC BY-SA, domaine public), auteur et licence
 *                 donnés en crédit ; en Full HD au plus.
 *   video-search  Wikimedia Commons : vidéos sous licence libre, la version VP9 (WebM) la plus proche du Full HD, que le
 *                 Chromium de rendu sur ARM lit.
 * L'adresse d'OpenSERP se change par OPENFILM_OPENSERP_URL. Installé dans <shared home>/providers/recherche/ ; source
 * versionnée : deploy/recherche-provider/ du fork.
 */
import { clamp, foundClips, foundPictures, needed, number, text }
  from '/opt/openfilm/packages/openfilm/studio/server/providers/common.mjs';
import { HITS, fetched, hitOf, queriesOf, readPage, searched, urlsOf }
  from '/opt/openfilm/packages/openfilm/studio/server/providers/web.mjs';

/** @typedef {import('/opt/openfilm/packages/openfilm/studio/server/providers/contract.mjs').Provider} Provider */
/** @typedef {import('/opt/openfilm/packages/openfilm/studio/server/providers/contract.mjs').RunContext} RunContext */

const NAME = 'Recherche libre AI-MPower';
const SERP = (process.env.OPENFILM_OPENSERP_URL || 'http://100.124.187.2:7001').replace(/\/+$/, '');
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
/** Wikimedia demande un client qui se nomme */
const AGENT = { 'user-agent': 'OpenFilm-DGX/1.0 (https://film.ai-mpower.com)' };
const MODELS = {
  'web-search': [{ id: 'openserp', name: 'OpenSERP (Bing, DuckDuckGo)' }],
  'image-search': [{ id: 'commons', name: 'Wikimedia Commons (licences libres)' }],
  'video-search': [{ id: 'commons', name: 'Wikimedia Commons (licences libres)' }],
};

/** Une requête JSON ; une réponse en erreur devient une phrase. */
async function json(/** @type {string} */ url, /** @type {RunContext} */ ctx, /** @type {Record<string, string>} */ headers = {}) {
  let res;
  try { res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctx.signal }); } catch (e) {
    throw new Error(`${NAME} : ${new URL(url).host} ne répond pas (${/** @type {Error} */ (e).message}).`);
  }
  if (!res.ok) throw new Error(`${NAME} : ${new URL(url).host} a répondu ${res.status} ${(await res.text()).slice(0, 200)}`);
  return /** @type {any} */ (await res.json());
}

/** Le texte d'un champ de métadonnées Commons (souvent du HTML), sur une ligne. */
const plain = (/** @type {unknown} */ v) => text(v).replace(/<[^>]*>/g, ' ')
  /* un lien wiki laissé brut par Commons : [[Utilisateur:X|X]] → X */
  .replace(/\[\[(?:[^\]|]*\|)*([^\]|]*)\]\]/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

/** Le crédit d'un fichier Commons : auteur et licence, comme une licence CC le demande. */
function creditOf(/** @type {any} */ meta) {
  const who = plain(meta?.Artist?.value) || plain(meta?.Credit?.value) || 'auteur inconnu';
  const license = plain(meta?.LicenseShortName?.value) || 'licence non dite';
  return `${who} / Wikimedia Commons, ${license}`;
}

/** Une licence que le film peut utiliser (CC BY, CC BY-SA, CC0, domaine public) : pas de NC ni de ND. */
const usable = (/** @type {any} */ meta) => {
  const license = plain(meta?.LicenseShortName?.value).toLowerCase();
  return Boolean(license) && !/\bnc\b|non-?commercial|\bnd\b|no-?deriv/.test(license);
};

/** Les fichiers Commons d'une recherche (`filetype:bitmap` ou `filetype:video`), dans l'ordre de pertinence. */
async function commons(/** @type {string} */ query, /** @type {'bitmap' | 'video'} */ type, /** @type {number} */ limit, /** @type {RunContext} */ ctx) {
  const prop = type === 'video'
    ? { prop: 'videoinfo', viprop: 'url|size|mime|derivatives|extmetadata' }
    : { prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1920' };
  const q = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:${type}`, gsrnamespace: '6', gsrlimit: String(limit), ...prop });
  const body = await json(`${COMMONS}?${q}`, ctx, AGENT);
  return Object.values(body?.query?.pages ?? {})
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.index ?? 0) - (b.index ?? 0))
    .map((/** @type {any} */ p) => ({ title: text(p.title), page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(text(p.title).replace(/ /g, '_'))}`, info: (p.videoinfo ?? p.imageinfo ?? [])[0] }))
    .filter((p) => p.info && usable(p.info.extmetadata));
}

/** La version VP9 d'une vidéo Commons la plus proche du Full HD, parmi ses dérivés ; null quand elle n'en a pas. */
function vp9Of(/** @type {any} */ info) {
  /* Commons donne le codec de chaque dérivé (« video/webm; codecs="vp9, opus" »), pas toujours celui de l'original : seuls
     les dérivés VP9 sont sûrs pour le Chromium de rendu (ni Theora ni H.264 sur ARM) */
  const all = (Array.isArray(info?.derivatives) ? info.derivatives : []).filter((/** @type {any} */ d) => /vp9/i.test(text(d?.type)) && text(d?.src));
  if (!all.length) return null;
  return all.sort((a, b) => Math.abs((Number(a.width) || 0) - 1920) - Math.abs((Number(b.width) || 0) - 1920))[0];
}

/** Si une vidéo a l'orientation demandée (landscape, portrait, square). */
function oriented(/** @type {string} */ orientation, /** @type {number} */ w, /** @type {number} */ h) {
  if (!orientation || !w || !h) return true;
  const r = w / h;
  return orientation === 'portrait' ? r < 0.9 : orientation === 'square' ? r >= 0.9 && r <= 1.1 : r > 1.1;
}

/** @type {Provider} */
export default {
  id: 'recherche',
  name: NAME,
  env: 'OPENFILM_RECHERCHE',
  keysUrl: 'https://film.ai-mpower.com',
  billingUrl: 'https://film.ai-mpower.com',
  verbs: ['web-search', 'web-fetch', 'image-search', 'video-search'],
  models: MODELS,
  /* aucune clé : OpenSERP est dans le réseau d'AI-MPower, Commons est public */
  ready: () => true,
  async run(verb, args, ctx) {
    if (verb === 'web-search') {
      const { queries, ignored } = queriesOf(args);
      const rows = await Promise.all(queries.map(async (query) => {
        let last = null;
        for (const engine of ['bing', 'duckduckgo']) {
          try {
            const q = new URLSearchParams({ text: query, limit: String(HITS) });
            const body = await json(`${SERP}/${engine}/search?${q}`, ctx);
            const results = (Array.isArray(body?.results) ? body.results : []).filter((/** @type {any} */ r) => r?.url);
            if (results.length) return { query, hits: results.slice(0, HITS).map((/** @type {any} */ r) => hitOf({ title: r.title, url: r.url, excerpt: r.snippet, publishedAt: r.date })) };
          } catch (e) { if (ctx.signal.aborted) throw e; last = e; }
        }
        if (last) throw last;
        return { query, hits: [] };
      }));
      return { ...searched('recherche', rows, ignored), cost: { note: 'gratuit, OpenSERP de serveuria' } };
    }
    if (verb === 'web-fetch') {
      const { urls, ignored } = urlsOf(args);
      const read = await Promise.all(urls.map(async (url) => {
        try { return { url, page: await readPage(url, ctx), why: '' }; } catch (e) {
          if (ctx.signal.aborted) throw e;
          return { url, page: null, why: /** @type {Error} */ (e).message };
        }
      }));
      const pages = read.flatMap((r) => r.page ? [r.page] : []);
      const failed = read.flatMap((r) => r.page ? [] : [{ url: r.url, why: r.why }]);
      return fetched('local', pages, failed, ignored);
    }
    if (verb === 'image-search') {
      const prompt = needed(args, 'prompt');
      const asked = clamp(Math.round(number(args.n) ?? 1), 1, 20);
      const files = await commons(prompt, 'bitmap', clamp(asked * 4, 8, 50), ctx);
      const hits = files.map((f) => ({ url: text(f.info.thumburl) || text(f.info.url), page: f.page, credit: creditOf(f.info.extmetadata) })).filter((h) => h.url);
      const result = await foundPictures({ service: NAME, provider: 'recherche', args, hits, notes: [] }, ctx);
      return { ...result, cost: { note: 'gratuit, Wikimedia Commons ; créditer auteur et licence' } };
    }
    if (verb === 'video-search') {
      const prompt = needed(args, 'prompt');
      const asked = clamp(Math.round(number(args.n) ?? 1), 1, 10);
      const orientation = text(args.orientation);
      const files = await commons(prompt, 'video', clamp(asked * 6, 12, 50), ctx);
      const hits = files.flatMap((f) => {
        const v = vp9Of(f.info);
        const w = Number(v?.width) || Number(f.info.width) || 0, h = Number(v?.height) || Number(f.info.height) || 0;
        if (!v?.src || !oriented(orientation, w, h)) return [];
        return [{ url: text(v.src), page: f.page, credit: creditOf(f.info.extmetadata), dur: Number(f.info.duration) || null, w: w || null, h: h || null }];
      });
      const result = await foundClips({ service: NAME, provider: 'recherche', args, hits, notes: [] }, ctx);
      return { ...result, cost: { note: 'gratuit, Wikimedia Commons ; créditer auteur et licence' } };
    }
    throw new Error(`${NAME} ne fait pas ${verb}.`);
  },
};
