const CONFIG = require('../config');

/**
 * Enhanced Stratified Estimator v3 — Population-weighted district stratification
 *
 * KEY IMPROVEMENT: Uses real district population sizes from the census,
 * not sample sizes. This is what professional conteos rápidos do.
 *
 * Architecture:
 * 1. For each sampled district: compute vote shares (ratio estimator)
 * 2. Shrink toward province → department (hierarchical Bayes)
 * 3. For UNSAMPLED districts: use province/department average
 * 4. Weight ALL districts by their TRUE total mesas (from census)
 * 5. For districts with pending mesas: project remaining votes using
 *    urban/rural differential from sampled mesas
 * 6. Sum to national with proper population weights
 */
class EnhancedEstimator {
  constructor() {
    this.lastEstimate = null;
  }

  /**
   * @param {Map} resultsByDept - Map<deptCode, { mesas, urbanMesas, ruralMesas }>
   * @param {Object} nationalData - { candidates, totals }
   * @param {Map} deptHeatmap - Map<deptCode, { electores, pctCounted, name, actasCounted }>
   * @param {DistrictCensus|null} census - district population weights (if built)
   */
  estimate(resultsByDept, nationalData, deptHeatmap, census) {
    const partyCodes = this._collectPartyCodes(resultsByDept);
    if (partyCodes.length === 0) return this._emptyEstimate(nationalData);

    // Build geographic hierarchy from sample
    const hierarchy = this._buildHierarchy(resultsByDept);

    // === LEVEL 1: Department-level ratio estimates ===
    const deptShares = new Map();
    for (const [deptCode, mesas] of hierarchy.departments) {
      if (mesas.length >= 2) {
        deptShares.set(deptCode, this._ratioEstimate(mesas, partyCodes));
      }
    }

    // === LEVEL 2: Province-level with shrinkage → department ===
    const provShares = new Map();
    for (const [provCode, mesas] of hierarchy.provinces) {
      const deptCode = provCode.substring(0, 2);
      const parent = deptShares.get(deptCode) || this._uniformShares(partyCodes);
      const local = mesas.length >= 2 ? this._ratioEstimate(mesas, partyCodes) : parent;
      provShares.set(provCode, this._shrinkToward(local, parent, mesas.length, partyCodes, 12));
    }

    // === LEVEL 3: District-level with shrinkage → province ===
    const districtShares = new Map();
    for (const [distCode, mesas] of hierarchy.districts) {
      const provCode = distCode.substring(0, 4);
      const deptCode = distCode.substring(0, 2);
      const parent = provShares.get(provCode) || deptShares.get(deptCode) || this._uniformShares(partyCodes);
      const local = mesas.length >= 2 ? this._ratioEstimate(mesas, partyCodes) : parent;
      districtShares.set(distCode, this._shrinkToward(local, parent, mesas.length, partyCodes, 6));
    }

    // === STEP 4: POPULATION-WEIGHTED PROJECTION ===
    let nationalProjection;
    let projectionMode;

    if (census?.isBuilt) {
      // USE CENSUS WEIGHTS (the big improvement)
      nationalProjection = this._projectWithCensus(
        districtShares, provShares, deptShares, partyCodes, census, resultsByDept
      );
      projectionMode = 'census_weighted_district';
    } else {
      // Fallback: sample-weighted (less accurate)
      nationalProjection = this._projectSampleWeighted(
        districtShares, hierarchy, deptShares, partyCodes, resultsByDept, deptHeatmap
      );
      projectionMode = 'sample_weighted_district';
    }

    const totalProjected = Array.from(nationalProjection.values()).reduce((a, b) => a + b, 0);

    // === STEP 5: Bootstrap CI ===
    const weights = this._computeWeights(resultsByDept, deptHeatmap);
    const bootstrapResults = this._runBootstrap(resultsByDept, weights, partyCodes, deptHeatmap);

    // Output
    const totals = nationalData?.totals;
    const pctCounted = totals ? (totals.contabilizadas / totals.totalActas) * 100 : 0;
    const topCIs = this._getTopCIWidths(bootstrapResults, partyCodes, nationalProjection);
    const grade = this._computeGrade(pctCounted, topCIs);
    const candidates = this._buildCandidates(nationalProjection, bootstrapResults, nationalData?.candidates, partyCodes, totalProjected);
    const consistency = this._checkConsistency(candidates, nationalData?.candidates);
    const deptProjections = this._buildDeptProjections(deptShares, partyCodes, deptHeatmap, census);

    let sampleSize = 0;
    for (const [, data] of resultsByDept) sampleSize += data.mesas.length;

    this.lastEstimate = {
      timestamp: Date.now(), pctCounted, candidates, departments: deptProjections,
      grade, consistency, sampleSize, projectionMode,
      districtsCovered: districtShares.size,
      provincesCovered: provShares.size,
      censusReady: census?.isBuilt || false,
      censusDistricts: census?.districts?.size || 0,
      totals: totals ? {
        actasCounted: totals.contabilizadas, actasTotal: totals.totalActas,
        totalVotesEmitted: totals.totalVotosEmitidos,
        totalVotesValid: totals.totalVotosValidos, turnout: totals.participacionCiudadana
      } : null
    };

    return this.lastEstimate;
  }

