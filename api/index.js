// api/index.js — Gaturrin: entrada serverless (Vercel)
// vercel.json manda TODAS las rutas por aquí para que el gate de PIN cubra
// también el HTML (si Vercel sirviera public/ estático, quedaría expuesto).
// No hay proceso residente: el sync periódico lo dispara un cron externo
// llamando /api/sync?token=<SYNC_TOKEN>.

module.exports = require('../lib/app').handler;
