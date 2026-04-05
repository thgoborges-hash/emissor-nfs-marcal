import React, { useState, useEffect, useRef } from 'react';
import { clientesApi } from '../../services/api';

const API_BASE = '/api';

function getHeaders() {
  const token = localStorage.getItem('token');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export default function TestarAgente() {
  const [mensagem, setMensagem] = useState('');
  const [historico, setHistorico] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [clienteId, setClienteId] = useState('');
  const [status, setStatus] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const chatRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/whatsapp/agente/status`, { headers: getHeaders() })
      .then(r => r.json()).then(setStatus).catch(console.error);
    clientesApi.listar().then(r => setClientes(r.data)).catch(console.error);
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [historico]);

  const enviar = async () => {
    if (!mensagem.trim() || enviando) return;
    const msg = mensagem.trim();
    setMensagem('');
    setEnviando(true);

    // Adiciona mensagem do "cliente" ao histórico visual
    setHistorico(prev => [...prev, { role: 'user', content: msg, timestamp: new Date() }]);

    try {
      // Monta histórico para a API (sem a mensagem atual, que vai no body.mensagem)
      const historicoApi = historico.map(h => ({ role: h.role, content: h.content }));

      const res = await fetch(`${API_BASE}/whatsapp/agente/testar`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          mensagem: msg,
          cliente_id: clienteId || undefined,
          historico: historicoApi,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setHistorico(prev => [...prev, {
          role: 'assistant',
          content: data.resposta,
          acoes: data.acoes,
          tempo: data.tempo_ms,
          timestamp: new Date(),
        }]);
      } else {
        setHistorico(prev => [...prev, {
          role: 'system',
          content: `Erro: ${data.erro}`,
          timestamp: new Date(),
        }]);
      }
    } catch (err) {
      setHistorico(prev => [...prev, {
        role: 'system',
        content: `Erro de conexao: ${err.message}`,
        timestamp: new Date(),
      }]);
    } finally {
      setEnviando(false);
    }
  };

  const limparChat = () => {
    setHistorico([]);
  };

  const iaOk = status?.agente_ia?.configurado;
  const clienteSelecionado = clientes.find(c => c.id === parseInt(clienteId));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Testar Agente IA</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {status && (
            <>
              <span style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 12,
                background: iaOk ? '#dcfce7' : '#fee2e2',
                color: iaOk ? '#166534' : '#991b1b'
              }}>
                {iaOk ? '🤖 IA ativa' : '🔴 IA nao configurada'}
              </span>
              <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, background: '#e0e7ff', color: '#3730a3' }}>
                {status.agente_ia?.modelo}
              </span>
            </>
          )}
        </div>
      </div>

      <p style={{ color: '#666', fontSize: 14, marginBottom: 20 }}>
        Simule uma conversa como se fosse um cliente no WhatsApp. O agente IA vai responder usando os dados reais do sistema.
      </p>

      {/* Configuracao */}
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 300px' }}>
            <label style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>
              Simular como cliente (opcional):
            </label>
            <select value={clienteId} onChange={e => setClienteId(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14 }}>
              <option value="">Cliente nao identificado</option>
              {clientes.filter(c => c.ativo).map(c => (
                <option key={c.id} value={c.id}>{c.nome_fantasia || c.razao_social} ({c.cnpj})</option>
              ))}
            </select>
          </div>
          <button className="btn" onClick={limparChat} style={{ padding: '8px 16px' }}>
            Limpar conversa
          </button>
        </div>
        {clienteSelecionado && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
            O agente tera acesso aos dados de: <strong>{clienteSelecionado.razao_social}</strong> — NFs, tomadores, resumo financeiro
          </div>
        )}
      </div>

      {/* Chat */}
      <div style={{
        border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden',
        height: 'calc(100vh - 380px)', minHeight: 350, display: 'flex', flexDirection: 'column',
        background: '#e5ddd5'  // WhatsApp-style background
      }}>
        {/* Area de mensagens */}
        <div ref={chatRef} style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {historico.length === 0 && (
            <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🤖</div>
              <p>Envie uma mensagem para testar o agente.</p>
              <p style={{ fontSize: 13 }}>
                Exemplos: "Oi, preciso de ajuda", "Qual o status das minhas notas?", "Quero emitir uma nota fiscal"
              </p>
            </div>
          )}
          {historico.map((msg, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : msg.role === 'system' ? 'center' : 'flex-start',
              marginBottom: 8,
            }}>
              <div style={{
                maxWidth: '75%',
                padding: '8px 14px',
                borderRadius: msg.role === 'user' ? '12px 12px 0 12px' : '12px 12px 12px 0',
                background: msg.role === 'user' ? '#dcf8c6' : msg.role === 'system' ? '#fee2e2' : '#fff',
                boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                fontSize: 14, lineHeight: 1.5,
              }}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>
                  {msg.role === 'user' ? '👤 Cliente (voce)' : msg.role === 'assistant' ? '🤖 Agente IA' : '⚠️ Sistema'}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                {msg.acoes && msg.acoes.length > 0 && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #ccc' }}>
                    {msg.acoes.map((a, j) => (
                      <span key={j} style={{
                        display: 'inline-block', background: '#e0e7ff', color: '#3730a3',
                        padding: '2px 8px', borderRadius: 12, fontSize: 11, marginRight: 4
                      }}>
                        {a.tipo}{a.parametro ? `: ${a.parametro}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {msg.tempo && (
                  <div style={{ fontSize: 10, color: '#aaa', marginTop: 4, textAlign: 'right' }}>
                    {msg.tempo}ms
                  </div>
                )}
              </div>
            </div>
          ))}
          {enviando && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 8 }}>
              <div style={{
                padding: '10px 18px', borderRadius: '12px 12px 12px 0',
                background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                fontSize: 14, color: '#999'
              }}>
                🤖 Digitando...
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8, background: '#f0f2f5' }}>
          <input type="text" value={mensagem}
            onChange={e => setMensagem(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && enviar()}
            placeholder={iaOk ? "Digite como se fosse um cliente..." : "IA nao configurada"}
            disabled={enviando || !iaOk}
            style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 20, outline: 'none', fontSize: 14 }} />
          <button className="btn btn-primary" onClick={enviar}
            disabled={enviando || !mensagem.trim() || !iaOk}
            style={{ borderRadius: 20, padding: '8px 24px' }}>
            {enviando ? '...' : 'Enviar'}
          </button>
        </div>
      </div>
    </div>
  );
}
