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

module.exports = { parseVisits, nearestCat, MATCH_TOLERANCE, MIN_VALID_RAW };
