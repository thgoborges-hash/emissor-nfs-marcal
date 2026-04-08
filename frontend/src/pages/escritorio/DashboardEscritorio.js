import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { notasFiscaisApi, clientesApi, iaApi } from '../../services/api';

const STATUS_LABELS = {
  rascunho: 'Rascunho', pendente_aprovacao: 'Pendente', aprovada: 'Aprovada',
  processando: 'Processando', emitida: 'Emitida', rejeitada: 'Rejeitada', cancelada: 'Cancelada',
  pendente_emissao: 'Aguardando Emissão', erro_emissao: 'Erro na Emissão'
};

export default function DashboardEscritorio() {
  const [resumo, setResumo] = useState(null);
  const [clientes, setClientes] = useState([]);
  const [creditos, setCreditos] = useState(null);
  const [nfsComErro, setNfsComErro] = useState([]);
  const [reemitindo, setReemitindo] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const navigate = useNavigate();

  const carregarDados = () => {
    Promise.all([
      notasFiscaisApi.resumo(),
      clientesApi.listar(),
      iaApi.creditos().catch(() => ({ data: null })),
      notasFiscaisApi.listar({ status: 'erro_emissao', limit: 20 }).catch(() => ({ data: { dados: [] } }))
    ]).then(([resResumo, resClientes, resCreditos, resErros]) => {
      setResumo(resResumo.data);
      setClientes(resClientes.data);
      setCreditos(resCreditos.data);
      setNfsComErro(resErros.data.dados || []);
    }).catch(console.error)
      .finally(() => setCarregando(false));
  };

  useEffect(() => { carregarDados(); }, []);

  const handleReemitir = async (id) => {
    setReemitindo(id);
    try {
      await notasFiscaisApi.emitir(id);
      carregarDados();
    } catch (err) {
      alert(err.response?.data?.erro || 'Erro ao re-emitir');
    } finally {
      setReemitindo(null);
    }
  };

  if (carregando) return <p>Carregando...</p>;

  const formatarMoeda = (valor) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);

  const totalPendentes = clientes.reduce((sum, c) => sum + (c.nfs_pendentes || 0), 0);

  return (
    <div>
      <h1 className="page-title">Painel do Escritório</h1>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="label">Clientes ativos</div>
          <div className="valor primary">{clientes.filter(c => c.ativo).length}</div>
        </div>
        <div className="kpi-card">
          <div className="label">NFs este mês</div>
          <div className="valor">{resumo?.total_mes?.total || 0}</div>
        </div>
        <div className="kpi-card">
          <div className="label">Faturamento total do mês</div>
          <div className="valor success">{formatarMoeda(resumo?.total_mes?.valor)}</div>
        </div>
        <div className="kpi-card" onClick={() => navigate('/escritorio/aprovacoes')} style={{ cursor: 'pointer' }}>
          <div className="label">Pendentes de aprovação</div>
          <div className="valor warning">{totalPendentes}</div>
        </div>
        {nfsComErro.length > 0 && (
          <div className="kpi-card" style={{ cursor: 'default', borderTop: '3px solid var(--danger)' }}>
            <div className="label">Erros de emissão</div>
            <div className="valor" style={{ color: 'var(--danger)' }}>{nfsComErro.length}</div>
          </div>
        )}
      </div>

      {/* Clientes com pendências */}
      {totalPendentes > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--warning)' }}>
          <h3 className="card-title" style={{ marginBottom: 12 }}>Notas aguardando aprovação</h3>
          {clientes.filter(c => c.nfs_pendentes > 0).map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <strong>{c.razao_social}</strong>
                <span style={{ marginLeft: 8, fontSize: 13, color: 'var(--text-light)' }}>{c.cnpj}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className="badge badge-pendente_aprovacao">{c.nfs_pendentes} pendente{c.nfs_pendentes > 1 ? 's' : ''}</span>
                <button className="btn btn-primary btn-sm" onClick={() => navigate('/escritorio/aprovacoes')}>
                  Revisar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* NFs com erro de emissão */}
      {nfsComErro.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--danger)' }}>
          <h3 className="card-title" style={{ marginBottom: 12, color: 'var(--danger)' }}>
            Notas com erro de emissão ({nfsComErro.length})
          </h3>
          {nfsComErro.map(nf => (
            <div key={nf.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--text-light)' }}>
                    DPS #{nf.numero_dps} &middot; {nf.cliente_razao_social}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>
                    {formatarMoeda(nf.valor_servico)} — {nf.tomador_razao_social || 'Sem tomador'}
                  </div>
                  {nf.observacoes && (
                    <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4, background: '#fef2f2', padding: '4px 8px', borderRadius: 4 }}>
                      {nf.observacoes}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-light)', marginTop: 2 }}>
                    Origem: {nf.origem} &middot; {new Date(nf.created_at).toLocaleString('pt-BR')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button
                    className="btn btn-success btn-sm"
                    onClick={() => handleReemitir(nf.id)}
                    disabled={reemitindo === nf.id}
                  >
                    {reemitindo === nf.id ? 'Emitindo...' : 'Re-emitir'}
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => navigate('/escritorio/notas')}
                  >
                    Detalhes
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Créditos IA */}
      {creditos && (
        <div className="card" style={{ borderLeft: '4px solid #7c3aed' }}>
          <h3 className="card-title" style={{ marginBottom: 12 }}>
            Uso da IA (Anthropic API)
          </h3>
          {!creditos.configurado ? (
            <div style={{ padding: '8px 0', color: 'var(--text-light)' }}>
              <p>{creditos.mensagem}</p>
              {creditos.instrucoes && (
                <p style={{ fontSize: 13, marginTop: 8 }}>{creditos.instrucoes}</p>
              )}
            </div>
          ) : creditos.erro ? (
            <p style={{ color: 'var(--danger)' }}>{creditos.erro}</p>
          ) : (
            <div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--text-light)' }}>Gasto hoje</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#7c3aed' }}>
                    US$ {creditos.custos?.hoje_usd || '0.00'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--text-light)' }}>Gasto 30 dias</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>
                    US$ {creditos.custos?.total_30d_usd || '0.00'}
                  </div>
                </div>
              </div>
              {creditos.custos?.por_dia?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-light)', marginBottom: 6 }}>Últimos 7 dias</div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 50 }}>
                    {creditos.custos.por_dia.map((d, i) => {
                      const max = Math.max(...creditos.custos.por_dia.map(x => x.custo_usd), 0.01);
                      const h = Math.max((d.custo_usd / max) * 40, 2);
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div style={{
                            width: '100%', height: h, background: '#7c3aed',
                            borderRadius: 2, minWidth: 8
                          }} title={`US$ ${d.custo_usd.toFixed(2)}`} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {creditos.uso?.por_modelo && Object.keys(creditos.uso.por_modelo).length > 0 && (
                <div style={{ fontSize: 13, color: 'var(--text-light)' }}>
                  Modelos usados: {Object.keys(creditos.uso.por_modelo).join(', ')}
                </div>
              )}
              <a href={creditos.link_console} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 13, color: '#7c3aed', marginTop: 8, display: 'inline-block' }}>
                Ver detalhes no Console Anthropic
              </a>
            </div>
          )}
        </div>
      )}

      {/* Últimas NFs */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Últimas notas fiscais</h3>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/escritorio/emitir')}>
            + Nova NF
          </button>
        </div>
        {resumo?.ultimas_notas?.length > 0 ? (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>DPS #</th>
                  <th>Tomador</th>
                  <th>Valor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {resumo.ultimas_notas.map(nf => (
                  <tr key={nf.id}>
                    <td>{nf.cliente}</td>
                    <td>{nf.numero_dps}</td>
                    <td>{nf.tomador || '-'}</td>
                    <td>{formatarMoeda(nf.valor_servico)}</td>
                    <td><span className={`badge badge-${nf.status}`}>{STATUS_LABELS[nf.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <p>Nenhuma nota fiscal emitida ainda.</p>
          </div>
        )}
      </div>
    </div>
  );
}
