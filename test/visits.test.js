const { test } = require('node:test');
const assert = require('node:assert');
const { parseVisits, nearestCat, identifyVisit, buildHabitProfiles, habitKey } = require('../lib/visits');

// Helpers para armar logs estilo Tuya
const T0 = 1780000000000;
const cw  = (offsetSec, value) => ({ code: 'cat_weight', value: String(value), event_time: T0 + offsetSec * 1000 });
const mode = (offsetSec, value) => ({ code: 'isnowmode', value, event_time: T0 + offsetSec * 1000 });
const dur = (offsetSec, value) => ({ code: 'nocatinsec', value: String(value), event_time: T0 + offsetSec * 1000 });

test('agrupa lecturas consecutivas en una visita con el peso máximo', () => {
  const visits = parseVisits([cw(0, 80), cw(10, 95), cw(20, 88), cw(30, 0)]);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].weight, 95);
  assert.equal(visits[0].ts, T0);
});

test('corta la sesión si pasan más de 2 minutos sin lecturas', () => {
  const visits = parseVisits([cw(0, 80), cw(10, 82), cw(200, 110), cw(210, 0)]);
  assert.equal(visits.length, 2);
  // Orden descendente por ts
  assert.equal(visits[0].weight, 110);
  assert.equal(visits[1].weight, 82);
});

test('descarta sesiones durante el modo isclean (falso positivo del rastrillo)', () => {
  const visits = parseVisits([mode(0, 'isclean'), cw(5, 90), cw(15, 0), mode(60, 'isidle'), cw(120, 80), cw(130, 0)]);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].weight, 80);
});

test('usa nocatinsec como duración si aparece justo después de la sesión', () => {
  const visits = parseVisits([cw(0, 80), cw(30, 85), cw(40, 0), dur(50, 42)]);
  assert.equal(visits[0].duration, 42);
});

test('sin nocatinsec, la duración es el largo de la sesión', () => {
  const visits = parseVisits([cw(0, 80), cw(30, 85), cw(45, 0)]);
  assert.equal(visits[0].duration, 30);
});

test('logs vacíos o sin cat_weight no producen visitas', () => {
  assert.equal(parseVisits([]).length, 0);
  assert.equal(parseVisits([mode(0, 'isidle'), dur(10, 5)]).length, 0);
});

// ── nearestCat ──
const POOL = [
  { name: 'TChala', targetRaw: 50 },
  { name: 'Dalila', targetRaw: 80 },
  { name: 'Whis',   targetRaw: 106 },
  { name: 'Ares',   targetRaw: 120 },
];

test('asigna al gato más cercano dentro del umbral', () => {
  assert.equal(nearestCat(52, POOL).name, 'TChala');
  assert.equal(nearestCat(84, POOL).name, 'Dalila');
  assert.equal(nearestCat(118, POOL).name, 'Ares');
});

test('rechaza lecturas fuera del umbral (±25% del objetivo)', () => {
  assert.equal(nearestCat(243, POOL), null); // ~11 kg: dos gatos o ruido
  assert.equal(nearestCat(155, POOL), null); // muy por encima de Ares (120×1.25=150)
});

test('rechaza pesos por debajo del mínimo plausible', () => {
  assert.equal(nearestCat(22, POOL), null);  // 1.00 kg: ruido del sensor
  assert.equal(nearestCat(0, POOL), null);
  assert.equal(nearestCat(null, POOL), null);
});

test('pool vacío devuelve null', () => {
  assert.equal(nearestCat(80, []), null);
});

// ── identifyVisit / buildHabitProfiles ──
// Dos gatas casi del mismo peso (A y B) más una claramente distinta (C)
const PAR = [
  { name: 'A', targetRaw: 82 },
  { name: 'B', targetRaw: 84 },
  { name: 'C', targetRaw: 106 },
];
const repetir = (n, v) => Array.from({ length: n }, () => Object.assign({}, v));

test('habitKey: sin duración o menos de 20 s es visita corta', () => {
  assert.equal(habitKey(null), 'corta');
  assert.equal(habitKey(6), 'corta');
  assert.equal(habitKey(30), 'd0');
  assert.equal(habitKey(40), 'd1');
  assert.equal(habitKey(60), 'd2');
  assert.equal(habitKey(120), 'd3');
});

test('peso inequívoco: asigna directo con confianza alta', () => {
  const r = identifyVisit({ weight: 106, duration: 40 }, PAR, {});
  assert.equal(r.cat, 'C');
  assert.equal(r.candidates, null);
  assert.ok(r.confidence >= 0.99);
});

test('pesos casi iguales y sin hábitos: queda en duda con ambos candidatos', () => {
  const r = identifyVisit({ weight: 83, duration: 40 }, PAR, {});
  assert.equal(r.cat, null);
  assert.deepEqual(r.candidates.slice().sort(), ['A', 'B']);
  assert.ok(r.confidence < 0.75);
});

test('fuera de rango de todos: desconocido (sin candidatos)', () => {
  const r = identifyVisit({ weight: 200, duration: 40 }, PAR, {});
  assert.deepEqual(r, { cat: null, candidates: null, confidence: null });
});

test('los hábitos desempatan cuando el peso no alcanza', () => {
  // A hace muchas visitas cortas; B casi nunca
  const profiles = {
    A: { n: 100, counts: { corta: 40, d0: 20, d1: 20, d2: 10, d3: 10 } },
    B: { n: 100, counts: { corta: 5, d0: 20, d1: 25, d2: 35, d3: 15 } },
  };
  assert.equal(identifyVisit({ weight: 83, duration: null }, PAR, profiles).cat, 'A');
  // Duración muy típica de B (50-75 s: 35% vs 10%) también desempata
  assert.equal(identifyVisit({ weight: 83, duration: 60 }, PAR, profiles).cat, 'B');
  // Duración que las dos hacen parecido (35-50 s): sigue en duda
  const r = identifyVisit({ weight: 83, duration: 40 }, PAR, profiles);
  assert.equal(r.cat, null);
  assert.equal(r.candidates[0], 'B');
});

test('buildHabitProfiles aprende solo de pesos claros o confirmados', () => {
  const visits = [].concat(
    repetir(3, { cat: 'A', weight: 76, duration: null }),        // claro aunque los objetivos disten 2 → cuenta
    repetir(2, { cat: 'B', weight: 83, duration: 40 }),          // ambiguo → no cuenta
    repetir(1, { cat: 'B', weight: 83, duration: 40, confirmed: true }), // confirmado → cuenta
    repetir(1, { cat: 'B', weight: 76, duration: 40 }),          // el peso dice A → no cuenta
    repetir(2, { cat: 'B', weight: 88, duration: 60 }),          // claro para B → cuenta
    repetir(1, { cat: null, weight: 90, duration: 40 })          // sin gato → no cuenta
  );
  const p = buildHabitProfiles(visits, PAR);
  assert.equal(p.A.n, 3);
  assert.equal(p.A.counts.corta, 3);
  assert.equal(p.B.n, 3);
});