  /**
   * THE KEY METHOD: Project national results using census population weights.
   *
   * For EVERY district in the country (not just sampled ones):
   * 1. If we have a sample: use the district's sampled vote shares
   * 2. If no sample: use province average (or department average)
   * 3. Weight by the district's REAL total mesas (from census)
   * 4. For uncounted mesas in each district: apply rural correction
   *
   * This is what makes us match a conteo rápido's accuracy.
   */
  _projectWithCensus(districtShares, provShares, deptShares, partyCodes, census, resultsByDept) {
    const projection = new Map();
    for (const pc of partyCodes) projection.set(pc, 0);

    let totalWeight = 0;

    // Iterate over ALL districts in the census
    for (const [distUbigeo, distInfo] of census.districts) {
      const { totalMesas, counted, pending, deptCode, provCode } = distInfo;
      if (totalMesas === 0) continue;

      // Get vote shares for this district
      let shares;
      if (districtShares.has(distUbigeo)) {
        // We have sampled mesas from this district — use them
        shares = districtShares.get(distUbigeo);
      } else if (provShares.has(provCode)) {
        // No sample, but we have data from the same province
        shares = provShares.get(provCode);
      } else if (deptShares.has(deptCode)) {
        // Fall back to department average
        shares = deptShares.get(deptCode);
      } else {
        continue; // No data at all for this region
      }

      // Apply remaining-vote correction if district has pending mesas
      const pctCounted = totalMesas > 0 ? counted / totalMesas : 1;
      const remainingFrac = 1 - pctCounted;

      let finalShares = shares;
      if (remainingFrac > 0.05) {
        // Get urban/rural data from the department
        const deptData = resultsByDept.get(deptCode);
        if (deptData && deptData.urbanMesas.length > 0 && deptData.ruralMesas.length >= 3) {
          finalShares = this._remainingVoteCorrection(
            shares, deptData, remainingFrac, partyCodes
          );
        }
      }

      // Weight by REAL district size (total mesas)
      for (const pc of partyCodes) {
        projection.set(pc, projection.get(pc) + totalMesas * (finalShares.get(pc) || 0));
      }
      totalWeight += totalMesas;
    }

    // Normalize
    if (totalWeight > 0) {
      for (const pc of partyCodes) {
        projection.set(pc, projection.get(pc) / totalWeight);
      }
    }

    return projection;
  }

