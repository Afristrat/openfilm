import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MAX_ENTRIES, MAX_PROMPT, agentConfig, createAgentHub, harnessOf, installLook, noteEvent, readSaid } from './agent.mjs';

const CONFIG = { baseUrl: 'https://gw.test/v1', model: 'm', name: 'M', keyFile: '/k', vision: false, look: null };
/** A conversation kept in memory, as the project's file would keep it. */
const memoryLog = (kept = new Map()) => ({ kept, load: (path) => structuredClone(kept.get(path) ?? []), save: (path, entries) => { kept.set(path, structuredClone(entries)); } });
const tick = () => new Promise((done) => setImmediate(done));

test('the agent is off without a gateway and a model, and refuses a gateway that would send its key in the clear', () => {
  assert.equal(agentConfig({}), null);
  assert.equal(agentConfig({ OPENFILM_AGENT_BASE_URL: 'https://gw.test/v1' }), null, 'no model');
  const on = agentConfig({ OPENFILM_AGENT_BASE_URL: 'https://gw.test/v1/', OPENFILM_AGENT_MODEL: ' qwen ', OPENFILM_AGENT_KEY_FILE: '/run/k' });
  assert.deepEqual(on, { baseUrl: 'https://gw.test/v1', model: 'qwen', name: 'qwen', keyFile: '/run/k', vision: false, look: null });
  assert.equal(agentConfig({ OPENFILM_AGENT_BASE_URL: 'http://127.0.0.1:4000/v1', OPENFILM_AGENT_MODEL: 'q', OPENFILM_AGENT_VISION: '1' })?.vision, true);
  assert.throws(() => agentConfig({ OPENFILM_AGENT_BASE_URL: 'http://gw.test/v1', OPENFILM_AGENT_MODEL: 'q' }), /https/);
  assert.throws(() => agentConfig({ OPENFILM_AGENT_BASE_URL: 'http://localhost.evil.test/v1', OPENFILM_AGENT_MODEL: 'q' }), /https/);
});

test("Pi's harness: one model, its key in a variable only, text only unless it reads pictures", () => {
  const h = harnessOf(CONFIG, 'secret', '/home/of');
  assert.equal(h.home, join('/home/of', 'agent', 'pi'));
  assert.equal(h.model, 'dgx');
  assert.deepEqual(h.env, { OPENFILM_AGENT_KEY: 'secret' });
  assert.equal(h.models.length, 1);
  assert.equal(h.models[0].keyEnv, 'OPENFILM_AGENT_KEY');
  assert.ok(!JSON.stringify(h.models).includes('secret'), 'the key is never in the models Pi writes down');
  assert.deepEqual(h.models[0].input, ['text']);
  assert.deepEqual(harnessOf({ ...CONFIG, vision: true }, 'k', '/h').models[0].input, ['text', 'image']);
  assert.equal(h.models[0].compat.maxTokensField, 'max_tokens');
});

test('a page may only send a message (trimmed, not too long) or a stop', () => {
  assert.deepEqual(readSaid('{"type":"prompt","text":"  ciao  "}'), { type: 'prompt', text: 'ciao' });
  assert.deepEqual(readSaid('{"type":"cancel"}'), { type: 'cancel' });
  for (const bad of ['nope', '{"type":"prompt","text":"   "}', '{"type":"prompt","text":3}', '{"type":"run","text":"rm"}',
    JSON.stringify({ type: 'prompt', text: 'x'.repeat(MAX_PROMPT + 1) })]) assert.equal(readSaid(bad), null, bad.slice(0, 40));
});

test('one agent per project: started on the first message, every page sees the turn, one turn at a time', async () => {
  let started = 0;
  /** @type {(v: string) => void} */
  let finish = () => {};
  const hub = createAgentHub({
    config: CONFIG,
    log: memoryLog(),
    start: async (_project, onUpdate) => {
      started++;
      return { prompt: (text) => { onUpdate({ said: text }); return new Promise((done) => { finish = done; }); }, cancel: () => {}, close: () => {} };
    },
  });
  const a = [], b = [];
  const project = { path: '/films/one' };
  const pa = hub.join(project, (e) => a.push(e));
  hub.join(project, (e) => b.push(e));
  assert.deepEqual(a[0], { kind: 'ready', available: true, busy: false, model: 'M' });
  pa.said('{"type":"prompt","text":"bonjour"}');
  await tick();
  assert.deepEqual(hub.working(), ['/films/one'], 'Studio knows the folder is being worked in');
  pa.said('{"type":"prompt","text":"encore"}');
  assert.deepEqual(a.at(-1), { kind: 'busy' }, 'a second message while it works is refused, to that page');
  finish('end_turn');
  await tick();
  for (const page of [a, b]) {
    assert.deepEqual(page.filter((e) => e.kind !== 'ready' && e.kind !== 'busy'), [{ kind: 'turn', text: 'bonjour' }, { kind: 'update', update: { said: 'bonjour' } }, { kind: 'done', stopReason: 'end_turn' }]);
  }
  assert.deepEqual(hub.working(), []);
  pa.said('{"type":"prompt","text":"suite"}');
  await tick();
  assert.equal(started, 1, 'the same agent for the next message');
  hub.closeAll();
});

