// lib/app.js — Gaturrin: toda la lógica del servidor (sin listen).
// Entradas: proxy.js (local, proceso persistente) y api/index.js (Vercel, serverless).

const https  = require('https');
const crypto = require('crypto');
const url    = require('url');
const fs     = require('fs');
const path   = require('path');

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
// Fecha de vencimiento del trial IoT Core (YYYY-MM-DD, la muestra iot.tuya.com).
// Opcional: si está definida, la UI avisa con 14 días de anticipación.
const TRIAL_END     = process.env.TUYA_TRIAL_END || null;
// PIN de acceso opcional: si está definido, toda la app pide el PIN una vez
// por dispositivo (cookie de larga duración). Sin él la app queda pública.
const ACCESS_PIN    = process.env.ACCESS_PIN || null;
// Token secreto para que un cron externo dispare /api/sync?token=... sin PIN
// (en Vercel no hay proceso residente que sincronice solo).
const SYNC_TOKEN    = process.env.SYNC_TOKEN || null;
// URL pública de la app: la usan los jobs de pg_cron (limpiezas programadas)
const APP_URL       = process.env.APP_URL || 'https://gaturrin.vercel.app';
// Alertas por Telegram (opcionales): crear bot con @BotFather y obtener el
// chat_id escribiéndole al bot y consultando /getUpdates.
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || null;
const TG_CHAT       = process.env.TELEGRAM_CHAT_ID || null;

if (!ACCESS_ID || !ACCESS_SECRET || !DEVICE_ID) {
  console.error('[Gaturrin] Faltan variables de entorno: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_DEVICE_ID');
  // En serverless no se puede tumbar el proceso: el handler responde 500.
  if (!process.env.VERCEL) process.exit(1);
}

const { parseVisits, nearestCat } = require('./visits');

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
function cmd(code, value, deviceId) {
  const devId = deviceId || (litterboxesCache[0] && litterboxesCache[0].device_id) || DEVICE_ID;
  return tuyaRequest('POST', '/v1.0/devices/' + devId + '/commands', { commands: [{ code, value }] });
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
let litterboxesCache = []; // [{ device_id, name, product_name, sort_order, cats:[names] }]
let deviceCatsMap    = {}; // device_id → [cat objects] subset of catsCache

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

async function loadLitterboxes() {
  if (!db) {
    if (DEVICE_ID && !litterboxesCache.length) {
      litterboxesCache = [{ device_id: DEVICE_ID, name: 'Arenero principal', product_name: null, sort_order: 0, cats: catsCache.map(c => c.name) }];
      deviceCatsMap[DEVICE_ID] = catsCache.slice();
    }
    return;
  }
  try {
    const { rows } = await db.query('SELECT device_id,name,product_name,sort_order FROM litterboxes ORDER BY sort_order,created_at ASC');
    for (const lb of rows) {
      const { rows: cr } = await db.query(
        'SELECT c.name FROM cats c JOIN cat_litterbox cl ON c.name=cl.cat_name WHERE cl.device_id=$1 ORDER BY c.target_raw ASC',
        [lb.device_id]
      );
      lb.cats = cr.map(r => r.name);
    }
    litterboxesCache = rows;
    deviceCatsMap = {};
    for (const lb of rows) {
      deviceCatsMap[lb.device_id] = catsCache.filter(c => lb.cats.includes(c.name));
    }
    if (!litterboxesCache.length && DEVICE_ID) {
      litterboxesCache = [{ device_id: DEVICE_ID, name: 'Arenero principal', product_name: null, sort_order: 0, cats: catsCache.map(c => c.name) }];
      deviceCatsMap[DEVICE_ID] = catsCache.slice();
    }
  } catch(e) { console.warn('[DB] loadLitterboxes:', e.message); }
}

function catByWeight(raw, deviceId) {
  const pool = (deviceId && deviceCatsMap[deviceId] && deviceCatsMap[deviceId].length)
    ? deviceCatsMap[deviceId] : catsCache;
  const cat = nearestCat(raw, pool);
  return cat ? cat.name : null;
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────
let db = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    // max bajo: en serverless cada instancia tiene su pool y el pooler de
    // Supabase multiplexa por detrás — no hacen falta muchas conexiones.
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
    console.log('[DB] Pool PostgreSQL creado');
  } catch(e) {
    console.warn('[DB] Módulo pg no disponible:', e.message);
  }
}

async function initDB() {
  if (!db) { await loadLitterboxes(); return; }
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
  // Nuevas tablas multi-arenero
  await db.query(`
    CREATE TABLE IF NOT EXISTS litterboxes (
      device_id    TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      product_name TEXT,
      sort_order   INT DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS cat_litterbox (
      cat_name  TEXT NOT NULL REFERENCES cats(name) ON DELETE CASCADE ON UPDATE CASCADE,
      device_id TEXT NOT NULL REFERENCES litterboxes(device_id) ON DELETE CASCADE,
      PRIMARY KEY (cat_name, device_id)
    )
  `);
  // Cooldown de alertas Telegram: persistido porque en serverless la memoria
  // se pierde entre invocaciones (sin esto, cada cold start re-avisa).
  await db.query(`
    CREATE TABLE IF NOT EXISTS alerts_sent (
      key TEXT PRIMARY KEY,
      ts  BIGINT NOT NULL
    )
  `);
  // Estimación del cajón de desechos: visitas desde el último vaciado manual
  await db.query(`
    CREATE TABLE IF NOT EXISTS maintenance (
      device_id    TEXT PRIMARY KEY,
      last_emptied BIGINT NOT NULL,
      threshold    INT NOT NULL DEFAULT 60
    )
  `);
  await db.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS device_id TEXT`);
  // Multi-arenero: unicidad por (device_id, ts) — el UNIQUE(ts) global original
  // perdería visitas simultáneas de dos areneros. El índice único además
  // acelera el historial (WHERE device_id ORDER BY ts DESC).
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS visits_device_ts ON visits (device_id, ts)`);
  await db.query(`ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_ts_key`);

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

  // Seed de arenero principal (idempotente — solo si la tabla está vacía)
  const { rows: existingLbs } = await db.query('SELECT 1 FROM litterboxes LIMIT 1');
  if (!existingLbs.length && DEVICE_ID) {
    await db.query(
      'INSERT INTO litterboxes (device_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [DEVICE_ID, 'Arenero principal']
    );
    const { rows: allCats } = await db.query('SELECT name FROM cats');
    for (const cat of allCats) {
      await db.query(
        'INSERT INTO cat_litterbox (cat_name, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [cat.name, DEVICE_ID]
      );
    }
    await db.query('UPDATE visits SET device_id=$1 WHERE device_id IS NULL', [DEVICE_ID]);
    console.log('[DB] Arenero semilla creado y visitas migradas a device_id');
  }
  await loadLitterboxes();
  console.log('[DB] Tablas listas, cats:', catsCache.map(c => c.name).join(', '), '| areneros:', litterboxesCache.map(l => l.name).join(', '));
}

