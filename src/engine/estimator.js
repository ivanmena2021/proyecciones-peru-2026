const CONFIG = require('../config');

/**
 * Stratified Ratio Estimator with Bootstrap Confidence Intervals
 *
 * Core statistical engine for election projections.
 * Works with any sampler that provides getResultsByDepartment().
 *
 * Method: Separate ratio estimator across departmental strata,
 * with urban/rural bias correction and Rao-Wu bootstrap CIs.
 */
class Estimator {
  constructor() {
    this.lastEstimate = null;
  }

  /**
   * Compute full projection with confidence intervals.
   *
   * @param {Map} resultsByDept - Map<deptCode, { mesas, urbanMesas, ruralMesas }>
   * @param {Object} nationalData - { candidates, totals } from ONPE national endpoint
   * @param {Map} deptHeatmap - Map<deptCode, { electores, pctCounted, name }>
   * @returns {Object} projection result
   */
  estimate(resultsByDept, nationalData, deptHeatmap) {
    // Collect all party codes from sampled mesas
    const partyCodes = this._collectPartyCodes(resultsByDept);

    if (partyCodes.length === 0) {
      return this._emptyEstimate(nationalData);
    }

    // Compute stratum weights using department electores from heatmap
    const weights = this._computeStratumWeights(resultsByDept, deptHeatmap);

    // Compute bias-corrected vote shares per department
    const deptShares = new Map();
    for (const [deptCode, data] of resultsByDept) {
      if (data.mesas.length < 3) continue;

      const shares = this._computeCorrectedShares(data, partyCodes);
      if (shares) {
        deptShares.set(deptCode, shares);
      }
    }

    // National projection: θ̂_c = Σ_s W_s × R̂_{s,c}
    const nationalProjection = new Map();
    for (const pc of partyCodes) {
      let projected = 0;
      for (const [deptCode, shares] of deptShares) {
        const w = weights.get(deptCode) || 0;
        projected += w * (shares.get(pc) || 0);
      }
      nationalProjection.set(pc, projected);
    }

    const totalProjected = Array.from(nationalProjection.values()).reduce((a, b) => a + b, 0);

    // Bootstrap confidence intervals
    const bootstrapResults = this._runBootstrap(resultsByDept, weights, partyCodes);

    // Progress
    const totals = nationalData?.totals;
    const pctCounted = totals
      ? (totals.contabilizadas / totals.totalActas) * 100
      : 0;

    // Confidence grade
    const topCandidateCIs = this._getTopCandidateCIWidths(bootstrapResults, partyCodes, nationalProjection);
    const grade = this._computeGrade(pctCounted, topCandidateCIs);

    // Build candidate results
    const candidates = this._buildCandidateResults(
      nationalProjection, bootstrapResults, nationalData?.candidates, partyCodes, totalProjected
    );

    // Consistency check
    const consistency = this._checkConsistency(candidates, nationalData?.candidates);

    // Department projections
    const deptProjections = this._buildDeptProjections(deptShares, partyCodes, deptHeatmap);

    // Sample size
    let sampleSize = 0;
    for (const [, data] of resultsByDept) sampleSize += data.mesas.length;

    this.lastEstimate = {
      timestamp: Date.now(),
      pctCounted,
      candidates,
      departments: deptProjections,
      grade,
      consistency,
      sampleSize,
      projectionMode: 'stratified_ratio',
      totals: totals ? {
        actasCounted: totals.contabilizadas,
        actasTotal: totals.totalActas,
        totalVotesEmitted: totals.totalVotosEmitidos,
        totalVotesValid: totals.totalVotosValidos,
        turnout: totals.participacionCiudadana
      } : null
    };

    return this.lastEstimate;
  }

