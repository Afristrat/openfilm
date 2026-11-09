/**
 * Media brought in from a link (DGX AI-MPower fork): a video page (YouTube, Vimeo, a direct file…) downloaded by yt-dlp
 * into the project, as Upload brings a file in. The download runs in the project's cache (.film/cache/from-url/<job>),
 * so the media pane never shows a part-file, and the finished file is moved into the folder asked for.
 *
 * A link goes only to the public web: http(s), and a host that names no address of this machine or its networks
 * (loopback, private, link-local, unique-local, carrier-grade NAT), checked by resolving it, so a link cannot reach
 * Studio itself or the services around it. One download at a time per project; each a job its page asks after.
 * The program is `yt-dlp` on the PATH, or OPENFILM_YTDLP.
 */
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, join, relative, sep } from 'node:path';

export class LinkError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status; }
}

/** The longest link taken. */
export const MAX_LINK = 2048;
/** How long a download may take before it is stopped. */
export const DOWNLOAD_MS = 60 * 60_000;

/**
 * Whether an address is one of this machine's or of a private network (never the public web's).
 * @param {string} address
 */
export function privateAddress(address) {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
      || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (isIP(a) === 6) {
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return privateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
  }
  return true;
}

/**
 * The link as taken: http(s), at most MAX_LINK long, its host on the public web (every address it resolves to).
 * @param {unknown} text @param {(host: string) => Promise<{ address: string }[]>} [resolve]
 */
export async function checkLink(text, resolve = (host) => dnsLookup(host, { all: true })) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_LINK) throw new LinkError(400, 'Give a link (http or https).');
  let url;
  try { url = new URL(text.trim()); } catch { throw new LinkError(400, 'This is not a link.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LinkError(400, 'Only http and https links are taken.');
  if (url.username || url.password) throw new LinkError(400, 'A link with a name and password in it is not taken.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new LinkError(400, 'Only links to the public web are taken.');
  }
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host).catch(() => { throw new LinkError(400, `No such site: ${host}.`); });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) throw new LinkError(400, 'Only links to the public web are taken.');
  return url;
}

/**
 * yt-dlp's words for one download into `dir`: one video (never a playlist), the best picture and sound joined in an
 * MP4 when they come apart, its title for a name, its progress one line each, and the file it made said at the end.
 * @param {string} link @param {string} dir
 */
export function ytdlpArgs(link, dir) {
  return [
    '--no-playlist', '--no-mtime', '--no-color', '--newline',
    '--js-runtimes', 'node',
    '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
    '-o', join(dir, '%(title).150B [%(id)s].%(ext)s'),
    '--progress-template', 'download:OFPROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s',
    '--print', 'after_move:OFFILE %(filepath)s',
    '--', link,
  ];
}

/**
 * What a line of yt-dlp says: how far a download is (0 to 1), the file it made, or nothing.
 * @param {string} line @returns {{ ratio: number } | { file: string } | null}
 */
export function readLine(line) {
  const file = /^OFFILE (.+)$/.exec(line.trim());
  if (file) return { file: file[1] };
  const progress = /^OFPROGRESS (\d+) (\d+(?:\.\d+)?)$/.exec(line.trim());
  if (progress && Number(progress[2]) > 0) return { ratio: Math.min(0.99, Number(progress[1]) / Number(progress[2])) };
  return null;
}

/**
 * The downloads of every project, each a job: `{ id, status: 'running' | 'done' | 'failed', ratio, path?, error? }`.
 * @param {{ spawn?: typeof spawnChild, resolve?: (host: string) => Promise<{ address: string }[]>, program?: string, timeoutMs?: number }} [deps]
 */
export function createLinkImports({ spawn = spawnChild, resolve, program = process.env.OPENFILM_YTDLP || 'yt-dlp', timeoutMs = DOWNLOAD_MS } = {}) {
  /** @type {Map<string, { id: string, project: string, status: 'running' | 'done' | 'failed', ratio: number, path?: string, error?: string }>} */
  const jobs = new Map();
  const shown = (/** @type {any} */ job) => ({ id: job.id, status: job.status, ratio: job.ratio, ...(job.path ? { path: job.path } : {}), ...(job.error ? { error: job.error } : {}) });
  return {
    /**
     * Start bringing `link` into the project's folder `into` (project-relative, already checked by the caller).
     * @param {string} projectPath @param {unknown} link @param {string} into
     */
    async start(projectPath, link, into) {
      if ([...jobs.values()].some((j) => j.project === projectPath && j.status === 'running')) throw new LinkError(409, 'A link is already being brought into this project.');
      const url = await checkLink(link, resolve);
      const id = randomUUID();
      const job = { id, project: projectPath, status: /** @type {'running' | 'done' | 'failed'} */ ('running'), ratio: 0 };
      jobs.set(id, job);
      const work = join(projectPath, '.film', 'cache', 'from-url', id);
      await mkdir(work, { recursive: true });
      const child = spawn(program, ytdlpArgs(url.href, work), { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
      let said = '';
      let err = '';
      let made = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (d) => {
        said += String(d);
        const lines = said.split('\n');
        said = lines.pop() ?? '';
        for (const line of lines) {
          const heard = readLine(line);
          if (heard && 'ratio' in heard) job.ratio = heard.ratio;
          if (heard && 'file' in heard) made = heard.file;
        }
      });
      child.stderr?.on('data', (d) => { err = (err + String(d)).slice(-4000); });
      child.on('error', (e) => { err = `${e.message}\n${err}`; });
      child.on('close', (code) => {
        clearTimeout(timer);
        void (async () => {
          /** @type {{ path: string } | { error: string }} */
          let ended;
          try {
            const last = readLine(said);
            if (last && 'file' in last) made = last.file;
            if (code !== 0) throw new Error(err.trim().split('\n').filter((l) => /ERROR/.test(l)).pop()?.replace(/^.*ERROR:\s*/, '') || `yt-dlp ended (${code}).`);
            /* the one file it made, said at the end or found in its folder */
            const file = made && made.startsWith(work + sep) ? made : join(work, (await readdir(work)).find((n) => !n.endsWith('.part')) ?? '');
            if (!(await stat(file)).isFile()) throw new Error('The download made no file.');
            const folder = join(projectPath, into);
            await mkdir(folder, { recursive: true });
            let target = join(folder, basename(file));
            for (let n = 2; await stat(target).then(() => true, () => false); n++) target = join(folder, basename(file).replace(/(\.\w+)$/, ` ${n}$1`));
            await rename(file, target);
            ended = { path: relative(projectPath, target).split(sep).join('/') };
          } catch (e) {
            ended = { error: e instanceof Error ? e.message : String(e) };
          }
          /* its work folder gone (the part-files with it) before the page is told it ended */
          await rm(work, { recursive: true, force: true }).catch(() => {});
          if ('path' in ended) Object.assign(job, { path: ended.path, ratio: 1, status: 'done' });
          else Object.assign(job, { error: ended.error, status: 'failed' });
        })();
      });
      return shown(job);
    },
    /** @param {string} projectPath @param {string} id */
    get(projectPath, id) {
      const job = jobs.get(id);
      if (!job || job.project !== projectPath) throw new LinkError(404, 'No such download.');
      return shown(job);
    },
  };
}
