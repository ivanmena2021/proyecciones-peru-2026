const CONFIG = require('./config');
const fetcher = require('./api/fetcher');
const QuickSampler = require('./sampling/quick-sampler');
const DistrictCensus = require('./sampling/district-census');
const Estimator = require('./engine/bayesian-estimator');
const Diagnostics = require('./engine/diagnostics');
const History = require('./history');
const cache = require('./cache');

/**
 * Poller v3: with district census for population-weighted projections.
 *
 * Lifecycle:
 * 1. Fetch national data (immediate display)
 * 2. Start census (background) + quick sample (foreground) in PARALLEL
 * 3. First projection uses sample weights (census still building)
 * 4. When census completes: projections upgrade to population weights
 * 5. Each cycle: augment sample + re-estimate + cache + broadcast
 */
class Poller {
  constructor() {
    this.sampler = new QuickSampler();
    this.census = new DistrictCensus();
    this.estimator = new Estimator();
    this.diagnostics = new Diagnostics();
    this.history = new History();

    this.sseClients = new Set();
    this.isRunning = false;
    this.cycleCount = 0;
    this.lastEstimate = null;
    this.intervalId = null;
    this.status = 'initializing';
    this.deptHeatmap = new Map();
    this._deptNames = new Map();
  }

  async start() {
    console.log('[poller] Starting election projection engine...');
    this.isRunning = true;
    cache.ensureDataDir();

    try {
      // Phase 1: National data for immediate display
      this.status = 'loading_national';
      await this._fetchNationalMeta();
      await this._fetchAndCacheNationalOnly();

      // Phase 2: Start census in BACKGROUND (doesn't block projections)
      this.status = 'sampling';
      console.log('[poller] Starting census (background) + sampling (foreground)...');
      const censusPromise = this.census.build().then(() => {
        console.log('[poller] Census complete! Projections now use population weights.');
      }).catch(err => {
        console.error('[poller] Census failed (continuing without):', err.message);
      });

      // Phase 3: Quick sample (foreground — blocks until done)
      await this.sampler.performInitialSample(200);

      // Phase 4: First projection (may or may not have census)
      this.status = 'estimating';
      await this._runCycle();
      this.status = 'running';

      // Phase 5: Periodic cycling
      this.intervalId = setInterval(() => {
        this._runCycle().catch(err => {
          console.error('[poller] Cycle error:', err.message);
        });
      }, CONFIG.POLL_INTERVAL_MS);

      console.log(`[poller] Engine running. Cycle every ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
    } catch (err) {
      console.error('[poller] Startup error:', err);
      this.status = 'error';
      this._startNationalOnlyMode();
    }
  }

  async _fetchNationalMeta() {
    const [depts, heatmap, participation] = await Promise.all([
      fetcher.fetchDepartments(),
      fetcher.fetchDepartmentHeatmap(),
      fetcher.fetchParticipationHeatmap()
    ]);
    if (depts) {
      for (const d of depts) {
        const code = String(d.ubigeo).substring(0, 2);
        this._deptNames.set(code, d.nombre);
      }
    }
    const partByDept = new Map();
    if (participation) {
      for (const p of participation) {
        const code = String(p.ubigeoNivel01).padStart(6, '0').substring(0, 2);
        partByDept.set(code, p.asistentes || 0);
      }
    }
    if (heatmap) {
      for (const h of heatmap) {
        const code = String(h.ubigeoNivel01).padStart(6, '0').substring(0, 2);
        this.deptHeatmap.set(code, {
          name: this._deptNames.get(code) || `Departamento ${code}`,
          pctCounted: h.porcentajeActasContabilizadas || 0,
          actasCounted: h.actasContabilizadas || 0,
          electores: partByDept.get(code) || 0
        });
      }
    }
    console.log(`[poller] Loaded metadata: ${this._deptNames.size} departments`);
  }

  async _fetchAndCacheNationalOnly() {
    const [candidates, totals] = await Promise.all([
      fetcher.fetchNationalCandidates(), fetcher.fetchNationalTotals()
    ]);
    if (candidates && totals) {
      const result = this._buildNationalOnlyResult(candidates, totals);
      cache.writeJSON('latest.json', result);
      this.lastEstimate = result;
      this._broadcast(result);
      console.log('[poller] National data cached. Sampling in progress...');
    }
  }

  _buildNationalOnlyResult(candidates, totals) {
    const sorted = (Array.isArray(candidates) ? candidates : [])
      .map(c => {
        const code = String(c.codigoAgrupacionPolitica);
        const pc = CONFIG.PARTIES[code] || {};
        return {
          code, party: c.nombreAgrupacionPolitica || pc.name || `Partido ${code}`,
          partyShort: pc.short || code, name: c.nombreCandidato || '',
          votes: c.totalVotosValidos || 0, pct: c.porcentajeVotosValidos || 0,
          projectedPct: c.porcentajeVotosValidos || 0,
          marginLow: (c.porcentajeVotosValidos || 0) - 2,
          marginHigh: (c.porcentajeVotosValidos || 0) + 2,
          se: 2, color: pc.color || CONFIG.DEFAULT_PARTY_COLOR
        };
      }).sort((a, b) => b.votes - a.votes);

    const departments = [];
    for (const [code, hm] of this.deptHeatmap) {
      departments.push({ code, ubigeo: code + '0000', name: hm.name,
        pctCounted: hm.pctCounted, actasCounted: hm.actasCounted, electores: hm.electores,
        leadingPartyCode: null, leadingPartyPct: null, leadingPartyColor: null });
    }
    departments.sort((a, b) => b.electores - a.electores);

    return {
      timestamp: Date.now(),
      pctCounted: totals ? (totals.contabilizadas / totals.totalActas) * 100 : 0,
      candidates: sorted, departments, grade: 'D',
      consistency: { ok: true, flags: [] }, sampleSize: 0,
      projectionMode: 'national_only',
      projectionNote: 'Datos nacionales de ONPE. Muestreo y censo distrital en progreso...',
      totals: totals ? {
        actasCounted: totals.contabilizadas, actasTotal: totals.totalActas,
        totalVotesEmitted: totals.totalVotosEmitidos,
        totalVotesValid: totals.totalVotosValidos, turnout: totals.participacionCiudadana
      } : null
    };
  }

  async _runCycle() {
    this.cycleCount++;
    const startTime = Date.now();

    try {
      const [candidates, totals, heatmap, participation] = await Promise.all([
        fetcher.fetchNationalCandidates(), fetcher.fetchNationalTotals(),
        fetcher.fetchDepartmentHeatmap(), fetcher.fetchParticipationHeatmap()
      ]);

      // Update heatmap
      if (heatmap) {
        const partByDept = new Map();
        if (participation) {
          for (const p of participation) {
            const code = String(p.ubigeoNivel01).padStart(6, '0').substring(0, 2);
            partByDept.set(code, p.asistentes || 0);
          }
        }
        for (const h of heatmap) {
          const code = String(h.ubigeoNivel01).padStart(6, '0').substring(0, 2);
          this.deptHeatmap.set(code, {
            name: this._deptNames.get(code) || `Departamento ${code}`,
            pctCounted: h.porcentajeActasContabilizadas || 0,
            actasCounted: h.actasContabilizadas || 0,
            electores: partByDept.get(code) || this.deptHeatmap.get(code)?.electores || 0
          });
        }
      }

      // Augment sample — en recta final (>70% contado) la muestra ya es estable
      // y el signal principal viene del live ONPE, así que augmentamos menos.
      const pctCountedNow = totals ? (totals.contabilizadas / totals.totalActas) * 100 : 0;
      const isLateStage = pctCountedNow >= CONFIG.LATE_STAGE_PCT;

      if (this.sampler.initialSampleDone && this.cycleCount > 1) {
        // En recta final, augmentar cada 4 ciclos (en vez de cada ciclo) y con timeout corto
        const shouldAugment = !isLateStage || (this.cycleCount % 4 === 0);
        if (shouldAugment) {
          const augmentSize = isLateStage ? 40 : 100;
          const timeout = isLateStage ? 10000 : 30000;
          try {
            await Promise.race([
              this.sampler.augmentSample(augmentSize),
              new Promise((_, reject) => setTimeout(() => reject(new Error('augment timeout')), timeout))
            ]);
          } catch (e) {
            console.log(`[poller] Augment timeout/error: ${e.message}, continuing`);
          }
        }
      }

      // Estimate with census if available
      console.log(`[poller] Cycle ${this.cycleCount}: estimating (census=${this.census.isBuilt})...`);
      const resultsByDept = this.sampler.getResultsByDepartment();
      const nationalData = { candidates, totals };
      let estimate;
      try {
        estimate = this.estimator.estimate(
          resultsByDept, nationalData, this.deptHeatmap,
          this.census.isBuilt ? this.census : null
        );
      } catch (estErr) {
        console.error(`[poller] Estimator error:`, estErr.message, estErr.stack?.split('\n')[1]);
        throw estErr;
      }

      const diag = this.diagnostics.run(estimate);
      this.history.add(estimate);

      const output = {
        ...estimate,
        diagnostics: { anomalies: diag.anomalies, backtest: diag.backtest, winnerCall: diag.winnerCall },
        projectionNote: this._getProjectionNote(estimate),
        apiStats: fetcher.getStats()
      };

      cache.writeJSON('latest.json', output);
      cache.writeJSON('history.json', this.history.getAll());
      this._broadcast(output);
      this.lastEstimate = output;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const t1 = estimate.candidates[0], t2 = estimate.candidates[1];
      console.log(
        `[poller] Cycle ${this.cycleCount} (${elapsed}s): ` +
        `${estimate.pctCounted?.toFixed(1)}% contado, ` +
        `${estimate.sampleSize} mesas, ` +
        `mode=${estimate.projectionMode}, grado ${estimate.grade}, ` +
        `#1 ${t1?.partyShort} ${t1?.projectedPct}% (ONPE ${t1?.pct}%), ` +
        `#2 ${t2?.partyShort} ${t2?.projectedPct}%`
      );
    } catch (err) {
      console.error(`[poller] Cycle ${this.cycleCount} error:`, err.message);
      if (this.lastEstimate) {
        this.lastEstimate.timestamp = Date.now();
        cache.writeJSON('latest.json', this.lastEstimate);
      }
    }
  }

