// proxy.js — Gaturrin
// Desarrollo: node proxy.js  →  http://localhost:3000
// Producción: variables de entorno TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_DEVICE_ID

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const url    = require('url');
const fs     = require('fs');

// Carga .env si existe (solo desarrollo local)
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq < 1 || line.trimStart().startsWith('#')) return;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  });
} catch {}

const PORT          = process.env.PORT || 3000;
const TUYA_HOST     = 'openapi.tuyaus.com';
const ACCESS_ID     = process.env.TUYA_ACCESS_ID;
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET;
const DEVICE_ID     = process.env.TUYA_DEVICE_ID;

if (!ACCESS_ID || !ACCESS_SECRET || !DEVICE_ID) {
  console.error('[Gaturrin] Faltan variables de entorno: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_DEVICE_ID');
  process.exit(1);
}

// ── Tuya API ──────────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex').toUpperCase();
}
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
function buildSign(t, tokenVal, method, tuyaPath, body) {
  const bodyHash  = sha256(body || '');
  const strToSign = [method, bodyHash, '', tuyaPath].join('\n');
  return hmacSha256(ACCESS_SECRET, ACCESS_ID + (tokenVal || '') + t + strToSign);
}
function tuyaRequest(method, tuyaPath, body) {
  return new Promise((resolve, reject) => {
    const t        = Date.now().toString();
    const bodyStr  = body ? JSON.stringify(body) : '';
    const tokenVal = tuyaPath.includes('/token') ? '' : (cachedToken || '');
    const sign     = buildSign(t, tokenVal, method, tuyaPath, bodyStr);
    const headers  = {
      'Content-Type': 'application/json',
      'client_id': ACCESS_ID, 't': t, 'sign': sign,
      'sign_method': 'HMAC-SHA256', 'lang': 'en',
    };
    if (tokenVal) headers['access_token'] = tokenVal;
    if (bodyStr)  headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: TUYA_HOST, path: tuyaPath, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Respuesta inválida: ' + data)); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return;
  const res = await tuyaRequest('GET', '/v1.0/token?grant_type=1');
  if (!res.success) throw new Error(res.msg || 'Error token');
  cachedToken = res.result.access_token;
  tokenExpiry = Date.now() + res.result.expire_time * 1000 - 60000;
  console.log('[Tuya] Token renovado');
}
function cmd(code, value) {
  return tuyaRequest('POST', '/v1.0/devices/' + DEVICE_ID + '/commands', { commands: [{ code, value }] });
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Gaturrin 🐾</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg:       #0f0e0d;
  --s1:       #1c1a17;
  --s2:       #242220;
  --border:   #332f2a;
  --accent:   #c8f04a;
  --teal:     #4af0c8;
  --amber:    #f0c84a;
  --text:     #f2ede6;
  --muted:    #7a7168;
  --danger:   #f04a6a;
  --r:        22px;
}
* { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
html { background:var(--bg); }
body {
  background:var(--bg); color:var(--text);
  font-family:'Syne',sans-serif;
  min-height:100vh;
  max-width:440px; margin:0 auto;
  padding:20px 16px env(safe-area-inset-bottom,24px);
}

/* ── Header ── */
header {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:20px; padding:0 2px;
}
.logo { font-size:20px; font-weight:800; letter-spacing:-0.5px; }
.logo .a { color:var(--accent); }
.conn { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--muted); }
.dot { width:7px; height:7px; border-radius:50%; background:var(--muted); transition:all .4s; flex-shrink:0; }
.dot.on { background:var(--teal); box-shadow:0 0 8px var(--teal); }

/* ── Hero card ── */
.hero {
  background:var(--s1); border:1.5px solid var(--border);
  border-radius:28px; padding:28px 20px 20px;
  margin-bottom:10px; text-align:center;
  transition:background .4s, border-color .4s;
}
.hero.cleaning  { background:#131e1a; border-color:rgba(74,240,200,.35); }
.hero.levelling { background:#1e1b10; border-color:rgba(240,200,74,.35); }

.hero-emoji {
  font-size:68px; line-height:1;
  margin-bottom:14px; display:block;
  transition:opacity .3s;
  filter:drop-shadow(0 4px 16px rgba(0,0,0,.4));
}
.hero-state {
  font-size:24px; font-weight:800; letter-spacing:-0.5px;
  margin-bottom:4px; transition:color .4s;
}
.hero.cleaning  .hero-state { color:var(--teal); }
.hero.levelling .hero-state { color:var(--amber); }

.hero-sub {
  font-family:'DM Mono',monospace; font-size:12px;
  color:var(--muted); margin-bottom:22px; min-height:18px;
}

.actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; }

.btn {
  padding:13px 16px; border:none; border-radius:14px;
  font-family:'Syne',sans-serif; font-size:14px; font-weight:700;
  cursor:pointer; transition:all .2s;
  display:flex; align-items:center; justify-content:center; gap:6px;
}
.btn:disabled { opacity:.35; cursor:not-allowed; transform:none !important; }

.btn-lime  { background:var(--accent); color:#0f0e0d; }
.btn-lime:not(:disabled):hover  { background:#d4f55a; transform:translateY(-1px); }

.btn-red   { background:rgba(240,74,106,.12); color:var(--danger); border:1.5px solid rgba(240,74,106,.25); }
.btn-red:not(:disabled):hover  { background:rgba(240,74,106,.22); }

.btn-ghost { background:var(--s2); color:var(--muted); border:1.5px solid var(--border); }
.btn-ghost:hover { color:var(--text); border-color:rgba(255,255,255,.12); }

/* ── Stats ── */
.stats { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:10px 0; }
.stat {
  background:var(--s1); border:1.5px solid var(--border);
  border-radius:var(--r); padding:18px 16px;
}
.stat-icon { font-size:18px; margin-bottom:8px; display:block; }
.stat-val {
  font-family:'Syne',sans-serif; font-size:38px; font-weight:800;
  color:var(--accent); line-height:1; letter-spacing:-1px;
}
.stat-label {
  font-size:11px; color:var(--muted); margin-top:4px;
  text-transform:uppercase; letter-spacing:1.5px; font-weight:700;
}

/* ── Refresh ── */
.btn-refresh { width:100%; margin-top:10px; }

/* ── Settings ── */
details.cfg {
  background:var(--s1); border:1.5px solid var(--border);
  border-radius:var(--r); margin-top:10px; overflow:hidden;
}
details.cfg summary {
  padding:15px 18px; cursor:pointer;
  font-size:12px; font-weight:700; color:var(--muted);
  list-style:none; display:flex; align-items:center; gap:8px;
  user-select:none; letter-spacing:.5px; text-transform:uppercase;
}
details.cfg summary::-webkit-details-marker { display:none; }
details.cfg summary:hover { color:var(--text); }
details.cfg[open] summary { border-bottom:1px solid var(--border); color:var(--text); }
.cfg-arrow { margin-left:auto; transition:transform .2s; }
details.cfg[open] .cfg-arrow { transform:rotate(180deg); }

.cfg-body { padding:4px 18px 12px; }
.cfg-row {
  display:flex; align-items:center; justify-content:space-between;
  padding:12px 0; border-bottom:1px solid var(--border);
}
.cfg-row:last-child { border-bottom:none; }
.cfg-name { font-size:13px; }
.cfg-desc { font-size:11px; color:var(--muted); margin-top:2px; }

.switch { position:relative; width:44px; height:24px; flex-shrink:0; margin-left:14px; }
.switch input { opacity:0; width:0; height:0; }
.slider { position:absolute; inset:0; background:var(--border); border-radius:24px; cursor:pointer; transition:.3s; }
.slider:before { content:''; position:absolute; width:18px; height:18px; left:3px; top:3px; background:var(--muted); border-radius:50%; transition:.3s; }
input:checked+.slider { background:var(--accent); }
input:checked+.slider:before { transform:translateX(20px); background:#0f0e0d; }

.sel {
  background:var(--s2); border:1.5px solid var(--border);
  border-radius:8px; padding:6px 10px;
  color:var(--text); font-family:'DM Mono',monospace; font-size:11px;
  outline:none; margin-left:12px; flex-shrink:0; cursor:pointer;
}
.sel:focus { border-color:var(--accent); }

/* ── Log ── */
.log-wrap {
  background:var(--s1); border:1.5px solid var(--border);
  border-radius:var(--r); margin-top:10px; overflow:hidden;
}
.log-head {
  padding:11px 16px; font-size:10px; font-weight:700;
  color:var(--muted); letter-spacing:2px; text-transform:uppercase;
  border-bottom:1px solid var(--border);
}
.log {
  padding:6px 8px; font-family:'DM Mono',monospace; font-size:10px;
  height:88px; overflow-y:auto; display:flex; flex-direction:column-reverse;
}
.le { padding:2px 4px; color:var(--muted); }
.le.s { color:var(--teal); }
.le.e { color:var(--danger); }
.le.i { color:var(--amber); }

::-webkit-scrollbar { width:3px; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:2px; }
</style>
</head>
<body>

<header>
  <div class="logo">Gatu<span class="a">rrin</span> 🐾</div>
  <div class="conn">
    <span class="dot" id="dot"></span>
    <span id="stxt">conectando...</span>
  </div>
</header>

<div class="hero" id="hero">
  <span class="hero-emoji" id="hero-emoji">🐱</span>
  <div class="hero-state" id="hero-state">Conectando...</div>
  <div class="hero-sub"   id="hero-sub">actualizando</div>
  <div class="actions">
    <button class="btn btn-lime" id="btn-clean"  onclick="doClean()"  disabled>⟳ Limpiar</button>
    <button class="btn btn-red"  id="btn-cancel" onclick="doCancel()" disabled>✕ Cancelar</button>
  </div>
</div>

<div class="stats">
  <div class="stat">
    <span class="stat-icon">🐾</span>
    <div class="stat-val"   id="weight">—</div>
    <div class="stat-label">libras</div>
  </div>
  <div class="stat">
    <span class="stat-icon">✓</span>
    <div class="stat-val"   id="uses">—</div>
    <div class="stat-label">usos hoy</div>
  </div>
</div>

<button class="btn btn-ghost btn-refresh" onclick="fetchStatus()">↻ Actualizar estado</button>

<details class="cfg">
  <summary>⚙ Configuración <span class="cfg-arrow">▾</span></summary>
  <div class="cfg-body">

    <div class="cfg-row">
      <div>
        <div class="cfg-name">Auto-limpieza</div>
        <div class="cfg-desc">Limpia sola después de cada visita</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="tog-autoclean" onchange="setCmd('cleanonoff',this.checked)">
        <span class="slider"></span>
      </label>
    </div>

    <div class="cfg-row">
      <div>
        <div class="cfg-name">Delay</div>
        <div class="cfg-desc">Espera antes de limpiar</div>
      </div>
      <select class="sel" id="sel-delay" onchange="setCmd('delaytoclean',this.value)">
        <option value="tensecond">10 seg</option>
        <option value="twentysecond">20 seg</option>
        <option value="thirdsencond">30 seg</option>
        <option value="forthsecond">40 seg</option>
        <option value="sixsecond" selected>60 seg</option>
        <option value="ninthsecond">90 seg</option>
        <option value="onetwosecond">2 min</option>
      </select>
    </div>

    <div class="cfg-row">
      <div>
        <div class="cfg-name">Ciclos</div>
        <div class="cfg-desc">Vueltas de limpieza por ciclo</div>
      </div>
      <select class="sel" id="sel-rout" onchange="setCmd('routtimes',this.value)">
        <option value="onetimes">1 vuelta</option>
        <option value="twotimes">2 vueltas</option>
      </select>
    </div>

    <div class="cfg-row">
      <div>
        <div class="cfg-name">Peso mínimo</div>
        <div class="cfg-desc">Para activar el sensor</div>
      </div>
      <select class="sel" id="sel-minwet" onchange="setCmd('catminwet',this.value)">
        <option value="twolb">2 lb</option>
        <option value="twop5lb">2.5 lb</option>
        <option value="threelb">3 lb</option>
        <option value="threep5lb" selected>3.5 lb</option>
      </select>
    </div>

  </div>
</details>

<div class="log-wrap">
  <div class="log-head">Log</div>
  <div class="log" id="log"></div>
</div>

<script>
var MODES = {
  isidle:      { label:'En reposo',   emoji:'😸', cls:'' },
  isclean:     { label:'Limpiando…',  emoji:'✨', cls:'cleaning' },
  idlevelling: { label:'Nivelando',   emoji:'⚖️', cls:'levelling' },
};

function log(m, t) {
  var el = document.getElementById('log');
  var e  = document.createElement('div');
  e.className = 'le ' + (t || 'i');
  e.textContent = '[' + new Date().toLocaleTimeString('es-CO') + '] ' + m;
  el.prepend(e);
}
function setOn(on) {
  document.getElementById('dot').className = 'dot' + (on ? ' on' : '');
  document.getElementById('stxt').textContent = on ? 'conectado' : 'sin conexión';
}
function timeAgo(sec) {
  if (sec === undefined || sec === null) return null;
  if (sec < 60)   return 'hace ' + sec + ' seg';
  if (sec < 3600) return 'hace ' + Math.floor(sec / 60) + ' min';
  return 'hace ' + Math.floor(sec / 3600) + 'h';
}
async function api(method, path, body) {
  var r = await fetch('/api' + path, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function fetchStatus() {
  try {
    var d = await api('GET', '/status');
    if (!d.success) throw new Error(d.msg);
    setOn(true);
    document.getElementById('btn-clean').disabled  = false;
    document.getElementById('btn-cancel').disabled = false;

    var m = {};
    d.result.forEach(function(s) { m[s.code] = s.value; });

    if (m.cat_weight !== undefined)
      document.getElementById('weight').textContent = (m.cat_weight / 10).toFixed(1);
    if (m.excretion_times_day !== undefined)
      document.getElementById('uses').textContent = m.excretion_times_day;

    var mode = MODES[m.isnowmode] || { label: m.isnowmode || '?', emoji:'🐱', cls:'' };
    document.getElementById('hero').className       = 'hero ' + mode.cls;
    document.getElementById('hero-emoji').textContent = mode.emoji;
    document.getElementById('hero-state').textContent = mode.label;

    var ago = timeAgo(m.nocatinsec);
    document.getElementById('hero-sub').textContent =
      (m.isnowmode === 'isclean') ? 'Ciclo de limpieza activo' :
      ago ? 'Último uso ' + ago : 'Todo en orden';

    if (m.cleanonoff !== undefined)
      document.getElementById('tog-autoclean').checked = m.cleanonoff;
    if (m.delaytoclean) document.getElementById('sel-delay').value  = m.delaytoclean;
    if (m.routtimes)    document.getElementById('sel-rout').value   = m.routtimes;
    if (m.catminwet)    document.getElementById('sel-minwet').value = m.catminwet;

    log('OK — ' + mode.label, 's');
  } catch(e) { log('Error: ' + e.message, 'e'); setOn(false); }
}

async function doClean() {
  try {
    document.getElementById('btn-clean').disabled = true;
    document.getElementById('btn-clean').textContent = '⟳ Enviando…';
    log('Iniciando limpieza…', 'i');
    var d = await api('POST', '/clean');
    if (!d.success) throw new Error(d.msg);
    log('✓ Limpieza iniciada', 's');
    setTimeout(fetchStatus, 2000);
  } catch(e) { log('Error: ' + e.message, 'e'); }
  setTimeout(function() {
    document.getElementById('btn-clean').textContent = '⟳ Limpiar';
    document.getElementById('btn-clean').disabled = false;
  }, 3000);
}

async function doCancel() {
  try {
    log('Cancelando…', 'i');
    var d = await api('POST', '/cancel');
    if (!d.success) throw new Error(d.msg);
    log('✓ Cancelado', 's');
    setTimeout(fetchStatus, 1500);
  } catch(e) { log('Error: ' + e.message, 'e'); }
}

async function setCmd(code, value) {
  try {
    var d = await api('POST', '/cmd/' + code + '/' + value);
    if (!d.success) throw new Error(d.msg);
    log(code + ' → ' + value, 's');
  } catch(e) { log('Error: ' + e.message, 'e'); }
}

fetchStatus();
setInterval(fetchStatus, 30000);
</script>
</body>
</html>`;

// ── Servidor ──────────────────────────────────────────────────────────────────

const server = http.createServer(async function(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  function json(data, code) {
    res.writeHead(code || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (pathname.startsWith('/api')) {
    let body = '';
    req.on('data', c => { body += c; });
    await new Promise(r => req.on('end', r));

    try {
      await getToken();

      if (pathname === '/api/status') {
        json(await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/status'));

      } else if (pathname === '/api/clean') {
        console.log('[API] clean → nowclean:jikeclean');
        json(await cmd('nowclean', 'jikeclean'));

      } else if (pathname === '/api/cancel') {
        console.log('[API] cancel → cancelnow:nowtocancle');
        json(await cmd('cancelnow', 'nowtocancle'));

      } else if (pathname.startsWith('/api/cmd/')) {
        const parts   = pathname.replace('/api/cmd/', '').split('/');
        const cmdCode = parts[0];
        const raw     = parts[1];
        const cmdVal  = raw === 'true' ? true : raw === 'false' ? false : isNaN(raw) ? raw : Number(raw);
        console.log('[API] cmd:', cmdCode, '=', cmdVal);
        json(await cmd(cmdCode, cmdVal));

      } else if (pathname === '/api/spec') {
        json(await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/specifications'));

      } else if (pathname === '/api/info') {
        json(await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID));

      } else if (pathname === '/api/records') {
        const now  = Date.now();
        const from = now - 24 * 60 * 60 * 1000;
        json(await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/logs?type=7&start_time=' + from + '&end_time=' + now + '&size=20'));

      } else {
        json({ success: false, msg: 'Not found' }, 404);
      }
    } catch(e) {
      console.error('[Error]', e.message);
      json({ success: false, msg: e.message }, 500);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, function() {
  console.log('\n🐾 Gaturrin en http://localhost:' + PORT + '\n');
});
