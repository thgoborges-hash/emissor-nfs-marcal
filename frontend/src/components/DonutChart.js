import React from 'react';

/**
 * Donut chart SVG sem dependências
 * @param {number} pct  — 0 a 1
 * @param {number} size — diâmetro em px
 * @param {string} cor  — accent color
 * @param {string} label — texto central (default: "X%")
 * @param {string} sub   — texto secundário central
 */
export default function DonutChart({ pct = 0, size = 160, cor = 'var(--primary)', label, sub }) {
  const stroke = size * 0.1;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct);
  const pctTexto = label || `${Math.round(pct * 100)}%`;

  return (
    <svg width={size} height={size} className="donut-chart" viewBox={`0 0 ${size} ${size}`}>
      <defs>
        <filter id={`donut-glow-${size}`}>
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Trilha de fundo */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={stroke}
        opacity={0.4}
      />

      {/* Progresso */}
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke={cor}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cy})`}
        filter={`url(#donut-glow-${size})`}
        style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.22, 1, 0.36, 1)' }}
      />

      <text
        x={cx} y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.22}
        fontWeight="700"
        fill="var(--text)"
        style={{ letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}
      >{pctTexto}</text>

      {sub && (
        <text
          x={cx} y={cy + size * 0.18}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={size * 0.08}
          fill="var(--text-muted)"
          style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 500 }}
        >{sub}</text>
      )}
    </svg>
  );
}
