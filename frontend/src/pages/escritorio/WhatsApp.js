import React, { useState, useEffect, useRef } from 'react';

const API_BASE = '/api';

function getHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

export default function WhatsApp() {
  const [conversas, setConversas] = useState([]);
  const [conversaSelecionada, setConversaSelecionada] = useState(null);
  const [mensagens, setMensagens] = useState([]);
  const [novaMensagem, setNovaMensagem] = useState('');
  const [status, setStatus] = useState(null);
  const [filtro, setFiltro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const mensagensRef = useRef(null);

  // Carrega status do serviço
  useEffect(() => {
    fetch(`${API_BASE}/whatsapp/status`, { headers: getHeaders() })
      .then(r => r.json())
      .then(setStatus)
      .catch(console.error);
  }, []);

  // Carrega conversas
  const carregarConversas = () => {
    fetch(`${API_BASE}/whatsapp/conversas`, { headers: getHeaders() })
      .then(r => r.json())
      .then(data => { setConversas(data); setCarregando(false); })
      .catch(err => { console.error(err); setCarregando(false); });
  };

  useEffect(() => {
    carregarConversas();
    const interval = setInterval(carregarConversas, 10000); // Refresh a cada 10s
    return () => clearInterval(interval);
  }, []);

  // Carrega mensagens da conversa selecionada
  const selecionarConversa = (conv) => {
    setConversaSelecionada(conv);
    fetch(`${API_BASE}/whatsapp/conversas/${conv.id}/mensagens`, { headers: getHeaders() })
      .then(r => r.json())
      .then(data => {
        setMensagens(data);
        setTimeout(() => {
          if (mensagensRef.current) {
            mensagensRef.current.scrollTop = mensagensRef.current.scrollHeight;
          }
        }, 100);
      })
      .catch(console.error);
  };

  // Refresh mensagens da conversa ativa
  useEffect(() => {
    if (!conversaSelecionada) return;
    const interval = setInterval(() => {
      fetch(`${API_BASE}/whatsapp/conversas/${conversaSelecionada.id}/mensagens`, { headers: getHeaders() })
        .then(r => r.json())
        .then(setMensagens)
        .catch(console.error);
    }, 5000);
    return () => clearInterval(interval);
  }, [conversaSelecionada]);

  // Envia mensagem humana
  const enviarMensagem = async () => {
    if (!novaMensagem.trim() || !conversaSelecionada) return;
    setEnviando(true);
    try {
      await fetch(`${API_BASE}/whatsapp/conversas/${conversaSelecionada.id}/responder`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ mensagem: novaMensagem })
      });
      setNovaMensagem('');
      // Refresh mensagens
      const r = await fetch(`${API_BASE}/whatsapp/conversas/${conversaSelecionada.id}/mensagens`, { headers: getHeaders() });
      setMensagens(await r.json());
      setTimeout(() => {
        if (mensagensRef.current) mensagensRef.current.scrollTop = mensagensRef.current.scrollHeight;
      }, 100);
    } catch (err) {
      alert('Erro ao enviar mensagem');
    }
    setEnviando(false);
  };

  // Transferir conversa
  const transferirConversa = async (id, acao) => {
    const endpoint = acao === 'humano' ? 'transferir' : 'devolver-bot';
    await fetch(`${API_BASE}/whatsapp/conversas/${id}/${endpoint}`, {
      method: 'PUT', headers: getHeaders()
    });
    carregarConversas();
  };

  // Filtra conversas
  const conversasFiltradas = conversas.filter(c => {
    if (!filtro) return true;
    const texto = `${c.nome || ''} ${c.razao_social || ''} ${c.telefone || ''} ${c.ultima_mensagem || ''}`.toLowerCase();
    return texto.includes(filtro.toLowerCase());
  });

  const formatarHora = (dt) => {
    if (!dt) return '';
    const d = new Date(dt);
    const hoje = new Date();
    if (d.toDateString() === hoje.toDateString()) {
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
           d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>WhatsApp</h1>
        {status && (
          <div style={{ display: 'flex', gap: 12 }}>
            <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: '0.8rem',
              background: status.whatsapp_configurado ? '#dcfce7' : '#fee2e2',
              color: status.whatsapp_configurado ? '#166534' : '#991b1b' }}>
              {status.whatsapp_configurado ? '🟢 WhatsApp ativo' : '🔴 WhatsApp não configurado'}
            </span>
            <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: '0.8rem',
              background: status.ia_configurada ? '#dcfce7' : '#fee2e2',
              color: status.ia_configurada ? '#166534' : '#991b1b' }}>
              {status.ia_configurada ? '🤖 IA ativa' : '🔴 IA não configurada'}
            </span>
          </div>
        )}
      </div>

      {!status?.whatsapp_configurado && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>
          <strong>WhatsApp não configurado.</strong> Configure as variáveis de ambiente no Render:
          <code style={{ display: 'block', marginTop: 8, background: '#1a1a2e', color: '#e0e0e0', padding: 12, borderRadius: 8, fontSize: '0.85rem' }}>
            WHATSAPP_PHONE_ID=seu_phone_number_id{'\n'}
            WHATSAPP_TOKEN=seu_access_token{'\n'}
            WHATSAPP_VERIFY_TOKEN=marcal_verify_2026{'\n'}
            ANTHROPIC_API_KEY=sua_chave_anthropic
          </code>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 200px)', minHeight: 500 }}>
        {/* Lista de conversas */}
        <div style={{ width: 350, flexShrink: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Buscar conversa..." value={filtro} onChange={(e) => setFiltro(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8 }} />
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {carregando ? <p style={{ padding: 16, color: 'var(--text-light)' }}>Carregando...</p> :
             conversasFiltradas.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)' }}>
                <div style={{ fontSize: '2rem', marginBottom: 8 }}>💬</div>
                <p>Nenhuma conversa ainda</p>
              </div>
            ) : conversasFiltradas.map(c => (
              <div key={c.id} onClick={() => selecionarConversa(c)}
                style={{
                  padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                  background: conversaSelecionada?.id === c.id ? '#eff6ff' : 'transparent'
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: '0.9rem' }}>{c.nome || c.razao_social || c.telefone}</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>{formatarHora(c.ultimo_mensagem_at)}</span>
                </div>
                {c.razao_social && c.nome && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--primary)' }}>{c.razao_social}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                    {c.ultima_mensagem || '...'}
                  </span>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {c.nao_lidas > 0 && (
                      <span style={{ background: '#25d366', color: '#fff', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem' }}>
                        {c.nao_lidas}
                      </span>
                    )}
                    {c.status === 'aguardando_humano' && (
                      <span style={{ background: '#f59e0b', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: '0.65rem' }}>HUMANO</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Área de mensagens */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
          {!conversaSelecionada ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-light)' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '3rem', marginBottom: 12 }}>📱</div>
                <p>Selecione uma conversa para visualizar</p>
              </div>
            </div>
          ) : (
            <>
              {/* Header da conversa */}
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
                <div>
                  <strong>{conversaSelecionada.nome || conversaSelecionada.telefone}</strong>
                  {conversaSelecionada.razao_social && <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--primary)' }}>{conversaSelecionada.razao_social}</span>}
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>
                    {conversaSelecionada.telefone}
                    {conversaSelecionada.status === 'aguardando_humano' && <span style={{ marginLeft: 8, color: '#f59e0b' }}>⚡ Atendimento humano</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {conversaSelecionada.status === 'ativa' ? (
                    <button className="btn btn-outline btn-sm" onClick={() => transferirConversa(conversaSelecionada.id, 'humano')}>
                      👤 Assumir
                    </button>
                  ) : (
                    <button className="btn btn-outline btn-sm" onClick={() => transferirConversa(conversaSelecionada.id, 'bot')}>
                      🤖 Devolver ao Bot
                    </button>
                  )}
                </div>
              </div>

              {/* Mensagens */}
              <div ref={mensagensRef} style={{ flex: 1, overflow: 'auto', padding: 16, background: '#e5ddd5', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {mensagens.map(msg => (
                  <div key={msg.id} style={{
                    alignSelf: msg.direcao === 'saida' ? 'flex-end' : 'flex-start',
                    maxWidth: '70%'
                  }}>
                    <div style={{
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: msg.direcao === 'saida' ? '#dcf8c6' : '#fff',
                      boxShadow: '0 1px 1px rgba(0,0,0,0.1)',
                      borderTopLeftRadius: msg.direcao === 'entrada' ? 0 : 8,
                      borderTopRightRadius: msg.direcao === 'saida' ? 0 : 8,
                    }}>
                      {msg.remetente && msg.direcao === 'saida' && (
                        <div style={{ fontSize: '0.7rem', color: msg.remetente === 'bot' ? '#6366f1' : '#059669', marginBottom: 2 }}>
                          {msg.remetente === 'bot' ? '🤖 Bot' : msg.remetente === 'sistema' ? '⚙️ Sistema' : '👤 Atendente'}
                        </div>
                      )}
                      <div style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>{msg.conteudo}</div>
                      <div style={{ fontSize: '0.65rem', color: '#999', textAlign: 'right', marginTop: 2 }}>
                        {formatarHora(msg.created_at)}
                        {msg.direcao === 'saida' && (
                          <span style={{ marginLeft: 4 }}>
                            {msg.status_envio === 'lida' ? '✓✓' : msg.status_envio === 'entregue' ? '✓✓' : '✓'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Input de mensagem */}
              <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8, background: '#f0f2f5' }}>
                <input type="text" value={novaMensagem} onChange={(e) => setNovaMensagem(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && enviarMensagem()}
                  placeholder="Digite uma mensagem..." disabled={enviando}
                  style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 20, outline: 'none' }} />
                <button className="btn btn-primary" onClick={enviarMensagem} disabled={enviando || !novaMensagem.trim()}
                  style={{ borderRadius: 20, padding: '8px 20px' }}>
                  {enviando ? '...' : 'Enviar'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