test('an agent that cannot start says why, and the next message tries again', async () => {
  let tries = 0;
  const hub = createAgentHub({ config: CONFIG, log: memoryLog(), start: async () => { tries++; throw new Error('gateway down'); } });
  const seen = [];
  const page = hub.join({ path: '/p' }, (e) => seen.push(e));
  page.said('{"type":"prompt","text":"a"}');
  await tick(); await tick();
  assert.deepEqual(seen.at(-1), { kind: 'error', message: 'gateway down' });
  page.said('{"type":"prompt","text":"b"}');
  await tick(); await tick();
  assert.equal(tries, 2);
});

test('without a model the page is told so, and nothing starts', () => {
  const hub = createAgentHub({ config: null, log: memoryLog(), start: () => { throw new Error('never'); } });
  const seen = [];
  hub.join({ path: '/p' }, (e) => seen.push(e)).said('{"type":"prompt","text":"a"}');
  assert.equal(seen[0].available, false);
  assert.equal(seen[1].kind, 'error');
});

test('an agent nobody looks at ends after a while', async () => {
  let closed = 0;
  const hub = createAgentHub({ config: CONFIG, log: memoryLog(), idleMs: 5, start: async () => ({ prompt: async () => 'end_turn', cancel: () => {}, close: () => { closed++; } }) });
  const page = hub.join({ path: '/p' }, () => {});
  page.said('{"type":"prompt","text":"a"}');
  await tick(); await tick();
  page.leave();
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(closed, 1);
});

test('the conversation as a page shows it: the words joined, each tool and how it ended, a stop; never more than MAX_ENTRIES', () => {
  const entries = [];
  for (const e of [
    { kind: 'turn', text: 'bonjour' },
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Je ' } } },
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'regarde.' } } },
    { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' } },
    { kind: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } } },
    { kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fait.' } } },
    { kind: 'done', stopReason: 'end_turn' },
    { kind: 'done', stopReason: 'cancelled' },
    { kind: 'error', message: 'panne' },
  ]) noteEvent(entries, e);
  assert.deepEqual(entries, [
    { kind: 'turn', text: 'bonjour' }, { kind: 'reply', text: 'Je regarde.' }, { kind: 'tool', id: 't1', title: 'ls', status: 'completed' },
    { kind: 'reply', text: 'Fait.' }, { kind: 'stopped' }, { kind: 'error', message: 'panne' },
  ]);
  const many = [];
  for (let i = 0; i < MAX_ENTRIES + 10; i++) noteEvent(many, { kind: 'turn', text: String(i) });
  assert.equal(many.length, MAX_ENTRIES);
  assert.deepEqual(many[0], { kind: 'turn', text: '10' }, 'the oldest go first');
});

