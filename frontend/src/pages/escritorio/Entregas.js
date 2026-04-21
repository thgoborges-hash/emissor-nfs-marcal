import React, { useState, useEffect } from 'react';
import { entregasApi, integraContadorApi } from '../../services/api';
import DonutChart from '../../components/DonutChart';
import Sparkline from '../../components/Sparkline';
import { KpiGridSkeleton } from '../../components/Skeleton';

export default function Entregas() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [competencia, setCompetencia] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // Filtros
  const [filtroStatus, setFiltroStatus] = useState('todos');
  const [filtroBusca, setFiltroBusca] = useState('');

  const carregar = async () => {
    setCarregando(true);
    try {
      const { data } = await entregasApi.dashboard(competencia);
      setDados(data);
    } catch (err) {
      setErro(err.response?.data?.erro || err.message);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregar(); }, [competencia]);

  const toggleStatus = async (clienteId, tipoEntrega, statusAtual) => {
    const novoStatus = statusAtual === 'ok' ? 'pendente' : 'ok';
    try {
      await entregasApi.atualizarStatus({ clienteId, competencia, tipoEntrega, status: novoStatus });
      carregar();
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    }
  };

  if (carregando && !dados) {
    return (
      <div>
        <h1 className="page-title">Entregas Mensais</h1>
        <p className="page-subtitle">Carregando…</p>
        <KpiGridSkeleton total={4} />
      </div>
    );
  }
  if (erro) return <div className="alert alert-danger">Erro: {erro}</div>;

  const k = dados.kpis;
  const tipos = dados.por_tipo;
  const tendencia = (dados.tendencia || []).map(t => t.pct * 100);
  const ranking = dados.ranking_responsaveis || [];

  // Aplica filtros à matriz
  const clientesFiltrados = (dados.clientes || []).filter(c => {
    if (filtroBusca && !c.nome.toLowerCase().includes(filtroBusca.toLowerCase())) return false;
    if (filtroStatus === 'pendentes' && c.pendentes === 0 && c.atrasadas === 0) return false;
    if (filtroStatus === 'atrasados' && c.atrasadas === 0) return false;
    if (filtroStatus === 'ok' && c.pct < 1) return false;
    return true;
  });

  return (
    <div>
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Entregas Mensais</h1>
          <p className="page-subtitle">
            Acompanhamento gerencial da carteira por tipo de obrigação
          </p>
        </div>
        <input
          type="month"
          value={competencia}
          onChange={e => setCompetencia(e.target.value)}
          style={{
            padding: '8px 14px', background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            color: 'var(--text)', fontFamily: 'inherit', fontSize: 13.5,
          }}
        />
      </div>

      {/* KPIs principais */}
      <div className="kpi-grid mt-2">
        <div className="kpi-card accent-success">
          <div className="label">Conclusão geral</div>
          <div className="valor success">{Math.round(k.pct_completo * 100)}%</div>
          <div className="sub">{k.concluidas} de {k.aplicaveis} entregas</div>
          <Sparkline data={tendencia} />
        </div>
        <div className="kpi-card accent-secondary">
          <div className="label">Clientes 100% ok</div>
          <div className="valor secondary">{k.clientes_ok}</div>
          <div className="sub">de {k.clientes_total} clientes ativos</div>
        </div>
        <div className="kpi-card accent-warning">
          <div className="label">Pendências (no prazo)</div>
          <div className="valor warning">{k.pendentes}</div>
          <div className="sub">aguardam fechamento</div>
        </div>
        <div className="kpi-card accent-danger">
          <div className="label">Atrasadas</div>
          <div className="valor danger">{k.atrasadas}</div>
          <div className="sub">em {k.clientes_com_atraso} clientes</div>
        </div>
      </div>

      {/* Painel: donut + barras + ranking */}
      <div className="entregas-painel mt-3">
        <section className="section-card">
          <h3 className="section-title">📊 Progresso geral do mês</h3>
          <div className="entregas-donut-wrap">
            <DonutChart
              pct={k.pct_completo}
              size={180}
              cor={k.pct_completo >= 0.9 ? 'var(--success)' : k.pct_completo >= 0.7 ? 'var(--warning)' : 'var(--danger)'}
              sub="completas"
            />
          </div>
          <div className="entregas-tendencia text-light text-sm mt-2" style={{ textAlign: 'center' }}>
            Tendência últimos 6 meses: {tendencia.map(t => `${Math.round(t)}%`).join(' → ')}
          </div>
        </section>

        <section className="section-card" style={{ gridColumn: 'span 2' }}>
          <h3 className="section-title">📦 Status por tipo de entrega</h3>
          <div className="bar-stack-list">
            {tipos.map(t => (
              <div key={t.tipo} className="bar-stack-row">
                <div className="bar-stack-label">
                  <strong>{t.nome}</strong>
                  <span className="text-muted text-sm" style={{ marginLeft: 8 }}>{t.ok}/{t.total}</span>
                </div>
                <div className="bar-stack-track">
                  {t.ok > 0 && (
                    <div className="bar-stack-seg ok" style={{ width: `${(t.ok / t.total) * 100}%` }} title={`${t.ok} ok`}>
                      {t.ok / t.total > 0.15 && <span>{Math.round((t.ok / t.total) * 100)}%</span>}
                    </div>
                  )}
                  {t.pend > 0 && (
                    <div className="bar-stack-seg pend" style={{ width: `${(t.pend / t.total) * 100}%` }} title={`${t.pend} pendentes`} />
                  )}
                  {t.atr > 0 && (
                    <div className="bar-stack-seg atr" style={{ width: `${(t.atr / t.total) * 100}%` }} title={`${t.atr} atrasadas`} />
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="bar-stack-legend mt-2">
            <span><i className="legend-dot ok" /> Concluído</span>
            <span><i className="legend-dot pend" /> Pendente</span>
            <span><i className="legend-dot atr" /> Atrasado</span>
          </div>
        </section>
      </div>

      {/* Ranking + Filtros */}
      <div className="entregas-painel mt-3">
        <section className="section-card">
          <h3 className="section-title">🏆 Ranking da equipe</h3>
          {ranking.length === 0 ? (
            <div className="text-muted text-sm">Ninguém da equipe fechou entregas este mês.</div>
          ) : (
            <div>
              {ranking.map((r, i) => {
                const max = ranking[0].qtd;
                return (
                  <div key={r.nome} className="ranking-row">
                    <div className="ranking-pos">{i + 1}º</div>
                    <div className="ranking-nome">{r.nome}</div>
                    <div className="ranking-bar">
                      <div className="ranking-fill" style={{ width: `${(r.qtd / max) * 100}%` }} />
                    </div>
                    <div className="ranking-qtd">{r.qtd}</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="section-card" style={{ gridColumn: 'span 2' }}>
          <h3 className="section-title">🔍 Filtros da matriz</h3>
          <div className="form-row">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Buscar cliente</label>
              <input value={filtroBusca} onChange={e => setFiltroBusca(e.target.value)} placeholder="Razão social…" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Status</label>
              <select value={filtroStatus} onChange={e => setFiltroStatus(e.target.value)}>
                <option value="todos">Todos os clientes</option>
                <option value="pendentes">Com pendências (qualquer)</option>
                <option value="atrasados">Com atrasos</option>
                <option value="ok">100% ok</option>
              </select>
            </div>
          </div>
          <div className="text-muted text-sm mt-2">
            Mostrando {clientesFiltrados.length} de {dados.clientes.length} clientes.
            Clique em uma célula pra alternar entre ok / pendente.
          </div>
        </section>
      </div>

      {/* Matriz Cliente × Entrega */}
      <section className="section-card mt-3" style={{ overflow: 'auto', padding: 0 }}>
        <table className="matriz-entregas">
          <thead>
            <tr>
              <th>Cliente</th>
              <th style={{ textAlign: 'center', width: 80 }}>%</th>
              {dados.ordem_tipos.filter(t => tipos.find(x => x.tipo === t)).map(t => (
                <th key={t} style={{ textAlign: 'center', width: 90 }}>{dados.nomes_tipos[t]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clientesFiltrados.slice(0, 60).map(c => (
              <tr key={c.id}>
                <td>
                  <div style={{ fontWeight: 500, fontSize: 13.5 }}>{c.nome}</div>
                  <div className="text-muted text-sm" style={{ fontFamily: 'var(--font-mono)' }}>{c.cnpj}</div>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <span className={`pct-pill ${c.pct === 1 ? 'ok' : c.atrasadas > 0 ? 'atr' : 'pend'}`}>
                    {Math.round(c.pct * 100)}%
                  </span>
                </td>
                {dados.ordem_tipos.filter(t => tipos.find(x => x.tipo === t)).map(t => {
                  const e = c.entregas[t];
                  if (!e || e.status === 'nao_aplicavel') {
                    return <td key={t} style={{ textAlign: 'center' }}><span className="cell-na">—</span></td>;
                  }
                  return (
                    <td key={t} style={{ textAlign: 'center' }}>
                      <button
                        className={`cell-status ${e.status}`}
                        onClick={() => toggleStatus(c.id, t, e.status)}
                        title={`${dados.nomes_tipos[t]}: ${e.status}${e.responsavel ? ` · ${e.responsavel}` : ''}`}
                      >
                        {e.status === 'ok' && '✓'}
                        {e.status === 'pendente' && '○'}
                        {e.status === 'atrasado' && '!'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {clientesFiltrados.length > 60 && (
          <div className="text-muted text-sm" style={{ padding: '12px 20px' }}>
            Mostrando primeiros 60. Use os filtros pra refinar.
          </div>
        )}
      </section>

      {/* Secao: Status SERPRO (alimentado pelo snapshot diario) */}
      <SerproStatusSection />
    </div>
  );
}

// ======================================================
// Secao adicional: Status SERPRO (procuracao, PGDAS-D, DCTFWeb, Caixa Postal)
// Le do snapshot diario. Nao bate na SERPRO a cada abertura da tela.
// ======================================================
function SerproStatusSection() {
  const [dados, setDados] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [filtroBusca, setFiltroBusca] = useState('');
  const [filtroStatus, setFiltroStatus] = useState('todos');
  const [rodando, setRodando] = useState(false);

  const carregar = async () => {
    setCarregando(true);
    setErro(null);
    try {
      const { data } = await integraContadorApi.snapshotTodos();
      setDados(data.dados || []);
    } catch (err) {
      setErro(err.response?.data?.erro || err.message);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregar(); }, []);

  const rodarAgora = async () => {
    if (!window.confirm('Vai consultar a SERPRO pra TODA a carteira (~13min, usa creditos). Continuar?')) return;
    setRodando(true);
    try {
      await integraContadorApi.rodarSnapshot();
      alert('Varredura iniciada. Acompanhe nos logs do Render e volte aqui em ~15min pra ver os resultados atualizados.');
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    } finally {
      setRodando(false);
    }
  };

  // Agrupa dados por cliente
  const porCliente = {};
  for (const row of dados) {
    const k = row.cliente_id;
    if (!porCliente[k]) {
      porCliente[k] = { id: k, razao: row.razao_social, cnpj: row.cnpj, obrigacoes: {} };
    }
    porCliente[k].obrigacoes[row.obrigacao] = row;
  }
  let clientes = Object.values(porCliente);

  // Filtro
  clientes = clientes.filter(c => {
    if (filtroBusca && !(c.razao || '').toLowerCase().includes(filtroBusca.toLowerCase())) return false;
    if (filtroStatus === 'pendencias') {
      const temPend = Object.values(c.obrigacoes).some(o => ['pendente', 'atrasada', 'erro'].includes(o.status));
      if (!temPend) return false;
    }
    return true;
  });

  const OBRIGACOES = [
    { key: 'PROCURACAO', label: 'Procuracao e-CAC' },
    { key: 'PGDASD',      label: 'PGDAS-D' },
    { key: 'DCTFWEB',     label: 'DCTFWeb' },
    { key: 'CAIXA_POSTAL',label: 'Caixa Postal' },
  ];

  function iconeStatus(s) {
    if (!s) return '—';
    if (s === 'ok') return '✅';
    if (s === 'pendente') return '⚠️';
    if (s === 'atrasada') return '❌';
    if (s === 'sem_dados') return '○';
    if (s === 'erro') return '🔶';
    return '—';
  }

  return (
    <section className="section-card mt-3">
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <h3 className="section-title" style={{ marginBottom: 0 }}>🏛️ Status SERPRO / e-CAC</h3>
        <button onClick={rodarAgora} disabled={rodando} className="btn btn-primary" style={{ fontSize: 13 }}>
          {rodando ? 'Iniciando...' : 'Rodar varredura agora'}
        </button>
      </div>

      <p className="text-light text-sm" style={{ marginTop: 0 }}>
        Status das obrigacoes federais alimentado por varredura diaria (SERPRO Integra Contador). Atualizado em lote, nao em tempo real.
      </p>

      {carregando && <div className="text-muted text-sm">Carregando snapshot…</div>}
      {erro && <div className="alert alert-warning text-sm">Erro ao carregar snapshot: {erro}</div>}
      {!carregando && dados.length === 0 && (
        <div className="alert alert-warning text-sm">
          <strong>Snapshot vazio.</strong> A varredura diaria ainda nao rodou. Clique em "Rodar varredura agora" pra popular a primeira vez (leva ~13min).
        </div>
      )}

      {dados.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              className="form-control"
              style={{ maxWidth: 260 }}
              placeholder="Buscar cliente..."
              value={filtroBusca}
              onChange={e => setFiltroBusca(e.target.value)}
            />
            <select className="form-control" style={{ maxWidth: 220 }}
              value={filtroStatus} onChange={e => setFiltroStatus(e.target.value)}>
              <option value="todos">Todos</option>
              <option value="pendencias">So com pendencia/erro</option>
            </select>
            <div className="text-muted text-sm" style={{ alignSelf: 'center' }}>
              Mostrando {clientes.length} cliente(s)
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="matriz-entregas">
              <thead>
                <tr>
                  <th>Cliente</th>
                  {OBRIGACOES.map(o => <th key={o.key} style={{ textAlign: 'center', width: 120 }}>{o.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {clientes.slice(0, 80).map(c => (
                  <tr key={c.id}>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13.5 }}>{c.razao}</div>
                      <div className="text-muted text-sm" style={{ fontFamily: 'var(--font-mono)' }}>{c.cnpj}</div>
                    </td>
                    {OBRIGACOES.map(o => {
                      const row = c.obrigacoes[o.key];
                      const titulo = row ? (row.resumo || row.status) + (row.erro ? ' — ' + row.erro : '') : 'Sem dados';
                      return (
                        <td key={o.key} style={{ textAlign: 'center' }}>
                          <span title={titulo} style={{ fontSize: 18 }}>{iconeStatus(row && row.status)}</span>
                          {row && row.resumo && (
                            <div className="text-muted" style={{ fontSize: 10.5, marginTop: 2 }}>{row.resumo.slice(0, 30)}</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {clientes.length > 80 && (
            <div className="text-muted text-sm mt-2">Mostrando primeiros 80. Use os filtros pra refinar.</div>
          )}
          <div className="text-muted text-sm mt-2">
            Legenda: ✅ ok · ⚠️ pendente · ❌ atrasada · 🔶 erro na consulta · ○ sem dados
          </div>
        </>
      )}
    </section>
  );
}
