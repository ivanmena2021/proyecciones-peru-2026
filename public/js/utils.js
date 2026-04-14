/**
 * Utility functions for formatting and display.
 */

function formatNumber(n) {
  if (n == null) return '—';
  return n.toLocaleString('es-PE');
}

function formatPct(n, decimals = 2) {
  if (n == null) return '—';
  return n.toFixed(decimals) + '%';
}

function formatTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  return d.toLocaleString('es-PE', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatTimeShort(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

function shortName(fullName) {
  if (!fullName) return '';
  const parts = fullName.split(' ').filter(Boolean);
  if (parts.length <= 2) return fullName;
  // Last two parts (apellidos typically) + first name initial
  return parts[parts.length - 2] + ' ' + parts[parts.length - 1];
}

function getGradeColor(grade) {
  switch (grade) {
    case 'A': return '#10B981';
    case 'B': return '#3B82F6';
    case 'C': return '#F59E0B';
    case 'D': return '#EF4444';
    default: return '#6B7280';
  }
}

function getGradeLabel(grade) {
  switch (grade) {
    case 'A': return 'Alta confianza';
    case 'B': return 'Confianza moderada';
    case 'C': return 'Confianza limitada';
    case 'D': return 'Precaucion — datos preliminares';
    default: return 'Sin datos';
  }
}

function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 107, g: 114, b: 128 };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

function adjustAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
