/**
 * The agent of Studio served to a browser (DGX AI-MPower fork, deploy/agent-web/CONCEPTION.md): the desktop app's own
 * agent (Pi, apps/desktop/src/pi-agent.mjs, through its AgentSession) run by this server in the project's folder, with
 * the `openfilm` command first on its PATH and OpenFilm's skills. Its model is a service of the person's, an
 * OpenAI-compatible gateway, named by the environment and never by the code:
 *   OPENFILM_AGENT_BASE_URL  the gateway (https, or http to this machine), its `/v1`
 *   OPENFILM_AGENT_MODEL     the model asked for there
 *   OPENFILM_AGENT_NAME      what the page calls it (the model's name when none)
 *   OPENFILM_AGENT_KEY_FILE  the file its key is in (<Studio's home>/agent/litellm.key when none), read as a session starts
 *   OPENFILM_AGENT_VISION    1 when the model reads pictures; otherwise Pi leaves them out of its requests
 *   OPENFILM_AGENT_LOOK_MODEL when the model reads none: a model of the same gateway that does, behind the agent's
 *                            `regarder` command (look.mjs), which it is told of as its conversation starts
 * Without a gateway and a model the agent is off and the page says so.
 *
 * One agent per project, whichever pages are open on it: each page sees every turn (the person's words, the agent's
 * as they come, its tools), one turn at a time. Pages talk to it on a WebSocket (/api/projects/:id/agent):
 *   in:  {type: 'prompt', text} · {type: 'cancel'}
 *   out: {kind: 'ready', available, busy, model} · {kind: 'turn', text} · {kind: 'update', update} (ACP session/update)
 *        · {kind: 'busy'} · {kind: 'done', stopReason} · {kind: 'error', message}
 *        · {kind: 'history', entries} right after `ready`: the conversation so far, for a page opened (again) on it
 * A project's conversation is taken up again when its agent starts anew (<project>/.film/agent/web.json keeps which),
 * and what was said is kept for the pages in <project>/.film/agent/web-log.json (the last MAX_ENTRIES entries).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioHome } from './projects.mjs';

/** The longest message a page may send (the socket closes above MAX_FRAME, 1 MiB, anyway). */
export const MAX_PROMPT = 32_000;
/** How long an agent nobody looks at and that is not working stays started (its process and model connection). */
export const IDLE_MS = 15 * 60_000;
/** How many entries of a conversation are kept for the pages (its words, the agent's, its tools). */
export const MAX_ENTRIES = 400;
/** The desktop app's agent code, beside this package in the repository the server runs from. */
const DESKTOP = new URL('../../../../apps/desktop/src/', import.meta.url);

/**
 * The agent's settings from the environment, or null when it is off (no gateway or no model). A gateway that is
 * neither https nor this machine's is refused: the key would go out in the clear.
 * @param {Record<string, string | undefined>} [env]
 */
export function agentConfig(env = process.env) {
  const baseUrl = env.OPENFILM_AGENT_BASE_URL?.trim().replace(/\/+$/, '');
  const model = env.OPENFILM_AGENT_MODEL?.trim();
  if (!baseUrl || !model) return null;
  if (!/^https:\/\/[^/]/.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(baseUrl)) {
    throw new Error(`OPENFILM_AGENT_BASE_URL must be https (or http to this machine): ${baseUrl}`);
  }
  return {
    baseUrl,
    model,
    name: env.OPENFILM_AGENT_NAME?.trim() || model,
    keyFile: env.OPENFILM_AGENT_KEY_FILE?.trim() || join(studioHome(), 'agent', 'litellm.key'),
    vision: env.OPENFILM_AGENT_VISION === '1',
    look: env.OPENFILM_AGENT_VISION === '1' ? null : env.OPENFILM_AGENT_LOOK_MODEL?.trim() || null,
  };
}

