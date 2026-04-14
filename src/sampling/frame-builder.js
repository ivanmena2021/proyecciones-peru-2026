const fetcher = require('../api/fetcher');
const CONFIG = require('../config');

/**
 * Frame Builder: constructs the complete sampling frame of all mesas
 * indexed by department, district, and status.
 *
 * The frame is the universe from which we sample.
 */
class FrameBuilder {
  constructor() {
    // Master index: mesaCode -> { districtUbigeo, deptCode, status, electores, isUrban }
    this.mesas = new Map();
    // Department index: deptCode -> Set<mesaCode>
    this.byDepartment = new Map();
    // District index: districtUbigeo -> { mesas: Set<mesaCode>, counted, pending, total }
    this.byDistrict = new Map();
    // Department metadata: deptCode -> { name, ubigeo, electores, asistentes, actasCounted, actasTotal }
    this.departments = new Map();
    // Province list per department
    this.provinces = new Map();

    this.isBuilt = false;
    this.lastFullBuild = 0;
    this.lastHeatmapUpdate = null;
  }

  /**
   * Full frame build - called once at startup.
   * Scans all departments -> provinces -> districts -> mesa codes.
   */
  async buildFull() {
    console.log('[frame] Starting full frame build...');
    const startTime = Date.now();

    // Step 1: Get departments
    const depts = await fetcher.fetchDepartments();
    if (!depts) throw new Error('Failed to fetch departments');

    console.log(`[frame] Found ${depts.length} departments`);

    // Step 2: Get heatmap data (actas progress per dept)
    const [heatmap, participation] = await Promise.all([
      fetcher.fetchDepartmentHeatmap(),
      fetcher.fetchParticipationHeatmap()
    ]);

    // Build department metadata
    const participationByDept = new Map();
    if (participation) {
      for (const p of participation) {
        const code = String(p.ubigeoNivel01).padStart(6, '0').substring(0, 2);
        participationByDept.set(code, {
          asistentes: p.asistentes || 0,
          porcentajeAsistentes: p.porcentajeAsistentes || 0
        });
      }
    }

    const heatmapByDept = new Map();
    if (heatmap) {
      for (const h of heatmap) {
        const code = String(h.ubigeoNivel01).padStart(6, '0').substring(0, 2);
        heatmapByDept.set(code, {
          actasContabilizadas: h.actasContabilizadas || 0,
          porcentaje: h.porcentajeActasContabilizadas || 0
        });
      }
    }

    for (const dept of depts) {
      const ubigeo = dept.idUbigeo || dept.ubigeo;
      const code = String(ubigeo).padStart(6, '0').substring(0, 2);
      const hm = heatmapByDept.get(code) || {};
      const part = participationByDept.get(code) || {};

      this.departments.set(code, {
        name: dept.nombreUbigeo || dept.nombre || `Dept ${code}`,
        ubigeo: String(ubigeo).padStart(6, '0'),
        electores: part.asistentes || 0,
        actasCounted: hm.actasContabilizadas || 0,
        pctCounted: hm.porcentaje || 0
      });
      this.byDepartment.set(code, new Set());
    }

    this.lastHeatmapUpdate = { heatmap, participation };

    // Step 3: For each department, get provinces, then districts
    const deptList = Array.from(this.departments.entries());
    console.log(`[frame] Scanning provinces for ${deptList.length} departments...`);

    const allDistricts = [];

    for (const [deptCode, deptMeta] of deptList) {
      const provinces = await fetcher.fetchProvinces(deptMeta.ubigeo);
      if (!provinces) continue;

      this.provinces.set(deptCode, provinces);

      for (const prov of provinces) {
        const provUbigeo = prov.idUbigeo || prov.ubigeo;
        const districts = await fetcher.fetchDistricts(deptMeta.ubigeo, String(provUbigeo).padStart(6, '0'));
        if (!districts) continue;

        for (const dist of districts) {
          const distUbigeo = String(dist.idUbigeo || dist.ubigeo).padStart(6, '0');
          allDistricts.push({ distUbigeo, deptCode });
        }
      }
    }

    console.log(`[frame] Found ${allDistricts.length} districts. Scanning actas...`);

    // Step 4: For each district, get acta counts and mesa codes
    // Use page size of 1000 to minimize API calls
    let totalMesas = 0;
    let scannedDistricts = 0;
    const PAGE_SIZE = 1000;

    // Process in batches to manage rate limiting
    const BATCH_SIZE = 40;
    for (let i = 0; i < allDistricts.length; i += BATCH_SIZE) {
      const batch = allDistricts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(({ distUbigeo }) =>
          fetcher.fetchDistrictActas(distUbigeo, 0, PAGE_SIZE)
        )
      );

      for (let j = 0; j < batch.length; j++) {
        const { distUbigeo, deptCode } = batch[j];
        const data = results[j];
        if (!data) continue;

        const counted = data.contabilizada || 0;
        const pending = data.pendiente || 0;
        const observed = data.observada || 0;

        this.byDistrict.set(distUbigeo, {
          mesas: new Set(),
          counted,
          pending,
          observed,
          total: counted + pending + observed
        });

        // Process all pages
        const processActas = (content) => {
          if (!content || !Array.isArray(content)) return;
          for (const acta of content) {
            const mesaCode = acta.codigoMesa;
            if (!mesaCode) continue;

            const code = String(mesaCode).padStart(6, '0');
            const status = acta.descripcionEstadoActa?.toLowerCase().includes('contabiliz')
              ? 'counted' : 'pending';

            this.mesas.set(code, {
              districtUbigeo: distUbigeo,
              deptCode: deptCode,
              status: status,
              electores: 0, // Will be populated when mesa is sampled
              isUrban: true  // Default, updated when sampled
            });

            this.byDepartment.get(deptCode)?.add(code);
            this.byDistrict.get(distUbigeo)?.mesas.add(code);
            totalMesas++;
          }
        };

        processActas(data.content);

        // Fetch remaining pages
        const totalPages = data.totalPaginas || 1;
        if (totalPages > 1) {
          const pagePromises = [];
          for (let page = 1; page < totalPages; page++) {
            pagePromises.push(fetcher.fetchDistrictActas(distUbigeo, page, PAGE_SIZE));
          }
          const pages = await Promise.all(pagePromises);
          for (const pageData of pages) {
            processActas(pageData?.content);
          }
        }

        scannedDistricts++;
      }

      if (i % 100 === 0 && i > 0) {
        console.log(`[frame] Scanned ${scannedDistricts}/${allDistricts.length} districts, ${totalMesas} mesas found`);
      }
    }

