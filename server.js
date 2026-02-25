import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const PORT = 8080;
const DATA_DIR = '/data/shares';
const HTML = readFileSync('./index.html', 'utf8');

// ===== Environment =====
const RUNPOD_KEY = process.env.RUNPOD_API_KEY || '';
const NEMOTRON_EP = process.env.NEMOTRON_ENDPOINT || '';
const COSY_EP = process.env.COSYVOICE_ENDPOINT || '';
const STT_EP = process.env.STT_ENDPOINT || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ===== Logger =====
function log(level, route, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    route,
    msg,
    ...meta,
  };
  console.log(JSON.stringify(entry));
}

// Startup config check
log('info', 'startup', 'Server initializing', {
  nemotron: NEMOTRON_EP ? `${NEMOTRON_EP.slice(0, 6)}...` : 'NOT SET',
  cosyvoice: COSY_EP ? `${COSY_EP.slice(0, 6)}...` : 'NOT SET',
  stt: STT_EP ? `${STT_EP.slice(0, 6)}...` : 'NOT SET',
  runpod_key: RUNPOD_KEY ? 'SET' : 'NOT SET',
  admin_key: ADMIN_KEY ? 'SET' : 'NOT SET',
});

// ===== API Key Store =====
const API_KEYS_FILE = '/data/api_keys.json';
function loadApiKeys() {
  if (!existsSync(API_KEYS_FILE)) return {};
  try { return JSON.parse(readFileSync(API_KEYS_FILE, 'utf8')); } catch { return {}; }
}
function saveApiKeys(keys) { writeFileSync(API_KEYS_FILE, JSON.stringify(keys, null, 2)); }

// ===== Rate Limiter (sliding window) =====
const rateLimits = new Map();
const RATE_WINDOW = 60_000;
const RATE_MAX = 60;

function checkRateLimit(key) {
  const now = Date.now();
  let ts = rateLimits.get(key);
  if (!ts) { ts = []; rateLimits.set(key, ts); }
  while (ts.length && ts[0] <= now - RATE_WINDOW) ts.shift();
  if (ts.length >= RATE_MAX) return false;
  ts.push(now);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of rateLimits) {
    while (ts.length && ts[0] <= now - RATE_WINDOW) ts.shift();
    if (!ts.length) rateLimits.delete(key);
  }
}, 60_000);

// ===== Helpers =====
function genId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += c[Math.floor(Math.random() * c.length)];
  return id;
}

function genApiKey() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let k = 'nmt_';
  for (let i = 0; i < 24; i++) k += c[Math.floor(Math.random() * c.length)];
  return k;
}

const HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ===== RunPod helpers =====
async function runpodPoll(endpointId, jobId, intervalMs, maxMs) {
  const t0 = Date.now();
  const deadline = t0 + maxMs;
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    polls++;
    const res = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
      headers: { 'Authorization': `Bearer ${RUNPOD_KEY}` },
    });
    const data = await res.json();
    if (data.status === 'COMPLETED') {
      log('info', 'runpod', 'Job completed', { jobId, polls, ms: Date.now() - t0 });
      return data.output;
    }
    if (data.status === 'FAILED') {
      log('error', 'runpod', 'Job failed', { jobId, polls, ms: Date.now() - t0, error: data.error });
      throw new Error(data.error || JSON.stringify(data.output) || 'Job failed');
    }
  }
  log('error', 'runpod', 'Job timeout', { jobId, polls, ms: Date.now() - t0 });
  throw new Error('Timeout');
}