  /**
   * Compute bias-corrected vote shares for a department.
   * Sub-stratifies urban/rural with Bayesian shrinkage.
   */
  _computeCorrectedShares(deptData, partyCodes) {
    const { urbanMesas, ruralMesas, mesas } = deptData;

    if (mesas.length === 0) return null;

    // Compute overall department shares (ratio estimator)
    const overallShares = this._ratioEstimate(mesas, partyCodes);

    // If we don't have both urban and rural, return overall
    if (urbanMesas.length === 0 || ruralMesas.length === 0) {
      return overallShares;
    }

    // Sub-stratum shares
    const urbanShares = this._ratioEstimate(urbanMesas, partyCodes);
    const ruralShares = this._ratioEstimate(ruralMesas, partyCodes);

    // Apply shrinkage to rural if sample is small
    const correctedRural = new Map();
    for (const pc of partyCodes) {
      const directRural = ruralShares.get(pc) || 0;
      const prior = overallShares.get(pc) || 0;

      if (ruralMesas.length >= CONFIG.MIN_SUBSAMPLE_FOR_DIRECT) {
        correctedRural.set(pc, directRural);
      } else {
        const lambda = ruralMesas.length / (ruralMesas.length + CONFIG.SHRINKAGE_KAPPA);
        correctedRural.set(pc, lambda * directRural + (1 - lambda) * prior);
      }
    }

    // Weight by estimated total votes (not by count of mesas counted)
    const avgVotesUrban = urbanMesas.reduce((s, m) => s + m.totalValid, 0) / urbanMesas.length;
    const avgVotesRural = ruralMesas.reduce((s, m) => s + m.totalValid, 0) / ruralMesas.length;

    // Estimate TOTAL mesas (not just sampled) urban vs rural using sample proportions
    // This is our best estimate of the department's urban/rural composition
    const totalUrban = urbanMesas.length;
    const totalRural = ruralMesas.length;
    const totalWeighted = totalUrban * avgVotesUrban + totalRural * avgVotesRural;

    if (totalWeighted === 0) return overallShares;

    const wUrban = (totalUrban * avgVotesUrban) / totalWeighted;
    const wRural = (totalRural * avgVotesRural) / totalWeighted;

    const corrected = new Map();
    for (const pc of partyCodes) {
      corrected.set(pc,
        wUrban * (urbanShares.get(pc) || 0) +
        wRural * (correctedRural.get(pc) || 0)
      );
    }

    return corrected;
  }

  /**
   * Ratio estimator: R_{s,c} = sum(Y_{m,c}) / sum(Y_m)
   */
  _ratioEstimate(mesas, partyCodes) {
    const shares = new Map();
    const totalValid = mesas.reduce((s, m) => s + m.totalValid, 0);
    if (totalValid === 0) {
      for (const pc of partyCodes) shares.set(pc, 0);
      return shares;
    }
    for (const pc of partyCodes) {
      const totalVotes = mesas.reduce((s, m) => s + (m.votes.get(pc) || 0), 0);
      shares.set(pc, totalVotes / totalValid);
    }
    return shares;
  }

  /**
   * Stratified bootstrap for confidence intervals.
   */
  _runBootstrap(resultsByDept, weights, partyCodes) {
    const B = CONFIG.BOOTSTRAP_ITERATIONS;
    const bootstrapSamples = new Map();
    for (const pc of partyCodes) bootstrapSamples.set(pc, []);

    for (let b = 0; b < B; b++) {
      const bootProjection = new Map();
      for (const pc of partyCodes) bootProjection.set(pc, 0);

      for (const [deptCode, data] of resultsByDept) {
        if (data.mesas.length < 2) continue;
        const w = weights.get(deptCode) || 0;
        if (w === 0) continue;

        // Resample with replacement
        const n = data.mesas.length;
        const resample = [];
        for (let i = 0; i < n; i++) {
          resample.push(data.mesas[Math.floor(Math.random() * n)]);
        }

        const totalValid = resample.reduce((s, m) => s + m.totalValid, 0);
        if (totalValid === 0) continue;

        for (const pc of partyCodes) {
          const totalVotes = resample.reduce((s, m) => s + (m.votes.get(pc) || 0), 0);
          bootProjection.set(pc, bootProjection.get(pc) + w * (totalVotes / totalValid));
        }
      }

      for (const pc of partyCodes) {
        bootstrapSamples.get(pc).push(bootProjection.get(pc));
      }
    }

    const result = new Map();
    for (const [pc, samples] of bootstrapSamples) {
      samples.sort((a, b) => a - b);
      const lo = samples[Math.floor(B * 0.025)] || 0;
      const hi = samples[Math.ceil(B * 0.975) - 1] || 0;
      const mean = samples.reduce((a, b) => a + b, 0) / B;
      const variance = samples.reduce((acc, s) => acc + (s - mean) ** 2, 0) / (B - 1);
      result.set(pc, { lo, hi, mean, se: Math.sqrt(variance) });
    }

    return result;
  }

