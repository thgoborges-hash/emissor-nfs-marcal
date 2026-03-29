import React, { useState, useEffect } from 'react';
import { notasFiscaisApi } from '../../services/api';

export default function Aprovacoes() {
  const [notas, setNotas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [processando, setProcessando] = useState(null);

  const carregarPendentes = async () => {
    try {
      const { data } = await notasFiscaisApi.listar({ status: 'pendente_aprovacao', limit: 50 });
      setNotas(data.dados);
    } catch (err) {
      console.error(err);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregarPendentes(); }, []);

  const formatarMoeda = (valor) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);

  const handleAprovar = async (id) => {
    setProcessando(id);
    try {
      await notasFiscaisApi.aprovar(id);
      // Emite automaticamente após aprovação
      if (window.confirm('Nota aprovada! Deseja emitir agora?')) {
        await notasFiscaisApi.emitir(id);
      }
      carregarPendentes();
    } catch (err) {
      alert(err.response?.data?.erro || 'Erro ao aprovar');
    } finally {
      setProcessando(null);
    }
  };

  const handleRejeitar = async (id) => {
    const motivo = prompt('Motivo da rejeição:');
    if (!motivo) return;

    setProcessando(id);
    try {
      await notasFiscaisApi.rejeitar(id, motivo);
      carregarPendentes();
    } catch (err) {
      alert(err.response?.data?.erro || 'Erro ao rejeitar');
    } finally {
      setProcessando(null);
    }
  };

  const handleAprovarTodas = async () => {
    if (!window.confirm(`Aprovar todas as ${notas.length} notas pendentes?`)) return;

    for (const nota of notas) {
      try {
        await notasFiscaisApi.aprovar(nota.id);
      } catch (err) {
        console.error(`Erro ao aprovar NF #${nota.numero_dps}:`, err);
      }
    }
    carregarPendentes();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Fila de Aprovação</h1>
        {notas.length > 1 && (
          <button className="btn btn-success" onClick={handleAprovarTodas}>
            Aprovar todas ({notas.length})
          </button>
        )}
      </div>

      {carregando ? (
        <p>Carregando...</p>
      ) : notas.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="icon">✅</div>
            <p>Nenhuma nota pendente de aprovação.</p>
            <p style={{ fontSize: 13, color: 'var(--text-light)' }}>Todas as solicitações foram processadas!</p>
          </div>
        </div>
      ) : (
        notas.map(nf => (
          <div key={nf.id} className="card" style={{ borderLeft: '4px solid var(--warning)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-light)', marginBottom: 4 }}>
                  DPS #{nf.numero_dps} &middot; {nf.cliente_razao_social} ({nf.cliente_cnpj})
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                  {formatarMoeda(nf.valor_servico)}
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-light)', marginLeft: 8 }}>
                    ISS {(nf.aliquota_iss * 100).toFixed(1)}% {nf.iss_retido ? '(retido)' : ''}
                  </span>
                </div>
                <div style={{ fontSize: 14 }}>
                  <strong>Tomador:</strong> {nf.tomador_razao_social || 'Não informado'} {nf.tomador_documento ? `(${nf.tomador_documento})` : ''}
                </div>
                <div style={{ fontSize: 14 }}>
                  <strong>Serviço:</strong> {nf.descricao_servico}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-light)', marginTop: 4 }}>
                  Competência: {nf.data_competencia} &middot; Criada em: {new Date(nf.created_at).toLocaleString('pt-BR')}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  className="btn btn-success"
                  onClick={() => handleAprovar(nf.id)}
                  disabled={processando === nf.id}
                >
                  {processando === nf.id ? 'Processando...' : 'Aprovar'}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => handleRejeitar(nf.id)}
                  disabled={processando === nf.id}
                >
                  Rejeitar
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
