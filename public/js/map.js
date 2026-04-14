/**
 * Peru department map (simplified SVG).
 * Colors departments by leading candidate and counting progress.
 */

// Simplified SVG paths for Peru's 25 departments
// Each path is a rough polygon approximation for display purposes
const DEPT_PATHS = {
  '01': { name: 'Amazonas',       d: 'M250,95 L270,80 L295,90 L290,120 L265,130 L245,115Z' },
  '02': { name: 'Ancash',         d: 'M170,170 L205,160 L215,185 L200,210 L175,215 L160,195Z' },
  '03': { name: 'Apurimac',       d: 'M210,310 L240,300 L255,320 L245,345 L220,340Z' },
  '04': { name: 'Arequipa',       d: 'M195,380 L250,365 L275,395 L260,435 L210,440 L185,415Z' },
  '05': { name: 'Ayacucho',       d: 'M220,310 L255,295 L270,320 L260,360 L230,365 L215,340Z' },
  '06': { name: 'Cajamarca',      d: 'M200,105 L240,95 L255,120 L240,150 L210,155 L195,135Z' },
  '07': { name: 'Callao',         d: 'M148,248 L158,245 L160,255 L150,258Z' },
  '08': { name: 'Cusco',          d: 'M260,320 L310,300 L340,330 L325,375 L280,380 L255,355Z' },
  '09': { name: 'Huancavelica',   d: 'M200,280 L230,270 L240,295 L225,320 L200,315Z' },
  '10': { name: 'Huanuco',        d: 'M215,175 L250,165 L265,190 L255,220 L225,225 L210,200Z' },
  '11': { name: 'Ica',            d: 'M180,320 L205,310 L215,345 L200,380 L175,370Z' },
  '12': { name: 'Junin',          d: 'M215,230 L255,220 L270,250 L255,280 L220,285 L205,260Z' },
  '13': { name: 'La Libertad',    d: 'M160,140 L210,130 L220,160 L200,180 L165,175Z' },
  '14': { name: 'Lambayeque',     d: 'M165,120 L200,110 L210,130 L195,145 L170,140Z' },
  '15': { name: 'Lima',           d: 'M155,220 L200,210 L215,250 L200,290 L170,295 L150,265Z' },
  '16': { name: 'Loreto',         d: 'M270,30 L360,20 L380,80 L350,140 L300,150 L270,120 L260,70Z' },
  '17': { name: 'Madre de Dios',  d: 'M330,280 L390,270 L400,310 L370,340 L335,330Z' },
  '18': { name: 'Moquegua',       d: 'M230,430 L265,420 L275,445 L255,460 L235,450Z' },
  '19': { name: 'Pasco',          d: 'M210,195 L240,185 L250,210 L240,230 L215,225Z' },
  '20': { name: 'Piura',          d: 'M130,65 L185,55 L200,85 L180,110 L140,105 L125,85Z' },
  '21': { name: 'Puno',           d: 'M275,380 L330,365 L355,400 L340,445 L295,455 L270,425Z' },
  '22': { name: 'San Martin',     d: 'M245,120 L285,110 L300,145 L285,175 L255,180 L240,155Z' },
  '23': { name: 'Tacna',          d: 'M255,455 L285,445 L295,470 L275,485 L255,475Z' },
  '24': { name: 'Tumbes',         d: 'M115,45 L145,40 L150,60 L130,65 L115,55Z' },
  '25': { name: 'Ucayali',        d: 'M285,175 L340,160 L365,210 L350,270 L310,280 L280,250 L275,210Z' }
};

let mapInitialized = false;

function renderMap(data) {
  const container = document.getElementById('peru-map');
  if (!container) return;

  if (!mapInitialized) {
    buildMapSVG(container);
    mapInitialized = true;
  }

  // Color departments based on data
  if (data?.departments) {
    colorDepartments(data.departments);
  }
}