  /**
   * Compute stratum weights using department voter data.
   * W_s = electores_s * validFraction_s / sum(...)
   */
  _computeStratumWeights(resultsByDept, deptHeatmap) {
    const weights = new Map();
    let totalWeight = 0;

    for (const [deptCode, data] of resultsByDept) {
      // Get electores from heatmap (best source) or estimate from sample
      const hm = deptHeatmap?.get(deptCode);
      let electores = hm?.electores || 0;

      // If no heatmap data, estimate from sample
      if (electores === 0 && data.mesas.length > 0) {
        electores = data.mesas.length * 250; // rough estimate
      }

      // Valid fraction from sample
      let validFraction = 0.85;
      if (data.mesas.length > 0) {
        const totalValid = data.mesas.reduce((s, m) => s + m.totalValid, 0);
        const totalEmitted = data.mesas.reduce((s, m) => s + (m.totalEmitted || m.totalValid), 0);
        if (totalEmitted > 0) validFraction = totalValid / totalEmitted;
      }

      const w = electores * validFraction;
      weights.set(deptCode, w);
      totalWeight += w;
    }

    // Normalize
    if (totalWeight > 0) {
      for (const [k, v] of weights) weights.set(k, v / totalWeight);
    }

    return weights;
  }

  _collectPartyCodes(resultsByDept) {
    const codes = new Set();
    for (const [, data] of resultsByDept) {
      for (const mesa of data.mesas) {
        for (const [pc] of mesa.votes) codes.add(pc);
      }
    }
    return Array.from(codes);
  }

  _buildCandidateResults(nationalProjection, bootstrapResults, onpeCandidates, partyCodes, totalProjected) {
    const candidates = [];
    const onpeLookup = new Map();
    if (onpeCandidates && Array.isArray(onpeCandidates)) {
      for (const c of onpeCandidates) {
        onpeLookup.set(String(c.codigoAgrupacionPolitica), c);
      }
    }

    for (const pc of partyCodes) {
      const projected = nationalProjection.get(pc) || 0;
      const boot = bootstrapResults.get(pc) || { lo: 0, hi: 0, se: 0 };
      const onpe = onpeLookup.get(pc);
      const partyConfig = CONFIG.PARTIES[pc] || {};

      const projectedPct = totalProjected > 0 ? (projected / totalProjected) * 100 : 0;
      const loRaw = totalProjected > 0 ? (boot.lo / totalProjected) * 100 : 0;
      const hiRaw = totalProjected > 0 ? (boot.hi / totalProjected) * 100 : 0;

      candidates.push({
        code: pc,
        party: onpe?.nombreAgrupacionPolitica || partyConfig.name || `Partido ${pc}`,
        partyShort: partyConfig.short || pc,
        name: onpe?.nombreCandidato || '',
        votes: onpe?.totalVotosValidos || 0,
        pct: onpe?.porcentajeVotosValidos || 0,
        projectedPct: Math.round(projectedPct * 100) / 100,
        marginLow: Math.round(loRaw * 100) / 100,
        marginHigh: Math.round(hiRaw * 100) / 100,
        se: Math.round((boot.se / Math.max(totalProjected, 0.001)) * 10000) / 100,
        color: partyConfig.color || CONFIG.DEFAULT_PARTY_COLOR
      });
    }

    candidates.sort((a, b) => b.projectedPct - a.projectedPct);
    return candidates;
  }

