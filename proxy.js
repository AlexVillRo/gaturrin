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

// ── Parser de visitas desde logs Tuya ─────────────────────────────────────────
// Detecta visitas agrupando secuencias de cat_weight > 0 (el dispositivo emite
// catinweight solo tras limpiar, no tras cada visita, así que no es confiable).

function parseVisits(logs) {
  const sorted = logs.slice().sort((a, b) => a.event_time - b.event_time);
  const SESSION_GAP = 2 * 60 * 1000; // >2 min sin lecturas = sesión nueva

  // Modo del dispositivo en un instante dado (para filtrar falsos positivos)
  const modes = sorted.filter(l => l.code === 'isnowmode');
  const modeAt = ts => {
    let m = 'isidle';
    for (const l of modes) { if (l.event_time <= ts) m = l.value; else break; }
    return m;
  };

  const visits = [];
  let session = null;

  const flush = () => {
    if (!session) return;
    const weight = Math.max(...session.weights);
    if (weight > 0 && modeAt(session.ts) !== 'isclean') {
      // Buscar nocatinsec emitido justo después del fin de sesión
      let duration = null;
      for (const l of sorted) {
        if (l.code === 'nocatinsec' && l.event_time >= session.lastTs && l.event_time <= session.lastTs + 90000) {
          duration = parseInt(l.value); break;
        }
      }
      if (!duration && session.lastTs > session.ts)
        duration = Math.round((session.lastTs - session.ts) / 1000);
      visits.push({ ts: session.ts, weight, duration });
    }
    session = null;
  };

  for (const log of sorted) {
    if (log.code !== 'cat_weight') continue;
    const w = parseInt(log.value);
    if (w > 0) {
      if (!session) {
        session = { ts: log.event_time, lastTs: log.event_time, weights: [w] };
      } else if (log.event_time - session.lastTs > SESSION_GAP) {
        flush();
        session = { ts: log.event_time, lastTs: log.event_time, weights: [w] };
      } else {
        session.lastTs = log.event_time;
        session.weights.push(w);
      }
    } else {
      flush(); // cat_weight = 0 → gato bajó
    }
  }
  flush();

  return visits.sort((a, b) => b.ts - a.ts);
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

// ── Cat config server-side ────────────────────────────────────────────────────
// targets calculados para que nearest-neighbor reproduzca fronteras originales:
// midpoint(50,80)=65, midpoint(80,106)=93, midpoint(106,120)=113
const CATS_FALLBACK = [
  { name:'TChala', targetRaw:50,  bg:'#ccfbf1', accent:'#2dd4bf', emoji:'🐱', photo:null },
  { name:'Dalila', targetRaw:80,  bg:'#fce7f6', accent:'#ec4899', emoji:'🌸', photo:null },
  { name:'Whis',   targetRaw:106, bg:'#ede9fe', accent:'#8b5cf6', emoji:'⭐', photo:null },
  { name:'Ares',   targetRaw:120, bg:'#fed7aa', accent:'#f97316', emoji:'👑', photo:null },
];
let catsCache = CATS_FALLBACK.slice();

async function loadCatsToCache() {
  if (!db) return;
  try {
    const { rows } = await db.query(
      'SELECT name,target_raw,bg,accent,emoji,photo FROM cats ORDER BY target_raw ASC'
    );
    if (rows.length) {
      catsCache = rows.map(r => ({
        name: r.name, targetRaw: r.target_raw,
        bg: r.bg, accent: r.accent, emoji: r.emoji, photo: r.photo
      }));
    }
  } catch(e) { console.warn('[DB] loadCatsToCache:', e.message); }
}

function catByWeight(raw) {
  if (!raw || !catsCache.length) return null;
  let best = catsCache[0], bestDist = Math.abs(raw - catsCache[0].targetRaw);
  for (let i = 1; i < catsCache.length; i++) {
    const d = Math.abs(raw - catsCache[i].targetRaw);
    if (d < bestDist) { bestDist = d; best = catsCache[i]; }
  }
  return best.name;
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────
let db = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    console.log('[DB] Pool PostgreSQL creado');
  } catch(e) {
    console.warn('[DB] Módulo pg no disponible:', e.message);
  }
}

