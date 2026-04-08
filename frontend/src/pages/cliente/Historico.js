import React, { useState, useEffect } from 'react';
import { notasFiscaisApi } from '../../services/api';

const STATUS_LABELS = {
  rascunho: 'Rascunho',
  pendente_aprovacao: 'Aguardando Aprovação',
  aprovada: 'Aprovada',
  processando: 'Processando',
  emitida: 'Emitida',
  rejeitada: 'Rejeitada',
  cancelada: 'Cancelada',
  pendente_emissao: 'Aguardando Emissão',
  erro_emissao: 'Erro na Emissão'
};

export default function Historico() {
  const [notas, setNotas] = useState([]);
  const [paginacao, setPaginacao] = useState({});
  const [filtros, setFiltros] = useState({ status: '', page: 1 });
  const [carregando, setCarregando] = useState(true);
  const [notaSelecionada, setNotaSelecionada] = useState(null);

  const carregarNotas = async () => {
    setCarregando(true);
    try {
      const params = { page: filtros.page, limit: 15 };
      if (filtros.status) params.status = filtros.status;
      const { data } = await notasFiscaisApi.listar(params);
      setNotas(data.dados);
      setPaginacao(data.paginacao);
    } catch (err) {
      console.error(err);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregarNotas(); }, [filtros]);

  const formatarMoeda = (valor) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);

  const handleEmitir = async (id) => {
    if (!window.confirm('Confirma a emissão desta nota fiscal?')) return;
    try {
      await notasFiscaisApi.emitir(id);
      carregarNotas();
      setNotaSelecionada(null);
    } catch (err) {
      alert(err.response?.data?.erro || 'Erro ao emitir');
    }
  };

  return (
    <div>
      <h1 className="page-title">Histórico de Notas Fiscais</h1>

      {/* Filtros */}
      <div className="card" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div className="form-group" style={{ marginBottom: 0, flex: 1, maxWidth: 200 }}>
          <select
            value={filtros.status}
            onChange={(e) => setFiltros({ ...filtros, status: e.target.value, page: 1 })}
          >
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <span style={{ fontSize: 13, color: 'var(--text-light)' }}>
          {paginacao.total || 0} notas encontradas
        </span>
      </div>

      {/* Tabela */}
      <div className="card">
        {carregando ? (
          <p>Carregando...</p>
        ) : notas.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📋</div>
            <p>Nenhuma nota fiscal encontrada.</p>
          </div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>DPS #</th>
                    <th>NFS-e #</th>
                    <th>Tomador</th>
                    <th>Serviço</th>
                    <th>Valor</th>
                    <th>Competência</th>
                    <th>Status</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map(nf => (
                    <tr key={nf.id}>
                      <td><strong>{nf.numero_dps}</strong></td>
                      <td>{nf.numero_nfse || '-'}</td>
                      <td>{nf.tomador_razao_social || '-'}</td>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {nf.descricao_servico}
                      </td>
                      <td>{formatarMoeda(nf.valor_servico)}</td>
                      <td>{nf.data_competencia}</td>
                      <td><span className={`badge badge-${nf.status}`}>{STATUS_LABELS[nf.status]}</span></td>
                      <td>
                        {nf.status === 'aprovada' && (
                          <button className="btn btn-success btn-sm" onClick={() => handleEmitir(nf.id)}>
                            Emitir
                          </button>
                        )}
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ marginLeft: 4 }}
                          onClick={() => setNotaSelecionada(nf)}
                        >
                          Ver
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Paginação */}
            {paginacao.totalPaginas > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
                <button
                  className="btn btn-outline btn-sm"
                  disabled={filtros.page <= 1}
                  onClick={() => setFiltros(f => ({ ...f, page: f.page - 1 }))}
                >
                  Anterior
                </button>
                <span style={{ padding: '6px 12px', fontSize: 13 }}>
                  Página {paginacao.pagina} de {paginacao.totalPaginas}
                </span>
                <button
                  className="btn btn-outline btn-sm"
                  disabled={filtros.page >= paginacao.totalPaginas}
                  onClick={() => setFiltros(f => ({ ...f, page: f.page + 1 }))}
                >
                  Próxima
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Modal de detalhes */}
      {notaSelecionada && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000
        }}>
          <div className="card" style={{ maxWidth: 500, width: '90%', maxHeight: '80vh', overflow: 'auto' }}>
            <div className="card-header">
              <h3 className="card-title">NF #{notaSelecionada.numero_dps}</h3>
              <button className="btn btn-outline btn-sm" onClick={() => setNotaSelecionada(null)}>Fechar</button>
            </div>
            <div style={{ fontSize: 14, lineHeight: 2 }}>
              <p><strong>Status:</strong> <span className={`badge badge-${notaSelecionada.status}`}>{STATUS_LABELS[notaSelecionada.status]}</span></p>
              {notaSelecionada.numero_nfse && <p><strong>NFS-e:</strong> {notaSelecionada.numero_nfse}</p>}
              <p><strong>Tomador:</strong> {notaSelecionada.tomador_razao_social || '-'}</p>
              <p><strong>Serviço:</strong> {notaSelecionada.descricao_servico}</p>
              <p><strong>Código:</strong> {notaSelecionada.codigo_servico}</p>
              <p><strong>Valor:</strong> {formatarMoeda(notaSelecionada.valor_servico)}</p>
              <p><strong>ISS ({(notaSelecionada.aliquota_iss * 100).toFixed(1)}%):</strong> {formatarMoeda(notaSelecionada.valor_iss)}</p>
              <p><strong>Competência:</strong> {notaSelecionada.data_competencia}</p>
              {notaSelecionada.data_emissao && <p><strong>Emitida em:</strong> {new Date(notaSelecionada.data_emissao).toLocaleString('pt-BR')}</p>}
              <p><strong>Criada por:</strong> {notaSelecionada.criado_por}</p>
              <p><strong>Origem:</strong> {notaSelecionada.origem}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