  _buildDeptProjections(deptShares, partyCodes, deptHeatmap) {
    const result = [];

    // Include all departments from heatmap, even those without samples
    const allDepts = new Set([
      ...deptShares.keys(),
      ...(deptHeatmap ? deptHeatmap.keys() : [])
    ]);

    for (const deptCode of allDepts) {
      const hm = deptHeatmap?.get(deptCode);
      const shares = deptShares.get(deptCode);

      let leader = null;
      let leaderPct = 0;
      if (shares) {
        for (const pc of partyCodes) {
          const share = shares.get(pc) || 0;
          if (share > leaderPct) {
            leaderPct = share;
            leader = pc;
          }
        }
      }

      result.push({
        code: deptCode,
        ubigeo: deptCode + '0000',
        name: hm?.name || `Departamento ${deptCode}`,
        pctCounted: hm?.pctCounted || 0,
        actasCounted: hm?.actasCounted || 0,
        electores: hm?.electores || 0,
        leadingPartyCode: leader,
        leadingPartyPct: Math.round(leaderPct * 10000) / 100,
        leadingPartyColor: leader ? (CONFIG.PARTIES[leader]?.color || CONFIG.DEFAULT_PARTY_COLOR) : null
      });
    }

    result.sort((a, b) => b.electores - a.electores);
    return result;
  }

  _checkConsistency(projected, onpeCandidates) {
    if (!onpeCandidates || !Array.isArray(onpeCandidates)) return { ok: true, flags: [] };
    const flags = [];
    const onpeByCode = new Map();
    for (const c of onpeCandidates) {
      onpeByCode.set(String(c.codigoAgrupacionPolitica), c.porcentajeVotosValidos || 0);
    }

    for (const c of projected.slice(0, 10)) {
      const onpePct = onpeByCode.get(c.code) || 0;
      const diff = Math.abs(c.projectedPct - onpePct);
      const se = c.se || 1;
      if (diff / se > 3) {
        flags.push({
          party: c.partyShort,
          projected: c.projectedPct,
          onpe: onpePct,
          zScore: Math.round((diff / se) * 10) / 10,
          message: `${c.partyShort}: proyectado ${c.projectedPct}% vs ONPE ${onpePct}% (z=${(diff / se).toFixed(1)})`
        });
      }
    }
    return { ok: flags.length === 0, flags };
  }

  _getTopCandidateCIWidths(bootstrapResults, partyCodes, nationalProjection) {
    const totalProjected = Array.from(nationalProjection.values()).reduce((a, b) => a + b, 0);
    return partyCodes
      .map(pc => ({ pc, share: nationalProjection.get(pc) || 0 }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 5)
      .map(({ pc }) => {
        const boot = bootstrapResults.get(pc);
        if (!boot || totalProjected === 0) return 10;
        return ((boot.hi - boot.lo) / totalProjected) * 100;
      });
  }

  _computeGrade(pctCounted, ciWidths) {
    const maxCI = Math.max(...ciWidths, 0);
    for (const [grade, thresholds] of Object.entries(CONFIG.CONFIDENCE_GRADES)) {
      if (pctCounted >= thresholds.minPctCounted && maxCI <= thresholds.maxCIWidth) {
        return grade;
      }
    }
    return 'D';
  }

  _emptyEstimate(nationalData) {
    return {
      timestamp: Date.now(),
      pctCounted: 0,
      candidates: [],
      departments: [],
      grade: 'D',
      consistency: { ok: true, flags: [] },
      sampleSize: 0,
      projectionMode: 'no_data',
      totals: null
    };
  }
}

module.exports = Estimator;
