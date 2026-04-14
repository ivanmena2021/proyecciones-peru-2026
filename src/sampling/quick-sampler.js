const CONFIG = require('../config');
const fetcher = require('../api/fetcher');

/**
 * Quick Sampler: samples mesas directly by random code generation.
 * No frame building required — produces projections in ~30 seconds.
 *
 * Strategy:
 * 1. Generate random mesa codes in range [1, MAX_MESA_CODE]
 * 2. Fetch each: if counted → store vote data; if pending → skip
 * 3. Classify by department using idUbigeo from response
 * 4. Feed stratified estimator with accumulated samples
 */
class QuickSampler {
  constructor() {
    // Mesa results: mesaCode -> { votes, totalValid, totalEmitted, electores, deptCode }
    this.mesaResults = new Map();
    // Track fetched codes (both found and not-found) to avoid re-fetching
    this.fetchedCodes = new Set();
    // Per-department counts
    this.deptMesaCounts = new Map(); // deptCode -> { sampled, urban, rural }
    // Max mesa code (discovered dynamically)
    this.maxMesaCode = 88000; // conservative estimate from probing
    this.initialSampleDone = false;
    this.stratumVariances = new Map();
  }

  /**
   * Perform initial rapid sample.
   * Generates random mesa codes and fetches them in parallel.
   */
  async performInitialSample(targetSize = 1500) {
    console.log(`[quick-sample] Starting rapid sample of ${targetSize} mesas...`);
    const startTime = Date.now();

    // Generate more codes than target (some will be pending/invalid)
    // At ~67% counting, ~67% of valid codes will be counted
    const overSampleFactor = 1.6;
    const codesToTry = Math.ceil(targetSize * overSampleFactor);

    const codes = this._generateRandomCodes(codesToTry);
    let fetched = 0;
    let skipped = 0;
    let notFound = 0;

    // Fetch in batches — smaller batches for faster first results
    const BATCH_SIZE = 80;
    for (let i = 0; i < codes.length && fetched < targetSize; i += BATCH_SIZE) {
      const batch = codes.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(code => this._fetchMesa(code))
      );

      for (const r of results) {
        if (r === 'fetched') fetched++;
        else if (r === 'pending') skipped++;
        else notFound++;
      }

      console.log(`[quick-sample] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${fetched} counted, ${skipped} pending, ${notFound} not found`);

      if (fetched >= targetSize) break;
    }

