// Genera public/icon-192.png y public/icon-512.png (huella de gato rosa sobre
// fondo lavanda) sin dependencias: encoder PNG mínimo + rasterizado por píxel.
// Uso: node scripts/gen-icons.js

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 (requerido por el formato PNG) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, pixels /* RGBA Buffer */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  // Scanlines con filtro 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Dibujo: huella de gato ──
const BG  = [0xf5, 0xee, 0xff]; // lavanda claro (fondo de la app)
const FG  = [0xd9, 0x46, 0xa8]; // rosa (acento)

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const inEllipse = (x, y, cx, cy, rx, ry) => {
    const dx = (x - cx * size) / (rx * size);
    const dy = (y - cy * size) / (ry * size);
    return dx * dx + dy * dy <= 1;
  };
  // Almohadilla central + 4 dedos (coordenadas relativas, dentro de la zona
  // segura maskable: contenido en el 80% central)
  const shapes = [
    [0.500, 0.640, 0.200, 0.165], // almohadilla
    [0.295, 0.410, 0.085, 0.095], // dedo ext izq
    [0.430, 0.315, 0.085, 0.095], // dedo int izq
    [0.570, 0.315, 0.085, 0.095], // dedo int der
    [0.705, 0.410, 0.085, 0.095], // dedo ext der
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const paw = shapes.some(s => inEllipse(x, y, s[0], s[1], s[2], s[3]));
      const c = paw ? FG : BG;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return encodePNG(size, px);
}

for (const size of [192, 512]) {
  const out = path.join(__dirname, '..', 'public', 'icon-' + size + '.png');
  fs.writeFileSync(out, drawIcon(size));
  console.log('✓', out);
}
