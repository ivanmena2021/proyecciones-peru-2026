// Simplified view — Top 3 candidates, gaps and evolution chart.
// All heavy logic stays in the backend; this is a thin renderer.

const state = { data: null, history: [], chart: null };

const fmtNum = n => (n == null ? '—' : new Intl.NumberFormat('es-PE').format(Math.round(n)));
const fmtPct = (n, d = 2) => (n == null || isNaN(n) ? '—' : n.toFixed(d) + '%');
const fmtTime = ts => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function connect() {
  const badge = document.getElementById('connection-badge');
  try {
    const es = new EventSource('/api/sse');
    es.onopen = () => { badge.textContent = 'En vivo'; badge.style.background = '#16a34a'; badge.style.borderColor = '#16a34a'; };
    es.onmessage = ev => {
      try { state.data = JSON.parse(ev.data); render(); } catch {}
    };
    es.onerror = () => {
      badge.textContent = 'Reconectando...';
      badge.style.background = ''; badge.style.borderColor = '';
    };
  } catch {
    badge.textContent = 'Polling';
  }
  // Fallback + history load
  loadLatest();
  loadHistory();
  setInterval(loadLatest, 20000);
  setInterval(loadHistory, 30000);
}

async function loadLatest() {
  try {
    const r = await fetch('/api/latest', { cache: 'no-store' });
    if (r.ok) { state.data = await r.json(); render(); }
  } catch {}
}
async function loadHistory() {
  try {
    const r = await fetch('/api/history', { cache: 'no-store' });
    if (r.ok) { state.history = await r.json(); renderChart(); }
  } catch {}
}

function render() {
  const d = state.data;
  if (!d) return;
  renderStale(d);
  renderSourceNote(d);
  renderProgress(d);
  renderPodium(d);
  renderGaps(d);
  renderChart();
}

function renderStale(d) {
  let b = document.getElementById('stale-banner');
  if (!d.onpeStale) { if (b) b.style.display = 'none'; return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'stale-banner';
    b.className = 'stale-banner';
    const main = document.querySelector('main');
    main.insertBefore(b, main.firstChild);
  }
  const s = d.onpeStaleSeconds || 0;
  const ago = s >= 60 ? Math.floor(s / 60) + ' min' : s + ' s';
  b.innerHTML = `<span class="stale-icon">&#9888;</span><div><strong>Feed de ONPE interrumpido</strong>Mostrando &uacute;ltima data v&aacute;lida (hace ${ago}). Proyecci&oacute;n bayesiana sobre muestra cacheada.</div>`;
  b.style.display = 'flex';
}

