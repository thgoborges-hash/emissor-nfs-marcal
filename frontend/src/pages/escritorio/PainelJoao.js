import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { joaoApi } from '../../services/api';

// =====================================================
// Painel João — status do daemon + fila de jobs
// -----------------------------------------------------
// Visualização da fila joao_jobs e do heartbeat do daemon local (Mac).
// Operador aprova ações sensíveis (importar_txt, gerar_obrigacao) ou cancela.
// =====================================================

const TIPO_LABELS = {
  classificar_extrato: 'Classificar extrato',
  importar_txt: 'Importar TXT',
  gerar_obrigacao: 'Gerar obrigação',
  monitorar_onvio: 'Monitorar Onvio',
  generico: 'Genérico',
};

const TIPO_ICONS = {
  classificar_extrato: '📊',
  importar_txt: '📥',
  gerar_obrigacao: '📜',
  monitorar_onvio: '👁️',
  generico: '⚙️',
};

const STATUS_INFO = {
  pending: { label: 'Na fila', cor: 'info', icon: '⏳' },
  pending_approval: { label: 'Aguarda aprovação', cor: 'warning', icon: '⏸️' },
  running: { label: 'Executando', cor: 'primary', icon: '🔄' },
  done: { label: 'Concluído', cor: 'success', icon: '✅' },
  failed: { label: 'Falhou', cor: 'danger', icon: '⚠️' },
  cancelled: { label: 'Cancelado', cor: 'muted', icon: '⊘' },
};

const formatarDataHora = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
};

const formatarAge = (ageSec) => {
  if (ageSec == null) return '—';
  if (ageSec < 60) return `${ageSec}s atrás`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}min atrás`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h atrás`;
  return `${Math.floor(ageSec / 86400)}d atrás`;
};

