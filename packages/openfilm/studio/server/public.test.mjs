import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicOrigins } from './public.mjs';

const EDITOR = 'https://film.example.test';
const FILM = 'https://film-apercu.example.test';

test('public origins: both or neither, https, an origin alone, the film apart from the editor', () => {
  assert.equal(publicOrigins({}), null);
  assert.deepEqual(publicOrigins({ OPENFILM_PUBLIC_ORIGIN: `${EDITOR}/`, OPENFILM_PUBLIC_FILM_ORIGIN: FILM }),
    { editor: EDITOR, film: FILM, editorHost: 'film.example.test', filmHost: 'film-apercu.example.test' });
  assert.throws(() => publicOrigins({ OPENFILM_PUBLIC_ORIGIN: EDITOR }), /go together/);
  assert.throws(() => publicOrigins({ OPENFILM_PUBLIC_ORIGIN: 'http://film.example.test', OPENFILM_PUBLIC_FILM_ORIGIN: FILM }), /must be https/);
  assert.throws(() => publicOrigins({ OPENFILM_PUBLIC_ORIGIN: `${EDITOR}/studio`, OPENFILM_PUBLIC_FILM_ORIGIN: FILM }), /origin alone/);
  assert.throws(() => publicOrigins({ OPENFILM_PUBLIC_ORIGIN: EDITOR, OPENFILM_PUBLIC_FILM_ORIGIN: EDITOR }), /origin of its own/);
  assert.throws(() => publicOrigins({ OPENFILM_PUBLIC_ORIGIN: 'not an address', OPENFILM_PUBLIC_FILM_ORIGIN: FILM }), /not an address/);
});

/** A request to `origin` (a local address) as a proxy forwards it: addressed to `host`. */
function call(origin, path, { host, method = 'GET', headers = {}, body } = {}) {
  const at = new URL(path, origin);
  return new Promise((done, fail) => {
    const req = request({ hostname: at.hostname, port: at.port, path: at.pathname + at.search, method, headers: { ...(host ? { host } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

let studio, scratch;
before(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'of-public-'));
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'library');
  process.env.OPENFILM_TRASH_DIR = join(scratch, 'trash');
  mkdirSync(process.env.OPENFILM_TRASH_DIR);
  process.env.OPENFILM_PUBLIC_ORIGIN = EDITOR;
  process.env.OPENFILM_PUBLIC_FILM_ORIGIN = FILM;
  const { startStudio } = await import('./server.mjs');
  studio = await startStudio({ port: 0, openBrowser: () => {}, quietMs: 150 });
});
after(async () => {
  await studio?.close();
  delete process.env.OPENFILM_PUBLIC_ORIGIN;
  delete process.env.OPENFILM_PUBLIC_FILM_ORIGIN;
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
});

test('the editor answers its public name and its local one, and still refuses any other name', async () => {
  assert.equal((await call(studio.origin, '/api/health', { host: 'film.example.test' })).status, 200);
  assert.equal((await call(studio.origin, '/api/health')).status, 200);
  assert.equal((await call(studio.origin, '/api/health', { host: 'evil.example.test' })).status, 403);
  /* the film's public name is the film's, not the editor's */
  assert.equal((await call(studio.origin, '/api/health', { host: 'film-apercu.example.test' })).status, 403);
});

test('by the public name, the key is still needed, and a write must come from the public editor', async () => {
  const host = 'film.example.test';
  assert.equal((await call(studio.origin, '/api/projects', { host })).status, 401);
  const open = await call(studio.origin, `/open?key=${studio.key}`, { host });
  assert.equal(open.status, 302);
  const cookie = /** @type {string[]} */ (open.headers['set-cookie'])[0].split(';')[0];
  assert.equal((await call(studio.origin, '/api/projects', { host, headers: { cookie } })).status, 200);
  const write = (/** @type {string} */ origin) => call(studio.origin, '/api/projects', {
    host, method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Public' }),
  });
  assert.equal((await write('https://evil.example.test')).status, 403, 'another site');
  assert.equal((await write(studio.origin)).status, 403, 'the local editor\'s origin, by the public name');
  const made = await write(EDITOR);
  assert.ok(made.status < 400, `the public editor writes (${made.status} ${made.text})`);
});

test('a project opened by the public name plays from the film\'s public origin; by the local name, from the local one', async () => {
  const made = await call(studio.origin, '/api/projects', {
    method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Both' }),
  });
  const { id } = JSON.parse(made.text).project ?? JSON.parse(made.text);
  const viaPublic = JSON.parse((await call(studio.origin, `/api/projects/${encodeURIComponent(id)}`, { host: 'film.example.test', headers: { 'x-studio-key': studio.key } })).text);
  const viaLocal = JSON.parse((await call(studio.origin, `/api/projects/${encodeURIComponent(id)}`, { headers: { 'x-studio-key': studio.key } })).text);
  assert.ok(viaPublic.folder.startsWith(`${FILM}/p/`), viaPublic.folder);
  assert.ok(viaLocal.folder.startsWith(`${studio.filmOrigin}/p/`), viaLocal.folder);
  assert.equal(viaPublic.folder.slice(FILM.length), viaLocal.folder.slice(studio.filmOrigin.length), 'the same token either way');
});

test('the film\'s origin answers its public name for the public editor, and its local name for the local one', async () => {
  const pub = await call(studio.filmOrigin, '/p/not-a-token/film.html', { host: 'film-apercu.example.test' });
  assert.equal(pub.status, 404);
  assert.equal(pub.headers['access-control-allow-origin'], EDITOR);
  const local = await call(studio.filmOrigin, '/p/not-a-token/film.html');
  assert.equal(local.status, 404);
  assert.equal(local.headers['access-control-allow-origin'], studio.origin);
  assert.equal((await call(studio.filmOrigin, '/p/not-a-token/film.html', { host: 'film.example.test' })).status, 403, 'the editor\'s name is not the film\'s');
  assert.equal((await call(studio.filmOrigin, '/p/not-a-token/film.html', { host: 'evil.example.test' })).status, 403);
});
