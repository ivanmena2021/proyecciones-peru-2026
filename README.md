# Proyecciones Electorales Perú 2026

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.21-000000?logo=express)
![License](https://img.shields.io/github/license/ivanmena2021/proyecciones-peru-2026)
![Last commit](https://img.shields.io/github/last-commit/ivanmena2021/proyecciones-peru-2026)
![Repo size](https://img.shields.io/github/repo-size/ivanmena2021/proyecciones-peru-2026)

Visualizador web en **tiempo real** de las proyecciones electorales de Perú 2026, con estimación bayesiana a partir de datos de **ONPE** (resultadoelectoral.onpe.gob.pe) y señales complementarias de TV Perú y RPP.

---

## ✨ Características

- 🔴 **Actualización en vivo** vía Server-Sent Events (SSE) — ciclos de polling cada 20s
- 📊 **Motor de estimación bayesiano** con bootstrap (1000 iteraciones) y shrinkage configurable
- 🎯 **Muestreo estratificado** urbano/rural por censo distrital, con bias-correction
- 🚦 **Grado de confianza A/B/C/D** según % contado y ancho del intervalo de credibilidad
- 🔀 **Dos modos de operación:**
  - `scrape` (default, ligero) — scraping de TV Perú / RPP SSR
  - `full` — motor bayesiano completo con muestreo a nivel de mesa
- 📈 **Historial** de hasta 200 puntos para visualizar evolución
- 🎨 **15 partidos políticos** pre-configurados con colores oficiales

---

## 🚀 Inicio rápido

**Requiere Node.js ≥ 20.**

```bash
npm install
npm start            # modo producción
npm run dev          # modo desarrollo (con --watch)
```

Por defecto escucha en `http://localhost:3000`.

### Cambiar de modo

```bash
POLLER_MODE=full npm start    # motor bayesiano completo
POLLER_MODE=scrape npm start  # default, ligero
```

---

## 🌐 Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/sse` | Stream SSE con estimaciones en tiempo real |
| GET | `/api/latest` | Última estimación disponible (JSON) |
| GET | `/api/history` | Serie histórica (hasta 200 puntos) |
| GET | `/api/status` | Estado del poller (último update, salud) |
| GET | `/health` | Health check para orquestadores |

---

## 🏗️ Arquitectura

```
┌──────────────┐     SSE      ┌───────────────────┐
│   Browser    │ ←─────────── │  Express server   │
│  (index.html)│              │   (server.js)     │
└──────────────┘              └────────┬──────────┘
                                       │
                          ┌────────────┴────────────┐
                          │                         │
                  ┌───────▼────────┐       ┌────────▼────────┐
                  │   Poller       │       │   Engine        │
                  │ (scrape/full)  │◄─────►│  (Bayesian)     │
                  └───────┬────────┘       └─────────────────┘
                          │
                 ┌────────▼─────────┐
                 │  ONPE / TV Perú  │
                 │   / RPP (API)    │
                 └──────────────────┘
```

**Módulos principales:**

- `src/poller.js` · `src/poller-scrape.js` — coordinación de ciclos de polling
- `src/engine/bayesian-estimator.js` — estimador bayesiano con bootstrap
- `src/engine/bias-correction.js` — corrección de sesgo por estratos
- `src/sampling/` — constructor de marco muestral, muestreo rápido, gestor de muestras
- `src/api/` — fetcher ONPE con rate-limiter, scraper de SSR
- `src/cache.js` · `src/history.js` — cache en memoria y serie histórica

---

## ⚙️ Configuración

Todas las constantes están en [`src/config.js`](src/config.js). Las más relevantes:

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `POLL_INTERVAL_MS` | `20000` | Intervalo entre ciclos de polling |
| `BOOTSTRAP_ITERATIONS` | `1000` | Iteraciones de bootstrap bayesiano |
| `INITIAL_SAMPLE_SIZE` | `800` | Tamaño de la muestra inicial |
| `MAX_SSE_CONNECTIONS` | `5000` | Clientes SSE simultáneos |

---

## 📦 Despliegue

El repo incluye `Procfile` para despliegue en plataformas tipo Heroku/Render:

```
web: node server.js
```

---

## 📄 Licencia

MIT — ver [LICENSE](LICENSE).

## 👤 Autor

**Ivan Mena** — Director DSFFA, MIDAGRI · [@ivanmena2021](https://github.com/ivanmena2021) · [LinkedIn](https://www.linkedin.com/in/ivan-mena-r/)
