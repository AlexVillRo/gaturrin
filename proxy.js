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

// ── Historial de visitas (en memoria) ─────────────────────────────────────────

const visitLog    = [];   // [{ ts, weight }]
let   prevCount   = null; // excretion_times_day anterior
let   lastWeight  = null; // último peso conocido

function trackVisit(result) {
  var m = {};
  result.forEach(s => { m[s.code] = s.value; });
  if (m.cat_weight > 0) lastWeight = m.cat_weight;
  if (m.excretion_times_day !== undefined) {
    const n = m.excretion_times_day;
    if (prevCount !== null && n > prevCount) {
      const newVisits = n - prevCount;
      for (let i = 0; i < newVisits; i++) {
        visitLog.unshift({ ts: Date.now(), weight: lastWeight });
      }
      if (visitLog.length > 200) visitLog.length = 200;
    }
    prevCount = n;
  }
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
  --bg:       #f5eeff;
  --surface:  #ffffff;
  --s2:       #fdf4ff;
  --border:   #e8d5f5;
  --pink:     #d946a8;
  --pink-s:   #fce7f6;
  --lav:      #8b5cf6;
  --lav-s:    #ede9fe;
  --mint:     #059669;
  --mint-s:   #d1fae5;
  --amber:    #d97706;
  --amber-s:  #fef3c7;
  --text:     #3b1f5e;
  --muted:    #9d7ebe;
  --danger:   #e11d48;
  --r:        24px;
  --shadow:   0 4px 24px rgba(139,92,246,.10), 0 1px 4px rgba(139,92,246,.07);
  --shadow-lg:0 8px 40px rgba(139,92,246,.15), 0 2px 8px rgba(139,92,246,.08);
}
* { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
html { background:var(--bg); }

body {
  background:var(--bg);
  color:var(--text);
  font-family:'Syne',sans-serif;
  min-height:100vh;
  max-width:440px;
  margin:0 auto;
  padding:24px 16px env(safe-area-inset-bottom,32px);
  position:relative;
}

/* ── Fondo decorativo ── */
.bg-deco {
  position:fixed; inset:0; pointer-events:none;
  overflow:hidden; z-index:0;
}
.bg-deco span {
  position:absolute; font-size:72px; opacity:.04;
  animation:floatPaw 8s ease-in-out infinite;
}
.bg-deco span:nth-child(1){top:8%;  left:4%;  animation-delay:0s;   transform:rotate(-20deg)}
.bg-deco span:nth-child(2){top:55%; left:78%; animation-delay:-3s;  transform:rotate(30deg)}
.bg-deco span:nth-child(3){top:25%; left:58%; animation-delay:-5s;  transform:rotate(-10deg)}
.bg-deco span:nth-child(4){top:75%; left:15%; animation-delay:-2s;  transform:rotate(45deg)}
.bg-deco span:nth-child(5){top:3%;  left:82%; animation-delay:-7s;  transform:rotate(-35deg)}
.bg-deco span:nth-child(6){top:88%; left:62%; animation-delay:-4s;  transform:rotate(15deg)}

@keyframes floatPaw {
  0%,100%{transform:rotate(-20deg) translateY(0)}
  50%    {transform:rotate(-20deg) translateY(-18px)}
}

/* ── Wrapper ── */
.wrap { position:relative; z-index:1; }

/* ── Header ── */
header {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:22px; padding:0 2px;
}
.logo { font-size:21px; font-weight:800; letter-spacing:-0.5px; color:var(--text); }
.logo .a { color:var(--pink); }
.logo .paw { font-size:16px; }

.conn { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--muted); }
.dot {
  width:8px; height:8px; border-radius:50%;
  background:var(--border); transition:all .4s; flex-shrink:0;
}
.dot.on {
  background:var(--mint);
  box-shadow:0 0 0 3px var(--mint-s);
  animation:blink 2.5s ease-in-out infinite;
}
@keyframes blink {
  0%,100%{box-shadow:0 0 0 3px var(--mint-s)}
  50%    {box-shadow:0 0 0 6px rgba(5,150,105,.15)}
}

