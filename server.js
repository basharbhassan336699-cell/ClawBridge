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

// ── Active claude sessions ────────────────────────────────────────────────────
const sessions = {};   // id -> { proc, output[], input_cb }
let sessionCounter = 0;

function createSession(cfg) {
  const id = `session_${++sessionCounter}_${Date.now()}`;
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY:  cfg.apiKey  || process.env.ANTHROPIC_API_KEY  || '',
    ANTHROPIC_BASE_URL: cfg.baseUrl || process.env.ANTHROPIC_BASE_URL || '',
    ...(cfg.model ? { ANTHROPIC_MODEL: cfg.model } : {}),
    TERM: 'xterm-256color',
  };

  // Find claude binary
  let claudeBin = 'claude';
  try { claudeBin = execSync('which claude', { encoding: 'utf8' }).trim(); } catch (_) {}

  const proc = spawn(claudeBin, ['--no-color'], {
    env,
    cwd: cfg.workdir || os.homedir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session = { id, proc, output: [], clients: new Set(), alive: true };
  sessions[id] = session;

  const push = (type, data) => {
    const entry = { type, data, ts: Date.now() };
    session.output.push(entry);
    // keep last 2000 lines
    if (session.output.length > 2000) session.output.shift();
    session.clients.forEach(res => {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch (_) {}
    });
  };

  proc.stdout.on('data', d => push('stdout', d.toString()));
  proc.stderr.on('data', d => push('stderr', d.toString()));
  proc.on('close', code => {
    session.alive = false;
    push('system', `[session ended — exit code ${code}]`);
    log(`Session ${id} closed (exit ${code})`);
  });
  proc.on('error', err => {
    session.alive = false;
    push('system', `[error: ${err.message}]`);
    log(`Session ${id} error: ${err.message}`);
  });

  log(`Session ${id} started (pid ${proc.pid})`);
  return id;
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
      active: Object.values(sessions).filter(s => s.alive).length,
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

  // ── POST /session/:id/input — send text to claude ──
  const inputMatch = path_.match(/^\/session\/([^/]+)\/input$/);
  if (method === 'POST' && inputMatch) {
    const id = inputMatch[1];
    const session = sessions[id];
    if (!session || !session.alive) {
      res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: 'Session not found or ended' }));
    }
    return readBody(req, body => {
      try {
        const { text } = JSON.parse(body);
        session.proc.stdin.write(text + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  }

  // ── GET /session/:id/info ──
  const infoMatch = path_.match(/^\/session\/([^/]+)\/info$/);
  if (method === 'GET' && infoMatch) {
    const id = infoMatch[1];
    const session = sessions[id];
    if (!session) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id, alive: session.alive, lines: session.output.length }));
  }

  // ── GET /sessions — list all ──
  if (method === 'GET' && path_ === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(
      Object.values(sessions).map(s => ({ id: s.id, alive: s.alive, lines: s.output.length }))
    ));
  }

  // ── POST /session/:id/kill ──
  const killMatch = path_.match(/^\/session\/([^/]+)\/kill$/);
  if (method === 'POST' && killMatch) {
    const session = sessions[killMatch[1]];
    if (session && session.alive) { session.proc.kill(); }
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
