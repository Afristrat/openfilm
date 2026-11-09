import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LinkError, checkLink, createLinkImports, privateAddress, readLine, ytdlpArgs } from './from-url.mjs';

const publicHost = async () => [{ address: '142.250.180.14' }];

test('addresses of this machine and of private networks are never the public web', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.100.20', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.85.125.95', '0.0.0.0', '::1', '::', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:192.168.1.1', '224.0.0.1']) {
    assert.equal(privateAddress(a), true, a);
  }
  for (const a of ['142.250.180.14', '172.32.0.1', '100.128.0.1', '2a00:1450:4007:80e::200e']) assert.equal(privateAddress(a), false, a);
});

test('a link is taken only to the public web, over http or https', async () => {
  assert.equal((await checkLink(' https://www.youtube.com/watch?v=OwFrfVmkrhI ', publicHost)).hostname, 'www.youtube.com');
  const refused = async (link, resolve = publicHost) => assert.rejects(checkLink(link, resolve), (e) => e instanceof LinkError && e.status === 400, String(link));
  await refused('');
  await refused(42);
  await refused('youtube.com/watch?v=x');
  await refused('file:///etc/passwd');
  await refused('ftp://example.com/a.mp4');
  await refused('http://localhost:4747/api/projects');
  await refused('http://127.0.0.1:4747/');
  await refused('http://[::1]:4747/');
  await refused('http://192.168.100.24:8000/');
  await refused('https://user:pass@example.com/v.mp4');
  await refused('https://studio.internal/a');
  await refused('https://rebinding.example/', async () => [{ address: '142.250.180.14' }, { address: '10.0.0.5' }]);
  await refused('https://nowhere.example/', async () => { throw new Error('ENOTFOUND'); });
  await refused(`https://example.com/${'a'.repeat(2048)}`);
});

test("yt-dlp is told: one video, picture and sound in an MP4, its title for a name, its progress and its file said", () => {
  const args = ytdlpArgs('https://www.youtube.com/watch?v=x', '/w');
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=x');
  assert.equal(args.at(-2), '--', 'the link can never be read as an option');
  for (const w of ['--no-playlist', '--newline', '--merge-output-format']) assert.ok(args.includes(w), w);
  assert.equal(args[args.indexOf('-o') + 1], join('/w', '%(title).150B [%(id)s].%(ext)s'));
  assert.deepEqual(readLine('OFPROGRESS 50 200'), { ratio: 0.25 });
  assert.deepEqual(readLine('OFPROGRESS 200 200'), { ratio: 0.99 }, 'done only once the file is in place');
  assert.equal(readLine('OFPROGRESS 5 NA'), null);
  assert.deepEqual(readLine('OFFILE /w/Titre [x].mp4\r'), { file: '/w/Titre [x].mp4' });
  assert.equal(readLine('[youtube] x: Downloading webpage'), null);
});

/** A yt-dlp that says what it is told to and writes one file. */
function fakeYtdlp({ code = 0, name = 'Ipnosi [x].mp4', stderr = '' } = {}) {
  return (_program, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    setImmediate(() => {
      child.stdout.write('OFPROGRESS 10 100\n');
      if (code === 0) {
        const file = join(options.cwd, name);
        writeFileSync(file, 'video');
        writeFileSync(join(options.cwd, `${name}.part`), '');
        child.stdout.write(`OFFILE ${file}\n`);
      }
      child.stderr.write(stderr);
      child.stdout.end(); child.stderr.end();
      child.emit('close', code);
    });
    child.args = args;
    return child;
  };
}
const settle = async (imports, project, id) => {
  for (let i = 0; i < 100; i++) {
    const job = imports.get(project, id);
    if (job.status !== 'running') return job;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('never ended');
};

test('a download lands in the folder asked for, under its title, and its work folder goes', async () => {
  const project = mkdtempSync(join(tmpdir(), 'of-link-'));
  const imports = createLinkImports({ spawn: fakeYtdlp(), resolve: publicHost });
  const job = await imports.start(project, 'https://www.youtube.com/watch?v=x', 'assets/video');
  assert.equal(job.status, 'running');
  const done = await settle(imports, project, job.id);
  assert.deepEqual(done, { id: job.id, status: 'done', ratio: 1, path: 'assets/video/Ipnosi [x].mp4' });
  assert.equal(readFileSync(join(project, 'assets/video/Ipnosi [x].mp4'), 'utf8'), 'video');
  assert.equal(existsSync(join(project, '.film/cache/from-url', job.id)), false, 'no part-file left behind');
  const again = await imports.start(project, 'https://www.youtube.com/watch?v=x', 'assets/video');
  assert.equal((await settle(imports, project, again.id)).path, 'assets/video/Ipnosi [x] 2.mp4', 'a second never overwrites the first');
});

test("a download that fails says yt-dlp's reason; one project, one download at a time; a job is its project's only", async () => {
  const project = mkdtempSync(join(tmpdir(), 'of-link-'));
  const failing = createLinkImports({ spawn: fakeYtdlp({ code: 1, stderr: 'WARNING: x\nERROR: [youtube] x: Video unavailable\n' }), resolve: publicHost });
  const job = await failing.start(project, 'https://www.youtube.com/watch?v=x', 'assets/video');
  assert.deepEqual(await settle(failing, project, job.id), { id: job.id, status: 'failed', ratio: 0.1, error: '[youtube] x: Video unavailable' });
  assert.throws(() => failing.get('/another/project', job.id), (e) => e instanceof LinkError && e.status === 404);

  const slow = createLinkImports({ spawn: () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} }), resolve: publicHost });
  await slow.start(project, 'https://example.com/a.mp4', 'assets');
  await assert.rejects(slow.start(project, 'https://example.com/b.mp4', 'assets'), (e) => e instanceof LinkError && e.status === 409);
  await assert.rejects(slow.start(mkdtempSync(join(tmpdir(), 'of-link-')), 'http://10.0.0.1/a.mp4', 'assets'), (e) => e instanceof LinkError && e.status === 400);
});
