// lib/visits.js — Lógica pura de visitas e identificación de gatos.
// Sin dependencias ni estado: testeable con node:test.

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

// Identificación por peso con umbral: el gato más cercano gana solo si la
// lectura está dentro de ±MATCH_TOLERANCE de su peso objetivo. Lecturas fuera
// de rango (ruido del sensor, dos gatos a la vez) devuelven null y se tratan
// como "desconocido" en vez de contaminar los datos del gato más cercano.
const MATCH_TOLERANCE = 0.25;
const MIN_VALID_RAW   = 30; // ~1.36 kg: por debajo es ruido, no un gato adulto

function nearestCat(raw, pool) {
  if (!raw || raw < MIN_VALID_RAW || !pool || !pool.length) return null;
  let best = null, bestDist = Infinity;
  for (const cat of pool) {
    const d = Math.abs(raw - cat.targetRaw);
    if (d < bestDist) { bestDist = d; best = cat; }
  }
  if (bestDist > best.targetRaw * MATCH_TOLERANCE) return null;
  return best;
}

// ── Identificación probabilística (peso + hábitos) ───────────────────────────
// Cuando dos gatos pesan casi lo mismo, el más cercano por peso es una moneda al
// aire. identifyVisit combina qué tan bien encaja el peso con cada gato y sus
// hábitos (qué tan seguido hace visitas cortas y cuánto suele durar), y si ni
// así hay seguridad devuelve los candidatos ("A o B") en vez de adivinar.
//
// Datos que lo respaldan (análisis sobre 503 visitas de dos gatas de peso
// parecido): la hora del día no distingue nada; las visitas cortas y la
// duración sí aportan. El ruido de la báscula para un mismo gato ronda ±2.5 raw.

const WEIGHT_SIGMA_MIN  = 2.5;  // raw (~115 g): ruido típico de la báscula
const WEIGHT_SIGMA_PCT  = 0.03; // ...o 3% del peso, si es mayor
const SHORT_VISIT_SEC   = 20;   // la arenera solo cuenta como uso válido >20 s
const DURATION_BINS     = [35, 50, 75]; // tramos de las visitas completas (s)
const HABIT_KEYS        = ['corta', 'd0', 'd1', 'd2', 'd3'];
const CONFIDENCE_MIN    = 0.75; // por debajo, la visita queda "en duda"
const CANDIDATES_CUM    = 0.9;  // candidatos hasta cubrir el 90% de probabilidad
const CLEAR_WEIGHT_P    = 0.75; // para aprender hábitos: el peso solo ya lo decía

function habitKey(duration) {
  if (!duration || duration < SHORT_VISIT_SEC) return 'corta';
  let i = 0;
  while (i < DURATION_BINS.length && duration >= DURATION_BINS[i]) i++;
  return 'd' + i;
}

// Probabilidad de cada gato del pool (dentro de la tolerancia), ordenada de
// mayor a menor. habitOf(cat) opcional: probabilidad del hábito observado.
function posteriors(raw, pool, habitOf) {
  const scores = [];
  for (const c of pool) {
    if (Math.abs(raw - c.targetRaw) > c.targetRaw * MATCH_TOLERANCE) continue;
    const sigma = Math.max(WEIGHT_SIGMA_MIN, c.targetRaw * WEIGHT_SIGMA_PCT);
    let lp = -0.5 * Math.pow((raw - c.targetRaw) / sigma, 2) - Math.log(sigma);
    if (habitOf) lp += Math.log(habitOf(c));
    scores.push({ name: c.name, lp });
  }
  const max = Math.max(...scores.map(s => s.lp));
  const total = scores.reduce((a, s) => a + Math.exp(s.lp - max), 0);
  scores.forEach(s => { s.p = Math.exp(s.lp - max) / total; });
  return scores.sort((a, b) => b.p - a.p);
}

// Nombre del gato al que el peso solo ya apunta con claridad, o null.
function clearCatByWeight(raw, pool) {
  if (!nearestCat(raw, pool)) return null;
  const s = posteriors(raw, pool);
  return s[0].p >= CLEAR_WEIGHT_P ? s[0].name : null;
}

// Perfil de hábitos por gato a partir del historial. Solo aprende de visitas
// confirmadas a mano o cuyo peso era inequívoco: nunca de lo que el propio
// algoritmo adivinó por hábitos (se reforzaría sus propios errores).
// visits: [{ cat, weight, duration, confirmed }]
function buildHabitProfiles(visits, pool) {
  const profiles = {};
  for (const v of visits) {
    if (!v.cat) continue;
    if (!v.confirmed && clearCatByWeight(v.weight, pool) !== v.cat) continue;
    const p = profiles[v.cat] || (profiles[v.cat] = { n: 0, counts: {} });
    const k = habitKey(v.duration);
    p.counts[k] = (p.counts[k] || 0) + 1;
    p.n++;
  }
  return profiles;
}

function habitProb(profile, key) {
  const n = profile ? profile.n : 0;
  const c = profile ? (profile.counts[key] || 0) : 0;
  return (c + 1) / (n + HABIT_KEYS.length); // suavizado: sin historial = neutro
}

// → { cat, candidates, confidence }
//   cat: nombre si hay seguridad; candidates: [nombres] si está en duda;
//   ambos null = desconocido (peso fuera de rango de todos).
function identifyVisit(visit, pool, profiles) {
  const none = { cat: null, candidates: null, confidence: null };
  if (!nearestCat(visit.weight, pool)) return none;
  const key = habitKey(visit.duration);
  const scores = posteriors(visit.weight, pool, c => habitProb(profiles && profiles[c.name], key));
  const confidence = Math.round(scores[0].p * 100) / 100;
  if (scores[0].p >= CONFIDENCE_MIN) return { cat: scores[0].name, candidates: null, confidence };
  const candidates = [];
  let cum = 0;
  for (const s of scores) {
    candidates.push(s.name);
    cum += s.p;
    if (candidates.length >= 2 && (cum >= CANDIDATES_CUM || candidates.length >= 3)) break;
  }
  return { cat: null, candidates, confidence };
}

module.exports = {
  parseVisits, nearestCat, identifyVisit, buildHabitProfiles, habitKey,
  MATCH_TOLERANCE, MIN_VALID_RAW, CONFIDENCE_MIN,
};