  _getProjectionNote(estimate) {
    if (estimate.projectionMode === 'no_data') return 'Sin datos de muestreo.';
    const n = estimate.sampleSize;
    const dists = estimate.districtsCovered || 0;
    const provs = estimate.provincesCovered || 0;
    const censusReady = estimate.censusReady;
    const censusDists = estimate.censusDistricts || 0;

    if (censusReady) {
      return `Modelo Bayesiano Beta-Binomial sobre ${censusDists.toLocaleString('es-PE')} distritos (pesos poblacionales). ` +
        `Muestra: ${n.toLocaleString('es-PE')} mesas de ${dists} distritos. ` +
        `Prior jerarquico: distrito → provincia → departamento. ` +
        `Correccion de voto remanente urbano/rural. IC: posterior Beta parametrico.`;
    }

    return `Modelo Bayesiano Beta-Binomial. Muestra: ${n.toLocaleString('es-PE')} mesas de ${dists} distritos. ` +
      `Censo distrital cargando (${censusDists} de ~1,800)... ` +
      `Prior jerarquico con correccion de voto remanente.`;
  }

  _startNationalOnlyMode() {
    console.log('[poller] Fallback: national-only mode');
    this.intervalId = setInterval(async () => {
      try {
        await this._fetchNationalMeta();
        const [c, t] = await Promise.all([fetcher.fetchNationalCandidates(), fetcher.fetchNationalTotals()]);
        if (c && t) {
          const r = this._buildNationalOnlyResult(c, t);
          cache.writeJSON('latest.json', r); this.lastEstimate = r; this._broadcast(r);
        }
      } catch {}
    }, CONFIG.POLL_INTERVAL_MS);
  }

  addSSEClient(res) {
    if (this.sseClients.size >= CONFIG.MAX_SSE_CONNECTIONS) return false;
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
    if (this.lastEstimate) res.write(`data: ${JSON.stringify(this.lastEstimate)}\n\n`);
    return true;
  }

  _broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const c of this.sseClients) { try { c.write(msg); } catch { this.sseClients.delete(c); } }
  }

  stop() {
    this.isRunning = false;
    if (this.intervalId) clearInterval(this.intervalId);
    for (const c of this.sseClients) { try { c.end(); } catch {} }
    this.sseClients.clear();
  }

  getStatus() {
    return {
      status: this.status, cycles: this.cycleCount, sseClients: this.sseClients.size,
      sample: this.sampler.getStats(), census: this.census.getStats(), api: fetcher.getStats()
    };
  }
}

module.exports = Poller;
