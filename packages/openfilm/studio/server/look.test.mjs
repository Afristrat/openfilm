import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOK_SIDE, frameArgs, look, lookRequest, lookSettings, readLookArgs } from './look.mjs';

test('what the agent asks: the file, a time in seconds when given, its question or a full description', () => {
  assert.deepEqual(readLookArgs(['plan.mp4', '--at', '12.5', 'le', 'cadrage', '?']), { file: 'plan.mp4', at: 12.5, question: 'le cadrage ?' });
  const plain = readLookArgs(['affiche.png']);
  assert.equal(plain.at, null);
  assert.match(plain.question, /^Décris précisément/);
  assert.throws(() => readLookArgs([]), /Usage/);
  assert.throws(() => readLookArgs(['a.mp4', '--at', '-1']), /seconds/);
  assert.throws(() => readLookArgs(['a.mp4', '--at', 'x']), /seconds/);
});

test('one frame, a video\'s at the time asked, never larger than LOOK_SIDE, as a PNG on standard output', () => {
  const video = frameArgs('/p/plan.mp4', 3);
  assert.deepEqual(video.slice(0, 6), ['-v', 'error', '-ss', '3', '-i', '/p/plan.mp4']);
  assert.ok(video.includes(`scale='min(${LOOK_SIDE},iw)':'min(${LOOK_SIDE},ih)':force_original_aspect_ratio=decrease`));
  assert.deepEqual(video.slice(-5), ['-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
  assert.ok(!frameArgs('/p/affiche.png', null).includes('-ss'), 'a picture has no time');
  assert.ok(!frameArgs('/p/plan.MOV', null).includes('-ss'), 'a video without a time: its first frame');
});

test('the request: the question then the picture as a data URL, for the looking model', () => {
  const body = lookRequest('qwen2.5vl', 'Quoi ?', Buffer.from('png'));
  assert.equal(body.model, 'qwen2.5vl');
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'Quoi ?' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` } },
  ]);
});

test('without its settings it says so, and never runs', () => {
  assert.throws(() => lookSettings({}), /not set up/);
  assert.throws(() => lookSettings({ OPENFILM_LOOK: '{"baseUrl":"https://g"}' }), /not set up/);
});

test('look: the frame sent with the key from its file, the model\'s words answered; a refusal says its status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'look-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'secret-key\n');
  const picture = join(dir, 'plan.mp4');
  writeFileSync(picture, 'video');
  const env = { OPENFILM_LOOK: JSON.stringify({ baseUrl: 'https://gw.test/v1', model: 'vl', keyFile }) };
  /** @type {any[]} */
  const calls = [];
  const grab = (/** @type {string[]} */ args) => { calls.push(args); return Buffer.from('PNG'); };
  const answer = (/** @type {number} */ status, /** @type {unknown} */ body) => async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  const words = await look([picture, '--at', '2', 'Qui parle ?'], { env, grab, fetchImpl: /** @type {any} */ (answer(200, { choices: [{ message: { content: ' Une femme. ' } }] })) });
  assert.equal(words, 'Une femme.');
  assert.ok(calls[0].includes('-ss') && calls[0].includes('2'));
  assert.equal(calls[1].url, 'https://gw.test/v1/chat/completions');
  assert.equal(calls[1].init.headers.authorization, 'Bearer secret-key');
  assert.equal(JSON.parse(calls[1].init.body).messages[0].content[0].text, 'Qui parle ?');
  await assert.rejects(look([picture], { env, grab, fetchImpl: /** @type {any} */ (answer(403, { error: 'no' })) }), /HTTP 403/);
  await assert.rejects(look([picture], { env, grab: () => Buffer.alloc(0), fetchImpl: /** @type {any} */ (answer(200, {})) }), /No picture/);
  await assert.rejects(look([picture], { env, grab, fetchImpl: /** @type {any} */ (answer(200, { choices: [] })) }), /nothing/);
});
