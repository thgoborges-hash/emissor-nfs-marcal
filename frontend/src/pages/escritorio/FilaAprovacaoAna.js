import React, { useState, useEffect } from 'react';
import { painelApi } from '../../services/api';

export default function FilaAprovacaoAna() {
  const [itens, setItens] = useState([]);
  const [filtro, setFiltro] = useState('pendente');
  const [carregando, setCarregando] = useState(true);
  const [processando, setProcessando] = useState(null);

  const carregar = async () => {
    setCarregando(true);
    try {
      const { data } = await painelApi.listarFila(filtro);
      setItens(data.itens);
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregar(); }, [filtro]);

  const aprovar = async (id) => {
    const obs = window.prompt('Observação (opcional):') ?? '';
    setProcessando(id);
    try {
      await painelApi.aprovar(id, obs || null);
      carregar();
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    } finally {
      setProcessando(null);
    }
  };

  const rejeitar = async (id) => {
    const motivo = window.prompt('Motivo da rejeição (obrigatório):');
    if (!motivo || !motivo.trim()) return;
    setProcessando(id);
    try {
      await painelApi.rejeitar(id, motivo);
      carregar();
    } catch (err) {
      alert(err.response?.data?.erro || err.message);
    } finally {
      setProcessando(null);
    }
  };

  const formatarData = (iso) => iso ? new Date(iso).toLocaleString('pt-BR') : '';

  return (
    <div>
      <h1 className="page-title">Fila de Aprovação ANA</h1>
      <p className="page-subtitle">
        Ações sensíveis que a ANA preparou e precisam de aval humano antes de executar (emissão DAS, cancelamento NF, DRE de extrato, etc.)
      </p>

      <div className="flex-gap mt-2" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {['pendente', 'aprovado', 'rejeitado', 'executado', 'falhou'].map(s => (
          <button
            key={s}
            onClick={() => setFiltro(s)}
            className={filtro === s ? `btn btn-primary btn-sm` : 'btn btn-outline btn-sm'}
            style={{ textTransform: 'capitalize' }}
          >{s}</button>
        ))}
        <button onClick={carregar} className="btn btn-ghost btn-sm">↻ Recarregar</button>
      </div>

      {carregando ? (
        <div className="empty-state"><div className="icon">⏳</div>Carregando...</div>
      ) : itens.length === 0 ? (
        <div className="empty-state">
          <div className="icon">{filtro === 'pendente' ? '✨' : '📭'}</div>
          <div style={{ fontSize: 15, marginBottom: 6 }}>Nenhum item {filtro} na fila.</div>
          {filtro === 'pendente' && <div className="text-muted text-sm">Quando a ANA preparar algo sensível, vai aparecer aqui.</div>}
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Ação</th>
                <th>Cliente</th>
                <th>Descrição</th>
                <th>Origem</th>
                <th>Criado</th>
                <th>{filtro === 'pendente' ? 'Ações' : 'Decidido'}</th>
              </tr>
            </thead>
            <tbody>
              {itens.map(it => (
                <tr key={it.id}>
                  <td className="text-muted">{it.id}</td>
                  <td><code>{it.tipo_acao}</code></td>
                  <td>{it.cliente_nome || <span className="text-muted">—</span>}</td>
                  <td>{it.descricao}</td>
                  <td>
                    <span className="text-light text-sm">
                      {it.origem}{it.origem_operador ? ` · ${it.origem_operador}` : ''}
                    </span>
                  </td>
                  <td className="text-light text-sm">{formatarData(it.criado_em)}</td>
                  {filtro === 'pendente' ? (
                    <td>
                      <div className="flex-gap">
                        <button disabled={processando === it.id} onClick={() => aprovar(it.id)}
                          className="btn btn-success btn-sm">✓ Aprovar</button>
                        <button disabled={processando === it.id} onClick={() => rejeitar(it.id)}
                          className="btn btn-danger btn-sm">✗ Rejeitar</button>
                      </div>
                    </td>
                  ) : (
                    <td>
                      <div className="text-light text-sm">
                        {it.decidido_por_nome} · {formatarData(it.decidido_em)}
                        {it.motivo_decisao && (
                          <div style={{ fontStyle: 'italic', marginTop: 4, color: 'var(--text-muted)' }}>
                            "{it.motivo_decisao}"
                          </div>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
