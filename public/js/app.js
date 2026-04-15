/**
 * Main application: data fetching, SSE, state management, DOM rendering.
 */

const state = {
  data: null,
  history: [],
  connectionStatus: 'connecting', // 'sse' | 'polling' | 'connecting' | 'error'
  lastUpdate: null
};

let eventSource = null;
let pollInterval = null;
let chartsInitialized = false;

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  connectSSE();
  fetchInitialData();
});

async function fetchInitialData() {
  try {
    const [latestRes, historyRes] = await Promise.all([
      fetch('/api/latest'),
      fetch('/api/history')
    ]);
    if (latestRes.ok) {
      state.data = await latestRes.json();
      render();
    }
    if (historyRes.ok) {
      state.history = await historyRes.json();
      if (chartsInitialized) updateCharts();
    }
  } catch (err) {
    console.error('Failed to fetch initial data:', err);
  }
}

// --- SSE Connection ---

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/sse');
  state.connectionStatus = 'connecting';
  updateConnectionBadge();

  eventSource.onopen = () => {
    state.connectionStatus = 'sse';
    updateConnectionBadge();
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      state.data = data;
      state.lastUpdate = Date.now();

      // Add to local history
      if (data.candidates && data.candidates.length > 0) {
        state.history.push({
          timestamp: data.timestamp,
          pctCounted: data.pctCounted,
          candidates: data.candidates.slice(0, 10).map(c => ({
            code: c.code,
            party: c.partyShort,
            pct: c.pct,
            projectedPct: c.projectedPct,
            marginLow: c.marginLow,
            marginHigh: c.marginHigh
          }))
        });
        // Keep last 200
        if (state.history.length > 200) {
          state.history = state.history.slice(-200);
        }
      }

      render();
    } catch (err) {
      console.error('Error parsing SSE data:', err);
    }
  };

  eventSource.onerror = () => {
    state.connectionStatus = 'polling';
    updateConnectionBadge();
    eventSource.close();
    startPolling();
    // Reconnect SSE after backoff
    setTimeout(connectSSE, 10000);
  };
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/latest');
      if (res.ok) {
        state.data = await res.json();
        state.lastUpdate = Date.now();
        render();
      }
    } catch {}
  }, 30000);
}

// --- Rendering ---

function render() {
  const d = state.data;
  if (!d) return;

  renderProgressBar(d);
  renderGrade(d);
  renderBattleForSecond(d);
  renderTopCandidates(d);
  renderFullTable(d);
  renderDepartmentTable(d);
  renderDiagnostics(d);
  renderFooter(d);

  if (typeof initCharts === 'function' && !chartsInitialized) {
    initCharts();
    chartsInitialized = true;
  }
  if (chartsInitialized && typeof updateCharts === 'function') {
    updateCharts();
  }
  if (typeof renderMap === 'function') {
    renderMap(d);
  }
}

function renderProgressBar(d) {
  const pct = d.pctCounted || 0;
  const bar = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  const detail = document.getElementById('progress-detail');
  const time = document.getElementById('update-time');

  if (bar) bar.style.width = pct + '%';
  if (label) label.textContent = formatPct(pct, 1);
  if (detail && d.totals) {
    detail.textContent = `${formatNumber(d.totals.actasCounted)} de ${formatNumber(d.totals.actasTotal)} actas`;
  }
  if (time) time.textContent = formatTime(d.timestamp);
}

function renderGrade(d) {
  const badge = document.getElementById('grade-badge');
  const label = document.getElementById('grade-label');
  const note = document.getElementById('projection-note');
  const detail = document.getElementById('projection-detail');

  if (badge) {
    badge.textContent = d.grade || '?';
    badge.style.backgroundColor = getGradeColor(d.grade);
  }
  if (label) label.textContent = getGradeLabel(d.grade);

  // Simplified user-friendly message
  if (note) {
    const n = d.sampleSize || 0;
    const pct = d.pctCounted || 0;
    if (n === 0) {
      note.textContent = 'Conectando con ONPE... Espera un momento.';
    } else if (n < 300) {
      note.textContent = `Incrementando muestra para ajustar la proyecci\u00f3n... (${n.toLocaleString('es-PE')} mesas analizadas de ${d.districtsCovered || 0} distritos)`;
    } else {
      note.textContent = `Proyecci\u00f3n basada en ${n.toLocaleString('es-PE')} mesas de ${d.districtsCovered || 0} distritos. La muestra se actualiza cada 45 segundos.`;
    }
  }

  // Technical detail goes to footer
  if (detail && d.projectionNote) {
    // Move the full technical description to a hidden detail element
    const sampleInfo = document.getElementById('sample-info');
    if (sampleInfo) sampleInfo.textContent = d.projectionNote;
  }
}