  /**
   * Fallback projection when census isn't ready yet.
   * Weights by department electores from heatmap.
   */
  _projectSampleWeighted(districtShares, hierarchy, deptShares, partyCodes, resultsByDept, deptHeatmap) {
    const projection = new Map();
    for (const pc of partyCodes) projection.set(pc, 0);

    const weights = this._computeWeights(resultsByDept, deptHeatmap);

    for (const [deptCode, data] of resultsByDept) {
      if (data.mesas.length < 2) continue;
      const w = weights.get(deptCode) || 0;

      // Aggregate district estimates for this department, weighted by sample count
      const deptDistricts = new Map();
      for (const [distCode, shares] of districtShares) {
        if (distCode.substring(0, 2) === deptCode) deptDistricts.set(distCode, shares);
      }

      const aggregated = this._aggregateByWeight(deptDistricts, hierarchy.districts, partyCodes);

      // Remaining vote correction
      const hm = deptHeatmap?.get(deptCode);
      const remainingFrac = 1 - ((hm?.pctCounted || 100) / 100);
      const corrected = remainingFrac > 0.05
        ? this._remainingVoteCorrection(aggregated, data, remainingFrac, partyCodes)
        : aggregated;

      for (const pc of partyCodes) {
        projection.set(pc, projection.get(pc) + w * (corrected.get(pc) || 0));
      }
    }

    return projection;
  }

  /**
   * Estimate how uncounted mesas vote differently, using urban/rural differential.
   */
  _remainingVoteCorrection(countedShares, deptData, remainingFrac, partyCodes) {
    const { urbanMesas, ruralMesas, mesas } = deptData;
    if (urbanMesas.length === 0 || ruralMesas.length < 3) return countedShares;

    const urbanShares = this._ratioEstimate(urbanMesas, partyCodes);
    const ruralShares = this._ratioEstimate(ruralMesas, partyCodes);

    // Uncounted mesas are more rural. Boost proportional to remaining fraction.
    const sampleRuralFrac = ruralMesas.length / mesas.length;
    const boost = Math.min(1.8, 1 + remainingFrac * 0.8);
    const adjRural = Math.min(0.95, sampleRuralFrac * boost);
    const adjUrban = 1 - adjRural;

    const uncountedShares = new Map();
    for (const pc of partyCodes) {
      uncountedShares.set(pc, adjUrban * (urbanShares.get(pc) || 0) + adjRural * (ruralShares.get(pc) || 0));
    }

    const alpha = 1 - remainingFrac;
    const result = new Map();
    for (const pc of partyCodes) {
      result.set(pc, alpha * (countedShares.get(pc) || 0) + (1 - alpha) * (uncountedShares.get(pc) || 0));
    }
    return result;
  }

  // --- Hierarchy ---
  _buildHierarchy(resultsByDept) {
    const districts = new Map(), provinces = new Map(), departments = new Map();
    for (const [deptCode, data] of resultsByDept) {
      if (!departments.has(deptCode)) departments.set(deptCode, []);
      for (const mesa of data.mesas) {
        const ubigeo = String(mesa.ubigeo || '').padStart(6, '0');
        const provCode = ubigeo.substring(0, 4);
        if (!districts.has(ubigeo)) districts.set(ubigeo, []);
        districts.get(ubigeo).push(mesa);
        if (!provinces.has(provCode)) provinces.set(provCode, []);
        provinces.get(provCode).push(mesa);
        departments.get(deptCode).push(mesa);
      }
    }
    return { districts, provinces, departments };
  }

  // --- Core math ---
  _ratioEstimate(mesas, partyCodes) {
    const shares = new Map();
    const tot = mesas.reduce((s, m) => s + m.totalValid, 0);
    if (tot === 0) { for (const pc of partyCodes) shares.set(pc, 0); return shares; }
    for (const pc of partyCodes) shares.set(pc, mesas.reduce((s, m) => s + (m.votes.get(pc) || 0), 0) / tot);
    return shares;
  }

  _shrinkToward(local, parent, n, partyCodes, kappa = CONFIG.SHRINKAGE_KAPPA) {
    const lambda = n / (n + kappa);
    const r = new Map();
    for (const pc of partyCodes) r.set(pc, lambda * (local.get(pc) || 0) + (1 - lambda) * (parent.get(pc) || 0));
    return r;
  }

  _uniformShares(partyCodes) {
    const s = new Map(); const v = 1 / Math.max(partyCodes.length, 1);
    for (const pc of partyCodes) s.set(pc, v); return s;
  }

