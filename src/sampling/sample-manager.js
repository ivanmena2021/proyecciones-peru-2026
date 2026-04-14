const CONFIG = require('../config');
const fetcher = require('../api/fetcher');

/**
 * Sample Manager: handles stratified sampling allocation,
 * SRSWOR within strata, and incremental augmentation.
 */
class SampleManager {
  constructor(frameBuilder) {
    this.frame = frameBuilder;
    // Accumulated mesa vote results: mesaCode -> { votes: Map<partyCode, count>, totalValid, totalEmitted, electores }
    this.mesaResults = new Map();
    // Track which mesas we've already fetched
    this.fetchedMesas = new Set();
    // Per-stratum variance estimates (for Neyman allocation after first round)
    this.stratumVariances = new Map();
    // Whether we've done the initial sample
    this.initialSampleDone = false;
  }

  /**
   * Perform initial stratified sample.
   * Allocates proportionally across departments, then fetches mesa vote data.
   */
  async performInitialSample() {
    if (!this.frame.isBuilt) {
      throw new Error('Frame not built yet');
    }

    console.log('[sample] Starting initial stratified sample...');
    const startTime = Date.now();

    // Calculate allocation per department (stratum)
    const allocation = this._computeAllocation(CONFIG.INITIAL_SAMPLE_SIZE);
    console.log('[sample] Allocation:', Object.fromEntries(
      Array.from(allocation.entries()).map(([k, v]) => [k, v])
    ));

    // For each stratum, draw SRSWOR from counted mesas and fetch vote data
    let totalFetched = 0;
    let totalFailed = 0;

    for (const [deptCode, sampleSize] of allocation) {
      const countedMesas = this.frame.getCountedMesas(deptCode);
      if (countedMesas.length === 0) {
        console.log(`[sample] Dept ${deptCode}: no counted mesas, skipping`);
        continue;
      }

      // SRSWOR: shuffle and take first k
      const shuffled = this._shuffle([...countedMesas]);
      const selected = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

      // Fetch vote data for selected mesas
      const results = await Promise.all(
        selected.map(code => this._fetchAndStoreMesa(code))
      );

      const fetched = results.filter(r => r).length;
      const failed = results.filter(r => !r).length;
      totalFetched += fetched;
      totalFailed += failed;

      if (fetched > 0) {
        const deptName = this.frame.departments.get(deptCode)?.name || deptCode;
        console.log(`[sample] Dept ${deptName}: ${fetched}/${selected.length} mesas fetched`);
      }
    }

    this.initialSampleDone = true;
    this._updateStratumVariances();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[sample] Initial sample complete in ${elapsed}s: ${totalFetched} mesas (${totalFailed} failed)`);

    return { fetched: totalFetched, failed: totalFailed };
  }

  /**
   * Incremental augmentation: sample newly counted mesas.
   * Called each poll cycle after the frame is refreshed.
   */
  async augmentSample() {
    if (!this.initialSampleDone) return { fetched: 0 };

    // For each department, find counted mesas we haven't fetched yet
    let newMesasFound = 0;
    let fetched = 0;

    for (const [deptCode] of this.frame.departments) {
      const countedMesas = this.frame.getCountedMesas(deptCode);
      const unfetched = countedMesas.filter(code => !this.fetchedMesas.has(code));

      if (unfetched.length === 0) continue;
      newMesasFound += unfetched.length;

      // Sample NEW_MESA_SAMPLE_RATE of unfetched mesas
      const toSample = Math.max(1, Math.ceil(unfetched.length * CONFIG.NEW_MESA_SAMPLE_RATE));
      const selected = this._shuffle([...unfetched]).slice(0, toSample);

      const results = await Promise.all(
        selected.map(code => this._fetchAndStoreMesa(code))
      );

      fetched += results.filter(r => r).length;
    }

    if (fetched > 0) {
      this._updateStratumVariances();
      console.log(`[sample] Augmented: +${fetched} mesas (${newMesasFound} new found)`);
    }

    return { fetched, newMesasFound };
  }

  /**
   * Fetch mesa vote data and store in our results map.
   */
  async _fetchAndStoreMesa(mesaCode) {
    if (this.fetchedMesas.has(mesaCode)) return true;

    const data = await fetcher.fetchMesaVotes(mesaCode);
    if (!data) return false;

    // Parse the vote breakdown
    const votes = new Map();
    const detalle = data.detalle || [];

    for (const d of detalle) {
      const partyCode = String(d.adAgrupacionPolitica || d.adCodigo || '');
      const voteCount = d.adVotos || 0;
      // Skip blank/null vote entries (codes 80=blanco, 81=nulo, or adGrafico===0)
      const codeNum = parseInt(partyCode, 10);
      if (partyCode && codeNum < 80 && d.adGrafico !== 0) {
        votes.set(partyCode, voteCount);
      }
    }

    const electores = data.totalElectoresHabiles || 0;

    this.mesaResults.set(mesaCode, {
      votes,
      totalValid: data.totalVotosValidos || 0,
      totalEmitted: data.totalVotosEmitidos || 0,
      electores: electores,
      deptCode: this.frame.mesas.get(mesaCode)?.deptCode || '00'
    });

    // Update frame with electores data and urban/rural classification
    const mesaMeta = this.frame.mesas.get(mesaCode);
    if (mesaMeta) {
      mesaMeta.electores = electores;
      mesaMeta.isUrban = electores >= CONFIG.URBAN_THRESHOLD_ELECTORES;
    }

    this.fetchedMesas.add(mesaCode);
    return true;
  }

  /**
   * Compute allocation across strata.
   * First round: proportional. After that: Neyman.
   */
  _computeAllocation(totalSample) {
    const allocation = new Map();
    const deptSizes = new Map();
    let totalN = 0;

    for (const [deptCode] of this.frame.departments) {
      const n = this.frame.byDepartment.get(deptCode)?.size || 0;
      deptSizes.set(deptCode, n);
      totalN += n;
    }

    if (totalN === 0) return allocation;

    if (!this.initialSampleDone || this.stratumVariances.size === 0) {
      // Proportional allocation
      for (const [deptCode, n] of deptSizes) {
        const k = Math.max(
          CONFIG.MIN_PER_STRATUM,
          Math.round(totalSample * (n / totalN))
        );
        allocation.set(deptCode, k);
      }
    } else {
      // Neyman allocation: k_s ∝ N_s × max_c(σ_{s,c})
      let sumNSigma = 0;
      const nSigma = new Map();

      for (const [deptCode, n] of deptSizes) {
        const sigma = this.stratumVariances.get(deptCode) || 0.1;
        const ns = n * sigma;
        nSigma.set(deptCode, ns);
        sumNSigma += ns;
      }

      for (const [deptCode, ns] of nSigma) {
        const k = Math.max(
          CONFIG.MIN_PER_STRATUM,
          Math.round(totalSample * (ns / sumNSigma))
        );
        allocation.set(deptCode, k);
      }
    }

    return allocation;
  }

  /**
   * Update within-stratum variance estimates for Neyman allocation.
   * Uses max variance across top 5 candidates.
   */
  _updateStratumVariances() {
    for (const [deptCode] of this.frame.departments) {
      const mesaCodes = this.frame.byDepartment.get(deptCode);
      if (!mesaCodes) continue;

      const sampledInDept = [];
      for (const code of mesaCodes) {
        const result = this.mesaResults.get(code);
        if (result) sampledInDept.push(result);
      }

      if (sampledInDept.length < 5) {
        this.stratumVariances.set(deptCode, 0.1); // default
        continue;
      }

      // Compute vote shares per mesa and find max variance across candidates
      const allPartyCodes = new Set();
      for (const r of sampledInDept) {
        for (const [pc] of r.votes) allPartyCodes.add(pc);
      }

      let maxVariance = 0;
      for (const partyCode of allPartyCodes) {
        const shares = sampledInDept.map(r => {
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

  /**
   * Get sampled results grouped by department.
   * Returns Map<deptCode, { mesas: MesaResult[], urbanMesas: MesaResult[], ruralMesas: MesaResult[] }>
   */
  getResultsByDepartment() {
    const grouped = new Map();

    for (const [deptCode] of this.frame.departments) {
      grouped.set(deptCode, { mesas: [], urbanMesas: [], ruralMesas: [] });
    }

    for (const [mesaCode, result] of this.mesaResults) {
      const mesaMeta = this.frame.mesas.get(mesaCode);
      if (!mesaMeta) continue;

      const group = grouped.get(mesaMeta.deptCode);
      if (!group) continue;

      const entry = { ...result, mesaCode };
      group.mesas.push(entry);
      if (mesaMeta.isUrban) {
        group.urbanMesas.push(entry);
      } else {
        group.ruralMesas.push(entry);
      }
    }

    return grouped;
  }

  /**
   * Fisher-Yates shuffle.
   */
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  getStats() {
    return {
      totalSampled: this.mesaResults.size,
      initialDone: this.initialSampleDone,
      strataWithVariance: this.stratumVariances.size
    };
  }
}

module.exports = SampleManager;
