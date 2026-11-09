// @ts-check
/**
 * DGX AI-MPower : les services du DGX spark-1540, appelés en direct sur la machine (127.0.0.1, sans Cloudflare ni
 * clé), Studio tournant sur ce DGX (conteneur openfilm-studio, réseau de l'hôte). Inventaire prouvé le 2026-11-08
 * (SOP-016) : voix higgs (:7861, API OpenAI /v1/audio/speech, WAV), transcription qwen3-asr (:8003, API OpenAI
 * /v1/audio/transcriptions, texte sans horodatage des mots), ComfyUI 0.39 (:8188) pour les images (Flux Schnell) et la
 * musique (ACE-Step 1.5 Turbo). Les adresses se changent par OPENFILM_DGX_TTS_URL, OPENFILM_DGX_ASR_URL et
 * OPENFILM_DGX_COMFY_URL.
 * Installé dans <shared home>/providers/dgx/ (added.mjs) ; source versionnée : deploy/dgx-provider/ du fork.
 */
import { landing, madePicture, modelOf, needed, notes, number, clamp, pictureSize, round, speechUpload, text, wavSeconds }
  from '/opt/openfilm/packages/openfilm/studio/server/providers/common.mjs';

/** @typedef {import('/opt/openfilm/packages/openfilm/studio/server/providers/contract.mjs').Provider} Provider */

