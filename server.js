#!/usr/bin/env node
/**
 * ClawBridge — Claude Code Web Bridge
 * يشغّل واجهة المتصفح ويربطها بـ Claude Code في Termux
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os   = require('os');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT     = process.env.CBW_PORT || 7979;
const UI_FILE  = path.join(__dirname, 'index.html');
const CFG_DIR    = path.join(os.homedir(), '.clawbridge');
const LOG_FILE   = path.join(CFG_DIR, 'webbridge.log');
const CFG_FILE   = path.join(CFG_DIR, '.env');
const UPLOAD_DIR = path.join(CFG_DIR, 'uploads');
const MAX_UPLOAD = 300 * 1024 * 1024; // 300 MB

// Ensure dirs
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

// ── Load .env config ─────────────────────────────────────────────────────────
function loadEnv() {
  const cfg = {};
  try {
    fs.readFileSync(CFG_FILE, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
  return cfg;
}

// ── Chat sessions (direct platform API: OpenAI-compatible + Anthropic) ────────
const sessions = {};   // id -> { id, cfg, messages[], output[], clients:Set, busy }
let sessionCounter = 0;

function createSession(cfg) {
  const id = `session_${++sessionCounter}_${Date.now()}`;
  sessions[id] = { id, cfg: cfg || {}, messages: [], output: [], clients: new Set(), busy: false };
  log(`Session ${id} created`);
  return id;
}

// Store an output entry and broadcast it to all connected SSE clients.
function pushEntry(session, type, data) {
  const entry = { type, data, ts: Date.now() };
  session.output.push(entry);
  if (session.output.length > 4000) session.output.shift();
  session.clients.forEach(res => {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (_) {}
  });
}

// Low-level: POST a JSON body and deliver the response stream line-by-line.
function postStream(urlStr, headers, bodyObj, cbs) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return cbs.onError(e); }
  const lib = u.protocol === 'http:' ? require('http') : require('https');
  const data = Buffer.from(JSON.stringify(bodyObj));
  const req = lib.request(u, {
    method: 'POST',
    headers: { ...headers, 'Content-Length': data.length },
    timeout: 180000,
  }, res => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      let err = ''; res.on('data', d => err += d);
      res.on('end', () => cbs.onError(new Error('HTTP ' + res.statusCode + ': ' + err.slice(0, 400)), res.statusCode));
      return;
    }
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        cbs.onLine(line);
      }
    });
    res.on('end', () => { if (buf) cbs.onLine(buf); cbs.onEnd(); });
    res.on('error', e => cbs.onError(e));
  });
  req.on('error', e => cbs.onError(e));
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.write(data); req.end();
}

// High-level: stream a chat reply from the configured platform.
// Auto-detects OpenAI-compatible vs Anthropic and falls back to the other
// protocol if the preferred one fails before producing any tokens.
function runChat(cfg, messages, { onToken, onDone, onError }) {
  const apiKey = (cfg.apiKey || '').trim();
  const base   = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  const model  = (cfg.model || '').trim();
  if (!apiKey) return onError(new Error('المفتاح غير مضبوط'));
  if (!model)  return onError(new Error('اختر نموذجاً أولاً'));

  const preferAnthropic = !base || /anthropic\.com/i.test(base);

  const callOpenAI = (onFail) => {
    const url = (/\/v1$/.test(base) ? base : base + '/v1') + '/chat/completions';
    let started = false;
    postStream(url,
      { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      { model, messages, stream: true },
      {
        onLine: line => {
          const s = line.trim();
          if (!s.startsWith('data:')) return;
          const p = s.slice(5).trim();
          if (p === '[DONE]') return;
          try {
            const j = JSON.parse(p);
            const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (t) { started = true; onToken(t); }
          } catch (_) {}
        },
        onEnd: () => { if (started) onDone(); else if (onFail) onFail(new Error('لا رد من المنصة')); else onDone(); },
        onError: (e) => { if (!started && onFail) onFail(e); else onError(e); },
      });
  };

  const callAnthropic = (onFail) => {
    const b = /\/v1$/.test(base) ? base.replace(/\/v1$/, '') : (base || 'https://api.anthropic.com');
    const url = b + '/v1/messages';
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const msgs = messages.filter(m => m.role !== 'system');
    let started = false;
    postStream(url,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      Object.assign({ model, max_tokens: 4096, stream: true, messages: msgs }, sys ? { system: sys } : {}),
      {
        onLine: line => {
          const s = line.trim();
          if (!s.startsWith('data:')) return;
          const p = s.slice(5).trim();
          try {
            const j = JSON.parse(p);
            if (j.type === 'content_block_delta' && j.delta && j.delta.text) { started = true; onToken(j.delta.text); }
          } catch (_) {}
        },
        onEnd: () => { if (started) onDone(); else if (onFail) onFail(new Error('لا رد من المنصة')); else onDone(); },
        onError: (e) => { if (!started && onFail) onFail(e); else onError(e); },
      });
  };

  if (preferAnthropic) callAnthropic(() => callOpenAI(null));
  else                 callOpenAI(() => callAnthropic(null));
}

// ── HTTP Router ──────────────────────────────────────────────────────────────
function router(req, res) {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path_ = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ── GET / — serve UI ──
  if (method === 'GET' && path_ === '/') {
    try {
      const html = fs.readFileSync(UI_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500); return res.end('UI file not found: ' + UI_FILE);
    }
  }

  // ── GET /logo.png — serve app icon ──
  if (method === 'GET' && (path_ === '/logo.png' || path_ === '/favicon.ico')) {
    try {
      const img = fs.readFileSync(path.join(__dirname, 'logo.png'));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(img);
    } catch (e) {
      res.writeHead(404); return res.end('logo not found');
    }
  }

  // ── POST /upload — stream large file to disk (up to 300MB, any type) ──
  if (method === 'POST' && path_ === '/upload') {
    const rawName = decodeURIComponent(
      url.searchParams.get('name') || req.headers['x-filename'] || 'upload.bin'
    );
    const safe = (rawName.replace(/[\/\\]/g, '_')
      .replace(/[^\w.\-() ؀-ۿ]/g, '_')
      .slice(0, 180)) || 'upload.bin';
    const dest = path.join(UPLOAD_DIR, `${Date.now()}_${safe}`);
    const ws = fs.createWriteStream(dest);
    let size = 0, aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        aborted = true;
        ws.destroy();
        try { fs.unlinkSync(dest); } catch (_) {}
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'الملف أكبر من 300MB (الحد الأقصى)' }));
        req.destroy();
        return;
      }
      if (ws.write(chunk) === false) {
        req.pause();
        ws.once('drain', () => req.resume());
      }
    });
    req.on('end', () => { if (!aborted) ws.end(); });
    req.on('error', () => { if (!aborted) { aborted = true; ws.destroy(); } });
    ws.on('finish', () => {
      if (aborted) return;
      log(`Uploaded ${dest} (${size} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: dest, name: safe, size }));
    });
    ws.on('error', () => {
      if (aborted) return;
      aborted = true;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'فشل حفظ الملف' }));
    });
    return;
  }

  // ── POST /models — discover available models from the platform ──
  if (method === 'POST' && path_ === '/models') {
    return readBody(req, body => {
      let cfg;
      try { cfg = JSON.parse(body || '{}'); }
      catch (e) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'bad request' })); }
      const env = loadEnv();
      const apiKey  = cfg.apiKey || env.ANTHROPIC_API_KEY || '';
      const baseUrl = (cfg.baseUrl || env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '');
      if (!apiKey) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'المفتاح مطلوب' })); }

      const isAnthropic = !baseUrl || /anthropic\.com/i.test(baseUrl);
      const candidates = [];
      if (isAnthropic) {
        const base = (baseUrl || 'https://api.anthropic.com').replace(/\/v1$/, '');
        candidates.push({ url: base + '/v1/models', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
      } else {
        const bearer = { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
        if (/\/v1$/.test(baseUrl)) candidates.push({ url: baseUrl + '/models', headers: bearer });
        else {
          candidates.push({ url: baseUrl + '/v1/models', headers: bearer });
          candidates.push({ url: baseUrl + '/models', headers: bearer });
        }
      }
      let i = 0;
      const tryNext = () => {
        if (i >= candidates.length) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'تعذّر جلب النماذج من المنصة' }));
        }
        const c = candidates[i++];
        httpJson(c.url, c.headers, (err, json) => {
          if (err || !json) return tryNext();
          const arr = json.data || json.models || [];
          const list = arr.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
          if (!list.length) return tryNext();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, models: list }));
        });
      };
      tryNext();
    });
  }

  // ── GET /status ──
  if (method === 'GET' && path_ === '/status') {
    const env = loadEnv();
    const hasKey = !!(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      server: 'ClawBridge v1.0',
      claude_available: isClaudeAvailable(),
      api_key_set: hasKey,
      sessions: Object.keys(sessions).length,
      active: Object.values(sessions).filter(s => s.busy).length,
    }));
  }

  // ── POST /config — save API config to .env ──
  if (method === 'POST' && path_ === '/config') {
    return readBody(req, body => {
      try {
        const cfg = JSON.parse(body);
        const lines = [];
        if (cfg.baseUrl) lines.push(`ANTHROPIC_BASE_URL=${cfg.baseUrl}`);
        if (cfg.apiKey)  lines.push(`ANTHROPIC_API_KEY=${cfg.apiKey}`);
        if (cfg.model)   lines.push(`ANTHROPIC_MODEL=${cfg.model}`);
        fs.writeFileSync(CFG_FILE, lines.join('\n') + '\n');
        log('Config saved to ' + CFG_FILE);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Config saved' }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  }

  // ── POST /session/new — start new claude session ──
  if (method === 'POST' && path_ === '/session/new') {
    return readBody(req, body => {
      try {
        const req_cfg = JSON.parse(body || '{}');
        const env_cfg = loadEnv();
        const cfg = {
          apiKey:  req_cfg.apiKey  || env_cfg.ANTHROPIC_API_KEY  || '',
          baseUrl: req_cfg.baseUrl || env_cfg.ANTHROPIC_BASE_URL || '',
          model:   req_cfg.model   || env_cfg.ANTHROPIC_MODEL    || '',
          workdir: req_cfg.workdir || os.homedir(),
        };
        if (!cfg.apiKey) {
          res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'API key not set. Configure it first.' }));
        }
        const id = createSession(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, session_id: id }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  }

  // ── GET /session/:id/stream — SSE stream ──
  const streamMatch = path_.match(/^\/session\/([^/]+)\/stream$/);
  if (method === 'GET' && streamMatch) {
    const id = streamMatch[1];
    const session = sessions[id];
    if (!session) { res.writeHead(404); return res.end('Session not found'); }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send history
    session.output.forEach(entry => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    session.clients.add(res);
    req.on('close', () => session.clients.delete(res));
    return;
  }

  // ── POST /session/:id/input — send a user message; stream the reply ──
  const inputMatch = path_.match(/^\/session\/([^/]+)\/input$/);
  if (method === 'POST' && inputMatch) {
    const id = inputMatch[1];
    const session = sessions[id];
    if (!session) {
      res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'الجلسة غير موجودة' }));
    }
    return readBody(req, body => {
      let text;
      try { text = (JSON.parse(body) || {}).text; }
      catch (e) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'bad request' })); }
      if (!text || !text.trim()) {
        res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'رسالة فارغة' }));
      }

      // Prefer the latest saved settings (so changing model/platform applies
      // immediately), then fall back to the session's original config.
      const env = loadEnv();
      const cfg = {
        apiKey:  env.ANTHROPIC_API_KEY  || session.cfg.apiKey  || '',
        baseUrl: env.ANTHROPIC_BASE_URL || session.cfg.baseUrl || '',
        model:   env.ANTHROPIC_MODEL    || session.cfg.model   || '',
      };

      // Record + echo the user's message, then ack the POST immediately.
      session.messages.push({ role: 'user', content: text });
      pushEntry(session, 'user', text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      if (session.busy) { pushEntry(session, 'system', '[انتظر — يوجد رد قيد التوليد]'); return; }
      session.busy = true;
      let acc = '';
      pushEntry(session, 'assistant_start', '');
      runChat(cfg, session.messages, {
        onToken: t => { acc += t; pushEntry(session, 'assistant', t); },
        onDone: () => {
          session.messages.push({ role: 'assistant', content: acc });
          pushEntry(session, 'assistant_done', '');
          session.busy = false;
        },
        onError: e => {
          // roll back the failed turn so the next try starts clean
          if (session.messages[session.messages.length - 1]?.role === 'user') session.messages.pop();
          pushEntry(session, 'error', 'تعذّر الاتصال بالمنصة: ' + e.message);
          pushEntry(session, 'assistant_done', '');
          session.busy = false;
        },
      });
    });
  }

  // ── GET /session/:id/info ──
  const infoMatch = path_.match(/^\/session\/([^/]+)\/info$/);
  if (method === 'GET' && infoMatch) {
    const id = infoMatch[1];
    const session = sessions[id];
    if (!session) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id, busy: session.busy, turns: session.messages.length }));
  }

  // ── GET /sessions — list all ──
  if (method === 'GET' && path_ === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(
      Object.values(sessions).map(s => ({ id: s.id, busy: s.busy, turns: s.messages.length }))
    ));
  }

  // ── POST /session/:id/kill — drop a session ──
  const killMatch = path_.match(/^\/session\/([^/]+)\/kill$/);
  if (method === 'POST' && killMatch) {
    const session = sessions[killMatch[1]];
    if (session) { session.clients.forEach(r => { try { r.end(); } catch (_) {} }); delete sessions[killMatch[1]]; }
    res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404); res.end('Not found');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function readBody(req, cb) {
  let data = '';
  req.on('data', c => data += c);
  req.on('end', () => cb(data));
}

// GET a JSON endpoint (used to discover models on the configured platform)
function httpJson(urlStr, headers, cb) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return cb(e); }
  const lib = u.protocol === 'http:' ? require('http') : require('https');
  const req = lib.request(u, { method: 'GET', headers, timeout: 20000 }, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try { cb(null, JSON.parse(data)); }
        catch (e) { cb(new Error('bad JSON')); }
      } else {
        cb(new Error('HTTP ' + res.statusCode));
      }
    });
  });
  req.on('error', cb);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.end();
}

function isClaudeAvailable() {
  try { execSync('which claude', { stdio: 'ignore' }); return true; } catch (_) { return false; }
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── Start ────────────────────────────────────────────────────────────────────
const server = http.createServer(router);
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const env = loadEnv();
  const hasKey = !!(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║            ClawBridge — Claude Code Web Bridge        ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  ✅  Server running                                   ║`);
  console.log(`║                                                        ║`);
  console.log(`║  📱  من نفس الهاتف:                                   ║`);
  console.log(`║      http://localhost:${PORT}                           ║`);
  console.log(`║                                                        ║`);
  console.log(`║  🌐  من أي جهاز على نفس الشبكة:                      ║`);
  console.log(`║      http://${ip}:${PORT}                        ║`);
  console.log(`║                                                        ║`);
  console.log(`║  🔑  API Key: ${hasKey ? '✅ محفوظ' : '❌ غير مضبوط — اضبطه من الواجهة'}             ║`);
  console.log(`║  🤖  Claude: ${isClaudeAvailable() ? '✅ متاح' : '⚠️  غير موجود في PATH'}                       ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('\n  افتح الرابط في المتصفح وابدأ\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ البورت ${PORT} مشغول. شغّل: CBW_PORT=7980 node server.js\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
