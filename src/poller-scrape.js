// Minimal scrape-based poller. Used while ONPE's JSON API is disabled.
// Pulls nation-wide top candidates + % procesado from public SSR pages
// (TV Peru, RPP) and broadcasts every POLL_INTERVAL_MS.
const CONFIG = require('./config');
const { scrapeResults } = require('./api/scraper');
const History = require('./history');
const cache = require('./cache');

class ScrapePoller {
  constructor() {
    this.history = new History();
    this.sseClients = new Set();
    this.intervalId = null;
    this.lastEstimate = null;
    this.cycleCount = 0;
    this.status = 'initializing';
    this.lastSource = null;
    this.lastSuccessAt = 0;
  }

  async start() {
    console.log('[poller-scrape] Starting scraper-based poller (ONPE API disabled)');
    cache.ensureDataDir();
    this.status = 'running';
    await this._runCycle();
    this.intervalId = setInterval(() => {
      this._runCycle().catch(e => console.error('[poller-scrape] cycle err:', e.message));
    }, CONFIG.POLL_INTERVAL_MS);
  }

  async _runCycle() {
    this.cycleCount++;
    const t0 = Date.now();
    try {
      const r = await scrapeResults();
      if (!r || !r.candidates.length) {
        console.warn(`[poller-scrape] Cycle ${this.cycleCount}: no data from any source`);
        // Keep last estimate alive but bump timestamp so clients know we're still up
        if (this.lastEstimate) {
          this.lastEstimate.timestamp = Date.now();
          this.lastEstimate.onpeStale = true;
          this.lastEstimate.onpeStaleSeconds = Math.round((Date.now() - this.lastSuccessAt) / 1000);
          cache.writeJSON('latest.json', this.lastEstimate);
          this._broadcast(this.lastEstimate);
        }
        return;
      }

      this.lastSource = r.source;
      this.lastSuccessAt = Date.now();

      const output = {
        timestamp: Date.now(),
        pctCounted: r.pctCounted,
        candidates: r.candidates,
        totals: r.totals,
        grade: this._grade(r.pctCounted),
        projectionMode: 'scraped_aggregate',
        projectionNote: `Datos agregados desde ${r.source.toUpperCase()} (ONPE API deshabilitada). ` +
          `% procesado: ${r.pctCounted.toFixed(3)}%. Top 7 candidatos con porcentajes oficiales ONPE.`,
        sourceUrl: r.sourceUrl,
        source: r.source,
        sampleSize: 0,
        consistency: { ok: true, flags: [] },
        onpeStale: false,
        onpeStaleSeconds: 0
      };

      this.history.add(output);
      cache.writeJSON('latest.json', output);
      cache.writeJSON('history.json', this.history.getAll());
      this._broadcast(output);
      this.lastEstimate = output;

      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      const top = output.candidates.slice(0, 3);
      console.log(
        `[poller-scrape] Cycle ${this.cycleCount} (${dt}s) [${r.source}]: ` +
        `${r.pctCounted.toFixed(2)}% contado — ` +
        top.map((c, i) => `${i + 1}°${c.partyShort} ${c.pct}%`).join(' | ')
      );
    } catch (err) {
      console.error(`[poller-scrape] Cycle ${this.cycleCount} error:`, err.message);
    }
  }

  _grade(pct) {
    if (pct >= 95) return 'A';
    if (pct >= 80) return 'B';
    if (pct >= 60) return 'C';
    return 'D';
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
    for (const c of this.sseClients) {
      try { c.write(msg); } catch { this.sseClients.delete(c); }
    }
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    for (const c of this.sseClients) { try { c.end(); } catch {} }
    this.sseClients.clear();
  }

  getStatus() {
    return {
      mode: 'scrape',
      status: this.status,
      cycles: this.cycleCount,
      sseClients: this.sseClients.size,
      lastSource: this.lastSource,
      lastSuccessAt: this.lastSuccessAt
    };
  }
}

module.exports = ScrapePoller;
