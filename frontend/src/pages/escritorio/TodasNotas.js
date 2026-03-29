import React, { useState, useEffect } from 'react';
import { notasFiscaisApi } from '../../services/api';

const STATUS_LABELS = {
  rascunho: 'Rascunho', pendente_aprovacao: 'Pendente', aprovada: 'Aprovada',
  processando: 'Processando', emitida: 'Emitida', rejeitada: 'Rejeitada', cancelada: 'Cancelada'
};

export default function TodasNotas() {
  const [notas, setNotas] = useState([]);
  const [paginacao, setPaginacao] = useState({});
  const [filtros, setFiltros] = useState({ status: '', page: 1 });
  const [carregando, setCarregando] = useState(true);

  const carregarNotas = async () => {
    setCarregando(true);
    try {
      const params = { page: filtros.page, limit: 20 };
      if (filtros.status) params.status = filtros.status;
      const { data } = await notasFiscaisApi.listar(params);
      setNotas(data.dados);
      setPaginacao(data.paginacao);
    } catch (err) { console.error(err); }
    finally { setCarregando(false); }
  };

  useEffect(() => { carregarNotas(); }, [filtros]);

  const formatarMoeda = (valor) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);

  const handleEmitir = async (id) => {
    if (!window.confirm('Confirma a emissão?')) return;
    try {
      await notasFiscaisApi.emitir(id);
      carregarNotas();
    } catch (err) { alert(err.response?.data?.erro || 'Erro'); }
  };

  const handleCancelar = async (id) => {
    const motivo = prompt('Motivo do cancelamento:');
    if (!motivo) return;
    try {
      await notasFiscaisApi.cancelar(id, motivo);
      carregarNotas();
    } catch (err) { alert(err.response?.data?.erro || 'Erro'); }
  };

  return (
    <div>
      <h1 className="page-title">Todas as Notas Fiscais</h1>

      <div className="card" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div className="form-group" style={{ marginBottom: 0, maxWidth: 200 }}>
          <select value={filtros.status} onChange={(e) => setFiltros({ status: e.target.value, page: 1 })}>
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <span style={{ fontSize: 13, color: 'var(--text-light)' }}>{paginacao.total || 0} notas</span>
      </div>

      <div className="card">
        {carregando ? <p>Carregando...</p> : notas.length === 0 ? (
          <div className="empty-state"><p>Nenhuma nota encontrada.</p></div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>DPS</th>
                    <th>NFS-e</th>
                    <th>Cliente</th>
                    <th>Tomador</th>
                    <th>Valor</th>
                    <th>Competência</th>
                    <th>Origem</th>
                    <th>Status</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map(nf => (
                    <tr key={nf.id}>
                      <td><strong>{nf.numero_dps}</strong></td>
                      <td>{nf.numero_nfse || '-'}</td>
                      <td>{nf.cliente_razao_social}</td>
                      <td>{nf.tomador_razao_social || '-'}</td>
                      <td>{formatarMoeda(nf.valor_servico)}</td>
                      <td>{nf.data_competencia}</td>
                      <td style={{ fontSize: 12 }}>{nf.origem}</td>
                      <td><span className={`badge badge-${nf.status}`}>{STATUS_LABELS[nf.status]}</span></td>
                      <td>
                        {nf.status === 'aprovada' && (
                          <button className="btn btn-success btn-sm" onClick={() => handleEmitir(nf.id)}>Emitir</button>
                        )}
                        {nf.status === 'emitida' && (
                          <button className="btn btn-danger btn-sm" onClick={() => handleCancelar(nf.id)}>Cancelar</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {paginacao.totalPaginas > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
                <button className="btn btn-outline btn-sm" disabled={filtros.page <= 1} onClick={() => setFiltros(f => ({ ...f, page: f.page - 1 }))}>Anterior</button>
                <span style={{ padding: '6px 12px', fontSize: 13 }}>Página {paginacao.pagina} de {paginacao.totalPaginas}</span>
                <button className="btn btn-outline btn-sm" disabled={filtros.page >= paginacao.totalPaginas} onClick={() => setFiltros(f => ({ ...f, page: f.page + 1 }))}>Próxima</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
