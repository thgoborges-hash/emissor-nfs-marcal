import React, { useState, useEffect, useCallback } from 'react';
import { notasFiscaisApi, clientesApi } from '../../services/api';

const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);
}

function formatarMes(mesStr) {
  if (!mesStr) return '';
  const [ano, mes] = mesStr.split('-');
  return `${MESES[parseInt(mes) - 1]}/${ano}`;
}

// Mini gráfico de barras em CSS puro
function GraficoBarras({ dados, campoLabel, campoValor, cor = '#4361ee', maxBarras = 12 }) {
  if (!dados || dados.length === 0) return <p style={{ color: '#999', fontSize: 14 }}>Sem dados para exibir</p>;
  const dadosVisiveis = dados.slice(-maxBarras);
  const maxVal = Math.max(...dadosVisiveis.map(d => d[campoValor] || 0), 1);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 200, padding: '0 4px' }}>
      {dadosVisiveis.map((d, i) => {
        const pct = ((d[campoValor] || 0) / maxVal) * 100;
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 0 }}>
            <span style={{ fontSize: 10, color: '#666', marginBottom: 4, whiteSpace: 'nowrap' }}>
              {formatarMoeda(d[campoValor])}
            </span>
            <div
              style={{
                width: '100%', maxWidth: 60, height: `${Math.max(pct, 2)}%`,
                background: `linear-gradient(180deg, ${cor} 0%, ${cor}99 100%)`,
                borderRadius: '4px 4px 0 0', transition: 'height 0.3s ease',
                minHeight: 4
              }}
              title={`${d[campoLabel]}: ${formatarMoeda(d[campoValor])}`}
            />
            <span style={{ fontSize: 10, color: '#888', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
              {typeof d[campoLabel] === 'string' && d[campoLabel].includes('-') ? formatarMes(d[campoLabel]) : (d[campoLabel] || '').substring(0, 10)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// KPI Card
function KPI({ label, valor, cor = 'var(--primary)', icone = '' }) {
  return (
    <div className="kpi-card">
      <div className="label">{icone} {label}</div>
      <div className="valor" style={{ color: cor }}>{valor}</div>
    </div>
  );
}

export default function Relatorios() {
  const [clientes, setClientes] = useState([]);
  const [clienteId, setClienteId] = useState('');
  const [periodoInicio, setPeriodoInicio] = useState('');
  const [periodoFim, setPeriodoFim] = useState('');
  const [agrupamento, setAgrupamento] = useState('mes');
  const [abaAtiva, setAbaAtiva] = useState('faturamento');

  const [dadosFaturamento, setDadosFaturamento] = useState(null);
  const [dadosStatus, setDadosStatus] = useState(null);
  const [dadosRanking, setDadosRanking] = useState(null);
  const [carregando, setCarregando] = useState(false);

  // Inicializa período: últimos 12 meses
  useEffect(() => {
    const hoje = new Date();
    const inicio = new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1);
    setPeriodoInicio(inicio.toISOString().slice(0, 10));
    setPeriodoFim(hoje.toISOString().slice(0, 10));

    clientesApi.listar().then(res => setClientes(res.data)).catch(console.error);
  }, []);

  const carregarRelatorios = useCallback(async () => {
    if (!periodoInicio || !periodoFim) return;
    setCarregando(true);

    const params = {
      periodo_inicio: periodoInicio,
      periodo_fim: periodoFim,
      ...(clienteId && { cliente_id: clienteId }),
    };

    try {
      const [resFat, resStatus, resRanking] = await Promise.all([
        notasFiscaisApi.relatorioFaturamento({ ...params, agrupamento }),
        notasFiscaisApi.relatorioStatus(params),
        notasFiscaisApi.relatorioRankingTomadores({ ...params, limit: 15 }),
      ]);
      setDadosFaturamento(resFat.data);
      setDadosStatus(resStatus.data);
      setDadosRanking(resRanking.data);
    } catch (err) {
      console.error('Erro ao carregar relatórios:', err);
    } finally {
      setCarregando(false);
    }
  }, [periodoInicio, periodoFim, clienteId, agrupamento]);

  useEffect(() => {
    if (periodoInicio && periodoFim) {
      carregarRelatorios();
    }
  }, [carregarRelatorios, periodoInicio, periodoFim]);

  const STATUS_CORES = {
    emitida: '#27ae60', pendente_aprovacao: '#f39c12', rascunho: '#95a5a6',
    aprovada: '#3498db', processando: '#9b59b6', rejeitada: '#e74c3c', cancelada: '#c0392b'
  };
  const STATUS_LABELS = {
    rascunho: 'Rascunho', pendente_aprovacao: 'Pendente', aprovada: 'Aprovada',
    processando: 'Processando', emitida: 'Emitida', rejeitada: 'Rejeitada', cancelada: 'Cancelada'
  };

  const totais = dadosFaturamento?.totais || {};

  return (
    <div>
      <h1 className="page-title">Relatorios</h1>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>Periodo Inicio</label>
            <input type="date" value={periodoInicio} onChange={e => setPeriodoInicio(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14 }} />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>Periodo Fim</label>
            <input type="date" value={periodoFim} onChange={e => setPeriodoFim(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14 }} />
          </div>
          <div style={{ flex: '1 1 250px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>Cliente</label>
            <select value={clienteId} onChange={e => setClienteId(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14 }}>
              <option value="">Todos os clientes</option>
              {clientes.filter(c => c.ativo).map(c => (
                <option key={c.id} value={c.id}>{c.nome_fantasia || c.razao_social}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button className="btn btn-primary" onClick={carregarRelatorios} disabled={carregando}
              style={{ padding: '8px 24px' }}>
              {carregando ? 'Carregando...' : 'Atualizar'}
            </button>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <KPI label="Faturamento Total" valor={formatarMoeda(totais.faturamento_total)} cor="var(--success)" icone="" />
        <KPI label="NFs Emitidas" valor={totais.total_nfs || 0} cor="var(--primary)" icone="" />
        <KPI label="Clientes Ativos" valor={totais.clientes_ativos || 0} cor="#9b59b6" icone="" />
        <KPI label="Ticket Medio" valor={formatarMoeda(totais.ticket_medio)} cor="#e67e22" icone="" />
      </div>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 0, borderBottom: '2px solid var(--border)' }}>
        {[
          { id: 'faturamento', label: 'Faturamento' },
          { id: 'status', label: 'Por Status' },
          { id: 'ranking', label: 'Ranking Tomadores' },
        ].map(aba => (
          <button key={aba.id} onClick={() => setAbaAtiva(aba.id)}
            style={{
              padding: '10px 24px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
              background: abaAtiva === aba.id ? 'var(--primary)' : 'transparent',
              color: abaAtiva === aba.id ? '#fff' : 'var(--text-light)',
              borderRadius: '8px 8px 0 0', transition: 'all 0.2s'
            }}>
            {aba.label}
          </button>
        ))}
      </div>

      {/* Conteúdo da aba */}
      <div className="card" style={{ borderRadius: '0 8px 8px 8px' }}>

        {/* === ABA FATURAMENTO === */}
        {abaAtiva === 'faturamento' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="card-title" style={{ margin: 0 }}>
                Faturamento {agrupamento === 'mes' ? 'por Mes' : 'por Cliente'}
              </h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={`btn btn-sm ${agrupamento === 'mes' ? 'btn-primary' : ''}`}
                  onClick={() => setAgrupamento('mes')} style={{ fontSize: 12 }}>Por Mes</button>
                <button className={`btn btn-sm ${agrupamento === 'cliente' ? 'btn-primary' : ''}`}
                  onClick={() => setAgrupamento('cliente')} style={{ fontSize: 12 }}>Por Cliente</button>
              </div>
            </div>

            {agrupamento === 'mes' ? (
              <>
                <GraficoBarras dados={dadosFaturamento?.dados} campoLabel="mes" campoValor="faturamento" cor="#4361ee" />
                <div className="table-container" style={{ marginTop: 20 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Mes</th>
                        <th style={{ textAlign: 'right' }}>NFs</th>
                        <th style={{ textAlign: 'right' }}>Faturamento</th>
                        <th style={{ textAlign: 'right' }}>ISS</th>
                        <th style={{ textAlign: 'right' }}>Clientes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(dadosFaturamento?.dados || []).map((d, i) => (
                        <tr key={i}>
                          <td>{formatarMes(d.mes)}</td>
                          <td style={{ textAlign: 'right' }}>{d.total_nfs}</td>
                          <td style={{ textAlign: 'right' }}>{formatarMoeda(d.faturamento)}</td>
                          <td style={{ textAlign: 'right' }}>{formatarMoeda(d.total_iss)}</td>
                          <td style={{ textAlign: 'right' }}>{d.clientes_ativos}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                <GraficoBarras dados={(dadosFaturamento?.dados || []).slice(0, 10)}
                  campoLabel="nome_fantasia" campoValor="faturamento" cor="#9b59b6" />
                <div className="table-container" style={{ marginTop: 20 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>CNPJ</th>
                        <th style={{ textAlign: 'right' }}>NFs</th>
                        <th style={{ textAlign: 'right' }}>Faturamento</th>
                        <th style={{ textAlign: 'right' }}>Ticket Medio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(dadosFaturamento?.dados || []).map((d, i) => (
                        <tr key={i}>
                          <td>{d.nome_fantasia || d.razao_social}</td>
                          <td style={{ fontSize: 12, color: '#888' }}>{d.cnpj}</td>
                          <td style={{ textAlign: 'right' }}>{d.total_nfs}</td>
                          <td style={{ textAlign: 'right' }}>{formatarMoeda(d.faturamento)}</td>
                          <td style={{ textAlign: 'right' }}>{formatarMoeda(d.ticket_medio)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* === ABA STATUS === */}
        {abaAtiva === 'status' && (
          <div>
            <h3 className="card-title">Distribuicao por Status</h3>

            {/* Cards de status */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
              {(dadosStatus?.por_status || []).map(s => (
                <div key={s.status} style={{
                  padding: '14px 16px', borderRadius: 8,
                  border: `2px solid ${STATUS_CORES[s.status] || '#ccc'}`,
                  background: `${STATUS_CORES[s.status] || '#ccc'}11`,
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: 24, fontWeight: 'bold', color: STATUS_CORES[s.status] }}>{s.total}</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{STATUS_LABELS[s.status] || s.status}</div>
                  <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>{formatarMoeda(s.valor)}</div>
                </div>
              ))}
            </div>

            {/* Tabela mensal por status */}
            <h4 style={{ marginBottom: 12, color: '#555' }}>Evolucao Mensal</h4>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Mes</th>
                    {Object.keys(STATUS_LABELS).map(s => (
                      <th key={s} style={{ textAlign: 'center' }}>{STATUS_LABELS[s]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const meses = [...new Set((dadosStatus?.por_mes_status || []).map(d => d.mes))].sort();
                    return meses.map(mes => {
                      const dados = (dadosStatus?.por_mes_status || []).filter(d => d.mes === mes);
                      return (
                        <tr key={mes}>
                          <td>{formatarMes(mes)}</td>
                          {Object.keys(STATUS_LABELS).map(s => {
                            const d = dados.find(x => x.status === s);
                            return (
                              <td key={s} style={{ textAlign: 'center', color: d ? STATUS_CORES[s] : '#ddd', fontWeight: d ? 600 : 400 }}>
                                {d ? d.total : '-'}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* === ABA RANKING TOMADORES === */}
        {abaAtiva === 'ranking' && (
          <div>
            <h3 className="card-title">Ranking de Tomadores (Top 15)</h3>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Tomador</th>
                    <th>Documento</th>
                    <th>Cliente</th>
                    <th style={{ textAlign: 'right' }}>NFs</th>
                    <th style={{ textAlign: 'right' }}>Faturamento</th>
                    <th>Ultima NF</th>
                  </tr>
                </thead>
                <tbody>
                  {(dadosRanking?.ranking || []).map((t, i) => (
                    <tr key={t.id}>
                      <td>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 28, height: 28, borderRadius: '50%', fontSize: 12, fontWeight: 'bold',
                          background: i < 3 ? ['#ffd700', '#c0c0c0', '#cd7f32'][i] : '#eee',
                          color: i < 3 ? '#fff' : '#666'
                        }}>{i + 1}</span>
                      </td>
                      <td>
                        <strong>{t.razao_social}</strong>
                      </td>
                      <td style={{ fontSize: 12, color: '#888' }}>{t.documento}</td>
                      <td style={{ fontSize: 13 }}>{t.cliente_razao_social}</td>
                      <td style={{ textAlign: 'right' }}>{t.total_nfs}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--success)' }}>{formatarMoeda(t.faturamento)}</td>
                      <td style={{ fontSize: 12, color: '#888' }}>{t.ultima_nf}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(!dadosRanking?.ranking || dadosRanking.ranking.length === 0) && (
              <div className="empty-state" style={{ padding: 40 }}>
                <p>Nenhum tomador encontrado no periodo selecionado.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
