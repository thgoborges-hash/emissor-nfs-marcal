import React from 'react';

/** Linha/bloco skeleton shimmer genérico */
export function Skeleton({ width = '100%', height = 14, style = {} }) {
  return <div className="skeleton" style={{ width, height, ...style }} />;
}

/** Skeleton específico pro grid de KPIs (mantém layout enquanto carrega) */
export function KpiGridSkeleton({ total = 4 }) {
  return (
    <div className="kpi-grid">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="kpi-card">
          <Skeleton width="55%" height={12} />
          <Skeleton width="40%" height={32} style={{ marginTop: 10 }} />
          <Skeleton width="70%" height={12} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

/** Skeleton de lista (tipo obrigações) */
export function ListSkeleton({ rows = 4 }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ padding: '12px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <Skeleton width="50%" height={14} />
            <Skeleton width="30%" height={10} style={{ marginTop: 6 }} />
          </div>
          <Skeleton width="60px" height={14} />
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