/** What the agent is told, with its first words each time its process starts, when it has `regarder`. */
export const LOOK_NOTE = 'Note de Studio : ton modèle ne lit pas les images. Pour voir une image ou une vidéo du projet, lance dans le shell '
  + '`regarder <fichier> [--at <secondes>] [question]` : un modèle qui voit la regarde et te répond en mots (une vidéo : '
  + 'l’image à ce moment, la première sans --at). Regarde avant de juger un cadrage, un titre, une incrustation ou un rendu.';

/**
 * Write the `regarder` command into `bin` (beside `openfilm`): this server's Node running look.mjs.
 * @param {string} bin @param {string} [node]
 */
export function installLook(bin, node = process.execPath) {
  const file = join(bin, 'regarder');
  const q = (/** @type {string} */ v) => `'${v.replace(/'/g, `'\\''`)}'`;
  const look = fileURLToPath(new URL('look.mjs', import.meta.url));
  writeFileSync(file, `#!/bin/sh\n# Studio's regarder command (written by the server; changes are lost)\nexec ${q(node)} ${q(look)} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * What Pi runs with (the desktop's roster harness, apps/desktop/src/agent-roster.mjs): its folder, the one model (its
 * key in a variable of its own, never written down), told what the gateway takes (no developer role, no stored
 * responses, `max_tokens`) and whether it reads pictures.
 * @param {{ baseUrl: string, model: string, name: string, vision: boolean }} config @param {string} key @param {string} home
 */
export function harnessOf(config, key, home) {
  return {
    home: join(home, 'agent', 'pi'),
    model: 'dgx',
    env: { OPENFILM_AGENT_KEY: key },
    models: [{
      id: 'dgx',
      name: config.name,
      api: 'openai-completions',
      baseUrl: config.baseUrl,
      keyEnv: 'OPENFILM_AGENT_KEY',
      model: config.model,
      levels: ['auto'],
      effort: 'auto',
      compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
      input: config.vision ? ['text', 'image'] : ['text'],
    }],
  };
}

/**
 * What a page said, or null for anything else: a message (its words, trimmed, at most MAX_PROMPT) or a stop.
 * @param {string} text @returns {{ type: 'prompt', text: string } | { type: 'cancel' } | null}
 */
export function readSaid(text) {
  let said;
  try { said = JSON.parse(text); } catch { return null; }
  if (said?.type === 'cancel') return { type: 'cancel' };
  if (said?.type !== 'prompt' || typeof said.text !== 'string') return null;
  const words = said.text.trim();
  return words && words.length <= MAX_PROMPT ? { type: 'prompt', text: words } : null;
}

/**
 * @typedef {{ kind: 'turn', text: string } | { kind: 'reply', text: string } | { kind: 'tool', id: string, title: string, status: string }
 *   | { kind: 'error', message: string } | { kind: 'stopped' }} Entry
 */

/**
 * The conversation as a page shows it, one event more: the person's words, the agent's words (its pieces joined),
 * each tool it ran and how that ended, an error, a turn stopped. The rest of what the agent says is not kept.
 * @param {Entry[]} entries @param {any} event @returns {Entry[]}
 */
export function noteEvent(entries, event) {
  const last = entries.at(-1);
  if (event?.kind === 'turn') entries.push({ kind: 'turn', text: String(event.text) });
  else if (event?.kind === 'error') entries.push({ kind: 'error', message: String(event.message) });
  else if (event?.kind === 'done' && event.stopReason === 'cancelled') entries.push({ kind: 'stopped' });
  else if (event?.kind === 'update') {
    const u = event.update ?? {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      if (last?.kind === 'reply') last.text += u.content.text;
      else entries.push({ kind: 'reply', text: String(u.content.text) });
    } else if (u.sessionUpdate === 'tool_call') {
      entries.push({ kind: 'tool', id: String(u.toolCallId ?? ''), title: String(u.title ?? ''), status: String(u.status ?? 'pending') });
    } else if (u.sessionUpdate === 'tool_call_update') {
      const tool = /** @type {any} */ (entries.findLast((e) => e.kind === 'tool' && e.id === u.toolCallId));
      if (tool) { if (u.title) tool.title = String(u.title); if (u.status) tool.status = String(u.status); }
    }
  }
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  return entries;
}