function renderSourceNote(d) {
  const el = document.getElementById('source-note');
  if (!el) return;
  if (d.projectionMode === 'scraped_aggregate' && d.source) {
    const label = d.source === 'tvperu' ? 'TV Per&uacute; (estatal)' : d.source.toUpperCase();
    el.innerHTML = `<span class="src-dot"></span> Porcentajes oficiales ONPE, obtenidos v&iacute;a <strong>${label}</strong> mientras la API JSON p&uacute;blica de ONPE est&aacute; deshabilitada.`;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

function renderProgress(d) {
  const pct = d.pctCounted || 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-pct').textContent = fmtPct(pct, 3);
  const detail = document.getElementById('progress-detail');
  if (d.totals && d.totals.actasCounted) {
    detail.textContent = `${fmtNum(d.totals.actasCounted)} / ${fmtNum(d.totals.actasTotal)} actas`;
  } else if (d.source) {
    detail.textContent = 'Fuente: ' + String(d.source).toUpperCase();
  }
  document.getElementById('update-time').textContent = fmtTime(d.timestamp);
}

function top3ByProjection(d) {
  const cs = Array.isArray(d.candidates) ? d.candidates : [];
  return [...cs].sort((a, b) => (b.projectedPct || 0) - (a.projectedPct || 0)).slice(0, 3);
}

function renderPodium(d) {
  const el = document.getElementById('podium');
  const top = top3ByProjection(d);
  if (!top.length) { el.innerHTML = '<div class="loading">Sin datos disponibles</div>'; return; }
  el.innerHTML = top.map((c, i) => `
    <div class="card rank-${i + 1}">
      <div class="rank-badge">${i + 1}&deg;</div>
      <div class="party-bar" style="background:${c.color || '#888'}"></div>
      <div class="party-name">${c.partyShort || ''} &mdash; ${escapeHtml(c.party || '')}</div>
      <div class="candidate-name">${escapeHtml(c.name || '—')}</div>
      <div class="stat-row">
        <span class="stat-label">Proyectado</span>
        <span class="stat-value projected">${fmtPct(c.projectedPct, 2)}</span>
      </div>
      <div class="ci">IC 95%: ${fmtPct(c.marginLow, 2)} &ndash; ${fmtPct(c.marginHigh, 2)}</div>
      <div class="stat-row">
        <span class="stat-label">% actual ONPE</span>
        <span class="stat-value">${fmtPct(c.pct, 2)}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Votos</span>
        <span class="stat-value">${fmtNum(c.votes)}</span>
      </div>
    </div>
  `).join('');
}

function renderGaps(d) {
  const top = top3ByProjection(d);
  const c1 = top[0], c2 = top[1], c3 = top[2];
  const totalValid = d.totals?.totalVotesValid || 0;

  setGap('gap-1-2', c1, c2, totalValid);
  setGap('gap-2-3', c2, c3, totalValid);
}

function setGap(id, a, b, totalValid) {
  const el = document.getElementById(id);
  if (!el || !a || !b) return;
  const votesA = a.votes || 0, votesB = b.votes || 0;
  const gapVotes = Math.abs(votesA - votesB);
  const gapPct = Math.abs((a.projectedPct || 0) - (b.projectedPct || 0));

  // If raw vote counts aren't available (scraper mode), estimate from pct.
  const votesEl = el.querySelector('.gap-votes');
  if (gapVotes > 0) {
    votesEl.textContent = fmtNum(gapVotes) + ' votos';
  } else if (totalValid && gapPct > 0) {
    votesEl.textContent = '~' + fmtNum((gapPct / 100) * totalValid) + ' votos';
  } else {
    votesEl.textContent = fmtPct(gapPct, 3);
  }
  el.querySelector('.gap-pct').textContent = fmtPct(gapPct, 3) + ' de diferencia';
  el.querySelector('.gap-names').textContent =
    `${a.partyShort || a.code} ${fmtPct(a.pct, 3)}  vs  ${b.partyShort || b.code} ${fmtPct(b.pct, 3)}`;
}

function renderChart() {
  const canvas = document.getElementById('evolution-chart');
  if (!canvas || !state.data) return;
  const hist = Array.isArray(state.history) ? state.history : [];
  const top = top3ByProjection(state.data);
  if (!top.length) return;

  const codes = top.map(c => c.code);
  const labels = hist.map(h => fmtTime(h.timestamp));

  // If no history yet, seed with the current point
  const pointsByCode = new Map();
  for (const c of top) pointsByCode.set(c.code, { proj: [], low: [], high: [], color: c.color, label: (c.partyShort || c.code) + ' — ' + (c.name?.split(' ').slice(-2).join(' ') || '') });

  for (const snap of hist) {
    const snapCs = Array.isArray(snap.candidates) ? snap.candidates : [];
    for (const code of codes) {
      const c = snapCs.find(x => x.code === code);
      const p = pointsByCode.get(code);
      p.proj.push(c ? c.projectedPct : null);
      p.low.push(c ? c.marginLow : null);
      p.high.push(c ? c.marginHigh : null);
    }
  }
  if (!hist.length) {
    labels.push(fmtTime(state.data.timestamp));
    for (const c of top) {
      const p = pointsByCode.get(c.code);
      p.proj.push(c.projectedPct); p.low.push(c.marginLow); p.high.push(c.marginHigh);
    }
  }

  const datasets = [];
  for (const c of top) {
    const p = pointsByCode.get(c.code);
    datasets.push({
      label: p.label,
      data: p.proj,
      borderColor: p.color || '#f0b429',
      backgroundColor: (p.color || '#f0b429') + '20',
      borderWidth: 2.5,
      tension: 0.3,
      pointRadius: 2,
      fill: false,
    });
    // IC band (fill between low/high via two datasets)
    datasets.push({
      label: p.label + ' IC',
      data: p.high,
      borderColor: 'transparent',
      backgroundColor: (p.color || '#f0b429') + '1a',
      pointRadius: 0,
      fill: '+1',
      tension: 0.3,
    });
    datasets.push({
      label: p.label + ' IClow',
      data: p.low,
      borderColor: 'transparent',
      backgroundColor: 'transparent',
      pointRadius: 0,
      fill: false,
      tension: 0.3,
    });
  }

  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets = datasets;
    state.chart.update('none');
    return;
  }
  state.chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: '#e8e8f0',
            filter: it => !it.text.endsWith('IC') && !it.text.endsWith('IClow'),
          }
        },
        tooltip: {
          filter: it => !it.dataset.label.endsWith('IC') && !it.dataset.label.endsWith('IClow'),
          callbacks: { label: ctx => ctx.dataset.label + ': ' + fmtPct(ctx.parsed.y, 2) }
        }
      },
      scales: {
        x: { ticks: { color: '#8b8fa3', maxTicksLimit: 10 }, grid: { color: '#1e2a5e' } },
        y: {
          ticks: { color: '#8b8fa3', callback: v => v + '%' },
          grid: { color: '#1e2a5e' },
          title: { display: true, text: '% proyectado', color: '#8b8fa3' }
        }
      }
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

connect();