/**
 * "Pelea por el 2do lugar": muestra candidatos con P(terminar 2°) >= 10%.
 * Si el líder tiene P(1°) < 85% y hay pelea también por #1, incluye al líder también.
 */
function renderBattleForSecond(d) {
  const section = document.getElementById('battle-section');
  const container = document.getElementById('battle-contenders');
  const subtitle = document.getElementById('battle-subtitle');
  if (!section || !container || !d.candidates) return;

  const cands = d.candidates.filter(c => c.rankProbs && c.rankProbs.length >= 2);
  if (cands.length === 0) { section.style.display = 'none'; return; }

  // Candidatos "en pelea por el 2°": P(2°) >= 10%
  const THRESHOLD = 0.10;
  const inBattle = cands.filter(c => (c.rankProbs[1] || 0) >= THRESHOLD);

  if (inBattle.length < 2) {
    section.style.display = 'none';
    return;
  }

  // Ordenar por P(2°) descendente (quien tiene más chance de quedar 2° aparece primero)
  inBattle.sort((a, b) => (b.rankProbs[1] || 0) - (a.rankProbs[1] || 0));

  // Para calcular votos estimados entre ellos, usar totales ONPE proyectados
  const totalValidEstimate = (d.totals && d.pctCounted > 5)
    ? d.totals.totalVotesValid / (d.pctCounted / 100)
    : null;

  // Proyectado máximo entre los contendientes (para normalizar barras)
  const maxProj = Math.max(...inBattle.map(c => c.projectedPct));

  section.style.display = '';
  subtitle.textContent = `${inBattle.length} candidatos se disputan el pase a segunda vuelta`;

  container.innerHTML = inBattle.map(c => {
    const p2 = (c.rankProbs[1] || 0) * 100;
    const p1 = (c.rankProbs[0] || 0) * 100;
    const p3plus = (100 - p1 - p2);
    const barWidth = (c.projectedPct / maxProj) * 100;

    const intensity = p2 >= 40 ? 'battle-card-hot' : p2 >= 25 ? 'battle-card-warm' : 'battle-card-cool';
    const projectedVotes = totalValidEstimate
      ? Math.round(totalValidEstimate * (c.projectedPct / 100))
      : null;

    return `
    <div class="battle-card ${intensity}" style="--accent: ${c.color}">
      <div class="battle-card-top">
        <div class="battle-party-badge" style="background: ${c.color}">${c.partyShort}</div>
        <div class="battle-candidate-info">
          <div class="battle-candidate-name">${shortName(c.name)}</div>
          <div class="battle-candidate-party">${c.party}</div>
        </div>
        <div class="battle-prob-big">
          <div class="battle-prob-value">${p2.toFixed(0)}<span class="battle-prob-pct">%</span></div>
          <div class="battle-prob-label">prob. 2&deg; lugar</div>
        </div>
      </div>

      <div class="battle-bar-wrap">
        <div class="battle-bar">
          <div class="battle-bar-fill" style="width: ${barWidth.toFixed(1)}%; background: ${c.color}"></div>
        </div>
        <div class="battle-bar-labels">
          <span class="battle-proj">${formatPct(c.projectedPct, 2)} proyectado</span>
          <span class="battle-ci">IC 95%: ${formatPct(c.marginLow, 2)} &mdash; ${formatPct(c.marginHigh, 2)}</span>
        </div>
      </div>

      <div class="battle-dist">
        <div class="battle-dist-item">
          <span class="battle-dist-label">P(1&deg;)</span>
          <span class="battle-dist-value">${p1.toFixed(1)}%</span>
        </div>
        <div class="battle-dist-item battle-dist-highlight">
          <span class="battle-dist-label">P(2&deg;)</span>
          <span class="battle-dist-value">${p2.toFixed(1)}%</span>
        </div>
        <div class="battle-dist-item">
          <span class="battle-dist-label">P(3&deg; o menos)</span>
          <span class="battle-dist-value">${Math.max(0, p3plus).toFixed(1)}%</span>
        </div>
        ${projectedVotes !== null ? `
        <div class="battle-dist-item">
          <span class="battle-dist-label">Votos proyectados</span>
          <span class="battle-dist-value">${formatNumber(projectedVotes)}</span>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderTopCandidates(d) {
  const container = document.getElementById('top-candidates');
  if (!container || !d.candidates) return;

  const top = d.candidates.slice(0, 8);

  // Compute trend from history (last 5 points)
  const trends = computeTrends(top);

  container.innerHTML = top.map((c, i) => {
    const trend = trends[c.code] || { arrow: '', delta: 0, label: '' };
    const diff = c.projectedPct - c.pct;
    const diffSign = diff >= 0 ? '+' : '';
    const diffClass = diff > 0.2 ? 'trend-up' : diff < -0.2 ? 'trend-down' : 'trend-stable';

    // Votes needed to catch the candidate above
    const votesGap = i > 0 ? computeVotesGap(top[i - 1], c, d) : null;

    return `
    <div class="candidate-card" style="--accent: ${c.color}">
      <div class="candidate-rank">#${i + 1}</div>
      <div class="candidate-party-badge" style="background: ${c.color}">${c.partyShort}</div>
      <div class="candidate-name">${shortName(c.name)}</div>
      <div class="candidate-party-full">${c.party}</div>
      <div class="candidate-stats">
        <div class="stat-row">
          <span class="stat-label">Actual ONPE</span>
          <span class="stat-value">${formatPct(c.pct)}</span>
        </div>
        <div class="stat-row projected">
          <span class="stat-label">Proyectado</span>
          <span class="stat-value stat-projected">${formatPct(c.projectedPct)}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">Tendencia</span>
          <span class="stat-value ${diffClass}">${trend.arrow} ${diffSign}${diff.toFixed(2)}pp</span>
        </div>
        <div class="stat-row ci">
          <span class="stat-label">IC 95%</span>
          <span class="stat-value stat-ci">${formatPct(c.marginLow, 1)} &mdash; ${formatPct(c.marginHigh, 1)}</span>
        </div>
      </div>
      ${votesGap !== null ? `
      <div class="votes-gap">
        Le faltan <strong>${formatNumber(votesGap)}</strong> votos para alcanzar a #${i}
      </div>` : `
      <div class="votes-gap votes-leader">L&iacute;der de la proyecci&oacute;n</div>`}
      <div class="candidate-votes">${formatNumber(c.votes)} votos contados</div>
    </div>`;
  }).join('');
}

/**
 * Compute trend arrows from history data.
 * Compares current projection vs average of last 5 history points.
 */
function computeTrends(candidates) {
  const trends = {};
  if (!state.history || state.history.length < 3) {
    for (const c of candidates) {
      trends[c.code] = { arrow: '&bull;', delta: 0 };
    }
    return trends;
  }

  // Get last 5 history points
  const recent = state.history.slice(-5);

  for (const c of candidates) {
    const pastValues = recent
      .map(p => p.candidates?.find(x => x.code === c.code)?.projectedPct)
      .filter(v => v != null);

    if (pastValues.length < 2) {
      trends[c.code] = { arrow: '&bull;', delta: 0 };
      continue;
    }

    const avgPast = pastValues.reduce((a, b) => a + b, 0) / pastValues.length;
    const delta = c.projectedPct - avgPast;

    let arrow;
    if (delta > 0.3) arrow = '&#9650;&#9650;'; // ▲▲ strong up
    else if (delta > 0.1) arrow = '&#9650;';     // ▲ up
    else if (delta < -0.3) arrow = '&#9660;&#9660;'; // ▼▼ strong down
    else if (delta < -0.1) arrow = '&#9660;';    // ▼ down
    else arrow = '&#9654;';                       // ▶ stable

    trends[c.code] = { arrow, delta };
  }

  return trends;
}

/**
 * Compute how many projected votes a candidate needs to catch the one above.
 * Uses projected percentages and estimated total valid votes.
 */
function computeVotesGap(above, current, d) {
  if (!d.totals) return null;
  // Estimate total valid votes when 100% counted
  const totalValidEstimate = d.totals.totalVotesValid / (d.pctCounted / 100);
  const aboveVotes = totalValidEstimate * (above.projectedPct / 100);
  const currentVotes = totalValidEstimate * (current.projectedPct / 100);
  const gap = Math.max(0, Math.round(aboveVotes - currentVotes));
  return gap;
}

function renderFullTable(d) {
  const tbody = document.getElementById('results-tbody');
  if (!tbody || !d.candidates) return;

  tbody.innerHTML = d.candidates.map((c, i) => `
    <tr>
      <td class="col-rank">${i + 1}</td>
      <td class="col-party">
        <span class="party-dot" style="background: ${c.color}"></span>
        ${c.partyShort}
      </td>
      <td class="col-name">${shortName(c.name)}</td>
      <td class="col-votes">${formatNumber(c.votes)}</td>
      <td class="col-pct">${formatPct(c.pct)}</td>
      <td class="col-projected">${formatPct(c.projectedPct)}</td>
      <td class="col-ci">${formatPct(c.marginLow, 1)} — ${formatPct(c.marginHigh, 1)}</td>
    </tr>
  `).join('');
}

function renderDepartmentTable(d) {
  const tbody = document.getElementById('dept-tbody');
  if (!tbody || !d.departments) return;

  const sorted = [...d.departments].sort((a, b) => b.electores - a.electores);

  tbody.innerHTML = sorted.map(dept => {
    const leaderColor = dept.leadingPartyColor || '#6B7280';
    const partyConfig = Object.values(state.data?.candidates || [])
      .find(c => c.code === dept.leadingPartyCode);
    const leaderName = partyConfig?.partyShort || dept.leadingPartyCode || '—';

    return `
      <tr>
        <td>${dept.name}</td>
        <td>
          <div class="mini-progress">
            <div class="mini-progress-fill" style="width: ${dept.pctCounted}%; background: ${leaderColor}"></div>
          </div>
          <span class="mini-pct">${formatPct(dept.pctCounted, 1)}</span>
        </td>
        <td>
          <span class="party-dot" style="background: ${leaderColor}"></span>
          ${leaderName}
          ${dept.leadingPartyPct ? `(${formatPct(dept.leadingPartyPct, 1)})` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function renderDiagnostics(d) {
  const container = document.getElementById('diagnostics');
  if (!container) return;

  const diag = d.diagnostics;
  if (!diag) {
    container.innerHTML = '';
    return;
  }

  let html = '';

  // Winner call
  if (diag.winnerCall) {
    const wc = diag.winnerCall;
    html += `<div class="diag-item ${wc.canCall ? 'diag-success' : 'diag-neutral'}">
      ${wc.canCall ? '&#10004;' : '&#9679;'} ${wc.message}
    </div>`;
  }

  // Backtest
  if (diag.backtest && diag.backtest.converging !== null) {
    html += `<div class="diag-item ${diag.backtest.converging ? 'diag-success' : 'diag-warning'}">
      ${diag.backtest.converging ? '&#10004;' : '&#9888;'} ${diag.backtest.message}
    </div>`;
  }

  // Anomalies
  if (diag.anomalies && diag.anomalies.length > 0) {
    for (const a of diag.anomalies.slice(0, 3)) {
      html += `<div class="diag-item diag-${a.severity === 'high' ? 'error' : 'warning'}">
        &#9888; ${a.message}
      </div>`;
    }
  }

  // Sample info
  html += `<div class="diag-item diag-neutral">
    &#128202; Muestra: ${formatNumber(d.sampleSize)} mesas | Modo: ${d.projectionMode}
  </div>`;

  container.innerHTML = html;
}

function renderFooter(d) {
  const sampleInfo = document.getElementById('sample-info');
  if (sampleInfo) {
    sampleInfo.textContent = `${formatNumber(d.sampleSize)} mesas muestreadas`;
  }
}

function updateConnectionBadge() {
  const badge = document.getElementById('connection-badge');
  if (!badge) return;

  const labels = {
    sse: 'En vivo',
    polling: 'Polling',
    connecting: 'Conectando...',
    error: 'Desconectado'
  };
  const colors = {
    sse: '#10B981',
    polling: '#F59E0B',
    connecting: '#6B7280',
    error: '#EF4444'
  };

  badge.textContent = labels[state.connectionStatus] || 'Desconocido';
  badge.style.backgroundColor = colors[state.connectionStatus] || '#6B7280';
}
