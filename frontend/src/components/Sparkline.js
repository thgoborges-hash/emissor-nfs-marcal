import React, { useMemo } from 'react';

/**
 * Mini-gráfico SVG leve (sem dependências) — linha + área preenchida + ponto no último valor
 *
 * @param {number[]} data  — série de valores
 * @param {number}   width — largura em px (default 100%)
 * @param {number}   height — altura em px
 */
export default function Sparkline({ data = [], height = 40 }) {
  const pontos = useMemo(() => {
    if (!data || data.length === 0) return { line: '', fill: '', last: null };

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const n = data.length;

    // Normaliza em coordenadas viewBox 0-100 x 0-100 (invertido em Y pra SVG)
    const coords = data.map((v, i) => {
      const x = (i / (n - 1 || 1)) * 100;
      const y = 100 - ((v - min) / range) * 88 - 6; // padding 6 top, 6 bottom
      return { x, y };
    });

    const line = coords.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    const fill = `${line} L 100,100 L 0,100 Z`;
    const last = coords[coords.length - 1];
    return { line, fill, last };
  }, [data]);

  if (!data || data.length === 0) return null;

  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }}>
      <path className="fill" d={pontos.fill} />
      <path className="line" d={pontos.line} vectorEffect="non-scaling-stroke" />
      {pontos.last && (
        <circle className="last" cx={pontos.last.x} cy={pontos.last.y} r="1.8" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