    this.isBuilt = true;
    this.lastFullBuild = Date.now();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[frame] Build complete in ${elapsed}s: ${this.mesas.size} mesas, ${allDistricts.length} districts, ${this.departments.size} departments`);

    return this.getStats();
  }

  /**
   * Incremental refresh: only update departments that show changes in heatmap.
   */
  async refreshIncremental() {
    const heatmap = await fetcher.fetchDepartmentHeatmap();
    const participation = await fetcher.fetchParticipationHeatmap();
    if (!heatmap) return;

    const changedDepts = new Set();

    for (const h of heatmap) {
      const code = String(h.ubigeoNivel01).padStart(6, '0').substring(0, 2);
      const dept = this.departments.get(code);
      if (!dept) continue;

      const newCounted = h.actasContabilizadas || 0;
      if (newCounted !== dept.actasCounted) {
        changedDepts.add(code);
        dept.actasCounted = newCounted;
        dept.pctCounted = h.porcentajeActasContabilizadas || 0;
      }
    }

    if (participation) {
      for (const p of participation) {
        const code = String(p.ubigeoNivel01).padStart(6, '0').substring(0, 2);
        const dept = this.departments.get(code);
        if (dept) {
          dept.electores = p.asistentes || dept.electores;
        }
      }
    }

    // For changed departments, rescan their districts to detect newly counted mesas
    if (changedDepts.size > 0) {
      console.log(`[frame] Incremental refresh: ${changedDepts.size} departments changed`);
      // We update mesa statuses but don't do a full rescan (too expensive per cycle)
      // The sample manager handles discovering new mesas through sampling
    }

    this.lastHeatmapUpdate = { heatmap, participation };
    return changedDepts;
  }

  /**
   * Get counted mesa codes for a department.
   */
  getCountedMesas(deptCode) {
    const mesaCodes = this.byDepartment.get(deptCode);
    if (!mesaCodes) return [];
    return Array.from(mesaCodes).filter(code => {
      const m = this.mesas.get(code);
      return m && m.status === 'counted';
    });
  }

  /**
   * Get all mesa codes for a department.
   */
  getAllMesas(deptCode) {
    const mesaCodes = this.byDepartment.get(deptCode);
    return mesaCodes ? Array.from(mesaCodes) : [];
  }

  /**
   * Classify mesas in a department as urban/rural.
   */
  getUrbanRuralSplit(deptCode) {
    const mesaCodes = this.byDepartment.get(deptCode);
    if (!mesaCodes) return { urban: [], rural: [] };

    const urban = [];
    const rural = [];
    for (const code of mesaCodes) {
      const m = this.mesas.get(code);
      if (!m) continue;
      (m.isUrban ? urban : rural).push(code);
    }
    return { urban, rural };
  }

  getStats() {
    let totalCounted = 0;
    let totalPending = 0;
    for (const [, m] of this.mesas) {
      if (m.status === 'counted') totalCounted++;
      else totalPending++;
    }
    return {
      totalMesas: this.mesas.size,
      counted: totalCounted,
      pending: totalPending,
      departments: this.departments.size,
      districts: this.byDistrict.size,
      isBuilt: this.isBuilt
    };
  }
}

module.exports = FrameBuilder;