export default function PainelJoao() {
  const [status, setStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [filtroStatus, setFiltroStatus] = useState('todos');
  const [filtroTipo, setFiltroTipo] = useState('todos');
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [processando, setProcessando] = useState(null);
  const [jobExpandido, setJobExpandido] = useState(null);

  const carregar = useCallback(async () => {
    try {
      const filtros = {};
      if (filtroStatus !== 'todos') filtros.status = filtroStatus;
      if (filtroTipo !== 'todos') filtros.tipo = filtroTipo;
      filtros.limite = 100;
      const [statusRes, jobsRes] = await Promise.all([
        joaoApi.status(),
        joaoApi.listarJobs(filtros),
      ]);
      setStatus(statusRes.data);
      setJobs(jobsRes.data.jobs || []);
      setErro(null);
    } catch (err) {
      setErro(err.response?.data?.erro || err.message);
    } finally {
      setCarregando(false);
    }
  }, [filtroStatus, filtroTipo]);

  useEffect(() => {
    carregar();
    const id = setInterval(carregar, 5000);
    return () => clearInterval(id);
  }, [carregar]);

  const aprovar = async (jobId) => {
    if (!window.confirm(`Aprovar job #${jobId}? Daemon vai executar em seguida.`)) return;
    setProcessando(jobId);
    try {
      await joaoApi.aprovarJob(jobId);
      await carregar();
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    } finally {
      setProcessando(null);
    }
  };

  const cancelar = async (jobId) => {
    const motivo = window.prompt(`Motivo do cancelamento (opcional):`);
    if (motivo === null) return;  // cancelado pelo usuário do prompt
    setProcessando(jobId);
    try {
      await joaoApi.cancelarJob(jobId, motivo);
      await carregar();
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    } finally {
      setProcessando(null);
    }
  };

  const daemon = status?.daemon || {};
  const fila = status?.fila || {};

  // Tipos únicos pra filtro
  const tiposDisponiveis = useMemo(() => {
    const set = new Set(jobs.map(j => j.tipo));
    return Array.from(set);
  }, [jobs]);

  if (carregando && !status) {
    return <div className="empty-state"><div className="icon">⏳</div>Carregando…</div>;
  }

  return (
    <div className="painel-joao">
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">
            <span style={{ marginRight: 10 }}>🛠️</span>
            João — Painel
          </h1>
          <p className="page-subtitle">
            Daemon local que opera o Domínio Web e monitora Onvio em tempo real
            via Chrome MCP.
          </p>
        </div>
      </div>

      {/* === Hero: status do daemon === */}
      <div
        className="card"
        style={{
          padding: 20,
          marginBottom: 20,
          background: daemon.online
            ? 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(6,182,212,0.06))'
            : 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(245,158,11,0.06))',
          borderColor: daemon.online ? 'var(--success)' : 'var(--danger)',
          boxShadow: daemon.online
            ? '0 0 32px rgba(16,185,129,0.12)'
            : '0 0 32px rgba(239,68,68,0.12)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  width: 60, height: 60, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: daemon.online ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                  fontSize: 28,
                  border: `2px solid ${daemon.online ? 'var(--success)' : 'var(--danger)'}`,
                }}
              >
                🤖
              </div>
              {daemon.online && (
                <span
                  style={{
                    position: 'absolute', bottom: 2, right: 2,
                    width: 14, height: 14, borderRadius: '50%',
                    background: 'var(--success)',
                    border: '2px solid var(--bg-card)',
                    animation: 'pulse 2s infinite',
                  }}
                />
              )}
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>
                {daemon.online ? 'João online' : 'João offline'}
              </div>
              <div className="text-light" style={{ fontSize: 13, marginTop: 4 }}>
                {daemon.hostname || '—'}
                {daemon.versao && <span> · v{daemon.versao}</span>}
                {daemon.metadata?.mode && <span> · modo {daemon.metadata.mode}</span>}
              </div>
              <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>
                Último ping {formatarAge(daemon.age_sec)}
                {daemon.jobs_ativos > 0 && <span> · {daemon.jobs_ativos} job(s) ativo(s) agora</span>}
              </div>
            </div>
          </div>

          {/* Contadores de fila */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {['pending_approval', 'pending', 'running', 'done', 'failed'].map(s => {
              const info = STATUS_INFO[s];
              const count = fila[s] || 0;
              const ativo = count > 0;
              return (
                <button
                  key={s}
                  onClick={() => setFiltroStatus(filtroStatus === s ? 'todos' : s)}
                  className="card"
                  style={{
                    padding: '10px 14px',
                    minWidth: 88,
                    border: filtroStatus === s ? `2px solid var(--${info.cor})` : '1px solid var(--border)',
                    cursor: 'pointer',
                    opacity: ativo ? 1 : 0.55,
                    transition: 'all 0.15s',
                  }}
                  title={`${info.label} — clique pra filtrar`}
                >
                  <div style={{ fontSize: 11, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {info.icon} {info.label}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: ativo ? `var(--${info.cor})` : 'var(--text-muted)' }}>
                    {count}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {erro && <div className="alert alert-danger" style={{ marginBottom: 16 }}>Erro: {erro}</div>}

      {/* === Filtros === */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--text-light)' }}>Tipo:</div>
        <button
          onClick={() => setFiltroTipo('todos')}
          className={filtroTipo === 'todos' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
        >
          Todos
        </button>
        {tiposDisponiveis.map(t => (
          <button
            key={t}
            onClick={() => setFiltroTipo(filtroTipo === t ? 'todos' : t)}
            className={filtroTipo === t ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
          >
            {TIPO_ICONS[t] || '•'} {TIPO_LABELS[t] || t}
          </button>
        ))}
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={carregar} className="btn btn-ghost btn-sm">↻ Atualizar</button>
        </div>
      </div>

      {/* === Lista de jobs === */}
      {jobs.length === 0 ? (
        <div className="empty-state">
          <div className="icon">{filtroStatus === 'pending_approval' ? '✨' : '📭'}</div>
          <div style={{ fontSize: 15, marginBottom: 6 }}>
            {filtroStatus === 'todos' ? 'Nenhum job no momento.' : `Nenhum job em "${STATUS_INFO[filtroStatus]?.label || filtroStatus}".`}
          </div>
          <div className="text-muted text-sm">
            Quando a Ana ou o painel enfileirar trabalho pro João, aparece aqui.
          </div>
        </div>
      ) : (
        <div className="jobs-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {jobs.map(job => {
            const info = STATUS_INFO[job.status] || STATUS_INFO.pending;
            const expandido = jobExpandido === job.id;
            const tipoLabel = TIPO_LABELS[job.tipo] || job.tipo;
            return (
              <div
                key={job.id}
                className="card"
                style={{
                  padding: 14,
                  borderLeft: `3px solid var(--${info.cor})`,
                  cursor: 'pointer',
                  transition: 'background 0.12s',
                }}
                onClick={() => setJobExpandido(expandido ? null : job.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 22 }}>{TIPO_ICONS[job.tipo] || '⚙️'}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>{tipoLabel}</span>
                        <span className="text-muted" style={{ fontSize: 12 }}>#{job.id}</span>
                        <span
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '2px 8px', borderRadius: 999,
                            background: `var(--${info.cor}-subtle)`,
                            color: `var(--${info.cor})`,
                            fontSize: 11, fontWeight: 600,
                            textTransform: 'uppercase', letterSpacing: '0.04em',
                          }}
                        >
                          {info.icon} {info.label}
                        </span>
                      </div>
                      <div className="text-light" style={{ fontSize: 12, marginTop: 4 }}>
                        Criado por {job.criado_por || '—'} · {formatarDataHora(job.created_at)}
                        {job.cliente_id && <span> · cliente #{job.cliente_id}</span>}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {job.status === 'pending_approval' && (
                      <>
                        <button
                          disabled={processando === job.id}
                          onClick={(e) => { e.stopPropagation(); aprovar(job.id); }}
                          className="btn btn-success btn-sm"
                        >
                          ✓ Aprovar
                        </button>
                        <button
                          disabled={processando === job.id}
                          onClick={(e) => { e.stopPropagation(); cancelar(job.id); }}
                          className="btn btn-danger btn-sm"
                        >
                          ✗ Cancelar
                        </button>
                      </>
                    )}
                    {['pending', 'running'].includes(job.status) && (
                      <button
                        disabled={processando === job.id}
                        onClick={(e) => { e.stopPropagation(); cancelar(job.id); }}
                        className="btn btn-outline btn-sm"
                      >
                        ✗ Cancelar
                      </button>
                    )}
                  </div>
                </div>

                {/* Bloco expandido — params, resultado, erro */}
                {expandido && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 8 }}>
                      <Campo label="Iniciado em" valor={formatarDataHora(job.iniciado_em)} />
                      <Campo label="Finalizado em" valor={formatarDataHora(job.finalizado_em)} />
                      <Campo label="Tentativas" valor={job.tentativas || 0} />
                      {job.aprovado_por && (
                        <Campo label="Aprovado por" valor={`${job.aprovado_por} em ${formatarDataHora(job.aprovado_em)}`} />
                      )}
                    </div>

                    {job.parametros && Object.keys(job.parametros).length > 0 && (
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-light)', userSelect: 'none' }}>
                          Parâmetros
                        </summary>
                        <pre style={{
                          fontFamily: 'var(--font-mono)', fontSize: 11,
                          background: 'var(--bg)', padding: 10, borderRadius: 6,
                          marginTop: 6, overflowX: 'auto',
                          border: '1px solid var(--border-subtle)',
                        }}>
                          {JSON.stringify(job.parametros, null, 2)}
                        </pre>
                      </details>
                    )}

                    {job.resultado && (
                      <details style={{ marginTop: 8 }} open>
                        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--success)', userSelect: 'none' }}>
                          Resultado
                        </summary>
                        <pre style={{
                          fontFamily: 'var(--font-mono)', fontSize: 11,
                          background: 'var(--success-subtle)', padding: 10, borderRadius: 6,
                          marginTop: 6, overflowX: 'auto',
                          border: '1px solid var(--success)',
                        }}>
                          {JSON.stringify(job.resultado, null, 2)}
                        </pre>
                      </details>
                    )}

                    {job.erro && (
                      <details style={{ marginTop: 8 }} open>
                        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--danger)', userSelect: 'none' }}>
                          Erro
                        </summary>
                        <pre style={{
                          fontFamily: 'var(--font-mono)', fontSize: 11,
                          background: 'var(--danger-subtle)', padding: 10, borderRadius: 6,
                          marginTop: 6, overflowX: 'auto', whiteSpace: 'pre-wrap',
                          border: '1px solid var(--danger)',
                        }}>
                          {job.erro}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.4); opacity: 0.4; }
        }
        .painel-joao .card:hover {
          background: var(--bg-hover);
        }
      `}</style>
    </div>
  );
}

function Campo({ label, valor }) {
  return (
    <div>
      <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, marginTop: 2 }}>{valor}</div>
    </div>
  );
}
