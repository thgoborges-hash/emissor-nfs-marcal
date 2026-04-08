import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { notasFiscaisApi } from '../../services/api';

const STATUS_LABELS = {
  rascunho: 'Rascunho',
  pendente_aprovacao: 'Pendente',
  aprovada: 'Aprovada',
  processando: 'Processando',
  emitida: 'Emitida',
  rejeitada: 'Rejeitada',
  cancelada: 'Cancelada',
  pendente_emissao: 'Aguardando Emissão',
  erro_emissao: 'Erro na Emissão'
};

export default function DashboardCliente() {
  const [resumo, setResumo] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    notasFiscaisApi.resumo()
      .then(({ data }) => setResumo(data))
      .catch(console.error)
      .finally(() => setCarregando(false));
  }, []);

  if (carregando) return <p>Carregando...</p>;

  const formatarMoeda = (valor) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="label">NFs este mês</div>
          <div className="valor primary">{resumo?.total_mes?.total || 0}</div>
        </div>
        <div className="kpi-card">
          <div className="label">Faturamento do mês</div>
          <div className="valor success">{formatarMoeda(resumo?.total_mes?.valor)}</div>
        </div>
        <div className="kpi-card">
          <div className="label">Emitidas no mês</div>
          <div className="valor">{resumo?.emitidas_mes?.total || 0}</div>
        </div>
        <div className="kpi-card">
          <div className="label">Pendentes de aprovação</div>
          <div className="valor warning">{resumo?.pendentes?.total || 0}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Últimas notas fiscais</h3>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/cliente/emitir')}>
            + Nova NF
          </button>
        </div>

        {resumo?.ultimas_notas?.length > 0 ? (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>DPS #</th>
                  <th>NFS-e #</th>
                  <th>Tomador</th>
                  <th>Valor</th>
                  <th>Competência</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {resumo.ultimas_notas.map(nf => (
                  <tr key={nf.id} onClick={() => navigate(`/cliente/historico`)} style={{ cursor: 'pointer' }}>
                    <td>{nf.numero_dps}</td>
                    <td>{nf.numero_nfse || '-'}</td>
                    <td>{nf.tomador || '-'}</td>
                    <td>{formatarMoeda(nf.valor_servico)}</td>
                    <td>{nf.data_competencia}</td>
                    <td><span className={`badge badge-${nf.status}`}>{STATUS_LABELS[nf.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <div className="icon">📝</div>
            <p>Nenhuma nota fiscal emitida ainda.</p>
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => navigate('/cliente/emitir')}>
              Emitir primeira NF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
