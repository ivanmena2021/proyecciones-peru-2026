const CONFIG = {
  PORT: process.env.PORT || 3000,
  ELECTION_ID: 10,
  AMBITO_NACIONAL: 1,
  AMBITO_EXTRANJERO: 2,

  ONPE_BASE: 'https://resultadoelectoral.onpe.gob.pe/presentacion-backend',
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

  // Polling (recta final: ciclos más cortos para actualización en vivo)
  POLL_INTERVAL_MS: 20_000,
  LATE_STAGE_PCT: 70, // a partir de este % contado, se reduce augmentación y se usa live ONPE más agresivo
  FRAME_REFRESH_INTERVAL_MS: 300_000, // full frame refresh every 5 min

  // Rate limiting
  MAX_CONCURRENT_REQUESTS: 80,
  REQUESTS_PER_SECOND: 200,
  REQUEST_TIMEOUT_MS: 15_000,
  MAX_RETRIES: 2,

  // Sampling
  INITIAL_SAMPLE_SIZE: 800,
  MIN_PER_STRATUM: 30,
  NEW_MESA_SAMPLE_RATE: 0.5, // sample 50% of newly counted mesas
  URBAN_THRESHOLD_ELECTORES: 200,

  // Bootstrap
  BOOTSTRAP_ITERATIONS: 1000,
  SHRINKAGE_KAPPA: 15,
  MIN_SUBSAMPLE_FOR_DIRECT: 10,

  // Confidence grade thresholds
  CONFIDENCE_GRADES: {
    A: { minPctCounted: 80, maxCIWidth: 1.0 },
    B: { minPctCounted: 60, maxCIWidth: 2.0 },
    C: { minPctCounted: 40, maxCIWidth: 3.0 },
    D: { minPctCounted: 0, maxCIWidth: Infinity }
  },

  // SSE
  MAX_SSE_CONNECTIONS: 5000,

  // History
  HISTORY_MAX_POINTS: 200,

  // Party display config (top parties with short names and colors)
  PARTIES: {
    '8':  { short: 'FP',     color: '#FF6B00', name: 'Fuerza Popular' },
    '35': { short: 'RP',     color: '#1E3A8A', name: 'Renovacion Popular' },
    '16': { short: 'PBG',    color: '#0891B2', name: 'Partido del Buen Gobierno' },
    '14': { short: 'PCO',    color: '#7C3AED', name: 'Partido Civico Obras' },
    '10': { short: 'JPP',    color: '#16A34A', name: 'Juntos Por el Peru' },
    '23': { short: 'PPT',    color: '#65A30D', name: 'Partido Pais Para Todos' },
    '2':  { short: 'AN',     color: '#DC2626', name: 'Ahora Nacion' },
    '33': { short: 'PLG',    color: '#DB2777', name: 'Primero La Gente' },
    '31': { short: 'SIC',    color: '#CA8A04', name: 'Partido Sicreo' },
    '21': { short: 'FE21',   color: '#EA580C', name: 'Frente de la Esperanza 2021' },
    '32': { short: 'PP',     color: '#9333EA', name: 'Podemos Peru' },
    '25': { short: 'CP',     color: '#2563EB', name: 'Cooperacion Popular' },
    '1':  { short: 'APP',    color: '#059669', name: 'Alianza Para el Progreso' },
    '12': { short: 'APRA',   color: '#B91C1C', name: 'Partido Aprista Peruano' },
    '20': { short: 'SP',     color: '#4F46E5', name: 'Somos Peru' }
  },

  // Default color for parties not in the list
  DEFAULT_PARTY_COLOR: '#6B7280'
};

module.exports = CONFIG;