/* ── Hero ── */
.hero {
  background:linear-gradient(145deg,#ede9fe,#fce7f6);
  border:2px solid var(--border);
  border-radius:32px;
  padding:32px 20px 22px;
  margin-bottom:12px;
  text-align:center;
  box-shadow:var(--shadow-lg);
  transition:all .5s cubic-bezier(.34,1.56,.64,1);
  position:relative;
  overflow:hidden;
}
.hero::before {
  content:'';
  position:absolute; inset:0;
  background:linear-gradient(145deg,rgba(255,255,255,.6),rgba(255,255,255,0));
  border-radius:32px; pointer-events:none;
}

.hero.cleaning  {
  background:linear-gradient(145deg,#d1fae5,#ecfdf5);
  border-color:rgba(5,150,105,.3);
}
.hero.levelling {
  background:linear-gradient(145deg,#fef3c7,#fff7ed);
  border-color:rgba(217,119,6,.3);
}

.cat-wrap {
  position:relative; display:inline-block;
  margin-bottom:16px;
}
.hero-emoji {
  font-size:80px; line-height:1; display:block;
  animation:catFloat 3s ease-in-out infinite;
  filter:drop-shadow(0 8px 24px rgba(139,92,246,.2));
  transition:filter .5s;
}
.hero.cleaning  .hero-emoji { filter:drop-shadow(0 8px 24px rgba(5,150,105,.25)); }
.hero.levelling .hero-emoji { filter:drop-shadow(0 8px 24px rgba(217,119,6,.25)); }

@keyframes catFloat {
  0%,100%{transform:translateY(0) rotate(0deg)}
  30%    {transform:translateY(-10px) rotate(-2deg)}
  70%    {transform:translateY(-6px) rotate(1.5deg)}
}
.hero.cleaning .hero-emoji  { animation:spin 1.8s linear infinite; }
@keyframes spin {
  from{transform:rotate(0deg)} to{transform:rotate(360deg)}
}

.hero-state {
  font-size:26px; font-weight:800; letter-spacing:-0.5px;
  margin-bottom:5px; color:var(--text);
  transition:color .4s;
}
.hero.cleaning  .hero-state { color:var(--mint); }
.hero.levelling .hero-state { color:var(--amber); }

.hero-sub {
  font-family:'DM Mono',monospace; font-size:12px;
  color:var(--muted); margin-bottom:22px; min-height:18px;
}

.actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; }

.btn {
  padding:14px 16px; border:none; border-radius:16px;
  font-family:'Syne',sans-serif; font-size:14px; font-weight:700;
  cursor:pointer; transition:all .2s cubic-bezier(.34,1.56,.64,1);
  display:flex; align-items:center; justify-content:center; gap:6px;
}
.btn:disabled { opacity:.38; cursor:not-allowed; transform:none !important; box-shadow:none !important; }

.btn-pink {
  background:linear-gradient(135deg,#e879b0,#d946a8);
  color:#fff; box-shadow:0 4px 16px rgba(217,70,168,.3);
}
.btn-pink:not(:disabled):hover  { transform:translateY(-2px); box-shadow:0 8px 24px rgba(217,70,168,.4); }
.btn-pink:not(:disabled):active { transform:translateY(0); }

.btn-ghost-red {
  background:rgba(225,29,72,.07); color:var(--danger);
  border:1.5px solid rgba(225,29,72,.2);
}
.btn-ghost-red:not(:disabled):hover { background:rgba(225,29,72,.13); }

.btn-ghost {
  background:var(--surface); color:var(--muted);
  border:1.5px solid var(--border);
  box-shadow:var(--shadow);
}
.btn-ghost:hover { color:var(--lav); border-color:rgba(139,92,246,.3); }

/* ── Stats ── */
.stats { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:12px 0; }
.stat {
  background:var(--surface); border:1.5px solid var(--border);
  border-radius:var(--r); padding:20px 16px;
  box-shadow:var(--shadow);
  transition:transform .2s, box-shadow .2s;
  animation:popIn .4s cubic-bezier(.34,1.56,.64,1) both;
}
.stat:nth-child(2) { animation-delay:.08s; }
.stat:hover { transform:translateY(-2px); box-shadow:var(--shadow-lg); }

@keyframes popIn {
  from{opacity:0;transform:scale(.88) translateY(8px)}
  to  {opacity:1;transform:scale(1)   translateY(0)}
}

.stat-pill {
  display:inline-flex; align-items:center; gap:5px;
  background:var(--lav-s); color:var(--lav);
  border-radius:20px; padding:4px 10px;
  font-size:11px; font-weight:700; margin-bottom:10px;
  letter-spacing:.3px;
}
.stat-val {
  font-family:'Syne',sans-serif; font-size:40px; font-weight:800;
  color:var(--text); line-height:1; letter-spacing:-2px;
}
.stat-val .unit { font-size:16px; font-weight:700; color:var(--muted); letter-spacing:0; margin-left:2px; }
.stat-label {
  font-size:11px; color:var(--muted); margin-top:4px;
  letter-spacing:1px; font-weight:700; text-transform:uppercase;
}

/* ── Refresh ── */
.btn-refresh { width:100%; margin-top:12px; }

/* ── Settings ── */
details.cfg {
  background:var(--surface); border:1.5px solid var(--border);
  border-radius:var(--r); margin-top:12px; overflow:hidden;
  box-shadow:var(--shadow);
}
details.cfg summary {
  padding:16px 20px; cursor:pointer;
  font-size:12px; font-weight:700; color:var(--muted);
  list-style:none; display:flex; align-items:center; gap:8px;
  user-select:none; letter-spacing:.5px; text-transform:uppercase;
  transition:color .2s;
}
details.cfg summary::-webkit-details-marker{display:none}
details.cfg summary:hover { color:var(--lav); }
details.cfg[open] summary { border-bottom:1px solid var(--border); color:var(--text); }
.cfg-arrow { margin-left:auto; transition:transform .25s; font-style:normal; }
details.cfg[open] .cfg-arrow { transform:rotate(180deg); }

.cfg-body { padding:4px 20px 12px; }
.cfg-row {
  display:flex; align-items:center; justify-content:space-between;
  padding:13px 0; border-bottom:1px solid var(--border);
}
.cfg-row:last-child { border-bottom:none; }
.cfg-name { font-size:13px; font-weight:700; }
.cfg-desc { font-size:11px; color:var(--muted); margin-top:2px; }

.switch { position:relative; width:46px; height:26px; flex-shrink:0; margin-left:14px; }
.switch input { opacity:0; width:0; height:0; }
.slider {
  position:absolute; inset:0;
  background:var(--border); border-radius:26px;
  cursor:pointer; transition:.3s;
}
.slider:before {
  content:''; position:absolute;
  width:20px; height:20px; left:3px; top:3px;
  background:#fff; border-radius:50%; transition:.3s;
  box-shadow:0 1px 4px rgba(0,0,0,.15);
}
input:checked+.slider { background:linear-gradient(135deg,#e879b0,#d946a8); }
input:checked+.slider:before { transform:translateX(20px); }

.sel {
  background:var(--s2); border:1.5px solid var(--border);
  border-radius:10px; padding:7px 11px;
  color:var(--text); font-family:'DM Mono',monospace; font-size:11px;
  outline:none; margin-left:12px; flex-shrink:0; cursor:pointer;
  transition:border-color .2s;
}
.sel:focus { border-color:var(--lav); }

/* ── Log ── */
.log-wrap {
  background:var(--surface); border:1.5px solid var(--border);
  border-radius:var(--r); margin-top:12px; overflow:hidden;
  box-shadow:var(--shadow);
}
.log-head {
  padding:12px 16px; font-size:10px; font-weight:700;
  color:var(--muted); letter-spacing:2px; text-transform:uppercase;
  border-bottom:1px solid var(--border);
  display:flex; align-items:center; gap:6px;
}
.log {
  padding:6px 8px; font-family:'DM Mono',monospace; font-size:10px;
  height:88px; overflow-y:auto; display:flex; flex-direction:column-reverse;
}
.le { padding:2px 6px; border-radius:4px; color:var(--muted); }
.le.s { color:var(--mint); }
.le.e { color:var(--danger); }
.le.i { color:var(--lav); }

/* ── Alertas ── */
.alerts { display:flex; flex-direction:column; gap:8px; margin-bottom:12px; }
.alert {
  display:flex; align-items:center; gap:10px;
  padding:12px 16px; border-radius:16px;
  font-size:13px; font-weight:700;
  animation:popIn .3s cubic-bezier(.34,1.56,.64,1) both;
}
.alert-err {
  background:rgba(225,29,72,.08);
  border:1.5px solid rgba(225,29,72,.25);
  color:var(--danger);
}
.alert-warn {
  background:rgba(217,119,6,.08);
  border:1.5px solid rgba(217,119,6,.25);
  color:var(--amber);
}
.alert-icon { font-size:18px; flex-shrink:0; }

/* ── Historial ── */
.hist-card {
  background:var(--surface); border:1.5px solid var(--border);
  border-radius:var(--r); margin-top:12px; overflow:hidden;
  box-shadow:var(--shadow);
}
.hist-head {
  padding:14px 18px; font-size:12px; font-weight:700;
  color:var(--text); letter-spacing:.3px;
  border-bottom:1px solid var(--border);
  display:flex; align-items:center; justify-content:space-between;
}
.hist-head span { color:var(--muted); font-size:11px; font-weight:400; }
.hist-empty {
  padding:32px 16px; text-align:center;
  font-size:13px; color:var(--muted);
}
.hist-empty .big { font-size:36px; margin-bottom:8px; }
.visit-row {
  display:flex; align-items:center; gap:14px;
  padding:13px 18px; border-bottom:1px solid var(--border);
  animation:popIn .3s cubic-bezier(.34,1.56,.64,1) both;
  transition:background .15s;
}
.visit-row:last-child { border-bottom:none; }
.visit-row:hover { background:var(--s2); }
.visit-avatar {
  width:38px; height:38px; border-radius:50%;
  background:var(--lav-s); display:flex; align-items:center;
  justify-content:center; font-size:20px; flex-shrink:0;
}
.visit-info { flex:1; min-width:0; }
.visit-time { font-size:13px; font-weight:700; }
.visit-ago  { font-size:11px; color:var(--muted); margin-top:1px; font-family:'DM Mono',monospace; }
.visit-weight {
  font-family:'Syne',sans-serif; font-size:18px; font-weight:800;
  color:var(--pink); text-align:right;
}
.visit-weight small { font-size:11px; font-weight:700; color:var(--muted); }

::-webkit-scrollbar { width:3px; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:2px; }
</style>
</head>
<body>

<div class="bg-deco" aria-hidden="true">
  <span>🐾</span><span>🐾</span><span>🐾</span>
  <span>🐾</span><span>🐾</span><span>🐾</span>
</div>

<div class="wrap">

<header>
  <div class="logo">Gatu<span class="a">rrin</span> <span class="paw">🐾</span></div>
  <div class="conn">
    <span class="dot" id="dot"></span>
    <span id="stxt">conectando...</span>
  </div>
</header>

<div class="alerts" id="alerts"></div>

<div class="hero" id="hero">
  <div class="cat-wrap">
    <span class="hero-emoji" id="hero-emoji">🐱</span>
  </div>
  <div class="hero-state" id="hero-state">Conectando...</div>
  <div class="hero-sub"   id="hero-sub">actualizando estado</div>
  <div class="actions">
    <button class="btn btn-pink"      id="btn-clean"  onclick="doClean()"  disabled>⟳ Limpiar</button>
    <button class="btn btn-ghost-red" id="btn-cancel" onclick="doCancel()" disabled>✕ Cancelar</button>
  </div>
</div>

<div class="stats">
  <div class="stat">
    <div class="stat-pill">🐾 Peso</div>
    <div class="stat-val" id="weight">—<span class="unit"></span></div>
    <div class="stat-label">libras</div>
  </div>
  <div class="stat">
    <div class="stat-pill">✓ Hoy</div>
    <div class="stat-val" id="uses">—</div>
    <div class="stat-label">usos del día</div>
  </div>
</div>

<button class="btn btn-ghost btn-refresh" onclick="fetchStatus()">↻ Actualizar estado</button>

<details class="cfg">
  <summary>⚙ Configuración <i class="cfg-arrow">▾</i></summary>
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

    <div class="cfg-row">
      <div>
        <div class="cfg-name">Tiempo mínimo en la arenera</div>
        <div class="cfg-desc">Para contar como visita válida</div>
      </div>
      <select class="sel" id="sel-validtoilt" onchange="setCmd('validtoilt',this.value)">
        <option value="tensec">10 seg</option>
        <option value="fifteensec">15 seg</option>
        <option value="twtenysec">20 seg</option>
        <option value="thirdsec">30 seg</option>
      </select>
    </div>

  </div>
</details>

<div class="hist-card">
  <div class="hist-head">🐾 Historial de visitas <span id="hist-count"></span></div>
  <div id="hist-list">
    <div class="hist-empty"><div class="big">😴</div>Esperando la primera visita…</div>
  </div>
</div>

<div class="log-wrap">
  <div class="log-head">🗒 Log</div>
  <div class="log" id="log"></div>
</div>

</div><!-- .wrap -->

<script>
var MODES = {
  isidle:      { label:'En reposo',   emoji:'😸', cls:'' },
  isclean:     { label:'Limpiando…',  emoji:'🫧', cls:'cleaning' },
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
  if (sec < 60)   return 'hace ' + sec + 's';
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
      document.getElementById('weight').innerHTML =
        (m.cat_weight / 10).toFixed(1) + '<span class="unit">lb</span>';
    if (m.excretion_times_day !== undefined)
      document.getElementById('uses').textContent = m.excretion_times_day;

    var mode = MODES[m.isnowmode] || { label: m.isnowmode || '?', emoji:'🐱', cls:'' };
    document.getElementById('hero').className         = 'hero ' + mode.cls;
    document.getElementById('hero-emoji').textContent = mode.emoji;
    document.getElementById('hero-state').textContent = mode.label;

    var ago = timeAgo(m.nocatinsec);
    document.getElementById('hero-sub').textContent =
      (m.isnowmode === 'isclean') ? 'Ciclo de limpieza activo ✨' :
      ago ? 'Último uso ' + ago : 'Todo en orden 😌';

    if (m.cleanonoff !== undefined)
      document.getElementById('tog-autoclean').checked = m.cleanonoff;
    if (m.delaytoclean)  document.getElementById('sel-delay').value      = m.delaytoclean;
    if (m.routtimes)     document.getElementById('sel-rout').value        = m.routtimes;
    if (m.catminwet)     document.getElementById('sel-minwet').value      = m.catminwet;
    if (m.validtoilt)    document.getElementById('sel-validtoilt').value  = m.validtoilt;

    // Alertas: fault (bit0=nodump, bit1=overload) y notification (bit0=no_weight)
    var alerts = [];
    if (m.fault & 1) alerts.push({ cls:'alert-err',  icon:'⚠️', txt:'Error: sin descarga (nodump)' });
    if (m.fault & 2) alerts.push({ cls:'alert-err',  icon:'🔴', txt:'Error: sobrecarga (overload)' });
    if (m.notification & 1) alerts.push({ cls:'alert-warn', icon:'⚖️', txt:'Advertencia: no se detectó peso' });
    var box = document.getElementById('alerts');
    box.innerHTML = '';
    alerts.forEach(function(a) {
      var el = document.createElement('div');
      el.className = 'alert ' + a.cls;
      el.innerHTML = '<span class="alert-icon">' + a.icon + '</span>' + a.txt;
      box.appendChild(el);
    });

    log('Estado: ' + mode.label, 's');
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

function fmtTime(ts) {
  var d   = new Date(ts);
  var now = new Date();
  var hm  = d.toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' });
  var diff = Math.floor((now - d) / 60000);
  var ago  = diff < 1 ? 'ahora mismo' : diff < 60 ? 'hace ' + diff + ' min' : 'hace ' + Math.floor(diff/60) + 'h';
  if (d.toDateString() === now.toDateString()) return { label: 'Hoy ' + hm, ago };
  var yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return { label: 'Ayer ' + hm, ago };
  return { label: d.toLocaleDateString('es-CO', { day:'numeric', month:'short' }) + ' ' + hm, ago };
}

async function fetchHistory() {
  try {
    var d = await api('GET', '/history');
    if (!d.success) return;
    var list = document.getElementById('hist-list');
    var count = document.getElementById('hist-count');
    if (!d.result.length) return;
    count.textContent = d.result.length + ' visita' + (d.result.length !== 1 ? 's' : '');
    list.innerHTML = '';
    d.result.forEach(function(v) {
      var t   = fmtTime(v.ts);
      var row = document.createElement('div');
      row.className = 'visit-row';
      var lb  = v.weight ? (v.weight / 10).toFixed(1) : '—';
      row.innerHTML =
        '<div class="visit-avatar">😸</div>' +
        '<div class="visit-info">' +
          '<div class="visit-time">' + t.label + '</div>' +
          '<div class="visit-ago">'  + t.ago   + '</div>' +
        '</div>' +
        '<div class="visit-weight">' + lb + '<small> lb</small></div>';
      list.appendChild(row);
    });
  } catch(e) {}
}

fetchStatus();
fetchHistory();
setInterval(fetchStatus, 30000);
setInterval(fetchHistory, 30000);
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
        const statusRes = await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/status');
        if (statusRes.success) trackVisit(statusRes.result);
        json(statusRes);

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

      } else if (pathname === '/api/history') {
        json({ success: true, result: visitLog });

      } else if (pathname === '/api/records') {
        // Query params deben ir ordenados alfabéticamente para el signing de Tuya
        const now  = Date.now();
        const from = now - 24 * 60 * 60 * 1000;
        const q    = '?end_time=' + now + '&size=100&start_time=' + from + '&type=7';
        json(await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/logs' + q));

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
