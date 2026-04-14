const CONFIG = require('../config');

/**
 * Bayesian Beta-Binomial Estimator
 *
 * Standard method used in professional conteos rápidos (quick counts).
 *
 * For each candidate c in each district d:
 *   Prior:      Beta(α₀, β₀) — from province/department average
 *   Likelihood: Binomial(votes_c, totalValid) — from sampled mesas
 *   Posterior:  Beta(α₀ + votes_c, β₀ + totalValid - votes_c)
 *
 * Properties:
 * - With FEW mesas sampled: posterior ≈ prior (provincial/department average)
 * - With MANY mesas sampled: posterior ≈ sample data (local dominates)
 * - Transition is smooth and mathematically optimal (conjugate updating)
 * - Produces credible intervals analytically (no simulation needed)
 *
 * The projection is:
 *   projected_votes[c] = Σ over ALL districts: posteriorMean[c][d] × districtWeight[d]
 *
 * For PENDING mesas in each district: uses the posterior mean (which already
 * incorporates geographic prior + local data) as the prediction.
 */
class BayesianEstimator {
  constructor() {
    this.lastEstimate = null;
  }

  /**
   * @param {Map} resultsByDept - Map<deptCode, { mesas, urbanMesas, ruralMesas }>
   * @param {Object} nationalData - { candidates, totals }
   * @param {Map} deptHeatmap - Map<deptCode, { electores, pctCounted, name, actasCounted }>
   * @param {DistrictCensus|null} census - district population data
   */
  estimate(resultsByDept, nationalData, deptHeatmap, census) {
    const partyCodes = this._collectPartyCodes(resultsByDept);
    if (partyCodes.length === 0) return this._emptyEstimate();

    // === STEP 1: Build hierarchy and compute priors at each level ===
    const hierarchy = this._buildHierarchy(resultsByDept);

    // National prior: pooled across all sampled mesas
    const nationalPrior = this._computePrior(hierarchy.allMesas, partyCodes);

    // Department priors: pooled within each department
    const deptPriors = new Map();
    for (const [deptCode, mesas] of hierarchy.departments) {
      deptPriors.set(deptCode, mesas.length >= 5
        ? this._computePrior(mesas, partyCodes)
        : nationalPrior
      );
    }

    // Province priors: pooled within each province, shrunk toward department
    const provPriors = new Map();
    for (const [provCode, mesas] of hierarchy.provinces) {
      const deptCode = provCode.substring(0, 2);
      const deptPrior = deptPriors.get(deptCode) || nationalPrior;
      provPriors.set(provCode, mesas.length >= 3
        ? this._blendPriors(this._computePrior(mesas, partyCodes), deptPrior, mesas.length, 10)
        : deptPrior
      );
    }

    // === STEP 2: Bayesian posterior for each sampled district ===
    const districtPosteriors = new Map(); // ubigeo → Map<partyCode, {mean, lo, hi}>

    for (const [distUbigeo, mesas] of hierarchy.districts) {
      const provCode = distUbigeo.substring(0, 4);
      const deptCode = distUbigeo.substring(0, 2);
      const prior = provPriors.get(provCode) || deptPriors.get(deptCode) || nationalPrior;

      const posterior = this._computePosterior(mesas, prior, partyCodes);
      districtPosteriors.set(distUbigeo, posterior);
    }

    // === STEP 3: National projection ===
    let nationalProjection;
    let projectionMode;

    if (census?.isBuilt) {
      // Census-weighted: iterate ALL districts, use posterior or prior
      nationalProjection = this._projectWithCensus(
        districtPosteriors, provPriors, deptPriors, nationalPrior,
        partyCodes, census, resultsByDept, deptHeatmap
      );
      projectionMode = 'bayesian_census';
    } else {
      // Sample-weighted fallback
      nationalProjection = this._projectSampleWeighted(
        districtPosteriors, hierarchy, partyCodes, resultsByDept, deptHeatmap
      );
      projectionMode = 'bayesian_sample';
    }

    // === STEP 4: Credible intervals (analytical from Beta posterior) ===
    const credibleIntervals = this._computeNationalCredibleIntervals(
      districtPosteriors, provPriors, deptPriors, nationalPrior,
      partyCodes, census, resultsByDept, deptHeatmap
    );

    // Build output
    const totals = nationalData?.totals;
    const pctCounted = totals ? (totals.contabilizadas / totals.totalActas) * 100 : 0;
    const totalProjected = Array.from(nationalProjection.values()).reduce((a, b) => a + b, 0);

    const candidates = this._buildCandidates(
      nationalProjection, credibleIntervals, nationalData?.candidates, partyCodes, totalProjected
    );

    const topCIs = candidates.slice(0, 5).map(c => c.marginHigh - c.marginLow);
    const grade = this._computeGrade(pctCounted, topCIs);
    const consistency = this._checkConsistency(candidates, nationalData?.candidates);

    // Department-level posteriors
    const deptProjections = this._buildDeptProjections(
      deptPriors, districtPosteriors, partyCodes, deptHeatmap, census
    );

    let sampleSize = 0;
    for (const [, data] of resultsByDept) sampleSize += data.mesas.length;

    this.lastEstimate = {
      timestamp: Date.now(), pctCounted, candidates, departments: deptProjections,
      grade, consistency, sampleSize, projectionMode,
      districtsCovered: districtPosteriors.size,
      provincesCovered: provPriors.size,
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

  // ============================================================
  // BAYESIAN CORE
  // ============================================================

  /**
   * Compute prior parameters from a set of mesas.
   * Uses method of moments to fit a Beta distribution.
   *
   * For each party: estimate α₀, β₀ from the observed vote shares.
   * The prior strength (α₀ + β₀) reflects how much data we have.
   *
   * Returns Map<partyCode, { alpha, beta }>
   */
  _computePrior(mesas, partyCodes) {
    const prior = new Map();
    if (mesas.length === 0) {
      for (const pc of partyCodes) prior.set(pc, { alpha: 1, beta: 1 }); // uninformative
      return prior;
    }

    // Compute share per mesa
    for (const pc of partyCodes) {
      const shares = mesas.map(m => {
        if (m.totalValid === 0) return 0;
        return (m.votes.get(pc) || 0) / m.totalValid;
      }).filter(s => s >= 0);

      if (shares.length < 2) {
        prior.set(pc, { alpha: 1, beta: 1 });
        continue;
      }

      const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
      const variance = shares.reduce((a, s) => a + (s - mean) ** 2, 0) / (shares.length - 1);

      // Method of moments for Beta distribution:
      // α = mean × ((mean(1-mean)/variance) - 1)
      // β = (1-mean) × ((mean(1-mean)/variance) - 1)
      // Clamp to avoid degenerate distributions
      const m0 = Math.max(0.001, Math.min(0.999, mean));
      const v = Math.max(0.0001, Math.min(m0 * (1 - m0) * 0.9, variance)); // cap variance

      const commonFactor = Math.max(2, (m0 * (1 - m0) / v) - 1);
      // Cap prior strength: don't let prior be too strong
      const maxStrength = Math.min(50, mesas.length * 2);
      const factor = Math.min(commonFactor, maxStrength);

      const alpha = Math.max(0.5, m0 * factor);
      const beta = Math.max(0.5, (1 - m0) * factor);

      prior.set(pc, { alpha, beta });
    }

    return prior;
  }

  /**
   * Compute posterior for a district given its sampled mesas and a prior.
   *
   * Posterior: Beta(α₀ + Σvotes_c, β₀ + Σ(totalValid - votes_c))
   *
   * Returns Map<partyCode, { mean, alpha, beta, lo95, hi95 }>
   */
  _computePosterior(mesas, prior, partyCodes) {
    const posterior = new Map();

    // Total votes across all sampled mesas in this district
    const totalValid = mesas.reduce((s, m) => s + m.totalValid, 0);

    for (const pc of partyCodes) {
      const totalVotes = mesas.reduce((s, m) => s + (m.votes.get(pc) || 0), 0);
      const p = prior.get(pc) || { alpha: 1, beta: 1 };

      // Conjugate update
      const alphaPost = p.alpha + totalVotes;
      const betaPost = p.beta + (totalValid - totalVotes);

      // Posterior mean = α / (α + β)
      const mean = alphaPost / (alphaPost + betaPost);

      // 95% credible interval (Beta quantiles via normal approximation)
      const { lo, hi } = this._betaCredibleInterval(alphaPost, betaPost, 0.95);

      posterior.set(pc, { mean, alpha: alphaPost, beta: betaPost, lo95: lo, hi95: hi });
    }

    return posterior;
  }

  /**
   * Blend two priors: local (from data) and parent (from higher level).
   * Weight by number of local observations.
   */
  _blendPriors(localPrior, parentPrior, localN, blendKappa) {
    const lambda = localN / (localN + blendKappa);
    const blended = new Map();

    for (const [pc, local] of localPrior) {
      const parent = parentPrior.get(pc) || { alpha: 1, beta: 1 };
      blended.set(pc, {
        alpha: lambda * local.alpha + (1 - lambda) * parent.alpha,
        beta: lambda * local.beta + (1 - lambda) * parent.beta
      });
    }

    return blended;
  }

  /**
   * 95% credible interval for Beta distribution.
   * Uses Wilson-Hilferty normal approximation for speed.
   */
  _betaCredibleInterval(alpha, beta, level = 0.95) {
    const mean = alpha / (alpha + beta);
    const n = alpha + beta;
    // Standard deviation of Beta
    const sd = Math.sqrt((alpha * beta) / (n * n * (n + 1)));
    // z for 95% CI
    const z = 1.96;
    return {
      lo: Math.max(0, mean - z * sd),
      hi: Math.min(1, mean + z * sd)
    };
  }

  // ============================================================
  // PROJECTION METHODS
  // ============================================================

  /**
   * Project using census weights: iterate ALL districts.
   * For each district:
   *   - If sampled: use posterior mean
   *   - If not sampled: use province prior mean (or dept prior)
   *   - Weight by totalMesas from census
   *   - Apply remaining-vote correction for pending mesas
   */
  _projectWithCensus(distPosteriors, provPriors, deptPriors, nationalPrior,
                     partyCodes, census, resultsByDept, deptHeatmap) {
    const projection = new Map();
    for (const pc of partyCodes) projection.set(pc, 0);
    let totalWeight = 0;

    // Pre-compute department-level ratio estimates (pooled, robust)
    const deptRatios = new Map();
    for (const [deptCode, data] of resultsByDept) {
      if (data.mesas.length >= 2) {
        deptRatios.set(deptCode, this._ratioEstimate(data.mesas, partyCodes));
      }
    }

    for (const [distUbigeo, distInfo] of census.districts) {
      const { totalMesas, counted, pending, deptCode, provCode } = distInfo;
      if (totalMesas === 0) continue;

      // Get vote share estimate for this district
      let shares;
      if (distPosteriors.has(distUbigeo)) {
        // Sampled district: use Bayesian posterior mean
        const post = distPosteriors.get(distUbigeo);
        shares = new Map();
        for (const pc of partyCodes) shares.set(pc, post.get(pc)?.mean || 0);
      } else {
        // Unsampled district: use department's pooled ratio estimate
        // This is more stable than the Beta prior mean because it uses ALL
        // mesas from the department, not fitted parameters
        shares = deptRatios.get(deptCode);
        if (!shares) continue; // no data for this department at all
      }

      // Remaining-vote correction for pending mesas
      const pctCounted = counted / totalMesas;
      const remainingFrac = 1 - pctCounted;

      if (remainingFrac > 0.05) {
        const deptData = resultsByDept.get(deptCode);
        if (deptData?.urbanMesas?.length > 0 && deptData?.ruralMesas?.length >= 3) {
          shares = this._remainingVoteCorrection(shares, deptData, remainingFrac, partyCodes);
        }
      }

      // Weight by total mesas (population weight)
      for (const pc of partyCodes) {
        projection.set(pc, projection.get(pc) + totalMesas * (shares.get(pc) || 0));
      }
      totalWeight += totalMesas;
    }

    // Normalize
    if (totalWeight > 0) {
      for (const pc of partyCodes) projection.set(pc, projection.get(pc) / totalWeight);
    }
    return projection;
  }

  /**
   * Fallback: sample-weighted projection when census isn't ready.
   */
  _projectSampleWeighted(distPosteriors, hierarchy, partyCodes, resultsByDept, deptHeatmap) {
    const projection = new Map();
    for (const pc of partyCodes) projection.set(pc, 0);

    const weights = this._computeDeptWeights(resultsByDept, deptHeatmap);

    for (const [deptCode, data] of resultsByDept) {
      if (data.mesas.length < 2) continue;
      const w = weights.get(deptCode) || 0;

      // Aggregate posteriors for this department's districts
      let totalN = 0;
      const agg = new Map();
      for (const pc of partyCodes) agg.set(pc, 0);

      for (const [distCode, post] of distPosteriors) {
        if (distCode.substring(0, 2) !== deptCode) continue;
        const n = hierarchy.districts.get(distCode)?.length || 1;
        totalN += n;
        for (const pc of partyCodes) {
          agg.set(pc, agg.get(pc) + n * (post.get(pc)?.mean || 0));
        }
      }

      if (totalN === 0) continue;

      // Remaining vote correction
      const hm = deptHeatmap?.get(deptCode);
      const remainingFrac = 1 - ((hm?.pctCounted || 100) / 100);
      let shares = new Map();
      for (const pc of partyCodes) shares.set(pc, agg.get(pc) / totalN);

      if (remainingFrac > 0.05) {
        shares = this._remainingVoteCorrection(shares, data, remainingFrac, partyCodes);
      }

      for (const pc of partyCodes) {
        projection.set(pc, projection.get(pc) + w * (shares.get(pc) || 0));
      }
    }

    return projection;
  }

  /**
   * Remaining-vote correction using urban/rural differential.
   */
  /**
   * Remaining-vote correction: estimates how uncounted mesas differ.
   *
   * Key insight: the correction should be PROPORTIONAL to how much the
   * urban/rural differential actually matters in this department.
   * If urban and rural vote similarly → correction is tiny.
   * If they vote very differently AND lots of rural is pending → bigger correction.
   *
   * Also: departments that are >70% counted probably have "late urban" pending,
   * not rural. Only apply strong correction when <60% counted.
   */
  _remainingVoteCorrection(countedShares, deptData, remainingFrac, partyCodes) {
    const { urbanMesas, ruralMesas, mesas } = deptData;
    if (!urbanMesas || urbanMesas.length === 0 || !ruralMesas || ruralMesas.length < 3) return countedShares;

    const urbanShares = this._ratioEstimate(urbanMesas, partyCodes);
    const ruralShares = this._ratioEstimate(ruralMesas, partyCodes);

    // Measure how DIFFERENT urban vs rural actually vote
    let maxDiff = 0;
    for (const pc of partyCodes) {
      const diff = Math.abs((urbanShares.get(pc) || 0) - (ruralShares.get(pc) || 0));
      if (diff > maxDiff) maxDiff = diff;
    }

    // If urban and rural vote similarly (maxDiff < 3pp), barely correct
    // If they vote very differently (maxDiff > 15pp), correct more
    const diffFactor = Math.min(1, maxDiff / 0.15); // 0 to 1 scale

    // Only apply strong correction when department is significantly behind (<60%)
    // Departments >70% counted: their pending mesas are likely just "late", not rural
    const lagFactor = Math.max(0, Math.min(1, (0.6 - (1 - remainingFrac)) / 0.3));
    // lagFactor: 1.0 at 30% counted, 0.5 at 45%, 0.0 at 60%+

    // Combined correction strength
    const correctionStrength = diffFactor * lagFactor * 0.5; // max 50% shift

    if (correctionStrength < 0.01) return countedShares; // negligible correction

    const sampleRuralFrac = ruralMesas.length / mesas.length;
    const adjRural = Math.min(0.8, sampleRuralFrac * (1 + correctionStrength * 0.5));
    const adjUrban = 1 - adjRural;

    const uncounted = new Map();
    for (const pc of partyCodes) {
      uncounted.set(pc, adjUrban * (urbanShares.get(pc) || 0) + adjRural * (ruralShares.get(pc) || 0));
    }

    // Blend: mostly trust counted data, only small shift for uncounted
    const alpha = 1 - remainingFrac * correctionStrength;
    const result = new Map();
    for (const pc of partyCodes) {
      result.set(pc, alpha * (countedShares.get(pc) || 0) + (1 - alpha) * (uncounted.get(pc) || 0));
    }
    return result;
  }

  /**
   * Compute national-level credible intervals by propagating
   * district-level Beta uncertainty through the weighted sum.
   *
   * Uses parametric bootstrap from the posteriors (faster than
   * non-parametric bootstrap, and theoretically grounded).
   */
  _computeNationalCredibleIntervals(distPosteriors, provPriors, deptPriors, nationalPrior,
                                     partyCodes, census, resultsByDept, deptHeatmap) {
    const B = 500; // fewer iterations needed with parametric bootstrap
    const samples = new Map();
    for (const pc of partyCodes) samples.set(pc, []);

    // For each bootstrap replicate: draw from each district's Beta posterior
    const weights = this._computeDeptWeights(resultsByDept, deptHeatmap);

    for (let b = 0; b < B; b++) {
      const draw = new Map();
      for (const pc of partyCodes) draw.set(pc, 0);

      for (const [deptCode, data] of resultsByDept) {
        if (data.mesas.length < 2) continue;
        const w = weights.get(deptCode) || 0;
        if (w === 0) continue;

        // Draw from each district's posterior
        for (const pc of partyCodes) {
          let distTotal = 0, distN = 0;
          for (const [distCode, post] of distPosteriors) {
            if (distCode.substring(0, 2) !== deptCode) continue;
            const p = post.get(pc);
            if (!p) continue;
            // Draw from Beta(alpha, beta) using gamma trick
            const sample = this._betaRandom(p.alpha, p.beta);
            const n = data.mesas.filter(m => String(m.ubigeo || '').padStart(6, '0') === distCode).length || 1;
            distTotal += sample * n;
            distN += n;
          }
          if (distN > 0) {
            draw.set(pc, draw.get(pc) + w * (distTotal / distN));
          }
        }
      }

      for (const pc of partyCodes) samples.get(pc).push(draw.get(pc));
    }

    // Compute percentiles
    const result = new Map();
    for (const [pc, s] of samples) {
      s.sort((a, b) => a - b);
      const lo = s[Math.floor(B * 0.025)] || 0;
      const hi = s[Math.ceil(B * 0.975) - 1] || 0;
      const mean = s.reduce((a, b) => a + b, 0) / B;
      const se = Math.sqrt(s.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (B - 1));
      result.set(pc, { lo, hi, mean, se });
    }
    return result;
  }

  /**
   * Draw from Beta(α, β) using the Gamma trick:
   * X ~ Gamma(α, 1), Y ~ Gamma(β, 1)  →  X/(X+Y) ~ Beta(α, β)
   */
  _betaRandom(alpha, beta) {
    const x = this._gammaRandom(alpha);
    const y = this._gammaRandom(beta);
    if (x + y === 0) return 0.5;
    return x / (x + y);
  }

  /**
   * Draw from Gamma(α, 1) using Marsaglia-Tsang method.
   */
  _gammaRandom(alpha) {
    if (alpha < 1) {
      // Boost: Gamma(α) = Gamma(α+1) × U^(1/α)
      return this._gammaRandom(alpha + 1) * Math.pow(Math.random(), 1 / alpha);
    }

    const d = alpha - 1/3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
      let x, v;
      do {
        x = this._normalRandom();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /**
   * Standard normal random (Box-Muller).
   */
  _normalRandom() {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  _buildHierarchy(resultsByDept) {
    const districts = new Map(), provinces = new Map(), departments = new Map();
    const allMesas = [];
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
        allMesas.push(mesa);
      }
    }
    return { districts, provinces, departments, allMesas };
  }

  _ratioEstimate(mesas, partyCodes) {
    const s = new Map();
    const t = mesas.reduce((a, m) => a + m.totalValid, 0);
    if (t === 0) { for (const pc of partyCodes) s.set(pc, 0); return s; }
    for (const pc of partyCodes) s.set(pc, mesas.reduce((a, m) => a + (m.votes.get(pc) || 0), 0) / t);
    return s;
  }

  _collectPartyCodes(r) {
    const c = new Set();
    for (const [, d] of r) for (const m of d.mesas) for (const [pc] of m.votes) c.add(pc);
    return Array.from(c);
  }

  _computeDeptWeights(resultsByDept, deptHeatmap) {
    const w = new Map(); let tot = 0;
    for (const [dc, data] of resultsByDept) {
      const hm = deptHeatmap?.get(dc);
      let el = hm?.electores || (data.mesas.length * 280);
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

  _buildCandidates(proj, ci, onpeC, partyCodes, totP) {
    const cs = [], lookup = new Map();
    if (onpeC && Array.isArray(onpeC)) for (const c of onpeC) lookup.set(String(c.codigoAgrupacionPolitica), c);
    for (const pc of partyCodes) {
      const p = proj.get(pc) || 0;
      const b = ci.get(pc) || { lo: 0, hi: 0, se: 0 };
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

  _buildDeptProjections(deptPriors, distPosteriors, partyCodes, deptHeatmap, census) {
    const r = [];
    const allDepts = new Set([...deptPriors.keys(), ...(deptHeatmap ? deptHeatmap.keys() : [])]);
    for (const dc of allDepts) {
      const hm = deptHeatmap?.get(dc);
      const prior = deptPriors.get(dc);
      let leader = null, leaderPct = 0;
      if (prior) {
        for (const pc of partyCodes) {
          const p = prior.get(pc) || { alpha: 1, beta: 1 };
          const mean = p.alpha / (p.alpha + p.beta);
          if (mean > leaderPct) { leaderPct = mean; leader = pc; }
        }
      }
      const censusDept = census?.deptTotals?.get(dc);
      r.push({
        code: dc, ubigeo: dc + '0000', name: hm?.name || `Departamento ${dc}`,
        pctCounted: hm?.pctCounted || 0, actasCounted: hm?.actasCounted || 0,
        electores: hm?.electores || 0,
        totalMesas: censusDept?.totalMesas || 0, pendingMesas: censusDept?.pending || 0,
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

module.exports = BayesianEstimator;
