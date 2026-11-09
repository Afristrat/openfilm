import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MAX_PROMPT, agentConfig, createAgentHub, harnessOf, readSaid } from './agent.mjs';

const CONFIG = { baseUrl: 'https://gw.test/v1', model: 'm', name: 'M', keyFile: '/k', vision: false };
const tick = () => new Promise((done) => setImmediate(done));

test('the agent is off without a gateway and a model, and refuses a gateway that would send its key in the clear', () => {
  assert.equal(agentConfig({}), null);
  assert.equal(agentConfig({ OPENFILM_AGENT_BASE_URL: 'https://gw.test/v1' }), null, 'no model');
  const on = agentConfig({ OPENFILM_AGENT_BASE_URL: 'https://gw.test/v1/', OPENFILM_AGENT_MODEL: ' qwen ', OPENFILM_AGENT_KEY_FILE: '/run/k' });
  assert.deepEqual(on, { baseUrl: 'https://gw.test/v1', model: 'qwen', name: 'qwen', keyFile: '/run/k', vision: false });
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
  const hub = createAgentHub({ config: CONFIG, start: async () => { tries++; throw new Error('gateway down'); } });
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
  const hub = createAgentHub({ config: null, start: () => { throw new Error('never'); } });
  const seen = [];
  hub.join({ path: '/p' }, (e) => seen.push(e)).said('{"type":"prompt","text":"a"}');
  assert.equal(seen[0].available, false);
  assert.equal(seen[1].kind, 'error');
});

test('an agent nobody looks at ends after a while', async () => {
  let closed = 0;
  const hub = createAgentHub({ config: CONFIG, idleMs: 5, start: async () => ({ prompt: async () => 'end_turn', cancel: () => {}, close: () => { closed++; } }) });
  const page = hub.join({ path: '/p' }, () => {});
  page.said('{"type":"prompt","text":"a"}');
  await tick(); await tick();
  page.leave();
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(closed, 1);
});
