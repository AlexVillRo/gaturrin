// proxy.js — Gaturrin: entrada local / servidor persistente
// Desarrollo: node proxy.js  →  http://localhost:3000
// Producción serverless (Vercel) usa api/index.js; toda la lógica vive en lib/app.js.

const http = require('http');
const app  = require('./lib/app');

const server = http.createServer(app.handler);

server.listen(app.PORT, function() {
  console.log('\n🐾 Gaturrin en http://localhost:' + app.PORT + '\n');
  app.ensureDB()
    .then(() => app.syncAllDevices())
    .then(() => app.checkAlerts())
    .catch(e => console.error('[DB] Error en init:', e.message));
  setInterval(() => app.syncAllDevices().then(app.checkAlerts).catch(console.error), 30 * 60 * 1000);
});
