# prort

Tabla de posiciones de **LigaPro** (por defecto, *Serie 4 / Divisional B / Clausura 2026*), con lo que la página oficial no muestra:

- **Puntos Perdidos** (`PPerd`): 3 por derrota, 2 por empate, 0 por victoria. Menos es mejor.
- **Orden por cualquier columna**, sin recargar.
- **Partidos por equipo**: tocá un equipo y aparecen sus partidos jugados (jornada, fecha, local/visitante, rival, resultado, cancha), la jornada en que queda libre y, plegados, los rivales que le quedan.
- **Detalle de cada partido**: tocá un resultado y se abre ahí mismo, con goles y asistencias, tarjetas amarillas y rojas con su minuto, y la figura del partido.
- **Avisos por Telegram** cuando hay un resultado nuevo, corregido o anulado, cuando se mueve la tabla, y cada vez que el servicio arranca.

Sin login, sin base de datos, sin framework de frontend. Un proceso, todo en memoria.

## De dónde salen los datos

La web de LigaPro arma sus pestañas pidiéndole JSON a rutas públicas de su propio sitio. Este servicio consulta esas mismas rutas: no hace falta navegador headless ni parseo de HTML.

| Qué | Ruta, bajo `https://www.ligapro.uy/api/` | Cuándo se pide |
| --- | --- | --- |
| Posiciones | `tournaments/{id}/positions` | En cada ciclo |
| Fixture completo, con resultados | `tournaments/{id}/games` | En cada ciclo |
| Campeonato: nombre, fechas, jornada actual | `tournaments/{id}` | Cada hora |
| Jornadas | `tournaments/{id}/groupweeks` | Cada hora |
| Partidos de una jornada | `tournaments/{id}/games?filter[groupweek][0]={jornada}` | Cada hora, uno por jornada, o antes si aparece un partido nuevo |
| Detalle de un partido | `games/{id}/info`, `games/{id}/events`, `games/{id}/mvps` | Sólo cuando alguien abre ese partido |

Algunas cosas de la API que conviene saber:

- **LigaPro limita las consultas** (responde HTTP 429). Por eso los pedidos van de a uno y espaciados, y si LigaPro frena, el servicio espera cada vez más antes de volver a consultar.
- **Las fechas de los partidos no son confiables**: hay partidos ya jugados con fecha de noviembre. Un partido cuenta como jugado si tiene resultado, y todo se ordena por jornada, no por fecha.
- **La hora viene siempre `00:00`**, así que no se muestra.
- **El detalle de algunos partidos está incompleto** (goles sin autor, o ningún evento). La página lo dice en vez de inventarlo.

## Correrlo local

```bash
npm install
npm run dev
```

Abrí <http://localhost:3000>. Sin variables de entorno usa los valores por defecto (campeonato `549`) y arranca sin notificaciones.

Para producción:

```bash
npm run build && npm start
```

Otros comandos: `npm test` (suite completa) y `npm run typecheck`.

## Configuración

Copiá el ejemplo y editá lo que necesites:

```bash
cp .env.example .env
```

`npm run dev` y `npm start` leen ese archivo solos (con `--env-file-if-exists`, nativo de Node 22). `.env` está en `.gitignore`: no lo subas.

Todas las variables están documentadas en [`.env.example`](.env.example). Las que más se tocan:

| Variable | Default | Qué hace |
| --- | --- | --- |
| `UPSTREAM_TOURNAMENT_ID` | `549` | Campeonato. Cambiar de torneo es tocar esto, no el código |
| `POLL_INTERVAL_MINUTES` | `5` | Cada cuánto se consultan posiciones y resultados |
| `POLL_JITTER_SECONDS` | `30` | Desfasaje aleatorio de ±N segundos en cada corrida; `0` lo desactiva |
| `JORNADA_REFRESH_MINUTES` | `60` | Cada cuánto se vuelve a leer a qué jornada pertenece cada partido |
| `MATCH_DETAILS_TTL_MINUTES` | `15` | Cuánto se guarda el detalle de un partido antes de volver a pedirlo |
| `MATCH_DETAILS_REQUESTS_PER_MINUTE` | `20` | Tope de pedidos por minuto a LigaPro para detalles de partidos |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | vacías | Si faltan, el sitio anda igual y no manda nada. Van juntas o ninguna |
| `TELEGRAM_MAX_MESSAGES_PER_POLL` | `5` | Tope de mensajes por ciclo |
| `SNAPSHOT_PATH` | `./data/snapshot.json` | Base para comparar después de un reinicio |
| `SITE_URL` | vacía | URL pública, se incluye en los mensajes de Telegram |
| `DISPLAY_TIMEZONE` | `America/Montevideo` | Zona horaria de "última actualización" |

Las horas de "última actualización" se calculan siempre en `DISPLAY_TIMEZONE`, sin importar en qué zona corra el servidor. Las fechas de los partidos vienen de LigaPro en hora local y se muestran tal cual.

Los avisos son **completos**: si un ciclo detecta varios cambios (varios resultados, varios equipos), todos aparecen. Si no entran en un mensaje, se parten en varios numerados en vez de recortarse. Los resultados se avisan con el marcador, sin goleadores.

## Endpoints

| Ruta | Qué devuelve |
| --- | --- |
| `/` | La página, con la tabla y los paneles de cada equipo |
| `/partido/{id}` | El detalle de un partido jugado, como página completa (anda sin JavaScript) |
| `/api/standings` | La tabla en JSON, con `PPerd` y, por equipo, partidos jugados, jornadas libres y rivales pendientes |
| `/api/matches/{id}` | El detalle de un partido en JSON |
| `/health` | Estado del proceso, de cada fuente de datos y del freno por límite de consultas |

## Deploy

Un contenedor, sin base de datos:

```bash
docker build -t prort . && docker run -p 3000:3000 --env-file .env prort
```

El snapshot (`SNAPSHOT_PATH`) sirve sólo para no reportar toda la tabla como "cambiada" después de un reinicio. Si el filesystem es efímero y no te importa, no montes nada: el servicio arranca en frío y manda el mensaje de arranque igual. Un snapshot de otro campeonato se ignora, así que cambiar `UPSTREAM_TOURNAMENT_ID` nunca dispara avisos falsos.