function buildMapSVG(container) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '100 10 320 490');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Background
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', 'transparent');
  svg.appendChild(bg);

  // Department paths
  for (const [code, dept] of Object.entries(DEPT_PATHS)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', dept.d);
    path.setAttribute('data-dept', code);
    path.setAttribute('fill', '#374151');
    path.setAttribute('stroke', '#111827');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('opacity', '0.5');
    path.style.transition = 'fill 0.5s, opacity 0.5s';
    path.style.cursor = 'pointer';

    // Tooltip on hover
    path.addEventListener('mouseenter', (e) => showTooltip(e, code));
    path.addEventListener('mouseleave', hideTooltip);

    svg.appendChild(path);

    // Department label
    const centroid = getCentroid(dept.d);
    if (centroid && code !== '07') { // Skip Callao (too small)
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', centroid.x);
      text.setAttribute('y', centroid.y);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('font-size', '7');
      text.setAttribute('font-weight', '600');
      text.setAttribute('fill', '#e8e8f0');
      text.setAttribute('pointer-events', 'none');
      text.setAttribute('opacity', '0.7');
      text.textContent = getShortDeptName(dept.name);
      svg.appendChild(text);
    }
  }

  // Tooltip element
  const tooltip = document.createElement('div');
  tooltip.id = 'map-tooltip';
  tooltip.className = 'map-tooltip';
  tooltip.style.display = 'none';
  container.style.position = 'relative';
  container.appendChild(tooltip);

  container.innerHTML = '';
  container.appendChild(svg);
  container.appendChild(tooltip);
}

function colorDepartments(departments) {
  for (const dept of departments) {
    const code = dept.code;
    const path = document.querySelector(`path[data-dept="${code}"]`);
    if (!path) continue;

    const color = dept.leadingPartyColor || '#374151';
    const opacity = 0.3 + 0.7 * (dept.pctCounted / 100);

    path.setAttribute('fill', color);
    path.setAttribute('opacity', Math.max(0.3, opacity).toFixed(2));
  }
}

function showTooltip(event, deptCode) {
  const tooltip = document.getElementById('map-tooltip');
  if (!tooltip || !state.data?.departments) return;

  const dept = state.data.departments.find(d => d.code === deptCode);
  const deptName = DEPT_PATHS[deptCode]?.name || deptCode;

  if (dept) {
    const leader = state.data.candidates?.find(c => c.code === dept.leadingPartyCode);
    tooltip.innerHTML = `
      <strong>${deptName}</strong><br>
      Avance: ${formatPct(dept.pctCounted, 1)}<br>
      ${leader ? `Lider: <span style="color:${leader.color}">${leader.partyShort}</span> ${dept.leadingPartyPct ? formatPct(dept.leadingPartyPct, 1) : ''}` : 'Sin datos'}
    `;
  } else {
    tooltip.innerHTML = `<strong>${deptName}</strong><br>Sin datos`;
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

function getCentroid(pathD) {
  const coords = pathD.match(/\d+\.?\d*/g);
  if (!coords || coords.length < 4) return null;

  let sumX = 0, sumY = 0, count = 0;
  for (let i = 0; i < coords.length - 1; i += 2) {
    sumX += parseFloat(coords[i]);
    sumY += parseFloat(coords[i + 1]);
    count++;
  }
  return { x: sumX / count, y: sumY / count };
}

function getShortDeptName(name) {
  const shorts = {
    'Amazonas': 'AMA', 'Ancash': 'ANC', 'Apurimac': 'APU', 'Arequipa': 'AQP',
    'Ayacucho': 'AYA', 'Cajamarca': 'CAJ', 'Callao': 'CAL', 'Cusco': 'CUS',
    'Huancavelica': 'HCV', 'Huanuco': 'HCO', 'Ica': 'ICA', 'Junin': 'JUN',
    'La Libertad': 'LAL', 'Lambayeque': 'LAM', 'Lima': 'LIM', 'Loreto': 'LOR',
    'Madre de Dios': 'MDD', 'Moquegua': 'MOQ', 'Pasco': 'PAS', 'Piura': 'PIU',
    'Puno': 'PUN', 'San Martin': 'SMA', 'Tacna': 'TAC', 'Tumbes': 'TUM', 'Ucayali': 'UCA'
  };
  return shorts[name] || name.substring(0, 3).toUpperCase();
}
