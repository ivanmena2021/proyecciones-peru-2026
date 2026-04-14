/**
 * Peru department map using real GeoJSON data.
 * Fetches simplified boundaries from GitHub and renders as SVG.
 */

const GEOJSON_URL = 'https://raw.githubusercontent.com/juaneladio/peru-geojson/master/peru_departamental_simple.geojson';

// Department code mapping: name → 2-digit code
const DEPT_NAME_TO_CODE = {
  'AMAZONAS': '01', 'ANCASH': '02', 'APURIMAC': '03', 'AREQUIPA': '04',
  'AYACUCHO': '05', 'CAJAMARCA': '06', 'CALLAO': '07', 'CUSCO': '08',
  'HUANCAVELICA': '09', 'HUANUCO': '10', 'ICA': '11', 'JUNIN': '12',
  'LA LIBERTAD': '13', 'LAMBAYEQUE': '14', 'LIMA': '15', 'LORETO': '16',
  'MADRE DE DIOS': '17', 'MOQUEGUA': '18', 'PASCO': '19', 'PIURA': '20',
  'PUNO': '21', 'SAN MARTIN': '22', 'TACNA': '23', 'TUMBES': '24', 'UCAYALI': '25'
};

let geoData = null;
let mapInitialized = false;

async function renderMap(data) {
  const container = document.getElementById('peru-map');
  if (!container) return;

  if (!mapInitialized) {
    await buildMap(container);
    mapInitialized = true;
  }

  if (data?.departments) {
    colorDepartments(data.departments, data.candidates);
  }
}

async function buildMap(container) {
  // Try to fetch real GeoJSON
  try {
    const res = await fetch(GEOJSON_URL);
    if (res.ok) {
      geoData = await res.json();
      renderGeoJSON(container, geoData);
      return;
    }
  } catch (e) {
    console.log('[map] GeoJSON fetch failed, using fallback');
  }

  // Fallback: simple placeholder
  container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 2rem;">Mapa cargando...</p>';
}

function renderGeoJSON(container, geojson) {
  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const feature of geojson.features) {
    forEachCoord(feature.geometry, (lon, lat) => {
      if (lon < minX) minX = lon;
      if (lon > maxX) maxX = lon;
      if (lat < minY) minY = lat;
      if (lat > maxY) maxY = lat;
    });
  }

  const width = 400;
  const height = 500;
  const padX = 10, padY = 10;

  // Projection: simple Mercator-like (lon/lat → x/y)
  const scaleX = (width - 2 * padX) / (maxX - minX);
  const scaleY = (height - 2 * padY) / (maxY - minY);
  const scale = Math.min(scaleX, scaleY);

  const projectX = lon => padX + (lon - minX) * scale;
  const projectY = lat => height - padY - (lat - minY) * scale; // flip Y

  // Build SVG
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = '100%';
  svg.style.maxHeight = '400px';

  for (const feature of geojson.features) {
    const name = (feature.properties.NOMBDEP || feature.properties.name || '').toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove accents for matching
    const code = DEPT_NAME_TO_CODE[name] || findCodeByName(name);

    const paths = geometryToSVGPaths(feature.geometry, projectX, projectY);

    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('data-dept', code || '00');
      path.setAttribute('data-name', feature.properties.NOMBDEP || name);
      path.setAttribute('fill', '#374151');
      path.setAttribute('stroke', '#111827');
      path.setAttribute('stroke-width', '0.5');
      path.setAttribute('opacity', '0.6');
      path.style.transition = 'fill 0.5s, opacity 0.5s';
      path.style.cursor = 'pointer';

      path.addEventListener('mouseenter', (e) => showTooltip(e, code, name));
      path.addEventListener('mouseleave', hideTooltip);

      svg.appendChild(path);
    }
  }

  // Add tooltip div
  container.innerHTML = '';
  container.style.position = 'relative';
  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.id = 'map-tooltip';
  tooltip.className = 'map-tooltip';
  tooltip.style.display = 'none';
  container.appendChild(tooltip);
}

function geometryToSVGPaths(geometry, px, py) {
  const paths = [];

  if (geometry.type === 'Polygon') {
    paths.push(ringToPath(geometry.coordinates[0], px, py));
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      paths.push(ringToPath(polygon[0], px, py));
    }
  }

  return paths;
}

function ringToPath(ring, px, py) {
  if (!ring || ring.length === 0) return '';
  let d = `M${px(ring[0][0]).toFixed(1)},${py(ring[0][1]).toFixed(1)}`;
  for (let i = 1; i < ring.length; i++) {
    d += `L${px(ring[i][0]).toFixed(1)},${py(ring[i][1]).toFixed(1)}`;
  }
  d += 'Z';
  return d;
}

function forEachCoord(geometry, fn) {
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) {
      for (const [lon, lat] of ring) fn(lon, lat);
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        for (const [lon, lat] of ring) fn(lon, lat);
      }
    }
  }
}

function findCodeByName(name) {
  // Fuzzy match for names with accent variations
  for (const [key, code] of Object.entries(DEPT_NAME_TO_CODE)) {
    const normalized = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normalized === name || name.includes(normalized) || normalized.includes(name)) {
      return code;
    }
  }
  return '00';
}

function colorDepartments(departments, candidates) {
  for (const dept of departments) {
    const paths = document.querySelectorAll(`path[data-dept="${dept.code}"]`);
    if (paths.length === 0) continue;

    const color = dept.leadingPartyColor || '#374151';
    const opacity = 0.3 + 0.7 * ((dept.pctCounted || 0) / 100);

    for (const path of paths) {
      path.setAttribute('fill', color);
      path.setAttribute('opacity', Math.max(0.35, opacity).toFixed(2));
    }
  }
}

function showTooltip(event, deptCode, deptName) {
  const tooltip = document.getElementById('map-tooltip');
  if (!tooltip || !state.data?.departments) return;

  const dept = state.data.departments.find(d => d.code === deptCode);
  const displayName = dept?.name || deptName || deptCode;

  if (dept) {
    const leader = state.data.candidates?.find(c => c.code === dept.leadingPartyCode);
    tooltip.innerHTML = `
      <strong>${displayName}</strong><br>
      Avance: ${formatPct(dept.pctCounted, 1)}<br>
      ${leader ? `L\u00edder: <span style="color:${leader.color}">${leader.partyShort}</span> ${dept.leadingPartyPct ? formatPct(dept.leadingPartyPct, 1) : ''}` : 'Sin datos'}
    `;
  } else {
    tooltip.innerHTML = `<strong>${displayName}</strong><br>Sin datos`;
  }

  tooltip.style.display = 'block';
  const rect = event.target.closest('.map-container').getBoundingClientRect();
  tooltip.style.left = (event.clientX - rect.left + 10) + 'px';
  tooltip.style.top = (event.clientY - rect.top - 10) + 'px';
}

function hideTooltip() {
  const tooltip = document.getElementById('map-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}
