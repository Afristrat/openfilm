#!/usr/bin/env node
/**
 * `regarder`, the eyes of the agent served to a browser when its own model reads no pictures (agent.mjs,
 * OPENFILM_AGENT_LOOK_MODEL): a picture, or the frame of a video at a time, sent to a model that reads them on the same
 * gateway, which answers in words. The agent runs it in its shell like any command:
 *   regarder <file> [--at <seconds>] [question…]
 * What it needs comes from the session, never from the agent: OPENFILM_LOOK, {baseUrl, model, keyFile} as JSON (the key
 * is read from its file here, never put in the environment nor printed).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The longest side of what is sent: enough to read a frame, small enough for a model on processors. */
export const LOOK_SIDE = 768;
/** How long the gateway is given to answer (a model on processors takes seconds per picture). */
export const LOOK_TIMEOUT_MS = 180_000;
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mxf', '.mts', '.ts']);
const DEFAULT_QUESTION = 'Décris précisément cette image en français : cadrage, personnes, objets, texte visible, couleurs, lumière, défauts éventuels.';

/**
 * What the agent asked: the file, the time in it (a video's frame), its question.
 * @param {string[]} argv @returns {{ file: string, at: number | null, question: string }}
 */
export function readLookArgs(argv) {
  const rest = [...argv];
  let at = null;
  const i = rest.indexOf('--at');
  if (i !== -1) {
    const seconds = Number(rest[i + 1]);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--at takes a time in seconds (0 or more).');
    at = seconds;
    rest.splice(i, 2);
  }
  const [file, ...words] = rest;
  if (!file) throw new Error('Usage: regarder <file> [--at <seconds>] [question…]');
  return { file, at, question: words.join(' ').trim() || DEFAULT_QUESTION };
}

/**
 * ffmpeg's arguments for the picture sent: one frame (a video's at `at`, its first when none), its longest side at most
 * LOOK_SIDE, as a PNG on its standard output.
 * @param {string} file @param {number | null} at
 */
export function frameArgs(file, at) {
  const video = at !== null || VIDEO.has(extname(file).toLowerCase());
  return [
    '-v', 'error',
    ...(video && at !== null ? ['-ss', String(at)] : []),
    '-i', file,
    '-frames:v', '1',
    '-vf', `scale='min(${LOOK_SIDE},iw)':'min(${LOOK_SIDE},ih)':force_original_aspect_ratio=decrease`,
    '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ];
}

/**
 * The request to the gateway: the question and the picture, in the OpenAI chat format.
 * @param {string} model @param {string} question @param {Buffer} png
 */
export function lookRequest(model, question, png) {
  return {
    model,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
      ],
    }],
  };
}

/**
 * The settings the session gave, or an error saying what is missing.
 * @param {Record<string, string | undefined>} env @returns {{ baseUrl: string, model: string, keyFile: string }}
 */
export function lookSettings(env = process.env) {
  let settings;
  try { settings = JSON.parse(env.OPENFILM_LOOK ?? ''); } catch { settings = null; }
  if (!settings?.baseUrl || !settings?.model || !settings?.keyFile) throw new Error('regarder is not set up on this server (OPENFILM_LOOK).');
  return settings;
}

/**
 * Look: the picture taken from the file, sent, the answer's words.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, grab?: (args: string[]) => Buffer }} [io]
 */
export async function look(argv, { env = process.env, fetchImpl = fetch, grab = (args) => execFileSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 }) } = {}) {
  const { file, at, question } = readLookArgs(argv);
  const settings = lookSettings(env);
  const png = grab(frameArgs(realpathSync(file), at));
  if (!png.length) throw new Error(`No picture in ${file}${at !== null ? ` at ${at} s` : ''}.`);
  const key = readFileSync(settings.keyFile, 'utf8').trim();
  const res = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': 'openfilm-studio-look' },
    body: JSON.stringify(lookRequest(settings.model, question, png)),
    signal: AbortSignal.timeout(LOOK_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`The model did not look (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const words = JSON.parse(text)?.choices?.[0]?.message?.content;
  if (typeof words !== 'string' || !words.trim()) throw new Error('The model answered nothing.');
  return words.trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  look(process.argv.slice(2)).then(
    (words) => { process.stdout.write(`${words}\n`); },
    (e) => { process.stderr.write(`regarder: ${e instanceof Error ? e.message : e}\n`); process.exitCode = 1; },
  );
}