  _aggregateByWeight(distSharesMap, allDists, partyCodes) {
    let totalN = 0;
    const weighted = new Map();
    for (const pc of partyCodes) weighted.set(pc, 0);
    for (const [distCode, shares] of distSharesMap) {
      const n = allDists.get(distCode)?.length || 1;
      totalN += n;
      for (const pc of partyCodes) weighted.set(pc, weighted.get(pc) + n * (shares.get(pc) || 0));
    }
    const r = new Map();
    for (const pc of partyCodes) r.set(pc, totalN > 0 ? weighted.get(pc) / totalN : 0);
    return r;
  }

  _computeWeights(resultsByDept, deptHeatmap) {
    const w = new Map(); let tot = 0;
    for (const [dc, data] of resultsByDept) {
      const hm = deptHeatmap?.get(dc);
      let el = hm?.electores || 0;
      if (el === 0 && data.mesas.length > 0) el = data.mesas.length * 280;
      let vf = 0.85;
      if (data.mesas.length > 0) {
        const tv = data.mesas.reduce((s, m) => s + m.totalValid, 0);
        const te = data.mesas.reduce((s, m) => s + (m.totalEmitted || m.totalValid), 0);
        if (te > 0) vf = tv / te;
      }
      const wt = el * vf; w.set(dc, wt); tot += wt;
    }
    if (tot > 0) for (const [k, v] of w) w.set(k, v / tot);
    return w;
  }

  // --- Bootstrap ---
  _runBootstrap(resultsByDept, weights, partyCodes, deptHeatmap) {
    const B = CONFIG.BOOTSTRAP_ITERATIONS;
    const samples = new Map();
    for (const pc of partyCodes) samples.set(pc, []);

    for (let b = 0; b < B; b++) {
      const bp = new Map();
      for (const pc of partyCodes) bp.set(pc, 0);

      for (const [dc, data] of resultsByDept) {
        if (data.mesas.length < 2) continue;
        const w = weights.get(dc) || 0;
        if (w === 0) continue;
        const n = data.mesas.length;
        const rs = Array.from({ length: n }, () => data.mesas[Math.floor(Math.random() * n)]);
        const tv = rs.reduce((s, m) => s + m.totalValid, 0);
        if (tv === 0) continue;

        const hm = deptHeatmap?.get(dc);
        const pctC = hm?.pctCounted || 100;
        const um = 1 + Math.max(0, (70 - pctC) / 100);

        for (const pc of partyCodes) {
          let sh = rs.reduce((s, m) => s + (m.votes.get(pc) || 0), 0) / tv;
          if (um > 1) sh = Math.max(0, sh + (Math.random() - 0.5) * 0.02 * um);
          bp.set(pc, bp.get(pc) + w * sh);
        }
      }
      for (const pc of partyCodes) samples.get(pc).push(bp.get(pc));
    }

    const result = new Map();
    for (const [pc, s] of samples) {
      s.sort((a, b) => a - b);
      const lo = s[Math.floor(B * 0.025)] || 0;
      const hi = s[Math.ceil(B * 0.975) - 1] || 0;
      const mean = s.reduce((a, b) => a + b, 0) / B;
      const variance = s.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (B - 1);
      result.set(pc, { lo, hi, mean, se: Math.sqrt(variance) });
    }
    return result;
  }

  // --- Output builders ---
  _collectPartyCodes(r) {
    const c = new Set();
    for (const [, d] of r) for (const m of d.mesas) for (const [pc] of m.votes) c.add(pc);
    return Array.from(c);
  }

