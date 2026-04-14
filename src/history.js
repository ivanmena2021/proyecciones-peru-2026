const CONFIG = require('./config');

/**
 * Circular buffer for time-series history of projections.
 * Stores last N snapshots for trend charts.
 */
class History {
  constructor(maxPoints = CONFIG.HISTORY_MAX_POINTS) {
    this.maxPoints = maxPoints;
    this.points = [];
  }

  add(snapshot) {
    this.points.push({
      timestamp: Date.now(),
      pctCounted: snapshot.pctCounted,
      candidates: snapshot.candidates.slice(0, 10).map(c => ({
        code: c.code,
        party: c.partyShort,
        pct: c.pct,
        projectedPct: c.projectedPct,
        marginLow: c.marginLow,
        marginHigh: c.marginHigh
      }))
    });

    if (this.points.length > this.maxPoints) {
      this.points = this.points.slice(-this.maxPoints);
    }
  }

  getAll() {
    return this.points;
  }

  getLast(n = 50) {
    return this.points.slice(-n);
  }
}

module.exports = History;
