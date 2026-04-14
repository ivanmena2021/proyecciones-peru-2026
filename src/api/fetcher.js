const CONFIG = require('../config');
const RateLimiter = require('./rate-limiter');

const limiter = new RateLimiter(CONFIG.MAX_CONCURRENT_REQUESTS);

let requestCount = 0;
let errorCount = 0;

/**
 * Fetch JSON from ONPE API with retry, timeout, and rate limiting.
 */
async function fetchONPE(path, options = {}) {
  const url = `${CONFIG.ONPE_BASE}/${path}`;
  const maxRetries = options.retries ?? CONFIG.MAX_RETRIES;

  return limiter.run(async () => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        requestCount++;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': CONFIG.USER_AGENT,
            'Accept': 'application/json'
          }
        });

        clearTimeout(timeout);

        if (response.status === 204) {
          return { success: true, data: null, status: 204 };
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${path}`);
        }

        const json = await response.json();
        return json;
      } catch (err) {
        errorCount++;
        if (attempt === maxRetries) {
          console.error(`[fetcher] FAILED after ${maxRetries + 1} attempts: ${path} - ${err.message}`);
          return null;
        }
        const backoff = Math.pow(2, attempt) * 500 + Math.random() * 200;
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  });
}

// --- High-level API wrappers ---

async function fetchNationalCandidates() {
  const res = await fetchONPE(
    `eleccion-presidencial/participantes-organizacion-politica?idEleccion=${CONFIG.ELECTION_ID}&tipoFiltro=eleccion`
  );
  return res?.data ?? null;
}

async function fetchNationalTotals() {
  const res = await fetchONPE(
    `resumen-general/totales?idEleccion=${CONFIG.ELECTION_ID}&tipoFiltro=eleccion`
  );
  return res?.data ?? null;
}

async function fetchDepartmentHeatmap() {
  const res = await fetchONPE(
    `resumen-general/mapa-calor?idEleccion=${CONFIG.ELECTION_ID}&tipoFiltro=ambito_geografico&idAmbitoGeografico=${CONFIG.AMBITO_NACIONAL}`
  );
  return res?.data ?? null;
}

async function fetchParticipationHeatmap() {
  const res = await fetchONPE(
    `participacion-ciudadana/mapa-calor?idEleccion=${CONFIG.ELECTION_ID}&tipoFiltro=ambito_geografico&idAmbitoGeografico=${CONFIG.AMBITO_NACIONAL}`
  );
  return res?.data ?? null;
}

async function fetchDepartments() {
  const res = await fetchONPE(
    `ubigeos/departamentos?idEleccion=${CONFIG.ELECTION_ID}&idAmbitoGeografico=${CONFIG.AMBITO_NACIONAL}`
  );
  return res?.data ?? null;
}

async function fetchProvinces(deptUbigeo) {
  const res = await fetchONPE(
    `ubigeos/provincias?idEleccion=${CONFIG.ELECTION_ID}&idAmbitoGeografico=${CONFIG.AMBITO_NACIONAL}&idUbigeoDepartamento=${deptUbigeo}`
  );
  return res?.data ?? null;
}

async function fetchDistricts(deptUbigeo, provUbigeo) {
  const res = await fetchONPE(
    `ubigeos/distritos?idEleccion=${CONFIG.ELECTION_ID}&idAmbitoGeografico=${CONFIG.AMBITO_NACIONAL}&idUbigeoDepartamento=${deptUbigeo}&idUbigeoProvincia=${provUbigeo}`
  );
  return res?.data ?? null;
}

async function fetchDistrictActas(districtUbigeo, page = 0, size = 20) {
  const res = await fetchONPE(
    `actas?pagina=${page}&tamanio=${size}&idAmbitoGeografico=${CONFIG.AMBITO_NACIONAL}&idUbigeo=${districtUbigeo}`
  );
  return res?.data ?? null;
}

async function fetchMesaVotes(mesaCode) {
  const res = await fetchONPE(`actas/buscar/mesa?codigoMesa=${mesaCode}`);
  if (!res?.data) return null;
  // Find the presidential election acta (idEleccion = 10)
  const actas = Array.isArray(res.data) ? res.data : [res.data];
  const presidential = actas.find(a =>
    a.idEleccion === CONFIG.ELECTION_ID ||
    a.eleccion?.id === CONFIG.ELECTION_ID
  );
  return presidential ?? actas[0] ?? null;
}

function getStats() {
  return { requests: requestCount, errors: errorCount };
}

function resetStats() {
  requestCount = 0;
  errorCount = 0;
}

module.exports = {
  fetchONPE,
  fetchNationalCandidates,
  fetchNationalTotals,
  fetchDepartmentHeatmap,
  fetchParticipationHeatmap,
  fetchDepartments,
  fetchProvinces,
  fetchDistricts,
  fetchDistrictActas,
  fetchMesaVotes,
  getStats,
  resetStats
};
