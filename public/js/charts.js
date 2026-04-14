/**
 * Chart.js visualizations: horizontal bar chart and time-series line chart.
 */

let barChart = null;
let timelineChart = null;

function initCharts() {
  Chart.defaults.color = '#8b8fa3';
  Chart.defaults.borderColor = 'rgba(55, 65, 81, 0.5)';
  Chart.defaults.font.family = "'Inter', sans-serif";

  initBarChart();
  initTimelineChart();
}

function initBarChart() {
  const ctx = document.getElementById('bar-chart');
  if (!ctx) return;

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: '% Actual',
          data: [],
          backgroundColor: [],
          borderRadius: 4,
          barPercentage: 0.6,
          categoryPercentage: 0.8
        },
        {
          label: '% Proyectado',
          data: [],
          backgroundColor: [],
          borderRadius: 4,
          barPercentage: 0.6,
          categoryPercentage: 0.8
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: {
            padding: 15,
            usePointStyle: true,
            pointStyle: 'rect',
            font: { size: 11, weight: '600' }
          }
        },
        tooltip: {
          backgroundColor: '#1f2937',
          borderColor: '#1e2a5e',
          borderWidth: 1,
          padding: 10,
          titleFont: { weight: '700' },
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(2)}%`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(55, 65, 81, 0.3)' },
          ticks: {
            callback: v => v + '%',
            font: { size: 11 }
          }
        },
        y: {
          grid: { display: false },
          ticks: {
            font: { size: 11, weight: '600' }
          }
        }
      }
    }
  });
}

function initTimelineChart() {
  const ctx = document.getElementById('timeline-chart');
  if (!ctx) return;

  timelineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: []
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            padding: 12,
            usePointStyle: true,
            pointStyle: 'circle',
            font: { size: 11, weight: '600' }
          }
        },
        tooltip: {
          backgroundColor: '#1f2937',
          borderColor: '#1e2a5e',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw?.toFixed(2)}%`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(55, 65, 81, 0.2)' },
          ticks: {
            maxTicksLimit: 8,
            font: { size: 10 }
          }
        },
        y: {
          grid: { color: 'rgba(55, 65, 81, 0.3)' },
          ticks: {
            callback: v => v + '%',
            font: { size: 11 }
          }
        }
      },
      elements: {
        point: { radius: 0, hitRadius: 10 },
        line: { tension: 0.3, borderWidth: 2.5 }
      }
    }
  });
}

function updateCharts() {
  if (!state.data) return;
  updateBarChart();
  updateTimelineChart();
}

function updateBarChart() {
  if (!barChart || !state.data?.candidates) return;

  const top = state.data.candidates.slice(0, 10);

  barChart.data.labels = top.map(c => c.partyShort);
  barChart.data.datasets[0].data = top.map(c => c.pct);
  barChart.data.datasets[0].backgroundColor = top.map(c => adjustAlpha(c.color, 0.6));
  barChart.data.datasets[1].data = top.map(c => c.projectedPct);
  barChart.data.datasets[1].backgroundColor = top.map(c => c.color);

  barChart.update('none');
}

function updateTimelineChart() {
  if (!timelineChart) return;

  const history = state.history;
  if (!history || history.length < 2) return;

  // Get top 5 candidates from latest data
  const top5 = (state.data?.candidates || []).slice(0, 5);
  if (top5.length === 0) return;

  // Build time labels
  const labels = history.map(p => formatTimeShort(p.timestamp));

  // Build datasets
  const datasets = top5.map(candidate => {
    const data = history.map(point => {
      const c = point.candidates?.find(x => x.code === candidate.code);
      return c ? c.projectedPct : null;
    });

    return {
      label: candidate.partyShort,
      data: data,
      borderColor: candidate.color,
      backgroundColor: adjustAlpha(candidate.color, 0.1),
      fill: false
    };
  });

  timelineChart.data.labels = labels;
  timelineChart.data.datasets = datasets;
  timelineChart.update('none');
}