const NAME = 'DGX AI-MPower';
const TTS = (process.env.OPENFILM_DGX_TTS_URL || 'http://127.0.0.1:7861').replace(/\/+$/, '');
const ASR = (process.env.OPENFILM_DGX_ASR_URL || 'http://127.0.0.1:8003').replace(/\/+$/, '');
const COMFY = (process.env.OPENFILM_DGX_COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');

const MODELS = {
  tts: [{ id: 'higgs', name: 'Higgs (voix maison, FR/AR)' }],
  asr: [{ id: 'qwen3-asr', name: 'Qwen3-ASR 1.7B' }],
  image: [{ id: 'flux1-schnell', name: 'Flux.1 Schnell', spec: { ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'] } }],
  music: [{ id: 'ace-step-1.5-turbo', name: 'ACE-Step 1.5 Turbo' }],
  /* Stable Audio Open 1.0 (ComfyUI natif : ConditioningStableAudio, encodeur t5_base), jusqu'à 47 s */
  sfx: [{ id: 'stable-audio-open-1.0', name: 'Stable Audio Open 1.0' }],
  /* Wan 2.2 TI2V 5B : 24 images/s, 1 à 5 s (2 s en environ 2 min 30 sur le GB10, mesuré le 2026-11-08) ; image de départ
     possible (--first-frame), pas d'image de fin */
  video: [{ id: 'wan2.2-ti2v-5b', name: 'Wan 2.2 TI2V 5B', spec: { ratios: ['16:9', '9:16', '1:1'], seconds: /** @type {[number, number]} */ ([1, 5]), frames: true } }],
};
/** la taille native de Wan 2.2 TI2V par format (multiples de 32) */
const VIDEO_SIZE = /** @type {Record<string, [number, number]>} */ ({ '16:9': [1280, 704], '9:16': [704, 1280], '1:1': [960, 960] });
/** les voix de higgs : id, nom, langue, genre (inventaire du 2026-11-08) */
const VOICES = /** @type {[string, string, string, 'm' | 'f'][]} */ ([
  ['amine', 'Amine', 'fr', 'm'], ['bilal', 'Bilal', 'fr', 'm'], ['mehdi', 'Mehdi', 'fr', 'm'], ['younes', 'Younes', 'fr', 'm'],
  ['hanae', 'Hanae', 'fr', 'f'], ['rim', 'Rim', 'fr', 'f'], ['salma', 'Salma', 'fr', 'f'],
  ['hamza', 'Hamza', 'ar', 'm'], ['khalid', 'Khalid', 'ar', 'm'], ['tariq', 'Tariq', 'ar', 'm'],
  ['layla', 'Layla', 'ar', 'f'], ['maryam', 'Maryam', 'ar', 'f'], ['sana', 'Sana', 'ar', 'f'],
]);
const VOICE_LANGUAGE = Object.fromEntries(VOICES.map(([id, , lang]) => [id, lang]));

/** Une requête à un service du DGX ; une réponse en erreur devient une phrase. */
async function ask(/** @type {string} */ url, /** @type {RequestInit} */ init, /** @type {AbortSignal} */ signal) {
  let res;
  try { res = await fetch(url, { ...init, signal }); } catch (e) {
    throw new Error(`${NAME} : ${new URL(url).host} ne répond pas (${/** @type {Error} */ (e).message}).`);
  }
  if (!res.ok) throw new Error(`${NAME} : ${new URL(url).pathname} a répondu ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Un graphe ComfyUI exécuté jusqu'à son fichier de sortie (image ou son) : ses octets et son nom. */
async function comfy(/** @type {Record<string, unknown>} */ graph, /** @type {'images' | 'audio'} */ kind, /** @type {import('/opt/openfilm/packages/openfilm/studio/server/providers/contract.mjs').RunContext} */ ctx) {
  const sent = /** @type {any} */ (await (await ask(`${COMFY}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph }) }, ctx.signal)).json());
  const id = String(sent?.prompt_id ?? '');
  if (!id) throw new Error(`${NAME} : ComfyUI n'a pas accepté le travail (${JSON.stringify(sent).slice(0, 200)}).`);
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    if (ctx.signal.aborted) throw new Error('arrêté');
    const history = /** @type {any} */ (await (await ask(`${COMFY}/history/${id}`, {}, ctx.signal)).json())?.[id];
    if (history?.status?.status_str === 'error') throw new Error(`${NAME} : ComfyUI a échoué (${JSON.stringify(history.status.messages ?? '').slice(0, 300)}).`);
    for (const out of Object.values(history?.outputs ?? {})) {
      const file = /** @type {any} */ (out)?.[kind]?.[0];
      if (file?.filename) {
        const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
        const bytes = new Uint8Array(await (await ask(`${COMFY}/view?${q}`, {}, ctx.signal)).arrayBuffer());
        return { bytes, name: String(file.filename) };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${NAME} : ComfyUI n'a pas fini en 15 minutes.`);
}

const seed = () => Math.floor(Math.random() * 2 ** 31);

/** @type {Provider} */
export default {
  id: 'dgx',
  name: NAME,
  env: 'OPENFILM_DGX',
  keysUrl: 'https://film.ai-mpower.com',
  billingUrl: 'https://film.ai-mpower.com',
  verbs: ['voice', 'tts', 'asr', 'image', 'music', 'sfx', 'video'],
  models: MODELS,
  /* aucune clé : les services sont sur la machine même ; connecté tant que Studio tourne sur le DGX */
  ready: () => true,
  async run(verb, args, ctx) {
    if (verb === 'voice') {
      const language = text(args.language).toLowerCase().slice(0, 2);
      const gender = text(args.gender).toLowerCase().slice(0, 1);
      const limit = clamp(Math.round(number(args.limit) ?? 13), 1, 100);
      const voices = VOICES.filter(([, , l, g]) => (!language || l === language) && (!gender || g === gender)).slice(0, limit)
        .map(([id, name, l, g]) => ({ voiceId: id, name, language: l, gender: g, description: null }));
      return { files: [], index: [], receipt: { provider: 'dgx', voices, ...notes(text(args.prompt) ? ['--prompt ne filtre pas les voix du DGX'] : []) } };
    }
    if (verb === 'tts') {
      const voice = needed(args, 'voice');
      const said = needed(args, 'text');
      const model = modelOf(MODELS, 'tts', ctx);
      const path = landing('audio/vo', args.out, 'wav');
      const res = await ask(`${TTS}/v1/audio/speech`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: said, voice, language: VOICE_LANGUAGE[voice] ?? 'fr', response_format: 'wav' }),
      }, ctx.signal);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const dur = wavSeconds(bytes);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, voice, provider: 'dgx', model } }],
        receipt: { provider: 'dgx', model, src: path, dur, voice, notes: ['pas d\'horodatage des mots : les sous-titres répartissent le texte sur la ligne'] },
        cost: { note: 'gratuit, sur le DGX' },
      };
    }
    if (verb === 'asr') {
      const src = needed(args, 'src');
      const upload = await speechUpload(src, ctx);
      const model = modelOf(MODELS, 'asr', ctx);
      const form = new FormData();
      form.set('model', model);
      form.set('file', upload.blob, upload.name);
      form.set('response_format', 'verbose_json');
      const body = /** @type {any} */ (await (await ask(`${ASR}/v1/audio/transcriptions`, { method: 'POST', body: form }, ctx.signal)).json());
      const words = (Array.isArray(body?.words) ? body.words : [])
        .filter((/** @type {any} */ w) => Number.isFinite(w?.start) && text(w.word))
        .map((/** @type {any} */ w) => ({ token: text(w.word), start: w.start, end: Number.isFinite(w.end) ? w.end : w.start }));
      const said = text(body?.text);
      return {
        files: [],
        index: [{ src, ...(Number.isFinite(body?.duration) ? { dur: round(body.duration) } : {}), text: said, words, transcribed: true }],
        receipt: { provider: 'dgx', model, src, text: said, words: words.length },
        cost: { note: 'gratuit, sur le DGX' },
      };
    }
    if (verb === 'image') {
      const prompt = needed(args, 'prompt');
      const model = modelOf(MODELS, 'image', ctx);
      const { width, height } = pictureSize(text(args.ratio) || '16:9', '') ?? { width: 1024, height: 576 };
      const w = Math.round(width / 16) * 16;
      const h = Math.round(height / 16) * 16;
      const graph = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-schnell-fp8.safetensors' } },
        2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
        4: { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: seed(), steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1.0 } },
        6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'openfilm' } },
      };
      const made = await comfy(graph, 'images', ctx);
      const path = landing('images', args.out, 'png');
      return madePicture({ path, bytes: made.bytes, prompt, provider: 'dgx', model, notes: [] });
    }
    if (verb === 'music') {
      const prompt = needed(args, 'prompt');
      const model = modelOf(MODELS, 'music', ctx);
      const sec = clamp(number(args.sec) ?? 30, 5, 240);
      const graph = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ace_step_1.5_turbo_aio.safetensors' } },
        2: { class_type: 'TextEncodeAceStepAudio1.5', inputs: { clip: ['1', 1], tags: prompt, lyrics: '[Instrumental]', seed: seed(), bpm: 120, duration: sec, timesignature: '4', language: 'en', keyscale: 'C major', generate_audio_codes: true, cfg_scale: 2.0, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0.0 } },
        3: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['2', 0] } },
        4: { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: sec, batch_size: 1 } },
        5: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: seed(), steps: 8, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1.0 } },
        6: { class_type: 'VAEDecodeAudio', inputs: { samples: ['5', 0], vae: ['1', 2] } },
        7: { class_type: 'SaveAudio', inputs: { audio: ['6', 0], filename_prefix: 'openfilm' } },
      };
      const made = await comfy(graph, 'audio', ctx);
      const path = landing('audio/music', args.out, 'flac');
      return {
        files: [{ path, bytes: made.bytes }],
        index: [{ src: path, kind: 'audio', dur: sec, from: { mode: 'music', prompt, provider: 'dgx', model } }],
        receipt: { provider: 'dgx', model, src: path, dur: sec },
        cost: { note: 'gratuit, sur le DGX' },
      };
    }
    if (verb === 'sfx') {
      const prompt = needed(args, 'prompt');
      const model = modelOf(MODELS, 'sfx', ctx);
      const sec = clamp(number(args.sec) ?? 5, 1, 47);
      const ckpts = /** @type {any} */ (await (await ask(`${COMFY}/object_info/CheckpointLoaderSimple`, {}, ctx.signal)).json())?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
      if (!ckpts.includes('stable-audio-open-1.0.safetensors')) {
        throw new Error(`${NAME} : le modèle d'effets sonores n'est pas encore sur le DGX (lancer ~/openfilm-docker/telecharger-stable-audio.sh sur spark-1540).`);
      }
      const graph = {
        1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stable-audio-open-1.0.safetensors' } },
        2: { class_type: 'CLIPLoader', inputs: { clip_name: 't5_base.safetensors', type: 'stable_audio' } },
        3: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
        4: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
        5: { class_type: 'ConditioningStableAudio', inputs: { positive: ['3', 0], negative: ['4', 0], seconds_start: 0, seconds_total: sec } },
        6: { class_type: 'EmptyLatentAudio', inputs: { seconds: sec, batch_size: 1 } },
        7: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: seed(), steps: 50, cfg: 4.98, sampler_name: 'dpmpp_3m_sde_gpu', scheduler: 'exponential', positive: ['5', 0], negative: ['5', 1], latent_image: ['6', 0], denoise: 1.0 } },
        8: { class_type: 'VAEDecodeAudio', inputs: { samples: ['7', 0], vae: ['1', 2] } },
        9: { class_type: 'SaveAudio', inputs: { audio: ['8', 0], filename_prefix: 'openfilm-sfx' } },
      };
      const made = await comfy(graph, 'audio', ctx);
      const path = landing('audio/sfx', args.out, 'flac');
      return {
        files: [{ path, bytes: made.bytes }],
        index: [{ src: path, kind: 'audio', dur: sec, from: { mode: 'sfx', prompt, provider: 'dgx', model } }],
        receipt: { provider: 'dgx', model, src: path, dur: sec },
        cost: { note: 'gratuit, sur le DGX' },
      };
    }
    if (verb === 'video') {
      const prompt = needed(args, 'prompt');
      const model = modelOf(MODELS, 'video', ctx);
      const ratio = text(args['aspect-ratio']) || '16:9';
      const [width, height] = VIDEO_SIZE[ratio] ?? VIDEO_SIZE['16:9'];
      const sec = clamp(number(args.duration) ?? 3, 1, 5);
      /* Wan prend 4n + 1 images */
      const length = Math.round((sec * 24) / 4) * 4 + 1;
      const said = /** @type {string[]} */ ([]);
      if (text(args['last-frame'])) said.push('Wan 2.2 TI2V ne prend pas d\'image de fin : --last-frame ignoré');
      /** @type {Record<string, unknown>} */
      const latent = { vae: ['3', 0], width, height, length, batch_size: 1 };
      /** @type {Record<string, unknown>} */
      const graph = {
        1: { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
        2: { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' } },
        3: { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
        4: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8.0 } },
        5: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
        6: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, distorted, watermark, text', clip: ['2', 0] } },
        7: { class_type: 'Wan22ImageToVideoLatent', inputs: latent },
        /* euler : uni_pc passe par cuSOLVER, qui ne s'initialise pas sur le GB10 (mesuré le 2026-11-08) */
        8: { class_type: 'KSampler', inputs: { model: ['4', 0], seed: seed(), steps: 20, cfg: 5.0, sampler_name: 'euler', scheduler: 'simple', positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0], denoise: 1.0 } },
        9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
        10: { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: 24.0 } },
        11: { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'openfilm', format: 'auto', codec: 'auto' } },
      };
      const first = text(args['first-frame']);
      if (first) {
        /* l'image de départ, déposée chez ComfyUI puis chargée dans le graphe */
        const form = new FormData();
        form.set('image', new Blob([await ctx.read(first)]), `openfilm-${Date.now()}-${first.split('/').pop()}`);
        form.set('overwrite', 'true');
        const up = /** @type {any} */ (await (await ask(`${COMFY}/upload/image`, { method: 'POST', body: form }, ctx.signal)).json());
        graph[12] = { class_type: 'LoadImage', inputs: { image: String(up?.name ?? '') } };
        latent.start_image = ['12', 0];
      }
      ctx.say(`Wan 2.2 sur le DGX : ${sec} s en ${width}×${height}, compter environ ${Math.ceil(sec * 75 / 60)} min`);
      const made = await comfy(graph, 'images', ctx);
      const path = landing('video', args.out, 'mp4');
      return {
        files: [{ path, bytes: made.bytes }],
        index: [{ src: path, kind: 'video', dur: round((length - 1) / 24), w: width, h: height, from: { mode: 'generate', prompt, provider: 'dgx', model } }],
        receipt: { provider: 'dgx', model, src: path, dur: round((length - 1) / 24), width, height, ...notes(said) },
        cost: { note: 'gratuit, sur le DGX' },
      };
    }
    throw new Error(`${NAME} ne fait pas ${verb}.`);
  },
};
