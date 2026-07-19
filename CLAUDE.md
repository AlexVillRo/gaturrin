# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

App web (en español) que reemplaza la app oficial de la arenera automática de gatos **Mintakawa CAST-LB500C**, conectada vía la API cloud de Tuya. Identifica a cada gato por su peso y registra sus visitas al baño. Es PWA instalable.

## Comandos

- **Correr en local:** `node proxy.js` → http://localhost:3000. Lee credenciales de `.env` (TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_DEVICE_ID — obligatorias, el proceso sale si faltan). Ver `.env.example` para las opcionales (ACCESS_PIN, SYNC_TOKEN, TUYA_TRIAL_END, TELEGRAM_*, DATABASE_URL).
- **Tests:** `npm test` (node:test, sin dependencias; cubren `lib/visits.js`).
- **Verificar sintaxis:** `node --check proxy.js`.
- **Regenerar iconos PWA:** `node scripts/gen-icons.js`.
- **Deploy:** Vercel serverless (el proyecto Railway anterior murió con el trial). `vercel.json` usa `builds` + `routes` para mandar **todas** las rutas por `api/index.js` — no cambiarlo a estáticos: si Vercel sirviera `public/` directo, el HTML quedaría fuera del gate de PIN. Sin proceso residente: el sync cada 30 min lo dispara un job `pg_cron` + `pg_net` **dentro del propio Supabase** (job `gaturrin-sync`, ver `cron.job`) llamando `/api/sync?token=<SYNC_TOKEN>`. BD: Postgres de Supabase, proyecto `gaturrin` (connection string del transaction pooler, puerto 6543, en `DATABASE_URL`). Producción: https://gaturrin.vercel.app (deploy automático al pushear `master` vía integración Git, o `vercel --prod`).

## Arquitectura

- **`lib/app.js`** — toda la lógica del servidor, sin `listen()` (única dependencia: `pg`). Cliente Tuya (firma HMAC-SHA256, token cacheado), API REST bajo `/api/*`, auth por PIN (cookie HMAC, `LOGIN_HTML` embebido), alertas Telegram (cooldown 24h persistido en tabla `alerts_sent` — la memoria no sobrevive en serverless), PostgreSQL opcional (tablas `visits`, `cats`, `litterboxes`, `cat_litterbox`; sin `DATABASE_URL` corre stateless leyendo logs de Tuya al vuelo). La BD se inicializa perezosamente (`ensureDB`) en el primer request.
- **`proxy.js`** — entrada local: `http.createServer(app.handler)` + sync automático cada 30 min + `checkAlerts` (solo aquí hay proceso persistente).
- **`api/index.js`** — entrada serverless (Vercel): exporta el mismo handler. `/api/sync` es awaited (no hay background tras responder) y acepta `?token=<SYNC_TOKEN>` sin PIN para el cron externo.
- **`lib/visits.js`** — lógica pura testeable: `parseVisits` (agrupa secuencias de `cat_weight > 0` en sesiones, corte a los 2 min; descarta modo `isclean`; no usar `catinweight`, solo se emite tras limpiezas) y `nearestCat` (identificación por peso con umbral ±25% del objetivo y mínimo 30 raw — fuera de rango devuelve null = visita "desconocido").
- **`public/`** — frontends estáticos servidos con `readFileSync`: `index.html` (app principal, vanilla JS + Chart.js), `configuracion.html` (wizard BLE/areneros), `manifest.webmanifest`, `sw.js` (network-first, no cachea `/api/`), iconos. **El frontend duplica la lógica de `nearestCat` en `identifyCat` — mantener ambos en sinc.**
- **API REST**: `status`, `visits` (+`/reassign`), `sync`, `resync`, `clean`, `cancel`, `cmd/:code/:value`, `spec`, `info`, `litterboxes` (+`/discover`, `/save`, `/delete`, `/assign`), `cats` (+`/save`, `/delete`), `avatars`, `maintenance` (+`/reset`, `/threshold`), `schedules` (+`/save`, `/delete` — jobs pg_cron), `notifyprefs` (+`/save`), `telegram` (webhook de botones), `login`, `tuyapage`/`rawlogs`/`logscan` (debug). Multi-arenero vía query `?device=<id>`.
- **Identificación**: el `cat_name` guardado en la BD (al sincronizar o reasignado a mano vía `/api/visits/reassign`) es la fuente de verdad del historial; el frontend (`visitCatName`) solo re-identifica por peso como fallback sin BD. `identifyCat` sigue usándose para la báscula en tiempo real.
- En el frontend, los nombres de gatos/areneros se inyectan con `esc()` — mantenerlo en cualquier `innerHTML` nuevo.

`gaturrin.html` (sin trackear) es un prototipo viejo, ignorarlo. `test_local.py` es la prueba de concepto de control local vía tinytuya (plan B si Tuya cloud falla).

## Peculiaridades de la API de Tuya (aprendidas a golpes)

- **La paginación de logs no funciona**: Tuya ignora `last_row_key` y siempre devuelve los ~100 eventos más recientes del rango. `fetchTuyaLogs` lo rodea consultando ventanas de 6h y bisectando recursivamente las que llegan al tope de 100. No "simplificar" esto de vuelta a paginación.
- **Retención de logs: ~7 días.** Por eso `/api/resync` cubre 10 días, no más.
- **El trial de IoT Core expira** (~cada 6 meses) y rompe todos los endpoints de dispositivo con código `28841002` — pero `/v1.0/token` sigue funcionando, así que un token válido no prueba nada. La UI detecta ese código y muestra banner de renovación; `TUYA_TRIAL_END` (YYYY-MM-DD) activa aviso anticipado 14 días antes (y por Telegram 7 días antes). Se renueva gratis en iot.tuya.com → Cloud → IoT Core → Extend Trial Period.
- **DPs clave** (categoría `msp`): `cat_weight` (peso en tiempo real, LB×10; kg = raw × 0.04536), `isnowmode` (`isidle`/`isclean`/`idlevelling`), `excretion_times_day`, `nocatinsec` (duración de visita), `fault`/`notification` (bitmasks). Escritura: `cleanonoff`, `nowclean`, `cancelnow`.
- En modo **local** (tinytuya, protocolo 3.5, IP y local_key en `.env` como `TUYA_LOCAL_*`) los DPs son numéricos, no códigos.

## Convenciones

- Código, comentarios, UI y mensajes de commit en español; commits con prefijo convencional (`fix:`, `feat:`, `refactor:`).
- Frontend vanilla JS estilo `var` + `function` (sin arrow functions ni template literals — mantener el estilo del código existente), tema pastel claro (lavanda `#f5eeff`, acento rosa `#d946a8`), fuentes Nunito + DM Mono.
- Los gatos actuales: TChala, Dalila, Whis, Ares (se identifican por rangos de peso configurados en la BD/UI).