test('a page opened again on a project is shown its conversation so far, kept with the project', async () => {
  const log = memoryLog();
  const start = async (_p, onUpdate) => ({ prompt: async () => { onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ciao' } }); return 'end_turn'; }, cancel: () => {}, close: () => {} });
  const hub = createAgentHub({ config: CONFIG, start, log });
  const first = [];
  const page = hub.join({ path: '/p' }, (e) => first.push(e));
  assert.equal(first.some((e) => e.kind === 'history'), false, 'nothing said yet: no history');
  page.said('{"type":"prompt","text":"salve"}');
  await tick(); await tick();
  page.leave();
  const expected = [{ kind: 'turn', text: 'salve' }, { kind: 'reply', text: 'ciao' }];
  assert.deepEqual(log.kept.get('/p'), expected, 'kept when the turn ends');
  hub.closeAll();
  /* Studio restarted: a new hub, the same project */
  const again = [];
  createAgentHub({ config: CONFIG, start, log }).join({ path: '/p' }, (e) => again.push(e));
  assert.deepEqual(again[1], { kind: 'history', entries: expected });
});

test('a model that reads no pictures is given eyes when the gateway has one that does; a model that reads them is not', () => {
  const base = { OPENFILM_AGENT_BASE_URL: 'https://gw.test/v1', OPENFILM_AGENT_MODEL: 'q' };
  assert.equal(agentConfig({ ...base, OPENFILM_AGENT_LOOK_MODEL: ' qwen2.5vl ' })?.look, 'qwen2.5vl');
  assert.equal(agentConfig({ ...base, OPENFILM_AGENT_LOOK_MODEL: 'qwen2.5vl', OPENFILM_AGENT_VISION: '1' })?.look, null);
  assert.equal(agentConfig(base)?.look, null);
});

test('regarder is written beside openfilm: this Node running look.mjs, with what the agent gives it', { skip: process.platform === 'win32' }, () => {
  const bin = mkdtempSync(join(tmpdir(), 'look-'));
  const file = installLook(bin, "/opt/no'de");
  const script = readFileSync(file, 'utf8');
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /exec '\/opt\/no'\\''de' '[^']*look\.mjs' "\$@"\n$/);
  assert.equal(statSync(file).mode & 0o111, 0o111, 'executable');
});

test('a page answers what the agent asks: its question on every page (and one opened meanwhile), settled once, kept in the conversation', async () => {
  /** @type {any} */
  let asks = null;
  /** @type {(v: string) => void} */
  let finish = () => {};
  const kept = memoryLog();
  const hub = createAgentHub({
    config: CONFIG,
    log: kept,
    start: async (_project, _onUpdate, given) => { asks = given; return { prompt: () => new Promise((done) => { finish = done; }), cancel: () => {}, close: () => {} }; },
  });
  const project = { path: '/films/ask' };
  const a = [], b = [];
  const pa = hub.join(project, (e) => a.push(e));
  pa.said('{"type":"prompt","text":"monte le clip"}');
  await tick();
  const answer = asks.question({ message: 'Quelle durée ?', toolCallId: 't1', questions: [{ id: 'q0', question: 'Quelle durée ?', options: [{ label: '1 min' }, { label: '3 min' }] }] });
  const asked = a.find((e) => e.kind === 'question');
  assert.ok(asked?.requestId, 'the page is asked');
  const pb = hub.join(project, (e) => b.push(e));
  assert.equal(b.find((e) => e.kind === 'question')?.requestId, asked.requestId, 'a page opened meanwhile is asked too');
  pb.said(JSON.stringify({ type: 'answer', requestId: asked.requestId, answers: { q0: { label: '3 min' } } }));
  assert.deepEqual(await answer, { q0: { label: '3 min' } });
  pa.said(JSON.stringify({ type: 'answer', requestId: asked.requestId, answers: { q0: { label: '1 min' } } }));
  assert.equal(a.filter((e) => e.kind === 'answered').length, 1, 'answered once: a late answer changes nothing');
  finish('end_turn');
  await tick();
  assert.deepEqual(kept.kept.get('/films/ask').find((e) => e.kind === 'asked'), { kind: 'asked', text: 'Quelle durée ?', answer: '3 min' });
  hub.closeAll();
});

test('a permission takes only one of its own options; unanswered in time the agent decides itself, and a stop settles what it asked', async () => {
  /** @type {any} */
  let asks = null;
  const hub = createAgentHub({
    config: CONFIG,
    log: memoryLog(),
    askMs: 30,
    start: async (_project, _onUpdate, given) => { asks = given; return { prompt: () => new Promise(() => {}), cancel: () => {}, close: () => {} }; },
  });
  const seen = [];
  const page = hub.join({ path: '/films/perm' }, (e) => seen.push(e));
  page.said('{"type":"prompt","text":"rendu"}');
  await tick();
  const allowed = asks.permission({ toolCall: { title: 'rm -rf' }, options: [{ optionId: 'ok', name: 'Autoriser', kind: 'allow_once' }, { optionId: 'no', name: 'Refuser', kind: 'reject_once' }] });
  const id = seen.find((e) => e.kind === 'permission').requestId;
  page.said(JSON.stringify({ type: 'answer', requestId: id, optionId: 'invented' }));
  page.said(JSON.stringify({ type: 'answer', requestId: id, optionId: 'ok' }));
  assert.equal(await allowed, 'ok');
  const awake = setTimeout(() => {}, 1000); /* the wait's own timer does not keep the process up */
  assert.equal(await asks.question({ message: 'x', toolCallId: null, questions: [] }), null, 'nobody answered in time');
  clearTimeout(awake);
  assert.equal(seen.filter((e) => e.kind === 'answered').at(-1).by, 'timeout');
  const stopped = asks.permission({ options: [] });
  page.said('{"type":"cancel"}');
  assert.equal(await stopped, null);
  hub.closeAll();
});

test('a page may answer what was asked, by its id, with choices or its own words only', () => {
  assert.deepEqual(readSaid('{"type":"answer","requestId":"r1","answers":{"q0":{"label":"3 min"},"q1":{"text":"  libre "},"q2":{"x":1}}}'),
    { type: 'answer', requestId: 'r1', answers: { q0: { label: '3 min' }, q1: { text: 'libre' } } });
  assert.deepEqual(readSaid('{"type":"answer","requestId":"r1","answers":null}'), { type: 'answer', requestId: 'r1', answers: null });
  assert.deepEqual(readSaid('{"type":"answer","requestId":"r1","optionId":"ok"}'), { type: 'answer', requestId: 'r1', optionId: 'ok' });
  assert.equal(readSaid('{"type":"answer","answers":{}}'), null);
});
