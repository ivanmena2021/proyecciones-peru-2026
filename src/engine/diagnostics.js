const CONFIG = require('../config');

/**
 * Diagnostics module: anomaly detection, backtesting, quality metrics.
 */
class Diagnostics {
  constructor() {
    this.backtrackHistory = []; // stores past projections for backtesting
    this.anomalies = [];
    this.maxBacktrack = 20; // keep last 20 projections for backtesting
  }

  /**
   * Run all diagnostics on a projection result.
   */
  run(estimate) {
    const results = {
      anomalies: this._detectAnomalies(estimate),
      coverageDiag: this._computeCoverage(estimate),
      backtest: this._backtest(estimate),
      winnerCall: this._checkWinnerCall(estimate)
    };

    // Store for backtesting
    this.backtrackHistory.push({
      timestamp: estimate.timestamp,
      candidates: estimate.candidates.slice(0, 10).map(c => ({
        code: c.code,
        projectedPct: c.projectedPct
      }))
    });
    if (this.backtrackHistory.length > this.maxBacktrack) {
      this.backtrackHistory.shift();
    }

    return results;
  }

  /**
   * Detect mesa-level anomalies in the sampled data.
   */
  _detectAnomalies(estimate) {
    const anomalies = [];

    // Check for any candidate with suspiciously high projection
    for (const c of estimate.candidates.slice(0, 10)) {
      if (c.projectedPct > 50) {
        anomalies.push({
          type: 'high_projection',
          severity: 'info',
          message: `${c.partyShort} proyectado en ${c.projectedPct}% — verificar`
        });
      }
    }

    // Check consistency flags
    if (estimate.consistency && !estimate.consistency.ok) {
      for (const flag of estimate.consistency.flags) {
        anomalies.push({
          type: 'consistency',
          severity: flag.zScore > 5 ? 'high' : 'medium',
          message: flag.message
        });
      }
    }

    // Check if sample size is adequate
    if (estimate.sampleSize < 500) {
      anomalies.push({
        type: 'low_sample',
        severity: 'high',
        message: `Muestra pequena: solo ${estimate.sampleSize} mesas muestreadas`
      });
    }

    this.anomalies = anomalies;
    return anomalies;
  }

  /**
   * Compute coverage diagnostics per department.
   */
  _computeCoverage(estimate) {
    if (!estimate.departments) return [];

    return estimate.departments.map(d => ({
      name: d.name,
      pctCounted: d.pctCounted,
      hasProjection: d.leadingPartyCode !== null
    }));
  }

  /**
   * Backtesting: compare current projection against past projections.
   * Projections should converge over time.
   */
  _backtest(currentEstimate) {
    if (this.backtrackHistory.length < 3) {
      return { converging: null, message: 'Insufficient history for backtesting' };
    }

    const recent = this.backtrackHistory.slice(-5);
    const currentTop = currentEstimate.candidates.slice(0, 5);

    // Compute average absolute change in projections over recent history
    let totalChange = 0;
    let comparisons = 0;

    for (const past of recent) {
      for (const currentC of currentTop) {
        const pastC = past.candidates.find(p => p.code === currentC.code);
        if (pastC) {
          totalChange += Math.abs(currentC.projectedPct - pastC.projectedPct);
          comparisons++;
        }
      }
    }

    const avgChange = comparisons > 0 ? totalChange / comparisons : 0;

    // Check if recent changes are getting smaller (converging)
    const isConverging = avgChange < 0.5; // less than 0.5pp average change

    return {
      converging: isConverging,
      avgChange: Math.round(avgChange * 100) / 100,
      message: isConverging
        ? `Proyecciones convergiendo (cambio promedio: ${avgChange.toFixed(2)}pp)`
        : `Proyecciones aun inestables (cambio promedio: ${avgChange.toFixed(2)}pp)`
    };
  }

  /**
   * Check if we can call a winner with high confidence.
   * Uses 3σ criterion for conservative election calling.
   */
  _checkWinnerCall(estimate) {
    const top5 = estimate.candidates.slice(0, 5);
    if (top5.length < 2) return { canCall: false, message: 'Not enough candidates' };

    const leader = top5[0];
    const second = top5[1];

    // Gap between leader and second place
    const gap = leader.projectedPct - second.projectedPct;

    // Combined SE (conservative: assume independent)
    const combinedSE = Math.sqrt((leader.se || 1) ** 2 + (second.se || 1) ** 2);

    // 3σ criterion
    const zScore = combinedSE > 0 ? gap / combinedSE : 0;
    const canCall = zScore > 3 && estimate.pctCounted > 50;

    return {
      canCall,
      leader: leader.partyShort,
      second: second.partyShort,
      gap: Math.round(gap * 100) / 100,
      zScore: Math.round(zScore * 10) / 10,
      confidence: canCall ? '99.7%' : null,
      message: canCall
        ? `${leader.partyShort} lider con ${gap.toFixed(2)}pp de ventaja (z=${zScore.toFixed(1)}, confianza 99.7%)`
        : `Resultado aun incierto: ventaja de ${gap.toFixed(2)}pp (z=${zScore.toFixed(1)})`
    };
  }
}

module.exports = Diagnostics;