// initDB una sola vez por proceso/instancia; si falla se reintenta en la
// siguiente petición en vez de dejar la promesa envenenada.
let _initPromise = null;
function ensureDB() {
  if (!_initPromise) {
    _initPromise = initDB().catch(e => {
      _initPromise = null;
      console.error('[DB] Error en init:', e.message);
      throw e;
    });
  }
  return _initPromise;
}

async function fetchTuyaLogs(from, now, deviceId) {
  const devId = deviceId || DEVICE_ID;
  // Tuya ignora last_row_key en la práctica: cada consulta devuelve máx. 100
  // eventos (los más recientes del rango). Se consulta por ventanas de tiempo
  // y se bisecta cualquier ventana que llegue al tope de 100.
  async function fetchWindow(start, end, depth) {
    const q = '?end_time=' + end + '&size=100&start_time=' + start + '&type=7';
    const r = await tuyaRequest('GET', '/v1.0/devices/' + devId + '/logs' + q);
    if (!r.success || !r.result) return [];
    const logs = r.result.logs || [];
    if (logs.length < 100 || depth >= 10 || end - start < 60000) return logs;
    const mid = Math.floor((start + end) / 2);
    return (await fetchWindow(mid, end, depth + 1)).concat(await fetchWindow(start, mid, depth + 1));
  }
  const WINDOW = 6 * 3600 * 1000;
  let allLogs = [];
  for (let end = now; end > from && allLogs.length < 20000; end -= WINDOW) {
    allLogs = allLogs.concat(await fetchWindow(Math.max(from, end - WINDOW), end, 0));
  }
  // Dedup por si los bordes de ventana se solapan
  const seen = new Set();
  return allLogs.filter(l => {
    const k = l.event_time + '|' + l.code + '|' + l.value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function syncVisits(deviceId) {
  if (!db) return;
  const devId = deviceId || (litterboxesCache[0] && litterboxesCache[0].device_id) || DEVICE_ID;
  try {
    await getToken();
    const { rows } = await db.query(
      'SELECT COALESCE(MAX(ts), 0) AS last_ts FROM visits WHERE device_id=$1', [devId]
    );
    const lastTs = Number(rows[0].last_ts);
    // Retrocede 5 min antes del último ts para no partir sesiones de cat_weight a la mitad
    const from   = lastTs > 0 ? lastTs - 5 * 60 * 1000 : Date.now() - 10 * 24 * 60 * 60 * 1000;
    const now    = Date.now();

    const logs   = await fetchTuyaLogs(from, now, devId);
    const visits = parseVisits(logs);

    let inserted = 0;
    const nuevas = [];
    for (const v of visits) {
      const catName = catByWeight(v.weight, devId);
      const { rowCount } = await db.query(
        `INSERT INTO visits (ts, cat_name, weight_raw, weight_kg, duration_sec, device_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (device_id, ts) DO NOTHING`,
        [v.ts, catName, v.weight,
         parseFloat((v.weight * 0.04536).toFixed(2)), v.duration, devId]
      );
      inserted += rowCount;
      if (rowCount) nuevas.push({ ts: v.ts, weight: v.weight, duration: v.duration, catName });
    }
    if (inserted > 0) console.log('[DB] Sync [' + devId.slice(-6) + ']: ' + inserted + ' visita(s) nuevas');

    // Aviso por visita: solo las de las últimas 3h, para no inundar en resyncs
    if (TG_TOKEN && TG_CHAT) {
      const limite = Date.now() - 3 * 3600 * 1000;
      for (const v of nuevas) {
        if (v.ts < limite) continue;
        await sendTelegram('🐱 <b>' + (v.catName || 'Desconocido 👻') + '</b> fue al baño a las ' + horaBogota(v.ts) +
          ' (' + (v.weight * 0.04536).toFixed(2) + ' kg' + (v.duration ? ', ' + v.duration + ' s' : '') + ')');
      }
    }
  } catch(e) {
    console.error('[DB] Error en sync [' + devId.slice(-6) + ']:', e.message);
  }
}

async function getMaintenance(devId) {
  if (!db || !devId) return null;
  const { rows } = await db.query('SELECT last_emptied, threshold FROM maintenance WHERE device_id=$1', [devId]);
  let m = rows[0];
  if (!m) {
    m = { last_emptied: Date.now(), threshold: 60 };
    await db.query('INSERT INTO maintenance (device_id, last_emptied) VALUES ($1,$2) ON CONFLICT DO NOTHING', [devId, m.last_emptied]);
  }
  const { rows: c } = await db.query('SELECT COUNT(*) AS n FROM visits WHERE device_id=$1 AND ts > $2', [devId, m.last_emptied]);
  return { last_emptied: Number(m.last_emptied), threshold: Number(m.threshold) || 60, visits: Number(c[0].n) };
}

async function syncAllDevices() {
  const devices = litterboxesCache.length ? litterboxesCache : (DEVICE_ID ? [{ device_id: DEVICE_ID }] : []);
  for (const lb of devices) {
    await syncVisits(lb.device_id).catch(e => console.error('[DB] syncAllDevices:', e.message));
  }
}

// ── Alertas por Telegram ──────────────────────────────────────────────────────

// Hora local del usuario (Colombia, sin DST)
const TZ = 'America/Bogota';
function horaBogota(ts) {
  return new Date(ts).toLocaleTimeString('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
}
function fechaBogota(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
function horaDelDiaBogota() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }), 10);
}

function tgApi(method, data) {
  if (!TG_TOKEN) return Promise.resolve(null);
  return new Promise(resolve => {
    const payload = JSON.stringify(data);
    const req = https.request({
      host: 'api.telegram.org',
      path: '/bot' + TG_TOKEN + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', e => { console.error('[TG]', e.message); resolve(null); });
    req.end(payload);
  });
}

// extra: campos adicionales del sendMessage (ej. reply_markup con botones)
async function sendTelegram(text, extra) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  const r = await tgApi('sendMessage', Object.assign({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }, extra || {}));
  return !!(r && r.ok);
}

// Cooldown de alertas: cada una se repite como mucho una vez al día mientras
// persista. Memoria como caché + tabla alerts_sent como verdad (la memoria
// no sobrevive entre invocaciones serverless).
const _lastNotified = {};
const ALERT_COOLDOWN = 24 * 3600 * 1000;

// La BD manda cuando existe: los botones de Telegram (snooze/reset) ajustan
// alerts_sent y la memoria de otra instancia serverless no debe pisarlos.
async function alreadyNotified(key, now) {
  if (db) {
    try {
      const { rows } = await db.query('SELECT ts FROM alerts_sent WHERE key=$1', [key]);
      return rows.length ? (now - Number(rows[0].ts) < ALERT_COOLDOWN) : false;
    } catch(e) { console.warn('[TG] alerts_sent:', e.message); }
  }
  return !!(_lastNotified[key] && now - _lastNotified[key] < ALERT_COOLDOWN);
}

async function notifyOnce(key, text, extra) {
  const now = Date.now();
  if (await alreadyNotified(key, now)) return;
  if (await sendTelegram(text, extra)) {
    _lastNotified[key] = now;
    if (db) {
      try {
        await db.query(
          'INSERT INTO alerts_sent (key, ts) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET ts=EXCLUDED.ts',
          [key, now]
        );
      } catch(e) { console.warn('[TG] alerts_sent:', e.message); }
    }
    console.log('[TG] Alerta enviada:', key);
  }
}

async function checkAlerts() {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    // Inactividad por gato (>18h sin visitas; señal médica en gatos)
    if (db) {
      const { rows } = await db.query(
        'SELECT cat_name, MAX(ts) AS last_ts FROM visits WHERE cat_name IS NOT NULL GROUP BY cat_name'
      );
      const lastByCat = {};
      rows.forEach(r => { lastByCat[r.cat_name] = Number(r.last_ts); });
      for (const cat of catsCache) {
        const last = lastByCat[cat.name];
        if (!last) continue; // sin historial: no hay baseline para alertar
        const hours = (Date.now() - last) / 3600000;
        if (hours > 18) {
          await notifyOnce('inactivo:' + cat.name,
            '🚨 <b>' + cat.name + '</b> no usa la arenera hace ' + Math.round(hours) +
            ' horas. En gatos puede ser señal de problema urinario — vale la pena vigilarlo.');
        }
      }
    }
    // Estado del dispositivo: offline, fallas y advertencias (mismos bits que la UI)
    try {
      await getToken();
      for (const lb of litterboxesCache) {
        const nombre = lb.name || 'La arenera';
        const info = await tuyaRequest('GET', '/v1.0/devices/' + lb.device_id);
        if (info.success && info.result && info.result.online === false) {
          await notifyOnce('offline:' + lb.device_id,
            '📡 <b>' + nombre + '</b> aparece desconectada de Tuya. Revisa el enchufe o el WiFi.');
          continue;
        }
        const st = await tuyaRequest('GET', '/v1.0/devices/' + lb.device_id + '/status');
        if (st.success && Array.isArray(st.result)) {
          const dp = {};
          st.result.forEach(s => { dp[s.code] = s.value; });
          const fault = Number(dp.fault || 0), notif = Number(dp.notification || 0);
          if (fault & 1) await notifyOnce('fault:nodump:' + lb.device_id,
            '⚠️ <b>' + nombre + '</b>: error de descarga (nodump) — el rastrillo no pudo vaciar. Revisa si hay atasco o el cajón está lleno.');
          if (fault & 2) await notifyOnce('fault:overload:' + lb.device_id,
            '🔴 <b>' + nombre + '</b>: sobrecarga (overload) — demasiado peso o algo bloquea el mecanismo.');
          if (notif & 1) await notifyOnce('notif:noweight:' + lb.device_id,
            '⚖️ <b>' + nombre + '</b>: no se detectó peso en la última visita — puede que la báscula necesite calibración.');
        }
      }
    } catch (e) { console.error('[TG] estado dispositivo:', e.message); }

    // Cajón de desechos: aviso preventivo antes de que falle la descarga
    if (db) {
      for (const lb of litterboxesCache) {
        try {
          const m = await getMaintenance(lb.device_id);
          if (!m) continue;
          const pct = Math.round(m.visits * 100 / m.threshold);
          const nombre = lb.name || 'la arenera';
          const botones = { reply_markup: { inline_keyboard: [
            [{ text: '✅ Ya lo limpié', callback_data: 'drawer_reset:' + lb.device_id }],
            [{ text: '⏰ En 4 horas', callback_data: 'drawer_snooze:' + lb.device_id + ':4' },
             { text: '🌙 Mañana',    callback_data: 'drawer_snooze:' + lb.device_id + ':24' }],
          ] } };
          if (pct >= 100) {
            await notifyOnce('drawer100:' + lb.device_id,
              '🗑️ El cajón de <b>' + nombre + '</b> debería estar lleno (' + m.visits +
              ' visitas desde el último vaciado). ¿Lo vaciamos?', botones);
          } else if (pct >= 80) {
            await notifyOnce('drawer80:' + lb.device_id,
              '🗑️ El cajón de <b>' + nombre + '</b> va ~' + pct + '%. Conviene vaciarlo pronto.', botones);
          }
        } catch (e) { console.warn('[TG] cajón:', e.message); }
      }
    }

    // Resumen diario (~9pm hora Colombia; la clave incluye la fecha → una vez al día)
    if (db && horaDelDiaBogota() >= 21) {
      const hoy = fechaBogota(Date.now());
      const key = 'digest:' + hoy;
      if (!(await alreadyNotified(key, Date.now()))) {
        const inicioDia = new Date(hoy + 'T00:00:00-05:00').getTime();
        const { rows } = await db.query(
          `SELECT cat_name, COUNT(*) AS n, ROUND(AVG(weight_kg),2) AS kg
           FROM visits WHERE ts >= $1 GROUP BY cat_name ORDER BY n DESC`, [inicioDia]);
        const { rows: base } = await db.query(
          `SELECT cat_name, COUNT(*)::float / 7 AS diaria
           FROM visits WHERE ts >= $1 AND ts < $2 GROUP BY cat_name`,
          [inicioDia - 7 * 86400000, inicioDia]);
        const baseMap = {};
        base.forEach(r => { baseMap[r.cat_name] = Number(r.diaria); });
        const lines = [];
        for (const r of rows) {
          const nombre = r.cat_name || 'Desconocido 👻';
          const prom = baseMap[r.cat_name];
          let extra = '';
          if (prom && Number(r.n) >= prom * 1.8) extra = ' 📈 muy por encima de su promedio';
          else if (prom && Number(r.n) <= prom * 0.4) extra = ' 📉 muy por debajo de su promedio';
          lines.push('• <b>' + nombre + '</b>: ' + r.n + ' visita' + (Number(r.n) === 1 ? '' : 's') +
            (r.kg ? ' · ' + r.kg + ' kg prom.' : '') + extra);
        }
        const vistos = new Set(rows.map(r => r.cat_name));
        for (const cat of catsCache) {
          if (!vistos.has(cat.name)) lines.push('• <b>' + cat.name + '</b>: sin visitas hoy ⚠️');
        }
        await notifyOnce(key, '🌙 <b>Resumen del día</b> (' + hoy + ')\n' +
          (lines.length ? lines.join('\n') : 'Hoy no se registraron visitas 🤔'));
      }
    }

    // Vencimiento del trial de Tuya (aviso desde 7 días antes)
    if (TRIAL_END) {
      const dias = Math.ceil((new Date(TRIAL_END + 'T23:59:59') - Date.now()) / 86400000);
      if (dias <= 7) {
        await notifyOnce('trial',
          '⏰ El trial de Tuya IoT Core ' + (dias <= 0 ? 'venció' : 'vence en ' + dias + ' día' + (dias === 1 ? '' : 's')) +
          '. Renuévalo gratis en iot.tuya.com → Cloud → IoT Core → Extend Trial Period.');
      }
    }
  } catch (e) { console.error('[TG] checkAlerts:', e.message); }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const PUBLIC_DIR  = path.join(__dirname, '..', 'public');
const HTML        = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

// ── Página de configuración ───────────────────────────────────────────────────

const CONFIG_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'configuracion.html'), 'utf8');