// ===================================================================
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health
    if (path === '/health') return Response.json({ status: 'ok' });

    // ===== CORS preflight for /v1/* =====
    if (req.method === 'OPTIONS' && path.startsWith('/v1/')) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ===== /api/warmup — Pre-warm Nemotron worker =====
    if (path === '/api/warmup' && req.method === 'GET') {
      if (!RUNPOD_KEY || !NEMOTRON_EP) return Response.json({ status: 'not_configured' });
      try {
        const res = await fetch(`https://api.runpod.ai/v2/${NEMOTRON_EP}/health`, {
          headers: { 'Authorization': `Bearer ${RUNPOD_KEY}` },
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json();
        const ready = (data.workers?.idle ?? 0) + (data.workers?.ready ?? 0) + (data.workers?.running ?? 0);
        const initializing = data.workers?.initializing ?? 0;
        const inQueue = data.jobs?.inQueue ?? 0;
        log('info', '/api/warmup', 'Health', { ready, initializing, inQueue });
        return Response.json({ ready, initializing, inQueue }, { headers: CORS_HEADERS });
      } catch (e) {
        return Response.json({ ready: 0, initializing: 0, inQueue: 0, error: e.message }, { headers: CORS_HEADERS });
      }
    }

    // ===== /api/chat — RunPod Nemotron with Claude fallback =====
    if (path === '/api/chat' && req.method === 'POST') {
      const t0 = Date.now();
      const body = await req.text();
      const parsed = JSON.parse(body);
      const msgCount = parsed.messages?.length || 0;
      log('info', '/api/chat', 'Request', { messages: msgCount, max_tokens: parsed.max_tokens });

      // Try RunPod first (20s fast timeout — skip if clearly unavailable)
      if (RUNPOD_KEY && NEMOTRON_EP) {
        try {
          const upstream = `https://api.runpod.ai/v2/${NEMOTRON_EP}/openai/v1/chat/completions`;
          const chatRes = await fetch(upstream, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RUNPOD_KEY}`, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(20_000),
          });
          if (chatRes.ok) {
            log('info', '/api/chat', 'RunPod OK', { ms: Date.now() - t0 });
            return new Response(chatRes.body, {
              status: chatRes.status,
              headers: { 'Content-Type': chatRes.headers.get('Content-Type') || 'application/json', ...HEADERS },
            });
          }
        } catch (e) {
          log('warn', '/api/chat', 'RunPod failed, falling back to Claude', { error: e.message, ms: Date.now() - t0 });
        }
      }

      // OpenRouter fallback (Gemini 2.0 Flash — fast Japanese support)
      if (!OPENROUTER_KEY) {
        return Response.json({ error: 'AI service unavailable' }, { status: 503 });
      }
      try {
        const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'google/gemini-2.0-flash-001',
            max_tokens: parsed.max_tokens || 256,
            messages: parsed.messages || [],
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const data = await orRes.json();
        const content = data.choices?.[0]?.message?.content || '';
        log('info', '/api/chat', 'OpenRouter OK', { ms: Date.now() - t0 });
        return Response.json({
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          model: 'gemini-2.0-flash',
        }, { headers: HEADERS });
      } catch (e) {
        log('error', '/api/chat', 'OpenRouter failed', { error: e.message, ms: Date.now() - t0 });
        return Response.json({ error: e.message }, { status: 502 });
      }
    }

    // ===== /api/tts — Proxy to CosyVoice2 (run + poll) =====
    if (path === '/api/tts' && req.method === 'POST') {
      const t0 = Date.now();
      if (!RUNPOD_KEY || !COSY_EP) {
        log('warn', '/api/tts', 'Endpoint not configured');
        return Response.json({ error: 'TTS endpoint not configured' }, { status: 503 });
      }
      try {
        const body = await req.json();
        log('info', '/api/tts', 'Request', { mode: body.mode, textLen: body.text?.length });
        const runRes = await fetch(`https://api.runpod.ai/v2/${COSY_EP}/run`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RUNPOD_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: body }),
        });
        const data = await runRes.json();
        if (data.status === 'COMPLETED' && data.output) {
          log('info', '/api/tts', 'Completed (sync)', { ms: Date.now() - t0 });
          return Response.json(data.output);
        }
        if (!data.id) {
          log('error', '/api/tts', 'No job ID', { data });
          return Response.json({ error: 'No job ID' }, { status: 502 });
        }
        log('info', '/api/tts', 'Polling', { jobId: data.id });
        const output = await runpodPoll(COSY_EP, data.id, 3000, 180_000);
        log('info', '/api/tts', 'Completed (async)', { ms: Date.now() - t0 });
        return Response.json(output || {});
      } catch (e) {
        log('error', '/api/tts', 'Failed', { error: e.message, ms: Date.now() - t0 });
        return Response.json({ error: e.message }, { status: 502 });
      }
    }

    // ===== /api/stt — Proxy to RunPod faster-whisper (server-side key) =====
    if (path === '/api/stt' && req.method === 'POST') {
      const t0 = Date.now();
      if (!RUNPOD_KEY || !STT_EP) {
        log('warn', '/api/stt', 'Endpoint not configured');
        return Response.json({ error: 'STT endpoint not configured' }, { status: 503 });
      }
      try {
        const blob = await req.blob();
        const sizeKB = (blob.size / 1024).toFixed(1);
        log('info', '/api/stt', 'Request', { sizeKB });
        const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
        const runRes = await fetch(`https://api.runpod.ai/v2/${STT_EP}/runsync`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RUNPOD_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { audio_base64: base64, model: 'large-v3-turbo', language: 'ja', word_timestamps: false }
          }),
        });
        const data = await runRes.json();
        if (data.output?.text) {
          log('info', '/api/stt', 'Completed (sync)', { textLen: data.output.text.length, ms: Date.now() - t0 });
          return Response.json({ text: data.output.text });
        }
        if (data.id && data.status !== 'COMPLETED') {
          log('info', '/api/stt', 'Polling', { jobId: data.id });
          const output = await runpodPoll(STT_EP, data.id, 1000, 30_000);
          const text = output?.text || output?.transcription || '';
          log('info', '/api/stt', 'Completed (async)', { textLen: text.length, ms: Date.now() - t0 });
          return Response.json({ text });
        }
        const text = data.output?.text || data.output?.transcription || '';
        log('info', '/api/stt', 'Completed', { textLen: text.length, ms: Date.now() - t0 });
        return Response.json({ text });
      } catch (e) {
        log('error', '/api/stt', 'Failed', { error: e.message, ms: Date.now() - t0 });
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // ===== /api/music — Proxy to RunPod ACE-Step =====
    if (path === '/api/music' && req.method === 'POST') {
      const t0 = Date.now();
      try {
        const body = await req.json();
        const endpointId = req.headers.get('x-music-endpoint') || '';
        const apiKey = RUNPOD_KEY || '';
        if (!apiKey || !endpointId) {
          log('warn', '/api/music', 'Endpoint not configured');
          return Response.json({ error: 'Music endpoint not configured' }, { status: 400 });
        }
        const duration = Math.min(Math.max(Number(body.duration) || 30, 5), 120);
        log('info', '/api/music', 'Request', { prompt: String(body.prompt || '').slice(0, 80), duration });

        const runRes = await fetch(`https://api.runpod.ai/v2/${endpointId}/run`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: {
              prompt: String(body.prompt || '').slice(0, 500),
              duration,
              instrumental: body.instrumental !== false,
              format: 'mp3',
            }
          }),
        });
        const data = await runRes.json();
        if (data.output?.audio_base64) {
          log('info', '/api/music', 'Completed (sync)', { ms: Date.now() - t0 });
          return Response.json({ audio_base64: data.output.audio_base64, format: 'mp3' });
        }
        if (data.id) {
          log('info', '/api/music', 'Polling', { jobId: data.id });
          const output = await runpodPoll(endpointId, data.id, 2000, 240_000);
          log('info', '/api/music', 'Completed (async)', { ms: Date.now() - t0 });
          return Response.json({ audio_base64: output?.audio_base64 || '', format: 'mp3' });
        }
        return Response.json(data);
      } catch (e) {
        log('error', '/api/music', 'Failed', { error: e.message, ms: Date.now() - t0 });
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // ===== Public API: /v1/chat/completions =====
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const t0 = Date.now();
      const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const keyPrefix = auth ? auth.slice(0, 8) + '...' : 'none';
      if (!auth) {
        log('warn', '/v1/chat', 'Missing API key', { ip: req.headers.get('x-forwarded-for') });
        return Response.json(
          { error: { message: 'Missing API key. Include Authorization: Bearer nmt_...', type: 'authentication_error' } },
          { status: 401, headers: CORS_HEADERS },
        );
      }
      const keys = loadApiKeys();
      if (!keys[auth]) {
        log('warn', '/v1/chat', 'Invalid API key', { key: keyPrefix });
        return Response.json(
          { error: { message: 'Invalid API key', type: 'authentication_error' } },
          { status: 401, headers: CORS_HEADERS },
        );
      }
      if (!checkRateLimit(auth)) {
        log('warn', '/v1/chat', 'Rate limited', { key: keyPrefix, name: keys[auth].name });
        return Response.json(
          { error: { message: 'Rate limit exceeded (60 req/min)', type: 'rate_limit_error' } },
          { status: 429, headers: { ...CORS_HEADERS, 'Retry-After': '60' } },
        );
      }
      if (!RUNPOD_KEY || !NEMOTRON_EP) {
        log('warn', '/v1/chat', 'Endpoint not configured');
        return Response.json(
          { error: { message: 'Service temporarily unavailable', type: 'server_error' } },
          { status: 503, headers: CORS_HEADERS },
        );
      }
      try {
        const body = await req.text();
        const parsed = JSON.parse(body);
        log('info', '/v1/chat', 'Request', { key: keyPrefix, name: keys[auth].name, messages: parsed.messages?.length, max_tokens: parsed.max_tokens, stream: !!parsed.stream });
        const upstream = `https://api.runpod.ai/v2/${NEMOTRON_EP}/openai/v1/chat/completions`;
        const chatRes = await fetch(upstream, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RUNPOD_KEY}`, 'Content-Type': 'application/json' },
          body,
        });
        log('info', '/v1/chat', 'Response', { key: keyPrefix, status: chatRes.status, ms: Date.now() - t0 });
        return new Response(chatRes.body, {
          status: chatRes.status,
          headers: { 'Content-Type': chatRes.headers.get('Content-Type') || 'application/json', ...CORS_HEADERS },
        });
      } catch (e) {
        log('error', '/v1/chat', 'Failed', { key: keyPrefix, error: e.message, ms: Date.now() - t0 });
        return Response.json(
          { error: { message: e.message, type: 'server_error' } },
          { status: 502, headers: CORS_HEADERS },
        );
      }
    }

    // ===== Admin: create API key =====
    if (path === '/api/admin/keys' && req.method === 'POST') {
      if (!ADMIN_KEY) return Response.json({ error: 'Admin not configured' }, { status: 503 });
      if ((req.headers.get('x-admin-key') || '') !== ADMIN_KEY) {
        log('warn', '/api/admin', 'Unauthorized key creation attempt');
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      try {
        const body = await req.json().catch(() => ({}));
        const name = String(body.name || 'unnamed').slice(0, 50);
        const key = genApiKey();
        const keys = loadApiKeys();
        keys[key] = { name, created: new Date().toISOString() };
        saveApiKeys(keys);
        log('info', '/api/admin', 'API key created', { name, key: key.slice(0, 8) + '...' });
        return Response.json({ key, name });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // ===== Admin: list API keys =====
    if (path === '/api/admin/keys' && req.method === 'GET') {
      if (!ADMIN_KEY) return Response.json({ error: 'Admin not configured' }, { status: 503 });
      if ((req.headers.get('x-admin-key') || '') !== ADMIN_KEY) {
        log('warn', '/api/admin', 'Unauthorized key list attempt');
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const keys = loadApiKeys();
      const list = Object.entries(keys).map(([k, v]) => ({ key: k.slice(0, 8) + '...', ...v }));
      log('info', '/api/admin', 'Keys listed', { count: list.length });
      return Response.json(list);
    }

    // ===== Audio files (intro/pitch) =====
    const audioMatch = path.match(/^\/api\/audio\/(\w+)$/);
    if (audioMatch && req.method === 'GET') {
      const file = join('/data', `${audioMatch[1]}.webm`);
      if (!existsSync(file)) return new Response('', { status: 404 });
      return new Response(Bun.file(file), {
        headers: { 'Content-Type': 'audio/webm', 'Cache-Control': 'public, max-age=3600', ...HEADERS },
      });
    }
    if (audioMatch && req.method === 'POST') {
      const name = audioMatch[1];
      if (!['intro', 'pitch'].includes(name)) return Response.json({ error: 'invalid name' }, { status: 400 });
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 1_000_000) return Response.json({ error: 'too large' }, { status: 413 });
      writeFileSync(join('/data', `${name}.webm`), Buffer.from(buf));
      return Response.json({ ok: true, size: buf.byteLength });
    }

    // ===== BGM files =====
    const bgmMatch = path.match(/^\/api\/bgm\/(\w+)$/);
    if (bgmMatch && req.method === 'GET') {
      const file = join('/data/bgm', `${bgmMatch[1]}.mp3`);
      if (!existsSync(file)) return new Response('', { status: 404 });
      return new Response(Bun.file(file), {
        headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=3600', ...HEADERS },
      });
    }
    if (bgmMatch && req.method === 'POST') {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 5_000_000) return Response.json({ error: 'too large' }, { status: 413 });
      const bgmDir = join('/data', 'bgm');
      if (!existsSync(bgmDir)) mkdirSync(bgmDir, { recursive: true });
      writeFileSync(join(bgmDir, `${bgmMatch[1]}.mp3`), Buffer.from(buf));
      return Response.json({ ok: true, size: buf.byteLength });
    }

    // ===== Share =====
    if (path === '/api/share' && req.method === 'POST') {
      try {
        const body = await req.json();
        const id = genId();
        const share = {
          id,
          goal: String(body.goal || '').slice(0, 2000),
          prompt: String(body.prompt || '').slice(0, 5000),
          voice_ref: String(body.voice_ref || '').slice(0, 200_000),
          voice_prompt_text: String(body.voice_prompt_text || '').slice(0, 500),
          visibility: body.visibility === 'public' ? 'public' : 'unlisted',
          created_at: new Date().toISOString(),
          plays: 0,
        };
        writeFileSync(join(DATA_DIR, `${id}.json`), JSON.stringify(share));
        const origin = req.headers.get('x-forwarded-proto') === 'https'
          ? `https://${req.headers.get('host')}` : url.origin;
        log('info', '/api/share', 'Created', { id, visibility: share.visibility, hasVoice: !!body.voice_ref });
        return Response.json({ id, url: `${origin}/v/${id}` });
      } catch {
        return Response.json({ error: 'invalid request' }, { status: 400 });
      }
    }

    const shareMatch = path.match(/^\/api\/share\/([A-Za-z0-9]{8})$/);
    if (shareMatch && req.method === 'GET') {
      const file = join(DATA_DIR, `${shareMatch[1]}.json`);
      if (!existsSync(file)) return Response.json({ error: 'not found' }, { status: 404 });
      const share = JSON.parse(readFileSync(file, 'utf8'));
      share.plays++;
      writeFileSync(file, JSON.stringify(share));
      return Response.json(share);
    }

    if (path === '/api/shares/public' && req.method === 'GET') {
      try {
        const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
        const shares = files
          .map(f => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')))
          .filter(s => s.visibility === 'public')
          .sort((a, b) => b.plays - a.plays)
          .slice(0, 20)
          .map(({ voice_ref, voice_prompt_text, ...rest }) => rest);
        return Response.json(shares);
      } catch { return Response.json([]); }
    }

    // ===== Serve HTML =====
    if (path === '/' || path === '/chat' || /^\/v\/[A-Za-z0-9]{8}$/.test(path)) {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...HEADERS },
      });
    }

    return new Response('Not found', { status: 404 });
  },
});

log('info', 'startup', `Server running on :${PORT}`);