/** Where a project's conversation is kept for its pages. */
const logFile = (/** @type {string} */ path) => join(path, '.film', 'agent', 'web-log.json');
/** @type {{ load: (path: string) => Entry[], save: (path: string, entries: Entry[]) => void }} */
export const projectLog = {
  load(path) {
    try { const kept = JSON.parse(readFileSync(logFile(path), 'utf8')); return Array.isArray(kept) ? kept.slice(-MAX_ENTRIES) : []; } catch { return []; }
  },
  save(path, entries) {
    mkdirSync(dirname(logFile(path)), { recursive: true });
    writeFileSync(logFile(path), `${JSON.stringify(entries)}\n`);
  },
};

/**
 * @typedef {{ prompt: (text: string) => Promise<unknown>, cancel: () => Promise<unknown> | void, close: () => void }} Started
 * @typedef {(project: { path: string }, onUpdate: (update: unknown) => void) => Promise<Started>} Start
 */

/**
 * The agents of every project, each started on its first message (`start`), and the pages open on them.
 * `log`: where each project's conversation is kept for its pages (projectLog: in the project).
 * @param {{ config: ReturnType<typeof agentConfig>, start: Start, idleMs?: number, log?: typeof projectLog }} options
 */
export function createAgentHub({ config, start, idleMs = IDLE_MS, log = projectLog }) {
  /** @type {Map<string, { pages: Set<(event: unknown) => void>, session: Promise<Started> | null, busy: boolean, idle: ReturnType<typeof setTimeout> | null, entries: Entry[] }>} */
  const rooms = new Map();
  const roomOf = (/** @type {string} */ path) => {
    let room = rooms.get(path);
    if (!room) rooms.set(path, (room = { pages: new Set(), session: null, busy: false, idle: null, entries: log.load(path) }));
    return room;
  };
  const tell = (/** @type {{ pages: Set<(event: unknown) => void>, entries: Entry[] }} */ room, /** @type {unknown} */ event) => {
    noteEvent(room.entries, event);
    for (const send of room.pages) send(event);
  };
  /* nobody looking and nothing to do: the agent's process ends after a while, its conversation kept on disk */
  const rest = (/** @type {string} */ path) => {
    const room = rooms.get(path);
    if (!room || room.pages.size || room.busy) return;
    if (room.idle) clearTimeout(room.idle);
    room.idle = setTimeout(() => {
      room.idle = null;
      if (room.pages.size || room.busy) return;
      void room.session?.then((s) => s.close(), () => {});
      rooms.delete(path);
    }, idleMs);
    room.idle.unref?.();
  };

  async function turn(/** @type {ReturnType<typeof roomOf>} */ room, /** @type {{ path: string }} */ project, /** @type {string} */ text) {
    room.busy = true;
    tell(room, { kind: 'turn', text });
    try {
      room.session ??= start(project, (update) => tell(room, { kind: 'update', update }));
      const session = await room.session.catch((e) => { room.session = null; throw e; });
      const stopReason = await session.prompt(text);
      tell(room, { kind: 'done', stopReason: stopReason ?? null });
    } catch (e) {
      tell(room, { kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      room.busy = false;
      try { log.save(project.path, room.entries); } catch (e) { console.error(`agent: the conversation of ${project.path} was not kept: ${e instanceof Error ? e.message : e}`); }
      rest(project.path);
    }
  }

  return {
    /** the folders an agent is working in now: Studio does not rename or delete them meanwhile */
    working: () => [...rooms].filter(([, room]) => room.busy).map(([path]) => path),
    /**
     * A page opened on a project's agent: it is told where the agent stands, then everything it does.
     * @param {{ path: string }} project @param {(event: unknown) => void} send
     */
    join(project, send) {
      const room = roomOf(project.path);
      if (room.idle) { clearTimeout(room.idle); room.idle = null; }
      room.pages.add(send);
      send({ kind: 'ready', available: Boolean(config), busy: room.busy, model: config?.name ?? null });
      if (room.entries.length) send({ kind: 'history', entries: room.entries });
      return {
        said(/** @type {string} */ text) {
          const said = readSaid(text);
          if (!said) return;
          if (said.type === 'cancel') { void room.session?.then((s) => s.cancel(), () => {}); return; }
          if (!config) { send({ kind: 'error', message: 'Aucun modèle n’est configuré pour l’agent sur ce serveur.' }); return; }
          if (room.busy) { send({ kind: 'busy' }); return; }
          void turn(room, project, said.text);
        },
        leave() {
          room.pages.delete(send);
          rest(project.path);
        },
      };
    },
    /** Studio closing: every agent's process ends */
    closeAll() {
      for (const room of rooms.values()) {
        if (room.idle) clearTimeout(room.idle);
        void room.session?.then((s) => s.close(), () => {});
      }
      rooms.clear();
    },
  };
}

/**
 * A project's agent started: Pi through the desktop's AgentSession, in the project's folder, the `openfilm` command
 * (written under <home>/agent/bin) first on its PATH, OpenFilm's skills, its conversation taken up again when the
 * project had one. With a looking model (config.look), `regarder` beside it and LOOK_NOTE before its first words. Every permission it asks is refused and every question declined: the page has no place for them yet.
 * @param {{ path: string }} project @param {(update: unknown) => void} onUpdate
 * @param {{ config: NonNullable<ReturnType<typeof agentConfig>>, home?: string }} options
 * @returns {Promise<Started>}
 */
export async function startPiSession(project, onUpdate, { config, home = studioHome() }) {
  const key = readFileSync(config.keyFile, 'utf8').trim();
  if (!key) throw new Error(`No key in ${config.keyFile}.`);
  const { AgentSession } = await import(new URL('agents.mjs', DESKTOP).href);
  const { installOpenfilmCommand } = await import(new URL('openfilm-command.mjs', DESKTOP).href);
  const { mySkillsDir } = await import('../../src/skills.mjs');
  const dataDir = join(home, 'agent');
  const kept = join(project.path, '.film', 'agent', 'web.json');
  let resume = null;
  try { resume = JSON.parse(readFileSync(kept, 'utf8')).sessionId ?? null; } catch { /* a first conversation */ }
  const binDir = installOpenfilmCommand(dataDir, {});
  if (config.look) installLook(binDir);
  const session = new AgentSession({
    agent: 'byok',
    cwd: project.path,
    resume,
    binDir,
    env: {
      OPENFILM_HOME: home,
      OPENFILM_AGENT: 'web',
      ...(config.look ? { OPENFILM_LOOK: JSON.stringify({ baseUrl: config.baseUrl, model: config.look, keyFile: config.keyFile }) } : {}),
    },
    harness: harnessOf(config, key, home),
    skills: { dataDir, mine: mySkillsDir(), prefsHome: home },
    onUpdate,
    onPermission: async () => null,
    onQuestion: async () => null,
  });
  const info = await session.start();
  mkdirSync(dirname(kept), { recursive: true });
  writeFileSync(kept, `${JSON.stringify({ sessionId: info.sessionId })}\n`);
  let told = !config.look;
  return {
    prompt: (text) => {
      const note = told ? [] : [{ type: 'text', text: LOOK_NOTE }];
      told = true;
      return session.prompt([...note, { type: 'text', text }]);
    },
    cancel: () => session.cancel(),
    close: () => session.close(),
  };
}