// ── Autenticación por PIN ─────────────────────────────────────────────────────
// Cookie = HMAC(PIN) con el secret de Tuya como llave: no guarda el PIN en el
// navegador y se invalida sola si cambian PIN o credenciales.

const AUTH_COOKIE = 'gaturrin_auth';

function authCookieValue() {
  return crypto.createHmac('sha256', ACCESS_SECRET).update('pin:' + ACCESS_PIN).digest('hex');
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isAuthed(req) {
  if (!ACCESS_PIN) return true;
  const cookies = req.headers.cookie || '';
  const m = cookies.match(new RegExp('(?:^|;\\s*)' + AUTH_COOKIE + '=([a-f0-9]+)'));
  if (!m) return false;
  return safeEqual(m[1], authCookieValue());
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gaturrin 🐾</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;800;900&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background:#f5eeff; color:#3b1f5e; font-family:'Nunito',sans-serif;
  min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;
}
.card {
  background:#fff; border:1.5px solid #e8d5f5; border-radius:28px;
  padding:40px 32px; width:100%; max-width:340px; text-align:center;
  box-shadow:0 8px 40px rgba(139,92,246,.15);
}
.paw { font-size:44px; margin-bottom:12px; }
h1 { font-size:22px; font-weight:900; margin-bottom:4px; }
h1 .a { color:#d946a8; }
p { font-size:13px; color:#9d7ebe; margin-bottom:24px; }
input {
  width:100%; padding:14px; border:1.5px solid #e8d5f5; border-radius:14px;
  font-size:22px; text-align:center; letter-spacing:8px; outline:none;
  font-family:'Nunito',sans-serif; font-weight:800; color:#3b1f5e;
}
input:focus { border-color:#8b5cf6; }
button {
  width:100%; margin-top:14px; padding:14px; border:none; border-radius:14px;
  background:linear-gradient(135deg,#e879b0,#d946a8); color:#fff;
  font-family:'Nunito',sans-serif; font-size:15px; font-weight:800; cursor:pointer;
  box-shadow:0 4px 16px rgba(217,70,168,.3);
}
.err { color:#e11d48; font-size:12px; font-weight:700; margin-top:12px; min-height:16px; }
</style>
</head>
<body>
<div class="card">
  <div class="paw">🐾</div>
  <h1>Gatu<span class="a">rrin</span></h1>
  <p>Ingresa el PIN para continuar</p>
  <form onsubmit="entrar(event)">
    <input type="password" id="pin" inputmode="numeric" autocomplete="current-password" autofocus>
    <button type="submit">Entrar</button>
  </form>
  <div class="err" id="err"></div>
</div>
<script>
async function entrar(e) {
  e.preventDefault();
  var r = await fetch('/api/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ pin: document.getElementById('pin').value })
  });
  var d = await r.json();
  if (d.success) location.reload();
  else {
    document.getElementById('err').textContent = 'PIN incorrecto';
    document.getElementById('pin').value = '';
    document.getElementById('pin').focus();
  }
}
</script>
</body>
</html>`;

// ── Archivos estáticos (PWA) ──────────────────────────────────────────────────

const STATIC_FILES = {
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/sw.js':                { file: 'sw.js',                type: 'text/javascript' },
  '/icon-192.png':         { file: 'icon-192.png',         type: 'image/png' },
  '/icon-512.png':         { file: 'icon-512.png',         type: 'image/png' },
};

// ── Handler HTTP ──────────────────────────────────────────────────────────────

// Lee el body soportando ambos entornos: stream crudo (local) y body ya
// consumido por los helpers de Vercel (por si quedaran activos).
function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return Promise.resolve(req.body);
    if (Buffer.isBuffer(req.body))    return Promise.resolve(req.body.toString());
    return Promise.resolve(JSON.stringify(req.body));
  }
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

const handler = async function(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  function json(data, code) {
    res.writeHead(code || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  if (!ACCESS_ID || !ACCESS_SECRET || !DEVICE_ID) {
    json({ success: false, msg: 'Faltan variables de entorno TUYA_*' }, 500);
    return;
  }

  // Estáticos de PWA: sin auth (no exponen datos y el navegador los pide solo)
  if (STATIC_FILES[pathname]) {
    const s = STATIC_FILES[pathname];
    try {
      const content = fs.readFileSync(path.join(PUBLIC_DIR, s.file));
      res.writeHead(200, { 'Content-Type': s.type, 'Cache-Control': 'public, max-age=86400' });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // BD lista antes de tocar caches/queries (en serverless no hay startup).
  // Si falla se sigue: los endpoints que solo hablan con Tuya aún sirven.
  try { await ensureDB(); } catch {}

  // Login: valida el PIN y entrega la cookie
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    let pin = '';
    try { pin = String(JSON.parse(body || '{}').pin || ''); } catch {}
    const ok = ACCESS_PIN && safeEqual(pin, String(ACCESS_PIN));
    if (!ok) { json({ success: false }, 401); return; }
    const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': AUTH_COOKIE + '=' + authCookieValue() +
        '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + secure,
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Webhook de Telegram (botones inline): Telegram manda el secreto en un
  // header propio (configurado con setWebhook), no hay cookie de PIN.
  if (pathname === '/api/telegram' && req.method === 'POST') {
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    if (!SYNC_TOKEN || !safeEqual(secret, SYNC_TOKEN)) { json({ success: false }, 401); return; }
    const body = await readBody(req);
    let update = {};
    try { update = JSON.parse(body || '{}'); } catch {}
    const cb = update.callback_query;
    // Solo botones presionados por el dueño (el chat configurado)
    if (cb && cb.from && String(cb.from.id) === String(TG_CHAT)) {
      try { await ensureDB(); } catch {}
      const data = String(cb.data || '');
      let respuesta = '';
      try {
        if (data.indexOf('drawer_reset:') === 0 && db) {
          const dev = data.slice('drawer_reset:'.length);
          await db.query(
            'INSERT INTO maintenance (device_id, last_emptied) VALUES ($1,$2) ON CONFLICT (device_id) DO UPDATE SET last_emptied=EXCLUDED.last_emptied',
            [dev, Date.now()]);
          await db.query('DELETE FROM alerts_sent WHERE key = ANY($1)',
            [['drawer80:' + dev, 'drawer100:' + dev]]);
          delete _lastNotified['drawer80:' + dev];
          delete _lastNotified['drawer100:' + dev];
          respuesta = 'Ciclo reiniciado 🎉 ¡Gracias por limpiar!';
        } else if (data.indexOf('drawer_snooze:') === 0 && db) {
          const parts = data.split(':');
          const dev   = parts[1];
          const horas = Math.min(72, Math.max(1, Number(parts[2]) || 4));
          // Corre el cooldown para que la alerta vuelva a ser elegible en N horas
          const ts = Date.now() - ALERT_COOLDOWN + horas * 3600000;
          for (const k of ['drawer80:' + dev, 'drawer100:' + dev]) {
            await db.query(
              'INSERT INTO alerts_sent (key, ts) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET ts=EXCLUDED.ts', [k, ts]);
            _lastNotified[k] = ts;
          }
          respuesta = horas >= 24 ? 'Listo, te recuerdo mañana 🌙' : 'Te recuerdo en ' + horas + ' horas ⏰';
        }
      } catch (e) { console.error('[TG] webhook:', e.message); }
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: respuesta || 'Ok' });
      if (respuesta && cb.message) {
        await tgApi('editMessageText', {
          chat_id: cb.message.chat.id, message_id: cb.message.message_id,
          text: cb.message.text + '\n\n➡️ ' + respuesta,
        });
      }
    }
    json({ ok: true });
    return;
  }

  // Cron externo: /api/sync y /api/clean con ?token=<SYNC_TOKEN> pasan sin
  // cookie (sync periódico y limpiezas programadas desde pg_cron)
  const cronOk = SYNC_TOKEN && (pathname === '/api/sync' || pathname === '/api/clean') &&
    safeEqual(String(parsed.query.token || ''), SYNC_TOKEN);

  // Gate: con ACCESS_PIN definido, todo lo demás requiere cookie válida
  if (!cronOk && !isAuthed(req)) {
    if (pathname.startsWith('/api')) { json({ success: false, msg: 'No autorizado', auth: false }, 401); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML);
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (pathname === '/configuracion') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CONFIG_HTML);
    return;
  }

  if (pathname.startsWith('/api')) {
    const body = await readBody(req);

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

      // ── Endpoints de areneros (sin token necesario) ────────────────────────────
      if (pathname === '/api/litterboxes') {
        json({ success: true, result: litterboxesCache });
        return;

      } else if (pathname === '/api/litterboxes/discover') {
        await getToken();
        let allDevices = [], lbRowKey = null;
        do {
          let q = '/v1.0/iot-01/associated-users/devices?size=100';
          if (lbRowKey) q += '&last_row_key=' + encodeURIComponent(lbRowKey);
          const r = await tuyaRequest('GET', q);
          if (!r.success || !r.result) break;
          const list = r.result.devices || r.result.list || (Array.isArray(r.result) ? r.result : []);
          allDevices = allDevices.concat(list);
          lbRowKey = r.result.has_next ? (r.result.last_row_key || null) : null;
        } while (lbRowKey && allDevices.length < 500);
        const addedIds = new Set(litterboxesCache.map(l => l.device_id));
        const devices = allDevices.map(d => ({
          device_id:    d.id,
          name:         d.name || d.product_name || d.id,
          product_name: d.product_name || null,
          online:       d.online || false,
          added:        addedIds.has(d.id),
        })).sort((a, b) => Number(a.added) - Number(b.added));
        json({ success: true, result: devices });
        return;

      } else if (pathname === '/api/litterboxes/save' && req.method === 'POST') {
        const p = JSON.parse(body || '{}');
        if (!p.device_id || !p.name) { json({ success:false, msg:'device_id y name requeridos' }, 400); return; }
        if (db) {
          await db.query(
            'INSERT INTO litterboxes (device_id,name,product_name) VALUES ($1,$2,$3) ON CONFLICT (device_id) DO UPDATE SET name=EXCLUDED.name',
            [p.device_id, p.name.trim(), p.product_name || null]
          );
          await loadLitterboxes();
        } else {
          const idx = litterboxesCache.findIndex(l => l.device_id === p.device_id);
          if (idx >= 0) { litterboxesCache[idx].name = p.name.trim(); }
          else { litterboxesCache.push({ device_id: p.device_id, name: p.name.trim(), product_name: p.product_name || null, sort_order: litterboxesCache.length, cats: [] }); }
        }
        json({ success: true, persisted: !!db });
        return;

      } else if (pathname === '/api/litterboxes/delete' && req.method === 'POST') {
        const p = JSON.parse(body || '{}');
        if (!p.device_id) { json({ success:false, msg:'device_id requerido' }, 400); return; }
        if (db) {
          await db.query('DELETE FROM litterboxes WHERE device_id=$1', [p.device_id]);
          await loadLitterboxes();
        } else {
          litterboxesCache = litterboxesCache.filter(l => l.device_id !== p.device_id);
          delete deviceCatsMap[p.device_id];
        }
        json({ success: true, persisted: !!db });
        return;

      } else if (pathname === '/api/litterboxes/assign' && req.method === 'POST') {
        const p = JSON.parse(body || '{}');
        if (!p.device_id || !Array.isArray(p.cats)) { json({ success:false, msg:'device_id y cats[] requeridos' }, 400); return; }
        if (db) {
          await db.query('DELETE FROM cat_litterbox WHERE device_id=$1', [p.device_id]);
          for (const catName of p.cats) {
            await db.query('INSERT INTO cat_litterbox (cat_name,device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [catName, p.device_id]);
          }
          await loadLitterboxes();
        } else {
          const lb = litterboxesCache.find(l => l.device_id === p.device_id);
          if (lb) lb.cats = p.cats.slice();
          deviceCatsMap[p.device_id] = catsCache.filter(c => p.cats.includes(c.name));
        }
        json({ success: true, persisted: !!db });
        return;
      }

      // ── Cajón de desechos y limpiezas programadas (solo BD) ──────────────────
      if (pathname === '/api/maintenance') {
        const devIdM = parsed.query.device || (litterboxesCache[0] && litterboxesCache[0].device_id) || DEVICE_ID;
        const m = await getMaintenance(devIdM);
        if (!m) { json({ success: false, msg: 'Sin BD' }); return; }
        json({ success: true, result: {
          visits: m.visits, threshold: m.threshold,
          pct: Math.min(100, Math.round(m.visits * 100 / m.threshold)),
          last_emptied: m.last_emptied,
        }});
        return;

      } else if (pathname === '/api/maintenance/reset' && req.method === 'POST') {
        if (!db) { json({ success: false, msg: 'Sin BD' }); return; }
        const p = JSON.parse(body || '{}');
        const devIdM = p.device_id || parsed.query.device || (litterboxesCache[0] && litterboxesCache[0].device_id) || DEVICE_ID;
        const th = (Number(p.threshold) > 0) ? Math.round(Number(p.threshold)) : null;
        if (th) {
          await db.query(
            'INSERT INTO maintenance (device_id, last_emptied, threshold) VALUES ($1,$2,$3) ON CONFLICT (device_id) DO UPDATE SET last_emptied=EXCLUDED.last_emptied, threshold=EXCLUDED.threshold',
            [devIdM, Date.now(), th]);
        } else {
          await db.query(
            'INSERT INTO maintenance (device_id, last_emptied) VALUES ($1,$2) ON CONFLICT (device_id) DO UPDATE SET last_emptied=EXCLUDED.last_emptied',
            [devIdM, Date.now()]);
        }
        json({ success: true });
        return;

      } else if (pathname === '/api/schedules') {
        // Los jobs viven en pg_cron (nombre: gaturrin-clean-<device>-<HHMM local>)
        if (!db) { json({ success: false, msg: 'Sin BD' }); return; }
        const { rows } = await db.query(
          "SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'gaturrin-clean-%' ORDER BY jobname");
        const result = rows.map(r => {
          const mm = r.schedule.match(/^(\d+)\s+(\d+)/);
          const mins  = mm ? Number(mm[1]) : 0;
          const hUTC  = mm ? Number(mm[2]) : 0;
          const hLoc  = (hUTC + 19) % 24; // UTC → Bogotá (UTC-5)
          return {
            jobname: r.jobname,
            device_id: r.jobname.replace('gaturrin-clean-', '').replace(/-\d{4}$/, ''),
            time: String(hLoc).padStart(2, '0') + ':' + String(mins).padStart(2, '0'),
          };
        });
        json({ success: true, result });
        return;

      } else if (pathname === '/api/schedules/save' && req.method === 'POST') {
        if (!db) { json({ success: false, msg: 'Sin BD' }); return; }
        if (!SYNC_TOKEN) { json({ success: false, msg: 'Falta SYNC_TOKEN en el servidor' }); return; }
        const p = JSON.parse(body || '{}');
        const devIdS = String(p.device_id || (litterboxesCache[0] && litterboxesCache[0].device_id) || DEVICE_ID || '');
        // El device_id se interpola en el comando SQL del job: solo alfanumérico
        if (!/^[A-Za-z0-9_-]+$/.test(devIdS)) { json({ success: false, msg: 'device_id inválido' }, 400); return; }
        const t = String(p.time || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) { json({ success: false, msg: 'Hora inválida (HH:MM)' }, 400); return; }
        const hLoc = Number(t[1]), mins = Number(t[2]);
        const hUTC = (hLoc + 5) % 24; // Bogotá → UTC
        const jobname = 'gaturrin-clean-' + devIdS + '-' + String(hLoc).padStart(2, '0') + String(mins).padStart(2, '0');
        const cleanUrl = APP_URL + '/api/clean?device=' + devIdS + '&token=' + SYNC_TOKEN;
        await db.query('SELECT cron.schedule($1, $2, $3)',
          [jobname, mins + ' ' + hUTC + ' * * *', "SELECT net.http_get('" + cleanUrl + "')"]);
        json({ success: true, jobname });
        return;

      } else if (pathname === '/api/schedules/delete' && req.method === 'POST') {
        if (!db) { json({ success: false, msg: 'Sin BD' }); return; }
        const p = JSON.parse(body || '{}');
        if (!p.jobname || String(p.jobname).indexOf('gaturrin-clean-') !== 0) {
          json({ success: false, msg: 'jobname inválido' }, 400); return;
        }
        await db.query('SELECT cron.unschedule($1)', [String(p.jobname)]);
        json({ success: true });
        return;
      }

      // ── Endpoints que hablan con Tuya (requieren token) ────────────────────────
      await getToken();
      const reqDevId = parsed.query.device || (litterboxesCache[0] && litterboxesCache[0].device_id) || DEVICE_ID;

      if (pathname === '/api/status') {
        const st = await tuyaRequest('GET', '/v1.0/devices/' + reqDevId + '/status');
        if (TRIAL_END) st.trial_end = TRIAL_END;
        json(st);

      } else if (pathname === '/api/clean') {
        console.log('[API] clean → nowclean:jikeclean [' + reqDevId.slice(-6) + ']');
        json(await cmd('nowclean', 'jikeclean', reqDevId));

      } else if (pathname === '/api/cancel') {
        console.log('[API] cancel → cancelnow:nowtocancle [' + reqDevId.slice(-6) + ']');
        json(await cmd('cancelnow', 'nowtocancle', reqDevId));

      } else if (pathname.startsWith('/api/cmd/')) {
        const parts   = pathname.replace('/api/cmd/', '').split('/');
        const cmdCode = parts[0];
        const raw     = parts[1];
        const cmdVal  = raw === 'true' ? true : raw === 'false' ? false : isNaN(raw) ? raw : Number(raw);
        console.log('[API] cmd:', cmdCode, '=', cmdVal);
        json(await cmd(cmdCode, cmdVal, reqDevId));

      } else if (pathname === '/api/spec') {
        json(await tuyaRequest('GET', '/v1.0/devices/' + reqDevId + '/specifications'));

      } else if (pathname === '/api/info') {
        json(await tuyaRequest('GET', '/v1.0/devices/' + reqDevId));

      } else if (pathname === '/api/visits') {
        if (db) {
          await syncVisits(reqDevId); // trae visitas nuevas desde Tuya antes de leer
          const { rows } = await db.query(
            `SELECT ts, weight_raw AS weight, duration_sec AS duration
             FROM visits WHERE device_id=$1 ORDER BY ts DESC LIMIT 2000`, [reqDevId]
          );
          json({ success: true, result: rows.map(r => ({
            ts: Number(r.ts), weight: Number(r.weight), duration: r.duration ? Number(r.duration) : null
          })), source: 'db' });
        } else {
          // Sin BD (dev local): lee de Tuya al vuelo. 3 días para no hacer
          // demasiadas llamadas por ventana en cada refresco.
          const now  = Date.now();
          const logs = await fetchTuyaLogs(now - 3 * 24 * 60 * 60 * 1000, now, reqDevId);
          json({ success: true, result: parseVisits(logs), source: 'tuya' });
        }

      } else if (pathname === '/api/sync') {
        // Awaited: en serverless la instancia muere al responder, no hay
        // background. Con ?device sincroniza uno; sin él, todos + alertas.
        if (parsed.query.device) {
          await syncVisits(reqDevId);
        } else {
          await syncAllDevices();
        }
        await checkAlerts();
        json({ success: true, msg: 'Sync completado' });

      } else if (pathname === '/api/resync') {
        // Fuerza re-sincronización completa desde 10 días atrás (ignora lastTs;
        // Tuya solo retiene ~7 días de logs)
        if (!db) { json({ success: false, msg: 'Sin BD' }); return; }
        const from90 = Date.now() - 10 * 24 * 60 * 60 * 1000;
        const now90  = Date.now();
        const logs   = await fetchTuyaLogs(from90, now90, reqDevId);
        const visits = parseVisits(logs);
        let inserted = 0, skipped = 0;
        for (const v of visits) {
          const { rowCount } = await db.query(
            `INSERT INTO visits (ts, cat_name, weight_raw, weight_kg, duration_sec, device_id)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (device_id, ts) DO NOTHING`,
            [v.ts, catByWeight(v.weight, reqDevId), v.weight,
             parseFloat((v.weight * 0.04536).toFixed(2)), v.duration, reqDevId]
          );
          if (rowCount) inserted++; else skipped++;
        }
        const cwSessions = logs.filter(l => l.code === 'cat_weight' && parseInt(l.value) > 0).length;
        json({ success: true, total_logs: logs.length, cat_weight_nonzero: cwSessions, visits_parsed: visits.length, inserted, skipped });

      } else if (pathname === '/api/tuyapage') {
        const qs    = new URL('http://x' + req.url).searchParams;
        const days  = parseInt(qs.get('days') || '7');
        const rowKey = qs.get('key') || null;
        const type  = qs.get('type') || '7';
        const fromP = Date.now() - days * 24 * 60 * 60 * 1000;
        let q = '?end_time=' + Date.now() + '&size=100&start_time=' + fromP;
        if (type) q += '&type=' + type;
        if (rowKey) q += '&last_row_key=' + encodeURIComponent(rowKey);
        const raw = await tuyaRequest('GET', '/v1.0/devices/' + reqDevId + '/logs' + q);
        const meta = raw.result ? {
          has_next: raw.result.has_next, last_row_key: raw.result.last_row_key,
          total: raw.result.total, count: (raw.result.logs || []).length,
          oldest: raw.result.logs?.length ? new Date(raw.result.logs[raw.result.logs.length-1].event_time).toISOString() : null,
          newest: raw.result.logs?.length ? new Date(raw.result.logs[0].event_time).toISOString() : null,
        } : null;
        json({ success: raw.success, result_meta: meta });

      } else if (pathname === '/api/rawlogs') {
        const qs     = new URL('http://x' + req.url).searchParams;
        const days   = parseInt(qs.get('days') || '7');
        const code   = qs.get('code') || null;
        const limit  = parseInt(qs.get('limit') || '500');
        const fromRaw = Date.now() - days * 24 * 60 * 60 * 1000;
        const logs   = await fetchTuyaLogs(fromRaw, Date.now(), reqDevId);
        const filtered = code ? logs.filter(l => l.code === code) : logs;
        const slice  = filtered.slice(0, limit).map(l => ({ ts: new Date(l.event_time).toISOString(), code: l.code, value: l.value }));
        json({ success: true, total: filtered.length, days, code, shown: slice.length, logs: slice });

      } else if (pathname === '/api/logscan') {
        const days = parseInt(new URL('http://x' + req.url).searchParams.get('days') || '90');
        const fromScan = Date.now() - days * 24 * 60 * 60 * 1000;
        const logs = await fetchTuyaLogs(fromScan, Date.now(), reqDevId);
        const counts = {}, samples = {}, allTs = [];
        logs.forEach(l => {
          counts[l.code] = (counts[l.code] || 0) + 1;
          if (!samples[l.code]) samples[l.code] = l.value;
          if (l.event_time) allTs.push(l.event_time);
        });
        const minTs = allTs.length ? Math.min(...allTs) : null;
        const maxTs = allTs.length ? Math.max(...allTs) : null;
        const cwValues = logs.filter(l => l.code === 'cat_weight').map(l => parseInt(l.value)).filter(v => v > 0);
        json({ success: true, total_logs: logs.length, days,
          range: { oldest: minTs ? new Date(minTs).toISOString() : null, newest: maxTs ? new Date(maxTs).toISOString() : null, span_days: minTs ? ((maxTs - minTs) / 86400000).toFixed(1) : null },
          cat_weight_nonzero: cwValues.length, cat_weight_values: cwValues,
          codes: Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([code,count]) => ({ code, count, sample: samples[code] }))
        });

      } else if (pathname === '/api/records') {
        const now  = Date.now();
        const from = now - 24 * 60 * 60 * 1000;
        const q    = '?end_time=' + now + '&size=100&start_time=' + from + '&type=7';
        json(await tuyaRequest('GET', '/v1.0/devices/' + reqDevId + '/logs' + q));

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
};

module.exports = { handler, ensureDB, syncAllDevices, checkAlerts, PORT };
