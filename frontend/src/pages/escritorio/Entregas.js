import React, { useState, useEffect } from 'react';
import { entregasApi, integraContadorApi } from '../../services/api';
import DonutChart from '../../components/DonutChart';
import Sparkline from '../../components/Sparkline';
import { KpiGridSkeleton } from '../../components/Skeleton';

export default function Entregas() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [competencia, setCompetencia] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

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

  const sincronizarSerpro = async () => {
    if (!window.confirm('Vai consultar a SERPRO pra toda a carteira (~13min, usa créditos). Continuar?')) return;
    setSincronizando(true);
    try {
      await integraContadorApi.rodarSnapshot();
      alert('Varredura iniciada em background. Volte aqui em ~15min e recarregue a tela.');
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    } finally {
      setSincronizando(false);
    }
  };

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
  const serproInfo = dados.serpro || {};
  const serproTipos = new Set(dados.serpro_tipos || []);

  const fmtDataHora = (iso) => {
    if (!iso) return 'nunca';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

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

      {/* Banner de sincronização SERPRO */}
      <div className={`serpro-banner ${serproInfo.ultima_varredura ? 'ativo' : 'inativo'}`}>
        <div className="serpro-banner-main">
          <div className="serpro-banner-icon">⚡</div>
          <div>
            <div className="serpro-banner-title">
              Varredura SERPRO · {serproInfo.ultima_varredura ? fmtDataHora(serproInfo.ultima_varredura) : 'nunca rodou'}
            </div>
            <div className="serpro-banner-sub">
              {serproInfo.ultima_varredura
                ? `${serproInfo.clientes_com_snapshot || 0} clientes com status automático (DCTFWeb ${serproInfo.por_tipo?.DCTFWEB || 0} · PGDAS-D ${serproInfo.por_tipo?.PGDASD || 0})`
                : 'Sem snapshot. Rode pra popular DCTFWeb e PGDAS-D com dados reais da carteira.'}
            </div>
          </div>
        </div>
        <button
          onClick={sincronizarSerpro}
          disabled={sincronizando}
          className="serpro-banner-btn"
        >
          {sincronizando ? '⟳ Iniciando…' : '⟳ Sincronizar SERPRO agora'}
        </button>
      </div>

      {/* Legenda de icones */}
      <div className="entregas-legenda">
        <span className="leg-item leg-serpro">⚡<span>SERPRO auto</span></span>
        <span className="leg-item leg-ok">✓<span>em dia</span></span>
        <span className="leg-item leg-pend">○<span>pendente</span></span>
        <span className="leg-item leg-atr">!<span>atrasada</span></span>
        <span className="leg-item leg-block">⚠<span>procuração pendente</span></span>
        <span className="leg-item leg-na">—<span>não aplicável</span></span>
        <span className="leg-item leg-manual">·<span>aguardando manual</span></span>
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
                  {t.automatica && <span className="serpro-tag" title="Alimentado automaticamente via SERPRO">⚡ auto</span>}
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
            <span className="text-muted" style={{ marginLeft: 'auto' }}>
              ⚡ = coluna alimentada automaticamente pelo SERPRO · demais pedem marcação manual
            </span>
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
              {dados.ordem_tipos.map(t => {
                const isSerpro = serproTipos.has(t);
                return (
                  <th key={t} style={{ textAlign: 'center', width: 90 }} className={isSerpro ? 'col-serpro' : 'col-manual'}>
                    {dados.nomes_tipos[t]}
                    {isSerpro
                      ? <span className="serpro-tag-mini" title="Atualizado automaticamente via SERPRO">⚡</span>
                      : <span className="manual-tag-mini" title="Aguardando marcação manual ou integração futura">◦</span>}
                  </th>
                );
              })}
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
                  {c.pct === null ? (
                    <span className="pct-pill pend" title="Nenhuma obrigação ativa acompanhada (sem SERPRO nem marcação manual).">—</span>
                  ) : (
                    <span
                      className={`pct-pill ${c.pct === 1 ? 'ok' : c.atrasadas > 0 ? 'atr' : 'pend'}`}
                      title={`${c.ok} de ${c.total_ativas} ativa(s) ok`}
                    >
                      {Math.round(c.pct * 100)}%
                    </span>
                  )}
                </td>
                {dados.ordem_tipos.map(t => {
                  const e = c.entregas[t];
                  if (!e || e.status === 'nao_aplicavel') {
                    return <td key={t} style={{ textAlign: 'center' }}><span className="cell-na">—</span></td>;
                  }
                  const isSerpro = e.fonte === 'serpro';
                  const isColSerpro = serproTipos.has(t);
                  // Celula "inativa" = coluna sem integracao automatica (nao-SERPRO) E nao foi marcada
                  // pela equipe (fonte != 'manual' com responsavel de verdade). Cobre fonte='mock'
                  // e tambem linhas antigas com fonte undefined/null.
                  const marcadaEquipe = e.fonte === 'manual' && e.responsavel;
                  const isInativa = !isColSerpro && !isSerpro && !marcadaEquipe;
                  const titleTxt = isInativa
                    ? `${dados.nomes_tipos[t]}: aguardando marcação manual (sem integração automática). Clique pra marcar como OK.`
                    : e.status === 'bloqueado'
                      ? `${dados.nomes_tipos[t]}: bloqueado — SERPRO não conseguiu consultar. Provável procuração Integra Contador não outorgada ou sem os serviços marcados no e-CAC. Revisar procuração desse cliente pra Marçal (CNPJ 36.749.464/0001-42).`
                      : `${dados.nomes_tipos[t]}: ${e.status}`
                        + (e.resumo ? ` · ${e.resumo}` : '')
                        + (e.responsavel && !isSerpro ? ` · ${e.responsavel}` : '')
                        + (isSerpro ? ' · ⚡ SERPRO' : '');
                  return (
                    <td key={t} style={{ textAlign: 'center', position: 'relative' }}>
                      <button
                        className={`cell-status ${e.status} ${isSerpro ? 'cell-serpro' : ''} ${isInativa ? 'cell-inativa' : ''}`}
                        onClick={() => toggleStatus(c.id, t, e.status)}
                        title={titleTxt}
                      >
                        {isInativa ? '·' :
                          (e.status === 'ok' && '✓') ||
                          (e.status === 'pendente' && '○') ||
                          (e.status === 'atrasado' && '!') ||
                          (e.status === 'bloqueado' && '⚠')}
                      </button>
                      {isSerpro && <span className="cell-serpro-dot" title="Via SERPRO">⚡</span>}
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

      {/* Nota sobre as demais fontes */}
      <div className="entregas-nota-fontes mt-3">
        <div>
          <strong>Como são alimentadas as colunas?</strong>
        </div>
        <ul>
          <li><span className="serpro-tag-inline">⚡ SERPRO</span> <strong>DCTFWeb</strong> e <strong>PGDAS-D</strong> — snapshot automático (varredura diária ou manual). Cabeçalho com ⚡.</li>
          <li><span className="manual-tag-inline">◦ manual</span> <strong>DAS, DCTF, Folha, eSocial, EFD-Reinf, Balancete</strong> — ainda sem integração automática. Células cinza pálido = aguardando marcação manual (não é atraso real). Clique numa célula pra marcar como ok.</li>
          <li>Para ativar a varredura SERPRO automática diária, setar <code>ENABLE_SERPRO_SNAPSHOT_CRON=true</code> no Render (horário default: 06h).</li>
        </ul>
      </div>
    </div>
  );
}
