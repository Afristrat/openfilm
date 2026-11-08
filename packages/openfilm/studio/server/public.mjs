// @ts-check
/**
 * Studio served at public addresses, behind a reverse proxy (a tunnel) that ends HTTPS and forwards to 127.0.0.1:
 * OPENFILM_PUBLIC_ORIGIN for the editor and OPENFILM_PUBLIC_FILM_ORIGIN for the film's origin (pages.mjs), both set
 * or neither. Each server then also answers requests addressed to its own public name (ownHost), and a page opened at
 * the public editor gets the film's public origin; requests to 127.0.0.1 are answered as before, so the CLI, the
 * agents and the renders on the machine keep the local addresses. The key still guards every API call: the public
 * names only add an address, never a way in without the key.
 */

/**
 * The public origins, or null when Studio is local only. Throws on a half or malformed setting rather than serving
 * an address that would be refused at the first write.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ editor: string, film: string, editorHost: string, filmHost: string } | null}
 */
export function publicOrigins(env = process.env) {
  const editor = env.OPENFILM_PUBLIC_ORIGIN?.trim() ?? '';
  const film = env.OPENFILM_PUBLIC_FILM_ORIGIN?.trim() ?? '';
  if (!editor && !film) return null;
  if (!editor || !film) throw new Error('OPENFILM_PUBLIC_ORIGIN and OPENFILM_PUBLIC_FILM_ORIGIN go together: set both or neither');
  const parse = (/** @type {string} */ name, /** @type {string} */ value) => {
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} is not an address: ${value}`); }
    if (url.protocol !== 'https:') throw new Error(`${name} must be https (the session cookies are Secure): ${value}`);
    if (url.origin !== value.replace(/\/+$/, '')) throw new Error(`${name} must be an origin alone, no path: ${value}`);
    return url;
  };
  const e = parse('OPENFILM_PUBLIC_ORIGIN', editor);
  const f = parse('OPENFILM_PUBLIC_FILM_ORIGIN', film);
  if (e.host === f.host) throw new Error('the film needs an origin of its own: OPENFILM_PUBLIC_FILM_ORIGIN must differ from OPENFILM_PUBLIC_ORIGIN');
  return { editor: e.origin, film: f.origin, editorHost: e.host.toLowerCase(), filmHost: f.host.toLowerCase() };
}

/**
 * Whether the request was addressed to `host` (a public name), as the proxy forwards it.
 * @param {import('node:http').IncomingMessage} req @param {string | undefined} host
 */
export function addressedTo(req, host) {
  return Boolean(host) && String(req.headers.host ?? '').toLowerCase() === host;
}
