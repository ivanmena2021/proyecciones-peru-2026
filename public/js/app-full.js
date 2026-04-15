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

  renderStaleBanner(d);
  renderProgressBar(d);
  renderGrade(d);
  renderSwap(d);
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

function renderStaleBanner(d) {
  let banner = document.getElementById('stale-banner');
  if (!d.onpeStale) {
    if (banner) banner.style.display = 'none';
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'stale-banner';
    banner.className = 'stale-banner';
    const main = document.querySelector('main.main');
    if (main) main.insertBefore(banner, main.firstChild);
  }
  const secs = d.onpeStaleSeconds || 0;
  const mins = Math.floor(secs / 60);
  const ago = mins >= 1 ? `${mins} min` : `${secs} s`;
  banner.innerHTML = `
    <span class="stale-icon">&#9888;</span>
    <div class="stale-text">
      <strong>Feed de ONPE interrumpido</strong>
      <span>Mostrando &uacute;ltima data v&aacute;lida (hace ${ago}) + proyecci&oacute;n bayesiana activa sobre muestra cacheada.</span>
    </div>`;
  banner.style.display = 'flex';
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
 * "Se voltea la tortilla": detecta candidatos cuyo rank ACTUAL (por votos
 * contabilizados en ONPE) difiere de su rank PROYECTADO (modal del posterior
 * bayesiano). Destaca el vuelco más dramático involucrando al 2° lugar.
 */
function renderSwap(d) {
  const section = document.getElementById('swap-section');
  const body = document.getElementById('swap-body');
  const subtitle = document.getElementById('swap-subtitle');
  if (!section || !body || !d.candidates) return;

  const cands = d.candidates.filter(c => c.rankProbs && c.rankProbs.length >= 3);
  if (cands.length < 3) { section.style.display = 'none'; return; }

  // Rank actual por votos contabilizados (pct ONPE)
  const byActual = [...cands].sort((a, b) => (b.pct || 0) - (a.pct || 0));
  const currentRank = new Map();
  byActual.forEach((c, i) => currentRank.set(c.code, i + 1));

  // Rank proyectado = argmax de rankProbs (posición más probable)
  const projRank = new Map();
  const projConfidence = new Map();
  for (const c of cands) {
    let maxP = -1, maxR = 99;
    for (let r = 0; r < 6; r++) {
      const p = c.rankProbs[r] || 0;
      if (p > maxP) { maxP = p; maxR = r + 1; }
    }
    projRank.set(c.code, maxR);
    projConfidence.set(c.code, maxP);
  }

  // Candidato que SUBE al 2° (actualmente NO es 2°, proyección dice 2°)
  const riser = cands.find(c =>
    projRank.get(c.code) === 2 && currentRank.get(c.code) > 2
  );
  // Candidato que CAE del 2° (actualmente 2°, proyección dice >2°)
  const faller = cands.find(c =>
    currentRank.get(c.code) === 2 && projRank.get(c.code) > 2
  );

  if (!riser || !faller) {
    section.style.display = 'none';
    return;
  }

  const riserP = (projConfidence.get(riser.code) || 0) * 100;
  const fallerProjR = projRank.get(faller.code);
  const fallerP = (faller.rankProbs[fallerProjR - 1] || 0) * 100;

  // Ventaja ACTUAL: en votos ya contabilizados (ONPE), quién lidera entre los dos
  const gapNow = Math.abs((faller.votes || 0) - (riser.votes || 0));
  const gapNowLeader = (faller.votes || 0) > (riser.votes || 0) ? faller : riser;

  // Ventaja PROYECTADA: diferencia de votos al final según proyección
  const totalValidEstimate = (d.totals && d.pctCounted > 5)
    ? d.totals.totalVotesValid / (d.pctCounted / 100)
    : 0;
  const gapVotes = totalValidEstimate
    ? Math.round(totalValidEstimate * Math.abs(riser.projectedPct - faller.projectedPct) / 100)
    : null;

  // El "vuelco" es la suma: desventaja que tiene que remontar + ventaja que termina teniendo
  const totalSwing = gapVotes !== null && gapNowLeader.code === faller.code
    ? gapNow + gapVotes
    : null;

  section.style.display = '';
  subtitle.textContent = `${riser.partyShort} supera a ${faller.partyShort} por el pase a segunda vuelta`;

  body.innerHTML = `
    <div class="swap-compare">
      <!-- Header con posiciones -->
      <div class="swap-col-header swap-header-actual">
        <span class="swap-col-label">AHORA (ONPE live)</span>
      </div>
      <div class="swap-arrow-wrap"></div>
      <div class="swap-col-header swap-header-projected">
        <span class="swap-col-label">PROYECCI&Oacute;N FINAL</span>
      </div>

      <!-- Fila del que SUBE: puesto actual inferior → 2° -->
      <div class="swap-pos-card swap-pos-from" style="--accent: ${riser.color}">
        <div class="swap-rank">#${currentRank.get(riser.code)}</div>
        <div class="swap-party-badge" style="background: ${riser.color}">${riser.partyShort}</div>
        <div class="swap-cand-name">${shortName(riser.name)}</div>
        <div class="swap-pct">${formatPct(riser.pct, 2)}</div>
      </div>
      <div class="swap-arrow-wrap swap-arrow-up">
        <div class="swap-arrow-line"></div>
        <div class="swap-arrow-icon">&#8593;</div>
        <div class="swap-arrow-label">SUBE</div>
      </div>
      <div class="swap-pos-card swap-pos-to swap-pos-winner" style="--accent: ${riser.color}">
        <div class="swap-rank swap-rank-gold">#2</div>
        <div class="swap-party-badge" style="background: ${riser.color}">${riser.partyShort}</div>
        <div class="swap-cand-name">${shortName(riser.name)}</div>
        <div class="swap-pct">${formatPct(riser.projectedPct, 2)}</div>
        <div class="swap-prob-tag swap-prob-win">${riserP.toFixed(0)}% prob.</div>
      </div>

      <!-- STRIP CENTRAL: ventaja actual en votos entre los dos "segundos" -->
      <div class="swap-gap-strip">
        <div class="swap-gap-now">
          <span class="swap-gap-pill" style="background: ${gapNowLeader.color}">${gapNowLeader.partyShort}</span>
          <span class="swap-gap-text">
            lidera <strong>ahora mismo</strong> por
          </span>
          <span class="swap-gap-votes">${formatNumber(gapNow)}</span>
          <span class="swap-gap-unit">votos</span>
        </div>
        <div class="swap-gap-arrow">&#8596;</div>
        <div class="swap-gap-proj">
          <span class="swap-gap-pill" style="background: ${riser.color}">${riser.partyShort}</span>
          <span class="swap-gap-text">terminar&aacute; arriba por</span>
          <span class="swap-gap-votes swap-gap-votes-win">${gapVotes !== null ? '~ ' + formatNumber(gapVotes) : '—'}</span>
          <span class="swap-gap-unit">votos proyectados</span>
        </div>
        ${totalSwing !== null ? `
        <div class="swap-gap-swing">
          Vuelco total: <strong>${formatNumber(totalSwing)} votos</strong> de diferencia entre ahora y el final proyectado
        </div>` : ''}
      </div>

      <!-- Fila del que CAE: actualmente 2° → puesto inferior -->
      <div class="swap-pos-card swap-pos-from swap-pos-losing" style="--accent: ${faller.color}">
        <div class="swap-rank">#2</div>
        <div class="swap-party-badge" style="background: ${faller.color}">${faller.partyShort}</div>
        <div class="swap-cand-name">${shortName(faller.name)}</div>
        <div class="swap-pct">${formatPct(faller.pct, 2)}</div>
      </div>
      <div class="swap-arrow-wrap swap-arrow-down">
        <div class="swap-arrow-line"></div>
        <div class="swap-arrow-icon">&#8595;</div>
        <div class="swap-arrow-label">CAE</div>
      </div>
      <div class="swap-pos-card swap-pos-to" style="--accent: ${faller.color}">
        <div class="swap-rank">#${fallerProjR}</div>
        <div class="swap-party-badge" style="background: ${faller.color}">${faller.partyShort}</div>
        <div class="swap-cand-name">${shortName(faller.name)}</div>
        <div class="swap-pct">${formatPct(faller.projectedPct, 2)}</div>
        <div class="swap-prob-tag swap-prob-lose">${fallerP.toFixed(0)}% prob.</div>
      </div>
    </div>

    <div class="swap-summary">
      <div class="swap-summary-item">
        <span class="swap-summary-label">Brecha proyectada</span>
        <span class="swap-summary-value">${formatPct(Math.abs(riser.projectedPct - faller.projectedPct), 2)}</span>
      </div>
      ${gapVotes !== null ? `
      <div class="swap-summary-item">
        <span class="swap-summary-label">Ventaja en votos</span>
        <span class="swap-summary-value">~ ${formatNumber(gapVotes)}</span>
      </div>` : ''}
      <div class="swap-summary-item">
        <span class="swap-summary-label">Actas contabilizadas</span>
        <span class="swap-summary-value">${formatPct(d.pctCounted, 1)}</span>
      </div>
    </div>
  `;
}

/**
 * "Pelea por el podio": muestra candidatos con probabilidad material
 * de terminar en posiciones 2° o 3° (excluye al líder cuando está sellado).
 * Detecta dinámicamente si la pelea es por el 2° o por el 3°.
 */
function renderBattleForSecond(d) {
  const section = document.getElementById('battle-section');
  const container = document.getElementById('battle-contenders');
  const subtitle = document.getElementById('battle-subtitle');
  const title = section?.querySelector('.battle-title');
  if (!section || !container || !d.candidates) return;

  const cands = d.candidates.filter(c => c.rankProbs && c.rankProbs.length >= 3);
  if (cands.length === 0) { section.style.display = 'none'; return; }

  // Un candidato está "en el podio en disputa" si tiene prob combinada
  // de quedar 2° o 3° ≥ 15%, o si P(2°) ≥ 5%
  const inBattle = cands.filter(c => {
    const p2 = c.rankProbs[1] || 0;
    const p3 = c.rankProbs[2] || 0;
    return (p2 + p3) >= 0.15 || p2 >= 0.05;
  });

  if (inBattle.length < 2) {
    section.style.display = 'none';
    return;
  }

  // Ordenar por P(2°)+P(3°) desc, luego por projectedPct
  inBattle.sort((a, b) => {
    const pa = (a.rankProbs[1] || 0) + (a.rankProbs[2] || 0);
    const pb = (b.rankProbs[1] || 0) + (b.rankProbs[2] || 0);
    if (Math.abs(pa - pb) > 0.01) return pb - pa;
    return b.projectedPct - a.projectedPct;
  });

  // Detectar naturaleza de la pelea
  const topP2 = inBattle[0].rankProbs[1] || 0;
  const is2ndLocked = topP2 >= 0.85;
  title.textContent = is2ndLocked ? 'Pelea por el 3\u00b0 lugar' : 'Pelea por el 2\u00b0 lugar';

  // Para calcular votos estimados entre ellos, usar totales ONPE proyectados
  const totalValidEstimate = (d.totals && d.pctCounted > 5)
    ? d.totals.totalVotesValid / (d.pctCounted / 100)
    : null;

  // Proyectado máximo entre los contendientes (para normalizar barras)
  const maxProj = Math.max(...inBattle.map(c => c.projectedPct));

  section.style.display = '';
  const focusRank = is2ndLocked ? 3 : 2; // qué puesto es el disputado
  const focusKey = focusRank - 1; // índice en rankProbs (0-based)
  subtitle.textContent = is2ndLocked
    ? `${inBattle.length} candidatos se disputan el 3\u00b0 lugar (el 2\u00b0 ya casi est\u00e1 definido)`
    : `${inBattle.length} candidatos se disputan el pase a segunda vuelta`;

  container.innerHTML = inBattle.map(c => {
    const p1 = (c.rankProbs[0] || 0) * 100;
    const p2 = (c.rankProbs[1] || 0) * 100;
    const p3 = (c.rankProbs[2] || 0) * 100;
    const pFocus = (c.rankProbs[focusKey] || 0) * 100;
    const pOther = Math.max(0, 100 - p1 - p2 - p3);
    const barWidth = (c.projectedPct / maxProj) * 100;

    const intensity = pFocus >= 40 ? 'battle-card-hot' : pFocus >= 20 ? 'battle-card-warm' : 'battle-card-cool';
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
          <div class="battle-prob-value">${pFocus.toFixed(0)}<span class="battle-prob-pct">%</span></div>
          <div class="battle-prob-label">prob. ${focusRank}&deg; lugar</div>
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
          <span class="battle-dist-label">P(2&deg;)</span>
          <span class="battle-dist-value">${p2.toFixed(1)}%</span>
        </div>
        <div class="battle-dist-item battle-dist-highlight">
          <span class="battle-dist-label">P(3&deg;)</span>
          <span class="battle-dist-value">${p3.toFixed(1)}%</span>
        </div>
        <div class="battle-dist-item">
          <span class="battle-dist-label">P(4&deg; o menos)</span>
          <span class="battle-dist-value">${pOther.toFixed(1)}%</span>
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