async function initDB() {
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id           SERIAL PRIMARY KEY,
      ts           BIGINT UNIQUE NOT NULL,
      cat_name     TEXT,
      weight_raw   INT NOT NULL,
      weight_kg    NUMERIC(5,2),
      duration_sec INT,
      synced_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS cat_avatars (
      cat_name   TEXT PRIMARY KEY,
      photo      TEXT,
      emoji      TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS cats (
      name        TEXT PRIMARY KEY,
      target_raw  INT NOT NULL,
      bg          TEXT NOT NULL DEFAULT '#ede9fe',
      accent      TEXT NOT NULL DEFAULT '#8b5cf6',
      emoji       TEXT NOT NULL DEFAULT '🐱',
      photo       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const { rows: existingCats } = await db.query('SELECT 1 FROM cats LIMIT 1');
  if (!existingCats.length) {
    for (const c of CATS_FALLBACK) {
      const av = await db.query('SELECT photo,emoji FROM cat_avatars WHERE cat_name=$1', [c.name]);
      const photo = av.rows[0]?.photo || null;
      const emoji = av.rows[0]?.emoji || c.emoji;
      await db.query(
        `INSERT INTO cats (name,target_raw,bg,accent,emoji,photo) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [c.name, c.targetRaw, c.bg, c.accent, emoji, photo]
      );
    }
    console.log('[DB] Cats sembrados (migrado desde cat_avatars)');
  }
  await loadCatsToCache();
  console.log('[DB] Tablas listas, cats:', catsCache.map(c => c.name).join(', '));
}

async function fetchTuyaLogs(from, now) {
  let allLogs = [], rowKey = null;
  do {
    let q = '?end_time=' + now + '&size=100&start_time=' + from + '&type=7';
    if (rowKey) q += '&last_row_key=' + encodeURIComponent(rowKey);
    const r = await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/logs' + q);
    if (!r.success || !r.result) break;
    allLogs = allLogs.concat(r.result.logs || []);
    rowKey  = r.result.has_next ? r.result.last_row_key : null;
  } while (rowKey && allLogs.length < 5000);
  return allLogs;
}

async function syncVisits() {
  if (!db) return;
  try {
    await getToken();
    const { rows } = await db.query('SELECT COALESCE(MAX(ts), 0) AS last_ts FROM visits');
    const lastTs = Number(rows[0].last_ts);
    // Retrocede 5 min antes del último ts para no partir sesiones de cat_weight a la mitad
    const from   = lastTs > 0 ? lastTs - 5 * 60 * 1000 : Date.now() - 90 * 24 * 60 * 60 * 1000;
    const now    = Date.now();

    const logs   = await fetchTuyaLogs(from, now);
    const visits = parseVisits(logs);

    let inserted = 0;
    for (const v of visits) {
      const { rowCount } = await db.query(
        `INSERT INTO visits (ts, cat_name, weight_raw, weight_kg, duration_sec)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (ts) DO NOTHING`,
        [v.ts, catByWeight(v.weight), v.weight,
         parseFloat((v.weight * 0.04536).toFixed(2)), v.duration]
      );
      inserted += rowCount;
    }
    if (inserted > 0) console.log('[DB] Sync: ' + inserted + ' visita(s) nuevas guardadas');
  } catch(e) {
    console.error('[DB] Error en sync:', e.message);
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Gaturrin 🐾</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
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
  font-family:'Nunito',sans-serif;
  font-size:15px;
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
.logo { font-size:22px; font-weight:900; letter-spacing:-0.5px; color:var(--text); }
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

/* ── Báscula ── */
.scale {
  background:var(--surface); border:1.5px solid var(--border);
  border-radius:32px; overflow:hidden; margin-bottom:12px;
  box-shadow:var(--shadow-lg);
}

/* Plataforma */
.scale-platform {
  min-height:180px; padding:28px 20px 20px;
  display:flex; flex-direction:column;
  align-items:center; justify-content:center;
  text-align:center; position:relative;
  background:linear-gradient(160deg,#faf5ff 0%,#fff0f9 60%,#f0f4ff 100%);
  border-bottom:1.5px solid var(--border);
  transition:background .5s, border-color .5s;
  overflow:hidden;
}
/* Textura de cuadrícula tipo báscula */
.scale-platform::before {
  content:'';
  position:absolute; inset:0; pointer-events:none;
  background-image:
    linear-gradient(rgba(139,92,246,.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(139,92,246,.04) 1px, transparent 1px);
  background-size:22px 22px;
}
/* Pata izquierda y derecha de la báscula */
.scale-platform::after {
  content:'';
  position:absolute; bottom:-1px; left:50%;
  transform:translateX(-50%);
  width:60%; height:3px;
  background:var(--border); border-radius:0 0 4px 4px;
}

.scale-platform.active {
  background:linear-gradient(160deg,#ecfdf5 0%,#d1fae5 100%);
  border-color:rgba(5,150,105,.3);
}
.scale-platform.cleaning {
  background:linear-gradient(160deg,#ede9fe 0%,#fce7f6 100%);
  border-color:rgba(139,92,246,.3);
}
.scale-platform.levelling {
  background:linear-gradient(160deg,#fef3c7 0%,#fff7ed 100%);
  border-color:rgba(217,119,6,.3);
}
.scale-platform.paused {
  background:linear-gradient(160deg,#fffbeb 0%,#fef3c7 100%);
  border-color:rgba(217,119,6,.35);
}
.scale-platform.paused .scale-weight { color:var(--amber); }

/* Avatar del gato en la báscula */
.scale-avatar {
  width:76px; height:76px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-size:38px; margin-bottom:12px;
  position:relative; z-index:1; overflow:hidden;
  box-shadow:0 4px 20px rgba(0,0,0,.12);
  transition:all .5s cubic-bezier(.34,1.56,.64,1);
  animation:catFloat 3s ease-in-out infinite;
}
.scale-avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.scale-avatar.idle     { opacity:.5; animation:none; }
.scale-avatar.cleaning { opacity:1;  animation:none; }
.scale-avatar.paused   { animation:pausePulse 1.4s ease-in-out infinite; }

@keyframes catFloat {
  0%,100%{transform:translateY(0) rotate(0deg)}
  35%    {transform:translateY(-10px) rotate(-2deg)}
  70%    {transform:translateY(-5px) rotate(1.5deg)}
}
@keyframes pausePulse {
  0%,100%{box-shadow:0 0 0 3px rgba(217,119,6,.38),0 4px 20px rgba(0,0,0,.12)}
  50%    {box-shadow:0 0 0 9px rgba(217,119,6,.05),0 4px 20px rgba(0,0,0,.12)}
}

/* ── Rig contenedor: avatar + overlay de limpieza ── */
.avatar-rig {
  position:relative; width:76px; height:76px;
  margin-bottom:12px; flex-shrink:0;
}
.scale-avatar { margin-bottom:0; }

.clean-overlay {
  display:none; position:absolute; inset:-12px; pointer-events:none;
}
.clean-overlay.active { display:block; }

/* Anilla orbital */
.co-ring {
  position:absolute; inset:0;
  border:1.5px dashed rgba(139,92,246,.28); border-radius:50%;
  animation:coSpin 8s linear infinite reverse;
}
/* Brazo barredor */
.co-arm {
  position:absolute; top:50%; left:50%; width:0; height:0;
  animation:coSpin 2.2s linear infinite;
}
.co-arm-blade {
  position:absolute; top:-1.5px; left:0; width:50px; height:3px;
  border-radius:0 3px 3px 0;
  background:linear-gradient(90deg,rgba(139,92,246,0) 0%,rgba(139,92,246,.45) 65%,rgba(139,92,246,.8) 100%);
}
/* Partículas de arena en estela */
.co-p {
  position:absolute; top:50%; left:50%; width:0; height:0;
  animation:coSpin 2.2s linear infinite;
}
.co-dot {
  position:absolute; border-radius:50%;
  background:rgba(167,139,250,.9); box-shadow:0 0 6px rgba(139,92,246,.5);
}
@keyframes coSpin { to{transform:rotate(360deg)} }

/* Número de peso en la báscula */
.scale-weight {
  font-size:56px; font-weight:900; line-height:1;
  letter-spacing:-2px; color:var(--text);
  position:relative; z-index:1;
  transition:color .4s;
}
.scale-weight .su { font-size:20px; font-weight:700; color:var(--muted); letter-spacing:0; }
.scale-platform.active   .scale-weight { color:var(--mint); }
.scale-platform.levelling .scale-weight { color:var(--amber); }

.scale-label {
  font-size:14px; font-weight:800; color:var(--muted);
  margin-top:4px; position:relative; z-index:1;
}

/* Pata decorativa grande (reposo) */
.scale-paw-bg {
  position:absolute; font-size:96px; opacity:.05;
  top:50%; left:50%; transform:translate(-50%,-50%);
  pointer-events:none; user-select:none;
}

/* Panel de datos debajo de la plataforma */
.scale-panel {
  display:grid; grid-template-columns:repeat(4,1fr);
  padding:14px 16px; gap:0;
}
.scale-stat {
  padding:6px 12px; text-align:center;
  border-right:1px solid var(--border);
}
.scale-stat:last-child { border-right:none; }
.scale-stat-label {
  font-size:9px; font-weight:700; letter-spacing:1.5px;
  text-transform:uppercase; color:var(--muted); margin-bottom:3px;
}
.scale-stat-val { font-size:14px; font-weight:800; color:var(--text); }

/* Botones */
.scale-actions {
  display:grid; grid-template-columns:1fr 1fr;
  gap:10px; padding:12px 14px 14px;
  border-top:1px solid var(--border);
}

.actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; }

.btn {
  padding:14px 16px; border:none; border-radius:16px;
  font-family:'Nunito',sans-serif; font-size:14px; font-weight:700;
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

@keyframes popIn {
  from{opacity:0;transform:scale(.88) translateY(8px)}
  to  {opacity:1;transform:scale(1)   translateY(0)}
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

/* ── Mis gatos ── */
.cats-section { margin-top:12px; }
.section-label {
  font-size:11px; font-weight:700; letter-spacing:1.5px;
  text-transform:uppercase; color:var(--muted);
  padding:0 2px; margin-bottom:10px; display:block;
}
.cats-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.cat-card {
  background:var(--surface); border:1.5px solid var(--border);
  border-radius:22px; padding:18px 12px 14px;
  text-align:center; box-shadow:var(--shadow);
  transition:transform .2s, box-shadow .2s;
  cursor:pointer; position:relative;
}
.cat-card:hover { transform:translateY(-2px); box-shadow:var(--shadow-lg); }
.cat-avatar-btn {
  width:64px; height:64px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-size:32px; margin:0 auto 10px; cursor:pointer;
  border:2px solid transparent;
  transition:transform .2s; position:relative;
  overflow:hidden;
}
.cat-avatar-btn:hover { transform:scale(1.1); }
.cat-avatar-btn img {
  width:100%; height:100%; object-fit:cover; border-radius:50%;
}
.cat-card-name { font-size:14px; font-weight:800; margin-bottom:4px; }
.cat-card-weight { font-size:22px; font-weight:900; font-family:'Nunito',sans-serif; color:var(--text); line-height:1; }
.cat-card-unit { font-size:11px; color:var(--muted); font-weight:700; }
.cat-card-meta { font-size:10px; color:var(--muted); margin-top:5px; font-family:'DM Mono',monospace; }
.cat-card-edit-btn {
  position:absolute; top:10px; right:10px;
  width:26px; height:26px; border-radius:50%; border:none;
  background:rgba(255,255,255,.65); color:var(--muted);
  font-size:11px; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  transition:all .15s; z-index:1; box-shadow:0 1px 4px rgba(0,0,0,.1);
}
.cat-card-edit-btn:hover { background:var(--surface); color:var(--text); transform:scale(1.1); }
.cat-card-add {
  grid-column:1 / -1;
  background:var(--s2); border:1.5px dashed var(--border);
  border-radius:16px; padding:12px 20px;
  display:flex; flex-direction:row; align-items:center; justify-content:center;
  gap:8px; cursor:pointer;
  transition:border-color .2s, background .2s;
}
.cat-card-add:hover { background:var(--surface); border-color:var(--lav); }
.cat-card-add-icon { font-size:16px; color:var(--muted); line-height:1; }
.cat-card-add-label { font-size:12px; font-weight:700; color:var(--muted); letter-spacing:.5px; }

/* ── Emoji picker ── */
.emoji-overlay {
  position:fixed; inset:0; background:rgba(59,31,94,.35);
  z-index:100; display:flex; align-items:flex-end; justify-content:center;
  opacity:0; pointer-events:none; transition:opacity .25s;
  backdrop-filter:blur(4px);
}
.emoji-overlay.open { opacity:1; pointer-events:all; }
.emoji-sheet {
  background:var(--surface); border-radius:28px 28px 0 0;
  padding:8px 16px 40px; width:100%; max-width:440px;
  transform:translateY(100%);
  transition:transform .35s cubic-bezier(.34,1.56,.64,1);
  box-shadow:0 -8px 40px rgba(139,92,246,.15);
}
.emoji-overlay.open .emoji-sheet { transform:translateY(0); }
.emoji-handle {
  width:36px; height:4px; background:var(--border);
  border-radius:2px; margin:10px auto 16px;
}
.emoji-title {
  font-size:15px; font-weight:800; text-align:center;
  margin-bottom:16px; color:var(--text);
}
.picker-upload {
  display:flex; align-items:center; justify-content:center; gap:10px;
  width:100%; padding:14px; border-radius:16px; border:2px dashed var(--border);
  background:var(--s2); cursor:pointer; font-size:14px; font-weight:700;
  color:var(--muted); margin-bottom:16px; transition:all .2s;
}
.picker-upload:hover { border-color:var(--pink); color:var(--pink); background:var(--pink-s); }
.picker-divider {
  display:flex; align-items:center; gap:10px; margin-bottom:14px;
  font-size:11px; color:var(--muted); font-weight:700; letter-spacing:1px; text-transform:uppercase;
}
.picker-divider::before,.picker-divider::after {
  content:''; flex:1; height:1px; background:var(--border);
}
.emoji-grid {
  display:grid; grid-template-columns:repeat(6,1fr); gap:6px;
}
.emoji-opt {
  height:48px; border-radius:14px; border:2px solid transparent;
  background:var(--s2); font-size:26px; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  transition:all .15s;
}
.emoji-opt:hover { transform:scale(1.15); background:var(--border); }
.emoji-opt.sel { border-color:var(--pink); background:var(--pink-s); }

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
  width:40px; height:40px; border-radius:50%;
  display:flex; align-items:center;
  justify-content:center; font-size:20px; flex-shrink:0;
}
.cat-name { font-weight:800; }
.visit-info { flex:1; min-width:0; }
.visit-time { font-size:13px; font-weight:700; }
.visit-ago  { font-size:11px; color:var(--muted); margin-top:1px; font-family:'DM Mono',monospace; }
.visit-weight {
  font-family:'Nunito',sans-serif; font-size:18px; font-weight:900;
  color:var(--pink); text-align:right;
}
.visit-weight small { font-size:11px; font-weight:700; color:var(--muted); }
.hist-more {
  width:100%; padding:13px 18px; border:none; background:none; cursor:pointer;
  font-family:'Nunito',sans-serif; font-size:13px; font-weight:700;
  color:var(--lav); border-top:1px solid var(--border);
  transition:background .15s, color .15s;
}
.hist-more:hover { background:var(--s2); color:var(--pink); }
.hist-more:disabled { opacity:.5; cursor:not-allowed; }

/* ── Dashboard de Estadísticas ── */
.dashboard-section { margin-top:12px; }
.dashboard-card {
  background:var(--surface); border:1.5px solid var(--border);
  border-radius:var(--r); padding:18px 18px 16px; box-shadow:var(--shadow);
}
.db-kpi-grid { display:flex; flex-direction:column; gap:8px; margin-bottom:14px; }
.db-kpi-card {
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 14px; border-radius:14px; font-size:12px; font-weight:800;
  border:1px solid var(--border);
}
.db-kpi-card.ok {
  background:rgba(5,150,105,.05); border-color:rgba(5,150,105,.2); color:var(--mint);
}
.db-kpi-card.warn {
  background:rgba(217,119,6,.05); border-color:rgba(217,119,6,.2); color:var(--amber);
}
.db-kpi-card.alert {
  background:rgba(225,29,72,.05); border-color:rgba(225,29,72,.2); color:var(--danger);
}
.db-tabs {
  display:grid; grid-template-columns:repeat(3,1fr); gap:6px;
  margin-bottom:14px; background:var(--s2); padding:4px; border-radius:14px;
  border:1px solid var(--border);
}
.db-tab {
  border:none; background:none; font-family:'Nunito',sans-serif;
  font-size:12px; font-weight:800; padding:8px; border-radius:10px;
  cursor:pointer; color:var(--muted); transition:all .2s;
}
.db-tab.active { background:var(--surface); color:var(--lav); box-shadow:var(--shadow); }
.db-chart-container { position:relative; width:100%; height:200px; }
.db-heat-cell {
  aspect-ratio:1; border-radius:2px;
  transition:transform .12s, outline .12s; cursor:pointer;
}
.db-heat-cell:hover { transform:scale(1.3); outline:1px solid var(--text); z-index:10; }

::-webkit-scrollbar { width:3px; }
::-webkit-scrollbar-thumb { background:var(--border); border-radius:2px; }

/* ── Cat editor overlay ── */
.cat-editor-overlay {
  position:fixed; inset:0; background:rgba(59,31,94,.35);
  z-index:150; display:flex; align-items:flex-end; justify-content:center;
  opacity:0; pointer-events:none; transition:opacity .25s;
  backdrop-filter:blur(4px);
}
.cat-editor-overlay.open { opacity:1; pointer-events:all; }
.cat-editor-sheet {
  background:var(--surface); border-radius:28px 28px 0 0;
  padding:8px 20px env(safe-area-inset-bottom,32px); width:100%; max-width:440px;
  transform:translateY(100%);
  transition:transform .35s cubic-bezier(.34,1.56,.64,1);
  box-shadow:0 -8px 40px rgba(139,92,246,.15);
  max-height:92vh; overflow-y:auto;
}
.cat-editor-overlay.open .cat-editor-sheet { transform:translateY(0); }
.cat-editor-title {
  font-size:16px; font-weight:800; text-align:center;
  margin-bottom:16px; color:var(--text);
}
.cat-editor-avatar-wrap {
  display:flex; align-items:center; justify-content:center;
  gap:16px; margin-bottom:20px;
}
.cat-editor-preview {
  width:72px; height:72px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-size:36px; background:var(--s2); overflow:hidden;
  flex-shrink:0; box-shadow:0 4px 16px rgba(0,0,0,.1);
}
.cat-editor-preview img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.cat-editor-field { margin-bottom:14px; }
.cat-editor-label {
  font-size:10px; font-weight:700; letter-spacing:1.5px;
  text-transform:uppercase; color:var(--muted);
  margin-bottom:7px; display:block;
}
.cat-editor-input {
  width:100%; padding:12px 14px; border:1.5px solid var(--border);
  border-radius:14px; font-family:'Nunito',sans-serif; font-size:14px;
  background:var(--s2); color:var(--text); outline:none;
  transition:border-color .2s;
}
.cat-editor-input:focus { border-color:var(--lav); }
.cat-editor-palette { display:flex; flex-wrap:wrap; gap:8px; }
.cef-swatch {
  width:32px; height:32px; border-radius:50%; border:2.5px solid transparent;
  cursor:pointer; transition:transform .15s;
}
.cef-swatch:hover { transform:scale(1.15); }
.cef-swatch.sel { border-color:var(--text); outline:2px solid var(--surface); outline-offset:-3px; }
.cat-editor-emoji-grid {
  display:grid; grid-template-columns:repeat(6,1fr); gap:6px;
  max-height:116px; overflow-y:auto;
}
.cat-editor-actions {
  display:grid; grid-template-columns:1fr 1fr;
  gap:10px; margin-top:20px;
}

/* ── Modal de gato ── */
.cat-modal-overlay {
  position:fixed; inset:0; background:rgba(59,31,94,.4);
  z-index:200; display:flex; align-items:flex-end; justify-content:center;
  opacity:0; pointer-events:none; transition:opacity .25s;
  backdrop-filter:blur(6px);
}
.cat-modal-overlay.open { opacity:1; pointer-events:all; }
.cat-modal {
  background:var(--surface); border-radius:28px 28px 0 0;
  width:100%; max-width:440px;
  transform:translateY(100%);
  transition:transform .35s cubic-bezier(.34,1.56,.64,1);
  box-shadow:0 -8px 40px rgba(139,92,246,.18);
  max-height:92vh; overflow-y:auto; overflow-x:hidden;
}
.cat-modal-overlay.open .cat-modal { transform:translateY(0); }
.cat-modal-handle {
  width:36px; height:4px; background:var(--border);
  border-radius:2px; margin:12px auto 0; display:block;
}
.cat-modal-header {
  display:flex; align-items:center; gap:14px;
  padding:16px 20px 14px; position:sticky; top:0;
  background:var(--surface); z-index:1;
  border-bottom:1.5px solid var(--border);
}
.cat-modal-avatar {
  width:52px; height:52px; border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-size:28px; flex-shrink:0; overflow:hidden;
  box-shadow:0 3px 12px rgba(0,0,0,.12);
}
.cat-modal-avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
.cat-modal-title { flex:1; min-width:0; }
.cat-modal-name { font-size:18px; font-weight:900; }
.cat-modal-sub  { font-size:12px; color:var(--muted); margin-top:2px; font-family:'DM Mono',monospace; }
.cat-modal-close {
  width:34px; height:34px; border-radius:50%; border:none;
  background:var(--s2); color:var(--muted); font-size:14px;
  cursor:pointer; display:flex; align-items:center; justify-content:center;
  transition:all .15s; flex-shrink:0;
}
.cat-modal-close:hover { background:var(--border); color:var(--text); }
.cat-modal-body { padding:16px 20px 32px; }
.cat-modal-stats {
  display:grid; grid-template-columns:repeat(4,1fr);
  gap:8px; margin-bottom:20px;
}
.cat-modal-stat {
  background:var(--s2); border:1px solid var(--border);
  border-radius:14px; padding:10px 6px; text-align:center;
}
.cat-modal-stat-val { font-size:16px; font-weight:900; line-height:1.1; }
.cat-modal-stat-label {
  font-size:9px; font-weight:700; letter-spacing:1px;
  text-transform:uppercase; color:var(--muted); margin-top:4px;
}
.cat-modal-section { margin-bottom:20px; }
.cat-modal-section-title {
  font-size:10px; font-weight:700; letter-spacing:1.5px;
  text-transform:uppercase; color:var(--muted);
  margin-bottom:10px; display:block;
}
.cat-modal-chart-wrap { position:relative; width:100%; height:140px; }
.cat-modal-chart-wrap.sm { height:110px; }
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

<div class="scale">
  <!-- Plataforma -->
  <div class="scale-platform" id="scale-platform">
    <span class="scale-paw-bg" id="scale-paw-bg">🐾</span>
    <div class="avatar-rig">
      <div class="scale-avatar idle" id="scale-avatar" style="background:#ede9fe">🐱</div>
      <div class="clean-overlay" id="clean-overlay">
        <div class="co-ring"></div>
        <div class="co-arm"><div class="co-arm-blade"></div></div>
        <div class="co-p" style="animation-delay:0s">
          <div class="co-dot" style="width:6px;height:6px;top:-50px;left:-3px;opacity:.9"></div>
        </div>
        <div class="co-p" style="animation-delay:-.10s">
          <div class="co-dot" style="width:5px;height:5px;top:-49px;left:-2.5px;opacity:.55"></div>
        </div>
        <div class="co-p" style="animation-delay:-.25s">
          <div class="co-dot" style="width:4px;height:4px;top:-48px;left:-2px;opacity:.28"></div>
        </div>
      </div>
    </div>
    <div class="scale-weight" id="scale-weight" style="display:none">—<span class="su"> lb</span></div>
    <div class="scale-label"  id="scale-label">Conectando…</div>
  </div>

  <!-- Panel de datos -->
  <div class="scale-panel">
    <div class="scale-stat">
      <div class="scale-stat-label">Peso</div>
      <div class="scale-stat-val" id="sp-weight">—</div>
    </div>
    <div class="scale-stat">
      <div class="scale-stat-label">Hace</div>
      <div class="scale-stat-val" id="sp-ago">—</div>
    </div>
    <div class="scale-stat">
      <div class="scale-stat-label">Duración</div>
      <div class="scale-stat-val" id="sp-dur">—</div>
    </div>
    <div class="scale-stat">
      <div class="scale-stat-label">Hoy</div>
      <div class="scale-stat-val" id="sp-uses">—</div>
    </div>
  </div>

  <!-- Botones -->
  <div class="scale-actions">
    <button class="btn btn-pink"      id="btn-clean"  onclick="doClean()"  disabled>⟳ Limpiar</button>
    <button class="btn btn-ghost-red" id="btn-cancel" onclick="doCancel()" disabled>✕ Cancelar</button>
  </div>
</div>


<button class="btn btn-ghost btn-refresh" onclick="fetchStatus()">↻ Actualizar estado</button>

<!-- Mis gatos -->
<div class="cats-section">
  <span class="section-label">Mis gatos</span>
  <div class="cats-grid" id="cats-grid"><!-- generado dinámicamente por renderCatCards() --></div>
</div>

<!-- Cat editor overlay -->
<input type="file" id="cat-editor-file" accept="image/*" style="display:none" onchange="handleCatEditorPhoto(this)">
<div class="cat-editor-overlay" id="cat-editor-overlay" onclick="closeCatEditor(event)">
  <div class="cat-editor-sheet">
    <div class="emoji-handle"></div>
    <div class="cat-editor-title" id="cat-editor-title">Agregar gato</div>
    <div class="cat-editor-avatar-wrap">
      <div class="cat-editor-preview" id="cat-editor-preview">🐱</div>
      <button class="btn btn-ghost" style="font-size:12px;padding:8px 14px" onclick="document.getElementById('cat-editor-file').click()">📷 Foto</button>
    </div>
    <div class="cat-editor-field">
      <label class="cat-editor-label">Nombre</label>
      <input type="text" id="cef-name" class="cat-editor-input" placeholder="Nombre del gato" maxlength="20">
    </div>
    <div class="cat-editor-field">
      <label class="cat-editor-label">Peso aproximado (kg)</label>
      <input type="number" id="cef-weight" class="cat-editor-input" step="0.1" min="0.5" max="20" placeholder="ej. 4.5">
    </div>
    <div class="cat-editor-field">
      <label class="cat-editor-label">Color</label>
      <div class="cat-editor-palette" id="cef-palette"></div>
    </div>
    <div class="cat-editor-field">
      <label class="cat-editor-label">Emoji</label>
      <div class="cat-editor-emoji-grid" id="cef-emoji-grid"></div>
    </div>
    <div class="cat-editor-actions">
      <button class="btn btn-ghost" onclick="closeCatEditor()">Cancelar</button>
      <button class="btn btn-pink" onclick="saveCatEditor()" id="cef-save-btn">Guardar</button>
    </div>
    <div id="cef-delete-zone" style="display:none;margin-top:10px;padding-bottom:6px;">
      <button class="btn" id="cef-delete-btn" onclick="deleteCatFromEditor()" style="width:100%;color:var(--danger);background:rgba(225,29,72,.07);border:1.5px solid rgba(225,29,72,.18);font-size:13px;">Eliminar gato</button>
    </div>
  </div>
</div>

<!-- Avatar picker -->
<input type="file" id="file-input" accept="image/*" style="display:none" onchange="handlePhoto(this)">
<div class="emoji-overlay" id="emoji-overlay" onclick="closePicker(event)">
  <div class="emoji-sheet">
    <div class="emoji-handle"></div>
    <div class="emoji-title" id="picker-title">Personalizar avatar</div>
    <button class="picker-upload" onclick="document.getElementById('file-input').click()">
      📷 Subir foto de tu gato
    </button>
    <div class="picker-divider">o elige un emoji</div>
    <div class="emoji-grid" id="emoji-grid"></div>
  </div>
</div>

<!-- Modal de gato -->
<div class="cat-modal-overlay" id="cat-modal-overlay" onclick="closeCatModal(event)">
  <div class="cat-modal">
    <span class="cat-modal-handle"></span>
    <div class="cat-modal-header">
      <div class="cat-modal-avatar" id="cma-avatar"></div>
      <div class="cat-modal-title">
        <div class="cat-modal-name" id="cma-name"></div>
        <div class="cat-modal-sub"  id="cma-sub"></div>
      </div>
      <button class="cat-modal-close" onclick="closeCatModal()">✕</button>
    </div>
    <div class="cat-modal-body">
      <div class="cat-modal-stats" id="cma-stats"></div>
      <div class="cat-modal-section">
        <span class="cat-modal-section-title">Peso últimos 30 días</span>
        <div class="cat-modal-chart-wrap"><canvas id="cma-weight-chart"></canvas></div>
      </div>
      <div class="cat-modal-section">
        <span class="cat-modal-section-title">Visitas últimos 7 días</span>
        <div class="cat-modal-chart-wrap sm"><canvas id="cma-activity-chart"></canvas></div>
      </div>
      <div class="cat-modal-section">
        <span class="cat-modal-section-title">Horas más activas</span>
        <div id="cma-heatmap"></div>
      </div>
    </div>
  </div>
</div>

<!-- Dashboard de Estadísticas -->
<div class="dashboard-section">
  <span class="section-label">Estadísticas y Salud 📊</span>
  <div class="dashboard-card">
    <!-- Health status alert list -->
    <div class="db-kpi-grid" id="db-kpi-list"></div>
    
    <!-- Tab navigation -->
    <div class="db-tabs">
      <button class="db-tab active" onclick="switchDbTab('weight', this)">Peso 📈</button>
      <button class="db-tab" onclick="switchDbTab('activity', this)">Actividad 📅</button>
      <button class="db-tab" onclick="switchDbTab('share', this)">Uso 🍩</button>
    </div>
    
    <!-- Chart canvas container -->
    <div class="db-chart-container">
      <canvas id="dbChart"></canvas>
    </div>
    
    <!-- Mapa de calor de hábitos horarios -->
    <div class="db-heatmap-section" style="margin-top:20px; border-top:1.5px solid var(--border); padding-top:16px;">
      <span class="scale-stat-label" style="font-size:10px; margin-bottom:12px; display:block;">Hábitos Horarios (24h) ⏰</span>
      <div id="db-heatmap-container"></div>
      
      <!-- Leyenda -->
      <div style="display:flex; justify-content:flex-end; align-items:center; gap:6px; margin-top:10px; font-size:9px; color:var(--muted);">
        <span>Menos activo</span>
        <div style="width:10px; height:10px; background:var(--muted); opacity:0.1; border-radius:2px;"></div>
        <div style="width:10px; height:10px; background:var(--lav); opacity:0.5; border-radius:2px;"></div>
        <div style="width:10px; height:10px; background:var(--lav); opacity:1; border-radius:2px;"></div>
        <span>Más activo</span>
      </div>
    </div>
  </div>
</div>

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
  <button class="hist-more" id="hist-more" style="display:none" onclick="verMas()">Ver más</button>
</div>

<div class="log-wrap">
  <div class="log-head">🗒 Log</div>
  <div class="log" id="log"></div>
</div>

</div><!-- .wrap -->

<script>
var _dbChart = null;
var _activeDbTab = 'weight';

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
function toKg(raw) { return (raw * 0.04536).toFixed(2); }
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

    _lastStatus = { mode: m.isnowmode, catWeight: m.cat_weight || 0, nocatinsec: m.nocatinsec };
    updateScale(_lastStatus.mode, _lastStatus.catWeight, _lastStatus.nocatinsec);

    if (m.excretion_times_day !== undefined)
      document.getElementById('sp-uses').textContent = m.excretion_times_day;

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

    log('Estado: ' + (m.isnowmode || '?'), 's');
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

// Último gato conocido (se actualiza con fetchHistory)
var _lastVisit  = null;
var _lastStatus = { mode: 'isidle', catWeight: 0, nocatinsec: null };
var _avatars    = {};
var _visits     = [];
var _expanded   = false;
var HIST_PAGE   = 10;

// ── Animación canvas de limpieza (va al fondo de la plataforma) ──────────────
var _cleanAnimId  = null;
var _cleanCanvas  = null;
var _cleanStopped = false;
var _cleanPaused  = false;

function stopCleanLoop() {
  _cleanStopped = true;
  if (_cleanAnimId) { cancelAnimationFrame(_cleanAnimId); _cleanAnimId = null; }
  if (_cleanCanvas) { _cleanCanvas.remove(); _cleanCanvas = null; }
}

// platformEl: el div .scale-platform (canvas queda detrás de avatar, peso y label)
// paused: true cuando un gato interrumpió la limpieza
function startCleanLoop(platformEl, paused) {
  if (_cleanCanvas && _cleanCanvas.parentElement === platformEl) {
    _cleanPaused = !!paused; return;
  }
  stopCleanLoop();
  _cleanStopped = false;
  _cleanPaused  = !!paused;

  var DPR = window.devicePixelRatio || 1;
  var W   = platformEl.offsetWidth  || 300;
  var H   = platformEl.offsetHeight || 185;

  var canvas = document.createElement('canvas');
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;border-radius:inherit';
  platformEl.insertBefore(canvas, platformEl.firstChild);
  _cleanCanvas = canvas;

  var ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  function drawPaw(x, y, sz, color, angle) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, sz*.15, sz*.65, sz*.5, 0, 0, Math.PI*2); ctx.fill();
    [[-0.55,-0.65],[-0.18,-0.95],[0.18,-0.95],[0.55,-0.65]].forEach(function(d) {
      ctx.beginPath();
      ctx.ellipse(d[0]*sz, d[1]*sz, sz*.22, sz*.28, 0, 0, Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }

  var PCOLS = ['rgba(100,75,45,.7)','rgba(82,60,35,.65)','rgba(115,88,55,.68)','rgba(90,68,40,.60)'];

  // Huellas: aparecen detrás de la hoja y tienen vida propia (sin fases abruptas)
  var paws = [];
  var wx = -40;
  var lastSpawnX = -40;
  var SPEED     = W / 210;   // ~3.5 s para cruzar toda la plataforma a 60 fps
  var SPAWN_GAP = W / 9;     // ~9 huellas por pasada

  function spawnPaw() {
    paws.push({
      x:     Math.max(14, Math.min(W-14, wx + (Math.random()-0.6)*50)),
      y:     14 + Math.random() * (H - 28),
      sz:    11 + Math.random() * 9,
      color: PCOLS[Math.floor(Math.random() * PCOLS.length)],
      angle: (Math.random() - 0.5) * 1.1,
      age:   0,
      life:  170 + Math.floor(Math.random() * 80),
    });
  }

  function pawOp(p) {
    var t = p.age / p.life;
    if (t < 0.15) return t / 0.15;           // fade-in rápido
    if (t < 0.65) return 1;                   // meseta visible
    return 1 - (t - 0.65) / 0.35;            // fade-out suave
  }

  function render() {
    ctx.clearRect(0, 0, W, H);

    paws.forEach(function(p) {
      var op = pawOp(p);
      if (op < 0.01) return;
      ctx.save(); ctx.globalAlpha = op;
      drawPaw(p.x, p.y, p.sz, p.color, p.angle);
      ctx.restore();
    });

    // Halo de la hoja: suave, sin línea dura
    if (wx > -50 && wx < W + 50) {
      var gc = _cleanPaused ? 'rgba(245,158,11,' : 'rgba(16,185,129,';
      var g1 = ctx.createLinearGradient(wx-44, 0, wx+44, 0);
      g1.addColorStop(0,   gc+'0)');
      g1.addColorStop(0.38,gc+'.05)');
      g1.addColorStop(0.5, gc+'.20)');
      g1.addColorStop(0.62,gc+'.05)');
      g1.addColorStop(1,   gc+'0)');
      ctx.fillStyle = g1; ctx.fillRect(wx-44, 0, 88, H);
      var g2 = ctx.createLinearGradient(wx-3, 0, wx+3, 0);
      g2.addColorStop(0,   gc+'0)');
      g2.addColorStop(0.5, gc+'.50)');
      g2.addColorStop(1,   gc+'0)');
      ctx.fillStyle = g2; ctx.fillRect(wx-3, 0, 6, H);
    }
  }

  function update() {
    if (_cleanPaused) return;

    wx += SPEED;

    if (wx - lastSpawnX >= SPAWN_GAP) {
      spawnPaw();
      lastSpawnX = wx;
    }

    // Hoja llega al borde → resetea al inicio (huellas existentes siguen su ciclo)
    if (wx > W + 40) {
      wx = -40;
      lastSpawnX = -40;
    }

    paws.forEach(function(p) { p.age++; });
    paws = paws.filter(function(p) { return p.age < p.life; });
  }

  function loop() {
    if (_cleanStopped) return;
    update(); render();
    _cleanAnimId = requestAnimationFrame(loop);
  }
  loop();
}

function updateScale(mode, catWeight, nocatinsec) {
  var platform = document.getElementById('scale-platform');
  var avatar   = document.getElementById('scale-avatar');
  var weightEl = document.getElementById('scale-weight');
  var labelEl  = document.getElementById('scale-label');
  var pawBg    = document.getElementById('scale-paw-bg');

  var catOnScale = catWeight > 0;

  // ── Gato encima DURANTE limpieza (arenera pausada) ──
  // Canvas al fondo de la plataforma, congelado; foto del gato en el avatar
  if (catOnScale && mode === 'isclean') {
    startCleanLoop(platform, true); // lanza o congela el canvas de fondo
    platform.className = 'scale-platform cleaning';
    pawBg.style.display = 'none';
    var catP = identifyCat(catWeight);
    avatar.className = 'scale-avatar paused';
    avatar.style.background = catP ? catP.bg : '#fef3c7';
    avatar.style.opacity = '';
    var photoP = catP ? getPhoto(catP.name) : null;
    avatar.innerHTML = photoP ? '<img src="' + photoP + '">' : (catP ? getEmoji(catP.name) : '🐱');
    weightEl.style.display = 'block';
    weightEl.innerHTML = toKg(catWeight) + '<span class="su"> kg</span>';
    labelEl.textContent = (catP ? catP.name : 'Gato') + ' · pausó limpieza';

  // ── Gato encima de la báscula (uso normal) ──
  } else if (catOnScale) {
    stopCleanLoop();
    var cat = identifyCat(catWeight);
    platform.className = 'scale-platform active';
    pawBg.style.display = 'none';
    avatar.className = 'scale-avatar';
    avatar.style.background = cat ? cat.bg : '#ede9fe';
    avatar.style.opacity = '';
    var photo = cat ? getPhoto(cat.name) : null;
    avatar.innerHTML = photo ? '<img src="' + photo + '">' : (cat ? getEmoji(cat.name) : '🐱');
    weightEl.style.display = 'block';
    weightEl.innerHTML = toKg(catWeight) + '<span class="su"> kg</span>';
    labelEl.textContent = cat ? cat.name : 'Gato detectado';

  // ── Limpiando ──
  // Canvas al fondo de la plataforma (gradiente morado visible debajo);
  // foto/emoji del último gato permanece visible en el avatar encima
  } else if (mode === 'isclean') {
    startCleanLoop(platform, false); // huellas + paleta detrás de todo
    platform.className = 'scale-platform cleaning';
    pawBg.style.display = 'none';
    var cat2 = _lastVisit ? CATS.find(function(c) { return c.name === _lastVisit.catName; }) : null;
    avatar.className = 'scale-avatar cleaning';
    avatar.style.opacity = '';
    if (cat2) {
      avatar.style.background = cat2.bg;
      var p2 = getPhoto(cat2.name);
      avatar.innerHTML = p2 ? '<img src="' + p2 + '">' : getEmoji(cat2.name);
    } else {
      avatar.style.background = '#ede9fe';
      avatar.innerHTML = '🧹';
    }
    weightEl.style.display = 'none';
    labelEl.textContent = 'Limpiando… ✨';

  // ── Nivelando ──
  } else if (mode === 'idlevelling') {
    stopCleanLoop();
    platform.className = 'scale-platform levelling';
    avatar.className = 'scale-avatar';
    avatar.innerHTML = '⚖️';
    avatar.style.background = '#fef3c7';
    avatar.style.opacity = '1';
    pawBg.style.display = 'none';
    weightEl.style.display = 'none';
    labelEl.textContent = 'Nivelando…';

  // ── En reposo — mostrar último gato ──
  } else {
    stopCleanLoop();
    platform.className = 'scale-platform';
    pawBg.style.display = _lastVisit ? 'none' : 'block';
    weightEl.style.display = 'none';
    if (_lastVisit) {
      var cat3 = CATS.find(function(c) { return c.name === _lastVisit.catName; });
      if (cat3) {
        avatar.className = 'scale-avatar idle';
        avatar.style.background = cat3.bg;
        avatar.style.opacity = '.55';
        var p3 = getPhoto(cat3.name);
        avatar.innerHTML = p3 ? '<img src="' + p3 + '">' : getEmoji(cat3.name);
        labelEl.textContent = 'En reposo';
      }
    } else {
      avatar.className = 'scale-avatar idle';
      avatar.innerHTML = '🐱';
      labelEl.textContent = 'En reposo';
    }
  }

  // ── Panel inferior ──
  var secs = _lastVisit ? Math.round((Date.now() - _lastVisit.ts) / 1000)
           : (nocatinsec !== undefined ? nocatinsec : null);
  document.getElementById('sp-weight').textContent = catOnScale
    ? toKg(catWeight) + ' kg'
    : (_lastVisit && _lastVisit.weight ? toKg(_lastVisit.weight) + ' kg' : '—');
  document.getElementById('sp-ago').textContent = secs ? timeAgo(secs) : '—';
  document.getElementById('sp-dur').textContent = (_lastVisit && _lastVisit.duration)
    ? (_lastVisit.duration < 60 ? _lastVisit.duration + 's' : Math.round(_lastVisit.duration / 60) + ' min')
    : '—';
}

// Perfiles de gatos — cargados dinámicamente desde /api/cats
var CATS = [];

var PALETTE = [
  { bg:'#ccfbf1', accent:'#2dd4bf', label:'Teal'     },
  { bg:'#fce7f6', accent:'#ec4899', label:'Rosa'      },
  { bg:'#ede9fe', accent:'#8b5cf6', label:'Lavanda'   },
  { bg:'#fed7aa', accent:'#f97316', label:'Naranja'   },
  { bg:'#d1fae5', accent:'#059669', label:'Verde'     },
  { bg:'#e0f2fe', accent:'#0ea5e9', label:'Cielo'     },
  { bg:'#fce7f3', accent:'#f43f5e', label:'Coral'     },
  { bg:'#fef9c3', accent:'#ca8a04', label:'Amarillo'  },
  { bg:'#e0e7ff', accent:'#6366f1', label:'Índigo'    },
  { bg:'#ecfccb', accent:'#65a30d', label:'Lima'      },
];

var CAT_EMOJIS = [
  '🐱','😸','😺','😻','😼','😽','🙀','😿','😾','😹',
  '🐈','🐈‍⬛','🦁','🐯','🐆','🦊','🐻','🐼','🐨','🦝',
  '👑','🌸','⭐','🌙','🌟','☀️','🌈','💜','🩷','🧡',
];

function getEmoji(name) {
  var cat = CATS.find(function(c) { return c.name === name; });
  if (_avatars[name] && _avatars[name].emoji) return _avatars[name].emoji;
  var stored = localStorage.getItem('emoji_' + name);
  if (stored) return stored;
  return (cat && cat.emoji) || '🐱';
}
function getPhoto(name) {
  var cat = CATS.find(function(c) { return c.name === name; });
  if (cat && cat.photo) return cat.photo;
  return (_avatars[name] && _avatars[name].photo) || localStorage.getItem('photo_' + name) || null;
}

async function loadCats() {
  try {
    var d = await api('GET', '/cats');
    if (d.success && d.result) {
      CATS = d.result.map(function(c) {
        return { name:c.name, targetRaw:c.targetRaw, bg:c.bg, accent:c.accent, emoji:c.emoji||'🐱', photo:c.photo||null };
      });
    }
  } catch(e) {}
}

function renderCatCards() {
  var grid = document.getElementById('cats-grid');
  if (!grid) return;
  grid.innerHTML = '';
  CATS.forEach(function(cat) {
    var photo    = getPhoto(cat.name);
    var avatarIn = photo
      ? '<img src="' + photo + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'
      : cat.emoji;
    var card = document.createElement('div');
    card.className = 'cat-card';
    card.id = 'cat-' + cat.name;
    card.innerHTML =
      '<button class="cat-card-edit-btn" title="Editar">✎</button>' +
      '<div class="cat-avatar-btn" style="background:' + cat.bg + '">' + avatarIn + '</div>' +
      '<div class="cat-card-name">' + cat.name + '</div>' +
      '<div><span class="cat-card-weight" id="w-' + cat.name + '">—</span><span class="cat-card-unit"> kg</span></div>' +
      '<div class="cat-card-meta" id="m-' + cat.name + '">cargando…</div>';
    card.onclick = function() { openCatModal(cat.name); };
    card.querySelector('.cat-card-edit-btn').onclick = function(ev) {
      ev.stopPropagation(); openCatEditor(cat.name);
    };
    grid.appendChild(card);
  });
  // "+" add card
  var addCard = document.createElement('div');
  addCard.className = 'cat-card-add';
  addCard.innerHTML = '<div class="cat-card-add-icon">＋</div><div class="cat-card-add-label">Agregar gato</div>';
  addCard.onclick = function() { openCatEditor(null); };
  grid.appendChild(addCard);
}

function renderCatMgrList() { /* removed — edit/delete now live in cat cards */ }

async function loadAvatars() {
  try {
    var d = await api('GET', '/avatars');
    if (d.success) {
      _avatars = d.result || {};
      Object.keys(_avatars).forEach(function(name) {
        var a = _avatars[name];
        if (a.photo) { localStorage.setItem('photo_' + name, a.photo); localStorage.removeItem('emoji_' + name); }
        else if (a.emoji) { localStorage.setItem('emoji_' + name, a.emoji); localStorage.removeItem('photo_' + name); }
      });
    }
  } catch(e) {}
}

function setAvatarEl(btn, name) {
  var photo = getPhoto(name);
  if (photo) {
    btn.textContent = '';
    var img = document.createElement('img');
    img.src = photo;
    btn.appendChild(img);
  } else {
    btn.innerHTML = getEmoji(name);
  }
}

function handlePhoto(input) {
  if (!input.files || !input.files[0] || !_editingCat) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var image = new Image();
    image.onload = function() {
      var canvas = document.createElement('canvas');
      var size   = 200;
      canvas.width = size; canvas.height = size;
      var ctx = canvas.getContext('2d');
      var s   = Math.min(image.width, image.height);
      var sx  = (image.width  - s) / 2;
      var sy  = (image.height - s) / 2;
      ctx.drawImage(image, sx, sy, s, s, 0, 0, size, size);
      var data = canvas.toDataURL('image/jpeg', 0.75);
      localStorage.setItem('photo_' + _editingCat, data);
      if (!_avatars[_editingCat]) _avatars[_editingCat] = {};
      _avatars[_editingCat] = { photo: data, emoji: null };
      var catObjP = CATS.find(function(c) { return c.name === _editingCat; });
      if (catObjP) { catObjP.photo = data; catObjP.emoji = null; }
      api('POST', '/avatar/' + _editingCat, { photo: data }).catch(function(){});
      var btn = document.querySelector('#cat-' + _editingCat + ' .cat-avatar-btn');
      if (btn) setAvatarEl(btn, _editingCat);
      input.value = '';
      closePicker();
      fetchHistory();
    };
    image.src = e.target.result;
  };
  reader.readAsDataURL(input.files[0]);
}

function identifyCat(weight) {
  if (!weight || weight <= 0 || !CATS.length) return null;
  var best = CATS[0], bestDist = Math.abs(weight - CATS[0].targetRaw);
  for (var i = 1; i < CATS.length; i++) {
    var d = Math.abs(weight - CATS[i].targetRaw);
    if (d < bestDist) { bestDist = d; best = CATS[i]; }
  }
  return best;
}

// ── Emoji picker ──
var _editingCat = null;

function openPicker(catName) {
  _editingCat = catName;
  var current = getEmoji(catName);
  document.getElementById('picker-title').textContent = 'Emoji para ' + catName;
  var grid = document.getElementById('emoji-grid');
  grid.innerHTML = '';
  CAT_EMOJIS.forEach(function(e) {
    var btn = document.createElement('button');
    btn.className = 'emoji-opt' + (e === current ? ' sel' : '');
    btn.textContent = e;
    btn.onclick = function(ev) { ev.stopPropagation(); pickEmoji(e); };
    grid.appendChild(btn);
  });
  document.getElementById('emoji-overlay').classList.add('open');
}

function pickEmoji(emoji) {
  if (!_editingCat) return;
  localStorage.setItem('emoji_' + _editingCat, emoji);
  localStorage.removeItem('photo_' + _editingCat);
  if (!_avatars[_editingCat]) _avatars[_editingCat] = {};
  _avatars[_editingCat] = { emoji: emoji, photo: null };
  var catObj = CATS.find(function(c) { return c.name === _editingCat; });
  if (catObj) { catObj.emoji = emoji; catObj.photo = null; }
  api('POST', '/avatar/' + _editingCat, { emoji: emoji }).catch(function(){});
  var btn = document.querySelector('#cat-' + _editingCat + ' .cat-avatar-btn');
  if (btn) setAvatarEl(btn, _editingCat);
  closePicker();
  fetchHistory();
}

function closePicker(e) {
  if (e && e.target !== document.getElementById('emoji-overlay')) return;
  document.getElementById('emoji-overlay').classList.remove('open');
  _editingCat = null;
}

function initCatEmojis() {
  CATS.forEach(function(cat) {
    var btn = document.querySelector('#cat-' + cat.name + ' .cat-avatar-btn');
    if (btn) setAvatarEl(btn, cat.name);
  });
}

async function fetchHistory() {
  try {
    var d = await api('GET', '/visits');
    if (!d.success) return;
    _visits = d.result || [];

    // ── Stats por gato ──
    var today   = new Date(); today.setHours(0,0,0,0);
    var weekAgo = today.getTime() - 6 * 24 * 60 * 60 * 1000; // hoy + 6 días atrás = 7 días
    var stats = {};
    CATS.forEach(function(c) { stats[c.name] = { visits7d:0, visitsToday:0, lastTs:0, lastW:0 }; });
    _visits.forEach(function(v) {
      var cat = identifyCat(v.weight);
      if (!cat) return;
      var s = stats[cat.name];
      if (v.ts >= weekAgo)        s.visits7d++;
      if (v.ts >= today.getTime()) s.visitsToday++;
      if (v.ts > s.lastTs) { s.lastTs = v.ts; s.lastW = v.weight; }
    });
    CATS.forEach(function(cat) {
      var s = stats[cat.name];
      var wEl = document.getElementById('w-' + cat.name);
      var mEl = document.getElementById('m-' + cat.name);
      if (wEl) wEl.textContent = s.lastW ? toKg(s.lastW) : '—';
      if (mEl) {
        var todayTxt = s.visitsToday + ' hoy · ' + s.visits7d + ' esta semana';
        var lastTxt  = s.lastTs ? fmtTime(s.lastTs).ago : 'sin visitas';
        mEl.textContent = todayTxt + ' · ' + lastTxt;
      }
    });

    // ── Guardar último gato y refrescar escala ──
    if (_visits.length) {
      var firstCat = identifyCat(_visits[0].weight);
      if (firstCat) {
        _lastVisit = { catName: firstCat.name, ts: _visits[0].ts, duration: _visits[0].duration, weight: _visits[0].weight };
        updateScale(_lastStatus.mode, _lastStatus.catWeight, _lastStatus.nocatinsec);
      }
    }

    renderVisits();
    updateDashboard();
  } catch(e) {}
}

function renderVisits() {
  var list  = document.getElementById('hist-list');
  var count = document.getElementById('hist-count');
  var more  = document.getElementById('hist-more');
  if (!_visits.length) return;

  var limit = _expanded ? _visits.length : HIST_PAGE;
  var slice = _visits.slice(0, limit);

  count.textContent = _visits.length + ' visitas registradas';
  list.innerHTML = '';
  slice.forEach(function(v) {
    var t   = fmtTime(v.ts);
    var cat = identifyCat(v.weight);
    var kg  = v.weight ? toKg(v.weight) : '—';
    var photo    = cat ? getPhoto(cat.name) : null;
    var avatarIn = photo
      ? '<img src="' + photo + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'
      : (cat ? getEmoji(cat.name) : '🐱');
    var durTxt = '';
    if (v.duration) {
      durTxt = v.duration < 60
        ? ' · ' + v.duration + 's'
        : ' · ' + Math.round(v.duration / 60) + ' min';
    }
    var row = document.createElement('div');
    row.className = 'visit-row';
    row.innerHTML =
      '<div class="visit-avatar" style="background:' + (cat ? cat.bg : '#f3f4f6') + '">' + avatarIn + '</div>' +
      '<div class="visit-info">' +
        '<div class="visit-time">' +
          (cat ? '<span class="cat-name" style="color:' + cat.accent + '">' + cat.name + '</span> · ' : '') +
          t.label +
        '</div>' +
        '<div class="visit-ago">' + t.ago + durTxt + '</div>' +
      '</div>' +
      '<div class="visit-weight">' + kg + '<small> kg</small></div>';
    list.appendChild(row);
  });

  if (!_expanded && _visits.length > HIST_PAGE) {
    more.textContent = 'Ver más (' + (_visits.length - HIST_PAGE) + ' restantes)';
    more.style.display = 'block';
    more.disabled = false;
  } else {
    more.style.display = 'none';
  }
}

async function verMas() {
  var more = document.getElementById('hist-more');
  more.textContent = 'Actualizando…';
  more.disabled = true;
  _expanded = true;
  await fetchHistory();
}

function updateDashboard() {
  updateHealthAlerts();
  renderDbChart();
  renderHeatmaps();
}

function renderHeatmaps() {
  var container = document.getElementById('db-heatmap-container');
  if (!container) return;
  container.innerHTML = '';
  
  if (!_visits || _visits.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--muted);text-align:center;padding:10px;">Sin datos de visitas</div>';
    return;
  }
  
  var header = document.createElement('div');
  header.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:4px;';
  
  var dummy = document.createElement('div');
  dummy.style.cssText = 'width:55px; flex-shrink:0;';
  header.appendChild(dummy);
  
  var gridHeader = document.createElement('div');
  gridHeader.style.cssText = 'display:grid; grid-template-columns:repeat(24, 1fr); gap:2px; flex:1; font-family:"DM Mono",monospace; font-size:8px; color:var(--muted); text-align:center;';
  
  for (var h = 0; h < 24; h++) {
    var span = document.createElement('span');
    if (h === 0) span.textContent = '0';
    else if (h === 6) span.textContent = '6';
    else if (h === 12) span.textContent = '12';
    else if (h === 18) span.textContent = '18';
    else if (h === 23) span.textContent = '23';
    gridHeader.appendChild(span);
  }
  header.appendChild(gridHeader);
  container.appendChild(header);
  
  CATS.forEach(function(cat) {
    var counts = Array(24).fill(0);
    _visits.forEach(function(v) {
      var vCat = identifyCat(v.weight);
      if (vCat && vCat.name === cat.name) {
        var hour = new Date(v.ts).getHours();
        counts[hour]++;
      }
    });
    
    var maxVal = Math.max.apply(Math, counts);
    
    var row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:6px;';
    
    var nameLabel = document.createElement('div');
    nameLabel.style.cssText = 'width:55px; font-size:11px; font-weight:800; color:' + cat.accent + '; flex-shrink:0; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;';
    nameLabel.textContent = cat.name + ' ' + getEmoji(cat.name);
    row.appendChild(nameLabel);
    
    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(24, 1fr); gap:2px; flex:1;';
    
    for (var h = 0; h < 24; h++) {
      var val = counts[h];
      var cell = document.createElement('div');
      cell.className = 'db-heat-cell';
      
      var opacity = 0.02;
      var color = 'var(--border)';
      if (val > 0) {
        color = cat.accent;
        opacity = 0.05 + (val / maxVal) * 0.95;
      }
      
      cell.style.backgroundColor = color;
      cell.style.opacity = opacity;
      cell.title = cat.name + ' · ' + String(h).padStart(2, '0') + ':00h\\n' + val + ' visita(s)';
      grid.appendChild(cell);
    }
    
    row.appendChild(grid);
    container.appendChild(row);
  });
}

function updateHealthAlerts() {
  var list = document.getElementById('db-kpi-list');
  if (!list) return;
  list.innerHTML = '';

  var now = Date.now();
  var alertsCount = 0;
  
  var lastVisits = {};
  CATS.forEach(function(c) { lastVisits[c.name] = null; });
  
  _visits.forEach(function(v) {
    var cat = identifyCat(v.weight);
    if (cat && lastVisits[cat.name] === null) {
      lastVisits[cat.name] = v.ts;
    }
  });

  CATS.forEach(function(cat) {
    var lastTs = lastVisits[cat.name];
    var card = document.createElement('div');
    
    if (lastTs === null) {
      card.className = 'db-kpi-card warn';
      card.innerHTML = '<span>' + getEmoji(cat.name) + ' ' + cat.name + ': sin visitas registrada</span> <span class="alert-icon">⚠️</span>';
      list.appendChild(card);
      alertsCount++;
    } else {
      var hoursElapsed = (now - lastTs) / (3600 * 1000);
      if (hoursElapsed > 18) {
        card.className = 'db-kpi-card alert';
        var agoText = hoursElapsed < 24 ? Math.round(hoursElapsed) + 'h' : Math.round(hoursElapsed / 24) + 'd';
        card.innerHTML = '<span>' + getEmoji(cat.name) + ' ' + cat.name + ': inactivo hace ' + agoText + '</span> <span class="alert-icon">🚨</span>';
        list.appendChild(card);
        alertsCount++;
      }
    }
  });

  if (alertsCount === 0) {
    var okCard = document.createElement('div');
    okCard.className = 'db-kpi-card ok';
    okCard.innerHTML = '<span>😺 Todos los gatos saludables</span> <span class="alert-icon">✅</span>';
    list.appendChild(okCard);
  }
}

function renderDbChart() {
  var ctx = document.getElementById('dbChart');
  if (!ctx) return;
  
  if (_dbChart) {
    _dbChart.destroy();
    _dbChart = null;
  }
  
  if (!_visits || _visits.length === 0) {
    return;
  }
  
  var chartConfig = {};
  if (_activeDbTab === 'weight') {
    var days = 30;
    var dateKeys = [];
    var labels = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      dateKeys.push(y + '-' + m + '-' + day);
      labels.push(d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }));
    }
    
    var dataByCat = {};
    CATS.forEach(function(c) {
      dataByCat[c.name] = {};
      dateKeys.forEach(function(k) { dataByCat[c.name][k] = []; });
    });

    _visits.forEach(function(v) {
      var cat = identifyCat(v.weight);
      if (!cat) return;
      var d = new Date(v.ts);
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      var key = y + '-' + m + '-' + day;
      if (dataByCat[cat.name][key]) {
        dataByCat[cat.name][key].push(parseFloat(toKg(v.weight)));
      }
    });

    var datasets = CATS.map(function(cat) {
      var data = dateKeys.map(function(k) {
        var arr = dataByCat[cat.name][k];
        if (!arr || arr.length === 0) return null;
        return Math.max.apply(Math, arr);
      });
      
      return {
        label: cat.name,
        data: data,
        borderColor: cat.accent,
        backgroundColor: cat.bg,
        borderWidth: 2.5,
        pointRadius: 2.5,
        pointHoverRadius: 4.5,
        tension: 0.3,
        spanGaps: true
      };
    });
    
    chartConfig = {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { family: 'Nunito', weight: 'bold', size: 10 } } },
          tooltip: {
            callbacks: {
              label: function(context) {
                return context.dataset.label + ': ' + context.parsed.y.toFixed(2) + ' kg';
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'Nunito', size: 8 } } },
          y: {
            ticks: { font: { family: 'Nunito', size: 8 } },
            title: { display: true, text: 'Peso (kg)', font: { family: 'Nunito', size: 9, weight: 'bold' } }
          }
        }
      }
    };
    
  } else if (_activeDbTab === 'activity') {
    var days = 7;
    var dateKeys = [];
    var labels = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      dateKeys.push(y + '-' + m + '-' + day);
      labels.push(d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }));
    }
    
    var countsByCat = {};
    CATS.forEach(function(c) {
      countsByCat[c.name] = {};
      dateKeys.forEach(function(k) { countsByCat[c.name][k] = 0; });
    });

    _visits.forEach(function(v) {
      var cat = identifyCat(v.weight);
      if (!cat) return;
      var d = new Date(v.ts);
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      var key = y + '-' + m + '-' + day;
      if (countsByCat[cat.name][key] !== undefined) {
        countsByCat[cat.name][key]++;
      }
    });

    var datasets = CATS.map(function(cat) {
      return {
        label: cat.name,
        data: dateKeys.map(function(k) { return countsByCat[cat.name][k]; }),
        backgroundColor: cat.accent,
        borderRadius: 4
      };
    });
    
    chartConfig = {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, font: { family: 'Nunito', weight: 'bold', size: 10 } } }
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { family: 'Nunito', size: 9 } } },
          y: { stacked: true, ticks: { precision: 0, font: { family: 'Nunito', size: 9 } }, title: { display: true, text: 'Visitas', font: { family: 'Nunito', size: 9, weight: 'bold' } } }
        }
      }
    };
    
  } else if (_activeDbTab === 'share') {
    var totals = {};
    CATS.forEach(function(c) { totals[c.name] = 0; });

    _visits.forEach(function(v) {
      var cat = identifyCat(v.weight);
      if (cat) totals[cat.name]++;
    });

    var data = CATS.map(function(c) { return totals[c.name]; });
    var labels = CATS.map(function(c) { return c.name; });
    var bgColors = CATS.map(function(c) { return c.accent; });
    
    chartConfig = {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: bgColors,
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, font: { family: 'Nunito', weight: 'bold', size: 10 } } }
        },
        cutout: '60%'
      }
    };
  }
  
  _dbChart = new Chart(ctx, chartConfig);
}

function switchDbTab(tab, btn) {
  _activeDbTab = tab;
  var tabs = document.querySelectorAll('.db-tab');
  tabs.forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
  renderDbChart();
}

// ── Cat editor ────────────────────────────────────────────────────────────────
var _editingCatOrigName = null;
var _cefPhoto = null;

function openCatEditor(name) {
  _editingCatOrigName = name;
  _cefPhoto = null;
  document.getElementById('cat-editor-file').value = '';
  var isEdit = !!name;
  document.getElementById('cat-editor-title').textContent = isEdit ? 'Editar gato' : 'Agregar gato';
  var cat = isEdit ? CATS.find(function(c) { return c.name === name; }) : null;
  document.getElementById('cef-name').value   = cat ? cat.name : '';
  document.getElementById('cef-weight').value = cat ? (cat.targetRaw * 0.04536).toFixed(1) : '';

  var preview = document.getElementById('cat-editor-preview');
  var photo = cat ? getPhoto(cat.name) : null;
  if (photo) {
    _cefPhoto = photo;
    preview.innerHTML = '<img src="' + photo + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
  } else {
    preview.innerHTML = (cat && cat.emoji) ? cat.emoji : '🐱';
  }
  preview.style.background = cat ? cat.bg : PALETTE[0].bg;

  var selBg = cat ? cat.bg : PALETTE[0].bg;
  var paletteEl = document.getElementById('cef-palette');
  paletteEl.innerHTML = '';
  PALETTE.forEach(function(p) {
    var btn = document.createElement('button');
    btn.className = 'cef-swatch' + (p.bg === selBg ? ' sel' : '');
    btn.style.background = p.accent;
    btn.title = p.label;
    btn.onclick = function(ev) {
      ev.stopPropagation();
      document.querySelectorAll('.cef-swatch').forEach(function(b) { b.classList.remove('sel'); });
      btn.classList.add('sel');
      document.getElementById('cat-editor-preview').style.background = p.bg;
    };
    paletteEl.appendChild(btn);
  });

  var selEmoji = (cat && cat.emoji) || '🐱';
  var emojiGrid = document.getElementById('cef-emoji-grid');
  emojiGrid.innerHTML = '';
  CAT_EMOJIS.forEach(function(e) {
    var btn = document.createElement('button');
    btn.className = 'emoji-opt' + (e === selEmoji ? ' sel' : '');
    btn.textContent = e;
    btn.onclick = function(ev) {
      ev.stopPropagation();
      document.querySelectorAll('#cef-emoji-grid .emoji-opt').forEach(function(b) { b.classList.remove('sel'); });
      btn.classList.add('sel');
      _cefPhoto = null;
      document.getElementById('cat-editor-file').value = '';
      document.getElementById('cat-editor-preview').innerHTML = e;
    };
    emojiGrid.appendChild(btn);
  });

  var delZone = document.getElementById('cef-delete-zone');
  var delBtn  = document.getElementById('cef-delete-btn');
  if (delZone) delZone.style.display = isEdit ? 'block' : 'none';
  if (delBtn)  { delBtn.dataset.confirm = '0'; delBtn.textContent = 'Eliminar gato'; delBtn.disabled = false; }

  document.getElementById('cat-editor-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCatEditor(e) {
  if (e && e.target !== document.getElementById('cat-editor-overlay')) return;
  document.getElementById('cat-editor-overlay').classList.remove('open');
  document.body.style.overflow = '';
  _editingCatOrigName = null;
  _cefPhoto = null;
}

function handleCatEditorPhoto(input) {
  if (!input.files || !input.files[0]) return;
  var reader = new FileReader();
  reader.onload = function(evt) {
    var image = new Image();
    image.onload = function() {
      var canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 200;
      var ctx = canvas.getContext('2d');
      var s = Math.min(image.width, image.height);
      ctx.drawImage(image, (image.width-s)/2, (image.height-s)/2, s, s, 0, 0, 200, 200);
      _cefPhoto = canvas.toDataURL('image/jpeg', 0.75);
      var preview = document.getElementById('cat-editor-preview');
      preview.innerHTML = '<img src="' + _cefPhoto + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
    };
    image.src = evt.target.result;
  };
  reader.readAsDataURL(input.files[0]);
}

async function saveCatEditor() {
  var name     = document.getElementById('cef-name').value.trim();
  var weightKg = parseFloat(document.getElementById('cef-weight').value);
  if (!name)                           { alert('El nombre es requerido'); return; }
  if (!weightKg || weightKg <= 0)      { alert('Ingresa un peso válido'); return; }
  if (CATS.length >= 12 && !_editingCatOrigName) { alert('Máximo 12 gatos'); return; }

  var swatches  = document.querySelectorAll('.cef-swatch');
  var selSwatch = document.querySelector('.cef-swatch.sel');
  var palIdx    = selSwatch ? Array.from(swatches).indexOf(selSwatch) : 0;
  var pal       = PALETTE[palIdx] || PALETTE[0];

  var selEmojiBtn = document.querySelector('#cef-emoji-grid .emoji-opt.sel');
  var emoji = selEmojiBtn ? selEmojiBtn.textContent : '🐱';

  var saveBtn = document.getElementById('cef-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando…';
  try {
    var d = await api('POST', '/cats/save', {
      originalName: _editingCatOrigName || null,
      name:     name,
      targetKg: weightKg,
      bg:       pal.bg,
      accent:   pal.accent,
      emoji:    _cefPhoto ? null : emoji,
      photo:    _cefPhoto || null,
    });
    if (!d.success) throw new Error(d.msg || 'Error al guardar');
    closeCatEditor();
    await loadCats();
    renderCatCards();
    renderCatMgrList();
    initCatEmojis();
    await fetchHistory();
  } catch(err) {
    alert('Error: ' + err.message);
  }
  saveBtn.disabled = false;
  saveBtn.textContent = 'Guardar';
}

async function deleteCatConfirm(name, btnEl) {
  if (btnEl.dataset.confirm !== '1') {
    btnEl.dataset.confirm = '1';
    btnEl.textContent = '¿Seguro?';
    btnEl.style.color = 'var(--danger)';
    setTimeout(function() {
      if (btnEl.dataset.confirm === '1') { btnEl.dataset.confirm = '0'; btnEl.textContent = '🗑'; btnEl.style.color = ''; }
    }, 3000);
    return;
  }
  btnEl.disabled = true;
  try {
    var d = await api('POST', '/cats/delete', { name: name });
    if (!d.success) throw new Error(d.msg || 'Error al eliminar');
    await loadCats(); renderCatCards(); await fetchHistory();
  } catch(err) {
    alert('Error: ' + err.message);
    btnEl.disabled = false; btnEl.dataset.confirm = '0'; btnEl.textContent = '🗑'; btnEl.style.color = '';
  }
}

async function deleteCatFromEditor() {
  var btn = document.getElementById('cef-delete-btn');
  if (!btn || !_editingCatOrigName) return;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = '¿Confirmar? Toca de nuevo para eliminar';
    setTimeout(function() {
      if (btn.dataset.confirm === '1') { btn.dataset.confirm = '0'; btn.textContent = 'Eliminar gato'; }
    }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    var d = await api('POST', '/cats/delete', { name: _editingCatOrigName });
    if (!d.success) throw new Error(d.msg || 'Error al eliminar');
    closeCatEditor();
    await loadCats(); renderCatCards(); await fetchHistory();
  } catch(err) {
    alert('Error: ' + err.message);
    btn.disabled = false; btn.dataset.confirm = '0'; btn.textContent = 'Eliminar gato';
  }
}

// ── Modal de gato ─────────────────────────────────────────────────────────────
var _catModalChartW = null;
var _catModalChartA = null;

function openCatModal(name) {
  var cat = CATS.find(function(c) { return c.name === name; });
  if (!cat) return;

  if (_catModalChartW) { _catModalChartW.destroy(); _catModalChartW = null; }
  if (_catModalChartA) { _catModalChartA.destroy(); _catModalChartA = null; }

  var avatarEl = document.getElementById('cma-avatar');
  avatarEl.style.background = cat.bg;
  var photo = getPhoto(name);
  avatarEl.innerHTML = photo ? '<img src="' + photo + '">' : getEmoji(name);

  var nameEl = document.getElementById('cma-name');
  nameEl.textContent = name;
  nameEl.style.color = cat.accent;

  var catVisits = _visits.filter(function(v) {
    var c = identifyCat(v.weight);
    return c && c.name === name;
  });

  var today   = new Date(); today.setHours(0,0,0,0);
  var todayTs = today.getTime();
  var weekAgo = todayTs - 6 * 24 * 60 * 60 * 1000;
  var visitsToday = catVisits.filter(function(v) { return v.ts >= todayTs; }).length;
  var visitsWeek  = catVisits.filter(function(v) { return v.ts >= weekAgo; }).length;
  var lastVisit   = catVisits.length ? catVisits[0] : null;
  var lastKg      = lastVisit ? toKg(lastVisit.weight) : '—';

  document.getElementById('cma-sub').textContent = lastVisit
    ? 'Última visita ' + fmtTime(lastVisit.ts).ago
    : 'Sin visitas registradas';

  var statsEl = document.getElementById('cma-stats');
  statsEl.innerHTML = '';
  [
    { val: lastKg + ' kg', lbl: 'Peso'   },
    { val: visitsToday,    lbl: 'Hoy'    },
    { val: visitsWeek,     lbl: 'Semana' },
    { val: catVisits.length, lbl: 'Total' },
  ].forEach(function(s) {
    var el = document.createElement('div');
    el.className = 'cat-modal-stat';
    el.innerHTML =
      '<div class="cat-modal-stat-val" style="color:' + cat.accent + '">' + s.val + '</div>' +
      '<div class="cat-modal-stat-label">' + s.lbl + '</div>';
    statsEl.appendChild(el);
  });

  _catModalChartW = _renderCatWeightChart(cat, catVisits);
  _catModalChartA = _renderCatActivityChart(cat, catVisits);
  _renderCatHeatmapRow(cat, catVisits);

  document.getElementById('cat-modal-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCatModal(e) {
  if (e && e.target !== document.getElementById('cat-modal-overlay')) return;
  document.getElementById('cat-modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function _renderCatWeightChart(cat, catVisits) {
  var days = 30, dateKeys = [], labels = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(); d.setDate(d.getDate() - i);
    var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    dateKeys.push(key);
    labels.push(i === 0 ? 'Hoy' : d.toLocaleDateString('es-CO', { day:'numeric', month:'short' }));
  }
  var byDay = {};
  dateKeys.forEach(function(k) { byDay[k] = []; });
  catVisits.forEach(function(v) {
    var d2 = new Date(v.ts);
    var k2 = d2.getFullYear() + '-' + String(d2.getMonth()+1).padStart(2,'0') + '-' + String(d2.getDate()).padStart(2,'0');
    if (byDay[k2]) byDay[k2].push(parseFloat(toKg(v.weight)));
  });
  var data = dateKeys.map(function(k) {
    var arr = byDay[k];
    return arr.length ? Math.max.apply(Math, arr) : null;
  });
  return new Chart(document.getElementById('cma-weight-chart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{ label: cat.name, data: data,
        borderColor: cat.accent, backgroundColor: cat.bg,
        borderWidth: 2.5, pointRadius: 2, pointHoverRadius: 4,
        tension: 0.3, spanGaps: true, fill: true }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function(ctx) { return ctx.parsed.y.toFixed(2) + ' kg'; } } }
      },
      scales: {
        x: { grid: { display:false }, ticks: { font: { family:'Nunito', size:8 }, maxTicksLimit:6, maxRotation:0 } },
        y: { ticks: { font: { family:'Nunito', size:8 } } }
      }
    }
  });
}

function _renderCatActivityChart(cat, catVisits) {
  var days = 7, dateKeys = [], labels = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(); d.setDate(d.getDate() - i);
    var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    dateKeys.push(key);
    labels.push(i === 0 ? 'Hoy' : d.toLocaleDateString('es-CO', { weekday:'short' }));
  }
  var counts = {};
  dateKeys.forEach(function(k) { counts[k] = 0; });
  catVisits.forEach(function(v) {
    var d2 = new Date(v.ts);
    var k2 = d2.getFullYear() + '-' + String(d2.getMonth()+1).padStart(2,'0') + '-' + String(d2.getDate()).padStart(2,'0');
    if (counts[k2] !== undefined) counts[k2]++;
  });
  return new Chart(document.getElementById('cma-activity-chart'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{ label:'Visitas', data: dateKeys.map(function(k) { return counts[k]; }),
        backgroundColor: cat.accent, borderRadius: 6, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display:false }, ticks: { font: { family:'Nunito', size:9 } } },
        y: { ticks: { precision:0, font: { family:'Nunito', size:9 } }, beginAtZero: true }
      }
    }
  });
}

function _renderCatHeatmapRow(cat, catVisits) {
  var heatEl = document.getElementById('cma-heatmap');
  heatEl.innerHTML = '';

  var counts = Array(24).fill(0);
  catVisits.forEach(function(v) { counts[new Date(v.ts).getHours()]++; });
  var maxVal  = Math.max.apply(Math, counts);
  var maxHour = counts.indexOf(maxVal);

  var infoDiv = document.createElement('div');
  infoDiv.style.cssText = 'font-size:11px; color:var(--muted); margin-bottom:8px; font-family:"DM Mono",monospace;';
  infoDiv.textContent = maxVal > 0
    ? 'Hora pico: ' + String(maxHour).padStart(2,'0') + ':00h (' + maxVal + ' visitas)'
    : 'Sin datos suficientes';
  heatEl.appendChild(infoDiv);

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:grid; grid-template-columns:repeat(24,1fr); gap:2px; font-family:"DM Mono",monospace; font-size:8px; color:var(--muted); text-align:center; margin-bottom:3px;';
  for (var h = 0; h < 24; h++) {
    var span = document.createElement('span');
    if (h === 0 || h === 6 || h === 12 || h === 18 || h === 23) span.textContent = h;
    hdr.appendChild(span);
  }
  heatEl.appendChild(hdr);

  var grid = document.createElement('div');
  grid.style.cssText = 'display:grid; grid-template-columns:repeat(24,1fr); gap:2px;';
  for (var h = 0; h < 24; h++) {
    var val  = counts[h];
    var cell = document.createElement('div');
    cell.className = 'db-heat-cell';
    cell.style.backgroundColor = val > 0 ? cat.accent : 'var(--border)';
    cell.style.opacity = val > 0 ? 0.1 + (val / maxVal) * 0.9 : 0.05;
    cell.title = String(h).padStart(2,'0') + ':00h — ' + val + ' visita(s)';
    grid.appendChild(cell);
  }
  heatEl.appendChild(grid);
}

// status y history arrancan siempre, sin depender de loadCats
loadAvatars().then(initCatEmojis);
fetchStatus();
fetchHistory();
setInterval(fetchStatus, 30000);
setInterval(fetchHistory, 60000);

// cats se carga en paralelo; cuando llega, renderiza cards y refresca historial
loadCats().then(function() {
  renderCatCards();
  renderCatMgrList();
  initCatEmojis();
  fetchHistory(); // re-render con cats identificados
}).catch(function(e) { console.error('[loadCats]', e); });
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
      if (pathname === '/api/avatars') {
        if (db) {
          const { rows } = await db.query('SELECT name,photo,emoji FROM cats');
          const out = {};
          rows.forEach(r => { out[r.name] = { photo: r.photo, emoji: r.emoji }; });
          json({ success: true, result: out });
        } else {
          const out = {};
          catsCache.forEach(c => { out[c.name] = { photo: c.photo, emoji: c.emoji }; });
          json({ success: true, result: out });
        }
        return;

      } else if (pathname.startsWith('/api/avatar/')) {
        const catName = decodeURIComponent(pathname.replace('/api/avatar/', ''));
        const payload = JSON.parse(body || '{}');
        if (db) {
          if (payload.photo !== undefined) {
            await db.query('UPDATE cats SET photo=$1, emoji=NULL WHERE name=$2', [payload.photo, catName]);
          } else if (payload.emoji !== undefined) {
            await db.query('UPDATE cats SET emoji=$1, photo=NULL WHERE name=$2', [payload.emoji, catName]);
          }
          await loadCatsToCache();
        } else {
          const c = catsCache.find(x => x.name === catName);
          if (c) {
            if (payload.photo !== undefined) { c.photo = payload.photo; c.emoji = null; }
            else if (payload.emoji !== undefined) { c.emoji = payload.emoji; c.photo = null; }
          }
        }
        json({ success: true });
        return;

      } else if (pathname === '/api/cats' && req.method === 'GET') {
        json({ success: true, result: catsCache });
        return;

      } else if (pathname === '/api/cats/save' && req.method === 'POST') {
        const p = JSON.parse(body || '{}');
        if (!p.name || !p.name.trim()) { json({ success:false, msg:'Nombre requerido' }, 400); return; }
        if (!p.targetKg || p.targetKg <= 0) { json({ success:false, msg:'Peso inválido' }, 400); return; }
        const tRaw  = Math.round(parseFloat(p.targetKg) / 0.04536);
        const name  = p.name.trim();
        const orig  = p.originalName ? p.originalName.trim() : null;
        if (db) {
          if (orig && orig !== name) {
            await db.query('UPDATE cats SET name=$1,target_raw=$2,bg=$3,accent=$4,emoji=$5,photo=$6 WHERE name=$7',
              [name, tRaw, p.bg||'#ede9fe', p.accent||'#8b5cf6', p.emoji||'🐱', p.photo||null, orig]);
          } else if (orig) {
            await db.query('UPDATE cats SET target_raw=$1,bg=$2,accent=$3,emoji=$4,photo=$5 WHERE name=$6',
              [tRaw, p.bg||'#ede9fe', p.accent||'#8b5cf6', p.emoji||'🐱', p.photo||null, orig]);
          } else {
            await db.query(
              'INSERT INTO cats (name,target_raw,bg,accent,emoji,photo) VALUES ($1,$2,$3,$4,$5,$6)',
              [name, tRaw, p.bg||'#ede9fe', p.accent||'#8b5cf6', p.emoji||'🐱', p.photo||null]
            );
          }
          await loadCatsToCache();
        } else {
          const idx = orig ? catsCache.findIndex(c => c.name === orig) : -1;
          const cat = { name, targetRaw:tRaw, bg:p.bg||'#ede9fe', accent:p.accent||'#8b5cf6', emoji:p.emoji||'🐱', photo:p.photo||null };
          if (idx >= 0) catsCache[idx] = cat; else catsCache.push(cat);
          catsCache.sort((a,b) => a.targetRaw - b.targetRaw);
        }
        json({ success: true, persisted: !!db });
        return;

      } else if (pathname === '/api/cats/delete' && req.method === 'POST') {
        const p = JSON.parse(body || '{}');
        if (!p.name) { json({ success:false, msg:'Nombre requerido' }, 400); return; }
        if (db) {
          await db.query('DELETE FROM cats WHERE name=$1', [p.name]);
          await loadCatsToCache();
        } else {
          catsCache = catsCache.filter(c => c.name !== p.name);
        }
        json({ success: true, persisted: !!db });
        return;
      }

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

      } else if (pathname === '/api/visits') {
        if (db) {
          await syncVisits(); // trae visitas nuevas desde Tuya antes de leer
          const { rows } = await db.query(
            `SELECT ts, weight_raw AS weight, duration_sec AS duration
             FROM visits ORDER BY ts DESC LIMIT 2000`
          );
          json({ success: true, result: rows.map(r => ({
            ts: Number(r.ts), weight: Number(r.weight), duration: r.duration ? Number(r.duration) : null
          })), source: 'db' });
        } else {
          const now  = Date.now();
          const from = now - 7 * 24 * 60 * 60 * 1000;
          const q    = '?end_time=' + now + '&size=500&start_time=' + from + '&type=7';
          const res2 = await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/logs' + q);
          if (!res2.success) { json(res2); return; }
          json({ success: true, result: parseVisits(res2.result.logs), source: 'tuya' });
        }

      } else if (pathname === '/api/sync') {
        syncVisits().catch(console.error);
        json({ success: true, msg: 'Sync iniciado en background' });

      } else if (pathname === '/api/resync') {
        // Fuerza re-sincronización completa desde 90 días atrás (ignora lastTs)
        if (!db) { json({ success: false, msg: 'Sin BD' }); return; }
        await getToken();
        const from90 = Date.now() - 90 * 24 * 60 * 60 * 1000;
        const now90  = Date.now();
        const logs   = await fetchTuyaLogs(from90, now90);
        const visits = parseVisits(logs);
        let inserted = 0, skipped = 0;
        for (const v of visits) {
          const { rowCount } = await db.query(
            `INSERT INTO visits (ts, cat_name, weight_raw, weight_kg, duration_sec)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (ts) DO NOTHING`,
            [v.ts, catByWeight(v.weight), v.weight,
             parseFloat((v.weight * 0.04536).toFixed(2)), v.duration]
          );
          if (rowCount) inserted++; else skipped++;
        }
        const cwSessions = logs.filter(l => l.code === 'cat_weight' && parseInt(l.value) > 0).length;
        console.log('[Resync] total logs:', logs.length, '| cat_weight>0:', cwSessions, '→ sesiones:', visits.length, '→ nuevas:', inserted, 'ya existían:', skipped);
        json({ success: true, total_logs: logs.length, cat_weight_nonzero: cwSessions, visits_parsed: visits.length, inserted, skipped });

      } else if (pathname === '/api/tuyapage') {
        // Muestra la respuesta cruda de Tuya (1 página) para inspeccionar campos de paginación
        await getToken();
        const qs    = new URL('http://x' + req.url).searchParams;
        const days  = parseInt(qs.get('days') || '7');
        const rowKey = qs.get('key') || null;
        const type  = qs.get('type') || '7';
        const fromP = Date.now() - days * 24 * 60 * 60 * 1000;
        let q = '?end_time=' + Date.now() + '&size=100&start_time=' + fromP;
        if (type) q += '&type=' + type;
        if (rowKey) q += '&last_row_key=' + encodeURIComponent(rowKey);
        const raw = await tuyaRequest('GET', '/v1.0/devices/' + DEVICE_ID + '/logs' + q);
        // Devolver todo menos los logs (para no saturar) + metadatos de paginación
        const meta = raw.result ? {
          has_next:     raw.result.has_next,
          last_row_key: raw.result.last_row_key,
          next_row_key: raw.result.next_row_key,
          total:        raw.result.total,
          count:        (raw.result.logs || []).length,
          oldest:       raw.result.logs && raw.result.logs.length ? new Date(raw.result.logs[raw.result.logs.length-1].event_time).toISOString() : null,
          newest:       raw.result.logs && raw.result.logs.length ? new Date(raw.result.logs[0].event_time).toISOString() : null,
          all_keys:     Object.keys(raw.result)
        } : null;
        json({ success: raw.success, result_meta: meta, raw_minus_logs: { ...raw, result: meta } });

      } else if (pathname === '/api/rawlogs') {
        // Ver logs crudos de Tuya — ?days=7&code=cat_weight&limit=200
        await getToken();
        const qs     = new URL('http://x' + req.url).searchParams;
        const days   = parseInt(qs.get('days') || '7');
        const code   = qs.get('code') || null;
        const limit  = parseInt(qs.get('limit') || '500');
        const fromRaw = Date.now() - days * 24 * 60 * 60 * 1000;
        const logs   = await fetchTuyaLogs(fromRaw, Date.now());
        const filtered = code ? logs.filter(l => l.code === code) : logs;
        const slice  = filtered.slice(0, limit).map(l => ({
          ts: new Date(l.event_time).toISOString(),
          code: l.code,
          value: l.value
        }));
        json({ success: true, total: filtered.length, days, code, shown: slice.length, logs: slice });

      } else if (pathname === '/api/logscan') {
        // Diagnóstico: muestra todos los códigos de eventos y el rango de fechas real cubierto
        await getToken();
        const days = parseInt(new URL('http://x' + req.url).searchParams.get('days') || '90');
        const fromScan = Date.now() - days * 24 * 60 * 60 * 1000;
        const logs = await fetchTuyaLogs(fromScan, Date.now());
        const counts = {}, samples = {}, allTs = [];
        logs.forEach(l => {
          counts[l.code] = (counts[l.code] || 0) + 1;
          if (!samples[l.code]) samples[l.code] = l.value;
          if (l.event_time) allTs.push(l.event_time);
        });
        const minTs = allTs.length ? Math.min(...allTs) : null;
        const maxTs = allTs.length ? Math.max(...allTs) : null;
        const spanDays = minTs ? ((maxTs - minTs) / 86400000).toFixed(1) : null;
        const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);
        // Mostrar cat_weight con valores distintos (no solo el sample)
        const cwValues = logs.filter(l => l.code === 'cat_weight').map(l => parseInt(l.value)).filter(v => v > 0);
        json({
          success: true, total_logs: logs.length, days,
          range: { oldest: minTs ? new Date(minTs).toISOString() : null, newest: maxTs ? new Date(maxTs).toISOString() : null, span_days: spanDays },
          cat_weight_nonzero: cwValues.length,
          cat_weight_values: cwValues,
          codes: sorted.map(([code,count]) => ({ code, count, sample: samples[code] }))
        });

      } else if (pathname === '/api/records') {
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
  initDB()
    .then(() => syncVisits())
    .catch(e => console.error('[DB] Error en init:', e.message));
  setInterval(() => syncVisits().catch(console.error), 30 * 60 * 1000);
});
