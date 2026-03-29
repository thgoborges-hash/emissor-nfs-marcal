import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { notasFiscaisApi, clientesApi } from '../../services/api';

const STATUS_LABELS = {
  rascunho: 'Rascunho', pendente_aprovacao: 'Pendente', aprovada: 'Aprovada',
  processando: 'Processando', emitida: 'Emitida', rejeitada: 'Rejeitada', cancelada: 'Cancelada'
};

export default function DashboardEscritorio() {
  const [resumo, setResumo] = useState(null);
  const [clientes, setClientes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      notasFiscaisApi.resumo(),
      clientesApi.listar()
    ]).then(([resResumo, resClientes]) => {
      setResumo(resResumo.data);
      setClientes(resClientes.data);
    }).catch(console.error)
      .finally(() => setCarregando(false));
  }, []);

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