  _buildCandidates(proj, boot, onpeC, partyCodes, totP) {
    const cs = [], lookup = new Map();
    if (onpeC && Array.isArray(onpeC)) for (const c of onpeC) lookup.set(String(c.codigoAgrupacionPolitica), c);
    for (const pc of partyCodes) {
      const p = proj.get(pc) || 0;
      const b = boot.get(pc) || { lo: 0, hi: 0, se: 0 };
      const o = lookup.get(pc);
      const cfg = CONFIG.PARTIES[pc] || {};
      const pp = totP > 0 ? (p / totP) * 100 : 0;
      const lo = totP > 0 ? (b.lo / totP) * 100 : 0;
      const hi = totP > 0 ? (b.hi / totP) * 100 : 0;
      cs.push({
        code: pc, party: o?.nombreAgrupacionPolitica || cfg.name || `Partido ${pc}`,
        partyShort: cfg.short || pc, name: o?.nombreCandidato || '',
        votes: o?.totalVotosValidos || 0, pct: o?.porcentajeVotosValidos || 0,
        projectedPct: Math.round(pp * 100) / 100,
        marginLow: Math.round(lo * 100) / 100, marginHigh: Math.round(hi * 100) / 100,
        se: Math.round((b.se / Math.max(totP, 0.001)) * 10000) / 100,
        color: cfg.color || CONFIG.DEFAULT_PARTY_COLOR
      });
    }
    cs.sort((a, b) => b.projectedPct - a.projectedPct);
    return cs;
  }

  _buildDeptProjections(deptShares, partyCodes, deptHeatmap, census) {
    const r = [];
    const allDepts = new Set([...deptShares.keys(), ...(deptHeatmap ? deptHeatmap.keys() : [])]);
    for (const dc of allDepts) {
      const hm = deptHeatmap?.get(dc);
      const shares = deptShares.get(dc);
      let leader = null, leaderPct = 0;
      if (shares) for (const pc of partyCodes) { const s = shares.get(pc) || 0; if (s > leaderPct) { leaderPct = s; leader = pc; } }
      const censusDept = census?.deptTotals?.get(dc);
      r.push({
        code: dc, ubigeo: dc + '0000', name: hm?.name || `Departamento ${dc}`,
        pctCounted: hm?.pctCounted || 0, actasCounted: hm?.actasCounted || 0,
        electores: hm?.electores || 0,
        totalMesas: censusDept?.totalMesas || 0,
        pendingMesas: censusDept?.pending || 0,
        leadingPartyCode: leader,
        leadingPartyPct: Math.round(leaderPct * 10000) / 100,
        leadingPartyColor: leader ? (CONFIG.PARTIES[leader]?.color || CONFIG.DEFAULT_PARTY_COLOR) : null
      });
    }
    r.sort((a, b) => b.electores - a.electores);
    return r;
  }

  _checkConsistency(proj, onpeC) {
    if (!onpeC || !Array.isArray(onpeC)) return { ok: true, flags: [] };
    const flags = [], byCode = new Map();
    for (const c of onpeC) byCode.set(String(c.codigoAgrupacionPolitica), c.porcentajeVotosValidos || 0);
    for (const c of proj.slice(0, 10)) {
      const op = byCode.get(c.code) || 0;
      const d = Math.abs(c.projectedPct - op); const se = c.se || 1;
      if (d / se > 3) flags.push({ party: c.partyShort, projected: c.projectedPct, onpe: op,
        zScore: Math.round((d / se) * 10) / 10,
        message: `${c.partyShort}: proj ${c.projectedPct}% vs ONPE ${op}% (z=${(d / se).toFixed(1)})` });
    }
    return { ok: flags.length === 0, flags };
  }

  _getTopCIWidths(boot, partyCodes, proj) {
    const t = Array.from(proj.values()).reduce((a, b) => a + b, 0);
    return partyCodes.map(pc => ({ pc, s: proj.get(pc) || 0 })).sort((a, b) => b.s - a.s).slice(0, 5)
      .map(({ pc }) => { const b = boot.get(pc); return (!b || t === 0) ? 10 : ((b.hi - b.lo) / t) * 100; });
  }

  _computeGrade(pct, ciW) {
    const mx = Math.max(...ciW, 0);
    for (const [g, t] of Object.entries(CONFIG.CONFIDENCE_GRADES)) { if (pct >= t.minPctCounted && mx <= t.maxCIWidth) return g; }
    return 'D';
  }

  _emptyEstimate() {
    return { timestamp: Date.now(), pctCounted: 0, candidates: [], departments: [],
      grade: 'D', consistency: { ok: true, flags: [] }, sampleSize: 0, projectionMode: 'no_data', totals: null };
  }
}

module.exports = EnhancedEstimator;
