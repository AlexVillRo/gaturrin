const { test } = require('node:test');
const assert = require('node:assert');
const { parseVisits, nearestCat } = require('../lib/visits');

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
