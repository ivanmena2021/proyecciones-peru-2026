const CONFIG = require('../config');
const fetcher = require('../api/fetcher');

/**
 * District Census: lightweight scan that obtains the TRUE size and counting
 * progress of every district (~1,800) WITHOUT downloading all mesa codes.
 *
 * This gives us:
 * - totalMesas per district (electoral weight)
 * - countedMesas per district (counting progress)
 * - pendingMesas per district (remaining vote location)
 *
 * These are the POPULATION WEIGHTS that make our stratified estimator correct.
 * Without them, we're weighting by sample size, not population size.
 */
class DistrictCensus {
  constructor() {
    // districtUbigeo -> { totalMesas, counted, pending, deptCode, provCode }
    this.districts = new Map();
    // Aggregated by department
    this.deptTotals = new Map(); // deptCode -> { totalMesas, counted, pending }
    // Aggregated by province
    this.provTotals = new Map(); // provCode -> { totalMesas, counted, pending }

    this.isBuilt = false;
    this.allDistrictUbigeos = [];
  }

  /**
   * Build the census: enumerate all districts and get their mesa counts.
   * Runs in background — does NOT block projections.
   */
  async build() {
    console.log('[census] Starting district census...');
    const startTime = Date.now();

    // Step 1: Get all department → province → district ubigeos
    const depts = await fetcher.fetchDepartments();
    if (!depts) throw new Error('Failed to fetch departments');

    const allDistricts = [];

    for (const dept of depts) {
      const deptUbigeo = String(dept.ubigeo).padStart(6, '0');
      const provinces = await fetcher.fetchProvinces(deptUbigeo);
      if (!provinces) continue;

      for (const prov of provinces) {
        const provUbigeo = String(prov.ubigeo || prov.idUbigeo).padStart(6, '0');
        const districts = await fetcher.fetchDistricts(deptUbigeo, provUbigeo);
        if (!districts) continue;

        for (const dist of districts) {
          const distUbigeo = String(dist.ubigeo || dist.idUbigeo).padStart(6, '0');
          allDistricts.push({
            ubigeo: distUbigeo,
            deptCode: deptUbigeo.substring(0, 2),
            provCode: distUbigeo.substring(0, 4)
          });
        }
      }
    }

    console.log(`[census] Found ${allDistricts.length} districts. Scanning mesa counts...`);
    this.allDistrictUbigeos = allDistricts;

    // Step 2: For each district, get summary (totalRegistros, contabilizada, pendiente)
    // This is ONE small request per district with tamanio=1
    const BATCH_SIZE = 60;
    let scanned = 0;

    for (let i = 0; i < allDistricts.length; i += BATCH_SIZE) {
      const batch = allDistricts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(d => fetcher.fetchDistrictActas(d.ubigeo, 0, 1))
      );

      for (let j = 0; j < batch.length; j++) {
        const { ubigeo, deptCode, provCode } = batch[j];
        const data = results[j];

        const counted = data?.contabilizada || 0;
        const pending = data?.pendiente || 0;
        const observed = data?.observada || 0;
        const total = counted + pending + observed;

        if (total > 0) {
          this.districts.set(ubigeo, {
            totalMesas: total,
            counted,
            pending: pending + observed,
            deptCode,
            provCode
          });

          // Aggregate to department
          if (!this.deptTotals.has(deptCode)) {
            this.deptTotals.set(deptCode, { totalMesas: 0, counted: 0, pending: 0 });
          }
          const dt = this.deptTotals.get(deptCode);
          dt.totalMesas += total;
          dt.counted += counted;
          dt.pending += pending + observed;

          // Aggregate to province
          if (!this.provTotals.has(provCode)) {
            this.provTotals.set(provCode, { totalMesas: 0, counted: 0, pending: 0 });
          }
          const pt = this.provTotals.get(provCode);
          pt.totalMesas += total;
          pt.counted += counted;
          pt.pending += pending + observed;
        }

        scanned++;
      }

      if (scanned % 200 === 0) {
        console.log(`[census] Scanned ${scanned}/${allDistricts.length} districts`);
      }
    }

