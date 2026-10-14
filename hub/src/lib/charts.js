'use strict';

const { formatINRCompact, formatINRShort } = require('./money');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Rounds an axis max up to a clean 1/2/2.5/5 × 10^n step so ticks read naturally. */
function niceMax(value, ticks = 4) {
  if (value <= 0) return ticks;
  const raw = value / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  return step * ticks;
}

/**
 * Single-series column chart as inline SVG (values in paise).
 * Bars ≤24px with a 4px rounded top and square baseline; recessive hairline grid;
 * labels only on the peak and the latest column; every column has a hover target
 * whose tooltip comes from data-tip (see public/js/app.js).
 */
function columnChart(points, { height = 220, label = 'Value' } = {}) {
  const width = 720;
  const pad = { top: 22, right: 8, bottom: 26, left: 52 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const band = innerW / points.length;
  const barW = Math.min(24, band * 0.6);
  const y = (v) => pad.top + innerH - (v / max) * innerH;
  const peak = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);

  const parts = [];
  for (let t = 0; t <= 4; t += 1) {
    const v = (max / 4) * t;
    const yy = y(v);
    parts.push(`<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="tick" x="${pad.left - 8}" y="${yy + 4}" text-anchor="end">${esc(formatINRCompact(v))}</text>`);
  }
  points.forEach((p, i) => {
    const cx = pad.left + band * i + band / 2;
    const h = Math.max(0, innerH - (y(p.value) - pad.top));
    const x = cx - barW / 2;
    const top = pad.top + innerH - h;
    const r = Math.min(4, h, barW / 2);
    const tip = `${p.tip || p.label}: ${formatINRShort(p.value)}`;
    if (h > 0) {
      // Rounded data-end, square at the baseline.
      parts.push(`<path class="bar${i === points.length - 1 ? ' bar-current' : ''}" d="M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z"/>`);
    }
    if ((i === peak || i === points.length - 1) && p.value > 0) {
      parts.push(`<text class="val" x="${cx}" y="${top - 6}" text-anchor="middle">${esc(formatINRCompact(p.value))}</text>`);
    }
    parts.push(`<text class="tick" x="${cx}" y="${height - 8}" text-anchor="middle">${esc(p.label)}</text>`);
    parts.push(`<rect class="hit" x="${pad.left + band * i}" y="${pad.top}" width="${band}" height="${innerH}" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(tip)}"/>`);
  });
  parts.push(`<line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + innerH}" y2="${pad.top + innerH}"/>`);
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

module.exports = { columnChart, niceMax };