    this.initialSampleDone = true;
    this._updateStratumVariances();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[quick-sample] Initial sample complete in ${elapsed}s: ${fetched} mesas from ${this.deptMesaCounts.size} departments`);

    return { fetched, skipped, notFound };
  }

  /**
   * Augment the sample with additional random mesas.
   * Called each polling cycle.
   */
  async augmentSample(batchSize = 200) {
    if (!this.initialSampleDone) return { fetched: 0 };

    const codes = this._generateRandomCodes(batchSize);
    let fetched = 0;

    const results = await Promise.all(
      codes.map(code => this._fetchMesa(code))
    );

    for (const r of results) {
      if (r === 'fetched') fetched++;
    }

    if (fetched > 0) {
      this._updateStratumVariances();
      console.log(`[quick-sample] Augmented: +${fetched} mesas (total: ${this.mesaResults.size})`);
    }

    return { fetched };
  }

  /**
   * Fetch a single mesa by code. Returns 'fetched', 'pending', or 'notfound'.
   */
  async _fetchMesa(code) {
    if (this.fetchedCodes.has(code)) return 'duplicate';
    this.fetchedCodes.add(code);

    let res;
    try {
      res = await Promise.race([
        fetcher.fetchONPE(`actas/buscar/mesa?codigoMesa=${code}`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('mesa_timeout')), 20000))
      ]);
    } catch {
      return 'notfound';
    }
    if (!res?.data || !Array.isArray(res.data) || res.data.length === 0) {
      return 'notfound';
    }

    // Find presidential acta
    const pres = res.data.find(a => a.idEleccion === CONFIG.ELECTION_ID);
    if (!pres) return 'notfound';

    // Check if counted
    if (!pres.totalVotosValidos || pres.totalVotosValidos === 0) {
      return 'pending';
    }

    // Extract department code from ubigeo
    const ubigeo = String(pres.idUbigeo).padStart(6, '0');
    const deptCode = ubigeo.substring(0, 2);

    // Parse votes
    const votes = new Map();
    const detalle = pres.detalle || [];
    for (const d of detalle) {
      const partyCode = String(d.adAgrupacionPolitica || '');
      const voteCount = d.adVotos || 0;
      const codeNum = parseInt(partyCode, 10);
      if (partyCode && codeNum < 80 && d.adGrafico !== 0) {
        votes.set(partyCode, voteCount);
      }
    }

    const electores = pres.totalElectoresHabiles || 0;
    const isUrban = electores >= CONFIG.URBAN_THRESHOLD_ELECTORES;

    this.mesaResults.set(code, {
      votes,
      totalValid: pres.totalVotosValidos,
      totalEmitted: pres.totalVotosEmitidos || 0,
      electores,
      deptCode,
      ubigeo,
      isUrban
    });

    // Update dept counts
    if (!this.deptMesaCounts.has(deptCode)) {
      this.deptMesaCounts.set(deptCode, { sampled: 0, urban: 0, rural: 0 });
    }
    const dc = this.deptMesaCounts.get(deptCode);
    dc.sampled++;
    if (isUrban) dc.urban++;
    else dc.rural++;

    return 'fetched';
  }

  /**
   * Generate random mesa codes, avoiding already-fetched ones.
   */
  _generateRandomCodes(count) {
    const codes = [];
    const maxAttempts = count * 3;
    let attempts = 0;

    while (codes.length < count && attempts < maxAttempts) {
      attempts++;
      const num = Math.floor(Math.random() * this.maxMesaCode) + 1;
      const code = String(num).padStart(6, '0');
      if (!this.fetchedCodes.has(code)) {
        codes.push(code);
      }
    }

    return codes;
  }

  /**
   * Get results grouped by department (for the estimator).
   */
  getResultsByDepartment() {
    const grouped = new Map();

    for (const [mesaCode, result] of this.mesaResults) {
      const deptCode = result.deptCode;
      if (!grouped.has(deptCode)) {
        grouped.set(deptCode, { mesas: [], urbanMesas: [], ruralMesas: [] });
      }
      const group = grouped.get(deptCode);
      const entry = { ...result, mesaCode };
      group.mesas.push(entry);
      if (result.isUrban) group.urbanMesas.push(entry);
      else group.ruralMesas.push(entry);
    }

    return grouped;
  }

  /**
   * Update within-stratum variance estimates for Neyman allocation.
   */
  _updateStratumVariances() {
    const grouped = this.getResultsByDepartment();

    for (const [deptCode, data] of grouped) {
      if (data.mesas.length < 5) {
        this.stratumVariances.set(deptCode, 0.1);
        continue;
      }

      const allPartyCodes = new Set();
      for (const r of data.mesas) {
        for (const [pc] of r.votes) allPartyCodes.add(pc);
      }

      let maxVariance = 0;
      for (const partyCode of allPartyCodes) {
        const shares = data.mesas.map(r => {
          if (r.totalValid === 0) return 0;
          return (r.votes.get(partyCode) || 0) / r.totalValid;
        });
        const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
        const variance = shares.reduce((acc, s) => acc + (s - mean) ** 2, 0) / (shares.length - 1);
        if (variance > maxVariance) maxVariance = variance;
      }

      this.stratumVariances.set(deptCode, Math.sqrt(maxVariance));
    }
  }

  getStats() {
    return {
      totalSampled: this.mesaResults.size,
      totalFetched: this.fetchedCodes.size,
      departments: this.deptMesaCounts.size,
      initialDone: this.initialSampleDone
    };
  }
}

module.exports = QuickSampler;
