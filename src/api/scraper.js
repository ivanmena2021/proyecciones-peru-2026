// Scraper fallback — ONPE disabled the JSON API, so we pull the
// nation-wide top candidates + % procesado from public SSR pages.
// Primary: TV Peru (government SSR). Secondary: RPP.
const CONFIG = require('../config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const SOURCES = [
  {
    name: 'tvperu',
    url: 'https://www.tvperu.gob.pe/noticias/politica/onpe-resultados-elecciones-2026-en-vivo-conteo-oficial-peru-hoy'
  },
  {
    name: 'rpp',
    url: 'https://rpp.pe/politica/elecciones/resultados-onpe-hoy-tiempo-real-en-vivo-conteo-de-votos-elecciones-2026-noticia-1684049'
  }
];

// Remove accents for matching
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().trim();
}

// Canonical candidate list (name patterns matching SSR pages) → ONPE party code.
// Party code is used to pick color and partyShort from CONFIG.PARTIES.
const CANDIDATES = [
  { code: '8',  match: /KEIKO.*FUJIMORI|FUJIMORI/i,               full: 'KEIKO SOFIA FUJIMORI HIGUCHI' },
  { code: '10', match: /ROBERTO.*SANCHEZ|SANCHEZ\s+PALOMINO/i,    full: 'ROBERTO HELBERT SANCHEZ PALOMINO' },
  { code: '35', match: /LOPEZ\s+ALIAGA|RAFAEL.*ALIAGA/i,          full: 'RAFAEL BERNARDO LOPEZ ALIAGA CAZORLA' },
  { code: '16', match: /JORGE\s+NIETO|NIETO\s+MONTESINOS/i,       full: 'JORGE NIETO MONTESINOS' },
  { code: '14', match: /RICARDO\s+BELMONT|BELMONT\s+CASSINELLI/i, full: 'RICARDO PABLO BELMONT CASSINELLI' },
  { code: '23', match: /CARLOS\s+ALVAREZ|ALVAREZ\s+LOAYZA/i,      full: 'CARLOS GONSALO ALVAREZ LOAYZA' },
  { code: '2',  match: /LOPEZ.?CHAU|LOPEZ\s+CHAU/i,               full: 'PABLO ALFONSO LOPEZ CHAU NAVA' },
  { code: '31', match: /ESPA.*GARCES|ALFONSO.*ESPA/i,             full: 'ALFONSO CARLOS ESPA Y GARCES-ALVEAR' },
  { code: '33', match: /PEREZ\s+TELLO|MARIA.*TELLO/i,             full: 'MARIA SOLEDAD PEREZ TELLO' }
];

/**
 * Parse a TV Peru / RPP HTML page into {pctCounted, candidates[]}.
 */
function parseHTML(html) {
  // Strip accents and uppercase for robust matching (candidate names appear
  // with accents on SSR pages: "Álvarez", "Sánchez", "López").
  const text = norm(html);
  let pctCounted = null;
  const mPct = text.match(/RESULTADOS\s+ONPE\s+AL[^0-9]{0,10}([0-9]+[.,][0-9]+)\s*%/)
            || text.match(/([0-9]+[.,][0-9]+)\s*%\s+DE\s+VOTOS\s+PROCESADOS/)
            || text.match(/CON\s+EL\s+([0-9]+[.,][0-9]+)\s*%\s+(?:DE\s+)?(?:VOTOS\s+)?PROCESAD/);
  if (mPct) pctCounted = parseFloat(mPct[1].replace(',', '.'));

  const candidates = [];
  for (const c of CANDIDATES) {
    const re = new RegExp('(?:' + c.match.source + ')[^%0-9]{0,60}([0-9]+[.,][0-9]+)\\s*%', 'i');
    const m = text.match(re);
    if (m && m[1]) {
      const pct = parseFloat(m[1].replace(',', '.'));
      if (!isNaN(pct) && pct >= 0 && pct <= 100) {
        const pc = CONFIG.PARTIES[c.code] || {};
        candidates.push({
          code: c.code,
          party: pc.name || `Partido ${c.code}`,
          partyShort: pc.short || c.code,
          name: c.full,
          pct,
          projectedPct: pct,
          votes: 0, // not in SSR — will be estimated if totals available
          marginLow: Math.max(0, pct - 0.5),
          marginHigh: Math.min(100, pct + 0.5),
          se: 0.25,
          color: pc.color || CONFIG.DEFAULT_PARTY_COLOR
        });
      }
    }
  }
  candidates.sort((a, b) => b.pct - a.pct);
  return { pctCounted, candidates };
}

/**
 * Also extract "X,XXX de Y,YYY actas" from the HTML if present.
 */
function parseActas(html) {
  const text = norm(html);
  const m = text.match(/([0-9][0-9.,]{2,})\s+ACTAS\s+(?:DE|\/)\s+([0-9][0-9.,]{2,})/);
  if (!m) return null;
  const counted = parseInt(m[1].replace(/[.,]/g, ''), 10);
  const total = parseInt(m[2].replace(/[.,]/g, ''), 10);
  if (!counted || !total || counted > total) return null;
  return { counted, total };
}

async function fetchPage(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-PE,es;q=0.9'
      }
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

/**
 * Scrape the first source that yields useful data.
 * Returns { pctCounted, candidates, totals, source } or null.
 */
async function scrapeResults() {
  for (const src of SOURCES) {
    const html = await fetchPage(src.url);
    if (!html) continue;
    const parsed = parseHTML(html);
    if (!parsed.pctCounted || parsed.candidates.length < 3) continue;
    const actas = parseActas(html);
    return {
      pctCounted: parsed.pctCounted,
      candidates: parsed.candidates,
      totals: actas ? {
        actasCounted: actas.counted,
        actasTotal: actas.total,
        totalVotesEmitted: null,
        totalVotesValid: null,
        turnout: null
      } : null,
      source: src.name,
      sourceUrl: src.url
    };
  }
  return null;
}

module.exports = { scrapeResults, parseHTML };
