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

  const badges = { pendente: '#f39c12', aprovado: '#27ae60', rejeitado: '#e74c3c', executado: '#3498db', falhou: '#c0392b' };

  return (
    <div>
      <h1 className="page-title">🤖 Fila de Aprovação da ANA</h1>
      <p style={{ color: '#666', marginTop: -8, marginBottom: 24 }}>
        Ações sensíveis que a ANA preparou e precisam de aval humano antes de executar (emissão DAS, cancelamento NF, DRE de extrato, etc.)
      </p>

      <div style={{ marginBottom: 16 }}>
        {['pendente', 'aprovado', 'rejeitado', 'executado', 'falhou'].map(s => (
          <button
            key={s}
            onClick={() => setFiltro(s)}
            style={{
              padding: '6px 16px', marginRight: 8, border: 'none', borderRadius: 4, cursor: 'pointer',
              background: filtro === s ? badges[s] : '#eee',
              color: filtro === s ? '#fff' : '#333',
              fontWeight: filtro === s ? 600 : 400,
              textTransform: 'capitalize',
            }}
          >{s}</button>
        ))}
        <button onClick={carregar} style={{ padding: '6px 16px', border: 'none', borderRadius: 4, background: '#ddd', cursor: 'pointer', marginLeft: 16 }}>
          ↻ Recarregar
        </button>
      </div>

      {carregando ? (
        <p>Carregando...</p>
      ) : itens.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', background: '#fafafa', borderRadius: 8 }}>
          <p style={{ fontSize: 18, color: '#666' }}>Nenhum item {filtro} na fila.</p>
          {filtro === 'pendente' && <p style={{ color: '#999', fontSize: 13 }}>Quando a ANA preparar algo sensível, vai aparecer aqui.</p>}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
          <thead style={{ background: '#f5f5f5' }}>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Ação</th>
              <th style={th}>Cliente</th>
              <th style={th}>Descrição</th>
              <th style={th}>Origem</th>
              <th style={th}>Criado</th>
              {filtro === 'pendente' && <th style={th}>Ações</th>}
              {filtro !== 'pendente' && <th style={th}>Decidido</th>}
            </tr>
          </thead>
          <tbody>
            {itens.map(it => (
              <tr key={it.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={td}>{it.id}</td>
                <td style={td}><code style={{ fontSize: 11, background: '#f5f5f5', padding: '2px 6px', borderRadius: 3 }}>{it.tipo_acao}</code></td>
                <td style={td}>{it.cliente_nome || '—'}</td>
                <td style={td}>{it.descricao}</td>
                <td style={td}>
                  <span style={{ fontSize: 11, color: '#666' }}>
                    {it.origem}{it.origem_operador ? ` · ${it.origem_operador}` : ''}
                  </span>
                </td>
                <td style={td}>{formatarData(it.criado_em)}</td>
                {filtro === 'pendente' ? (
                  <td style={td}>
                    <button
                      disabled={processando === it.id}
                      onClick={() => aprovar(it.id)}
                      style={{ padding: '4px 12px', marginRight: 8, background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                    >✓ Aprovar</button>
                    <button
                      disabled={processando === it.id}
                      onClick={() => rejeitar(it.id)}
                      style={{ padding: '4px 12px', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                    >✗ Rejeitar</button>
                  </td>
                ) : (
                  <td style={td}>
                    <span style={{ color: '#666', fontSize: 12 }}>
                      {it.decidido_por_nome} · {formatarData(it.decidido_em)}
                      {it.motivo_decisao && <div style={{ fontStyle: 'italic', marginTop: 4 }}>"{it.motivo_decisao}"</div>}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th = { padding: '10px 12px', textAlign: 'left', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' };
const td = { padding: '10px 12px', verticalAlign: 'top', fontSize: 14 };