    this.isBuilt = true;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalMesas = Array.from(this.districts.values()).reduce((s, d) => s + d.totalMesas, 0);
    const totalCounted = Array.from(this.districts.values()).reduce((s, d) => s + d.counted, 0);

    console.log(
      `[census] Complete in ${elapsed}s: ${this.districts.size} districts, ` +
      `${totalMesas.toLocaleString()} total mesas, ${totalCounted.toLocaleString()} counted ` +
      `(${(totalCounted/totalMesas*100).toFixed(1)}%)`
    );

    return this.getStats();
  }

  /**
   * Refresh counting progress for all districts.
   * Much faster than full build since we already have the district list.
   */
  async refresh() {
    if (!this.isBuilt) return;

    // Reset aggregates
    for (const [, dt] of this.deptTotals) { dt.counted = 0; dt.pending = 0; }
    for (const [, pt] of this.provTotals) { pt.counted = 0; pt.pending = 0; }

    const BATCH_SIZE = 80;
    const districts = Array.from(this.districts.keys());

    for (let i = 0; i < districts.length; i += BATCH_SIZE) {
      const batch = districts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(ubigeo => fetcher.fetchDistrictActas(ubigeo, 0, 1))
      );

      for (let j = 0; j < batch.length; j++) {
        const ubigeo = batch[j];
        const data = results[j];
        const dist = this.districts.get(ubigeo);
        if (!dist || !data) continue;

        dist.counted = data.contabilizada || 0;
        dist.pending = (data.pendiente || 0) + (data.observada || 0);

        const dt = this.deptTotals.get(dist.deptCode);
        if (dt) { dt.counted += dist.counted; dt.pending += dist.pending; }

        const pt = this.provTotals.get(dist.provCode);
        if (pt) { pt.counted += dist.counted; pt.pending += dist.pending; }
      }
    }
  }

  /**
   * Get the total number of mesas for a district.
   */
  getDistrictSize(ubigeo) {
    return this.districts.get(ubigeo)?.totalMesas || 0;
  }

  /**
   * Get counting progress for a district.
   */
  getDistrictProgress(ubigeo) {
    const d = this.districts.get(ubigeo);
    if (!d || d.totalMesas === 0) return 0;
    return d.counted / d.totalMesas;
  }

  /**
   * Get all districts in a department with their sizes.
   */
  getDistrictsInDept(deptCode) {
    const result = [];
    for (const [ubigeo, data] of this.districts) {
      if (data.deptCode === deptCode) {
        result.push({ ubigeo, ...data });
      }
    }
    return result;
  }

  /**
   * Get the total pending mesas in a department, grouped by district.
   * This tells us WHERE the remaining votes are.
   */
  getPendingByDistrict(deptCode) {
    const result = [];
    for (const [ubigeo, data] of this.districts) {
      if (data.deptCode === deptCode && data.pending > 0) {
        result.push({
          ubigeo,
          pending: data.pending,
          total: data.totalMesas,
          pctPending: data.pending / data.totalMesas
        });
      }
    }
    result.sort((a, b) => b.pending - a.pending);
    return result;
  }

  getStats() {
    if (!this.isBuilt) return { isBuilt: false };
    let totalMesas = 0, totalCounted = 0;
    for (const [, d] of this.districts) {
      totalMesas += d.totalMesas;
      totalCounted += d.counted;
    }
    return {
      isBuilt: true,
      districts: this.districts.size,
      departments: this.deptTotals.size,
      provinces: this.provTotals.size,
      totalMesas,
      totalCounted,
      pctCounted: totalMesas > 0 ? (totalCounted / totalMesas * 100).toFixed(1) : 0
    };
  }
}

module.exports = DistrictCensus;
