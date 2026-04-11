import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = '/api';

function getHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function apiGet(path) {
  const r = await fetch(`${API_BASE}${path}`, { headers: getHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiDelete(path) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export default function PainelAna() {
  const [status, setStatus] = useState(null);
  const [horario, setHorario] = useState(null);
  const [qrcode, setQrcode] = useState(null);
  const [carregandoQr, setCarregandoQr] = useState(false);
  const [erroQr, setErroQr] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [filtroChecklist, setFiltroChecklist] = useState('todos'); // todos|presentes|ausentes
  const [novoGrupo, setNovoGrupo] = useState('');
  const [listaEmMassa, setListaEmMassa] = useState('');
  const [salvando, setSalvando] = useState(false);

  // -------- Carregamento --------
  const carregarStatus = useCallback(async () => {
    try {
      const s = await apiGet('/whatsapp/status');
      setStatus(s);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const carregarHorario = useCallback(async () => {
    try {
      const h = await apiGet('/whatsapp/horario-comercial');
      setHorario(h);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const carregarChecklist = useCallback(async () => {
    try {
      const c = await apiGet('/whatsapp/evolution/grupos/checklist');
      setChecklist(c);
    } catch (err) {
      console.error(err);
      setChecklist({ checklist: [], total_esperados: 0, total_presentes: 0, progresso_pct: 0 });
    }
  }, []);

  useEffect(() => {
    carregarStatus();
    carregarHorario();
    carregarChecklist();
    const iv = setInterval(() => {
      carregarStatus();
      carregarChecklist();
    }, 15000);
    return () => clearInterval(iv);
  }, [carregarStatus, carregarHorario, carregarChecklist]);

  // -------- QR Code --------
  const buscarQrCode = async () => {
    setCarregandoQr(true);
    setErroQr(null);
    try {
      const r = await apiGet('/whatsapp/evolution/qrcode');
      setQrcode(r);
    } catch (err) {
      setErroQr(err.message || 'Erro ao buscar QR code');
    }
    setCarregandoQr(false);
  };

  // -------- Grupos esperados --------
  const adicionarGrupoUnico = async (e) => {
    e.preventDefault();
    if (!novoGrupo.trim()) return;
    setSalvando(true);
    try {
      await apiPost('/whatsapp/evolution/grupos/esperados', { nome: novoGrupo.trim() });
      setNovoGrupo('');
      await carregarChecklist();
    } catch (err) {
      alert('Erro ao adicionar grupo: ' + err.message);
    }
    setSalvando(false);
  };

  const adicionarEmLote = async () => {
    const nomes = listaEmMassa
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (nomes.length === 0) return;
    if (!window.confirm(`Adicionar ${nomes.length} grupos à lista de esperados?`)) return;
    setSalvando(true);
    try {
      await apiPost('/whatsapp/evolution/grupos/esperados', { lista: nomes });
      setListaEmMassa('');
      await carregarChecklist();
    } catch (err) {
      alert('Erro ao adicionar lote: ' + err.message);
    }
    setSalvando(false);
  };

  const removerGrupo = async (id) => {
    if (!window.confirm('Remover este grupo da lista esperada?')) return;
    try {
      await apiDelete(`/whatsapp/evolution/grupos/esperados/${id}`);
      await carregarChecklist();
    } catch (err) {
      alert('Erro ao remover: ' + err.message);
    }
  };

  const checklistFiltrado = (checklist?.checklist || []).filter((c) => {
    if (filtroChecklist === 'presentes') return c.presente;
    if (filtroChecklist === 'ausentes') return !c.presente;
    return true;
  });

  // -------- Helpers de renderização --------
  const isEvolution = status?.provider === 'evolution';
  const conectado = status?.conexao === 'open' || status?.conexao === 'connected';

  const chipStatus = (ativo, labelOn, labelOff) => (
    <span
      style={{
        padding: '4px 12px',
        borderRadius: 20,
        fontSize: '0.8rem',
        background: ativo ? '#dcfce7' : '#fee2e2',
        color: ativo ? '#166534' : '#991b1b',
      }}
    >
      {ativo ? labelOn : labelOff}
    </span>
  );

  return (
    <div>
      <h1 className="page-title">Painel da ANA</h1>
      <p style={{ color: 'var(--text-light)', marginTop: -8, marginBottom: 24 }}>
        Controle centralizado do agente de WhatsApp (Evolution API)
      </p>

      {/* ========== CARDS DE STATUS ========== */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 24 }}>
        {/* Provider */}
        <div style={{ background: '#fff', padding: 20, borderRadius: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', textTransform: 'uppercase', marginBottom: 8 }}>Provider</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
            {status?.provider === 'evolution' ? '🚀 Evolution API' :
             status?.provider === 'blip' ? '💬 Blip' :
             status?.provider === 'meta' ? '📘 Meta Cloud' : '—'}
          </div>
          <div style={{ marginTop: 8 }}>
            {chipStatus(status?.whatsapp_configurado, '🟢 Configurado', '🔴 Não configurado')}
          </div>
        </div>

        {/* Conexão */}
        <div style={{ background: '#fff', padding: 20, borderRadius: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', textTransform: 'uppercase', marginBottom: 8 }}>Conexão WhatsApp</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
            {conectado ? '🟢 Conectada' :
             status?.conexao === 'close' || status?.conexao === 'disconnected' ? '🔴 Desconectada' :
             status?.conexao === 'connecting' ? '🟡 Conectando...' :
             status?.conexao ? `⚪ ${status.conexao}` : '—'}
          </div>
          {isEvolution && !conectado && (
            <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={buscarQrCode} disabled={carregandoQr}>
              {carregandoQr ? 'Carregando...' : 'Gerar QR Code'}
            </button>
          )}
        </div>

        {/* IA */}
        <div style={{ background: '#fff', padding: 20, borderRadius: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', textTransform: 'uppercase', marginBottom: 8 }}>Agente IA (Claude)</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
            {status?.ia_configurada ? '🤖 Ativa' : '⚪ Inativa'}
          </div>
          <div style={{ marginTop: 8 }}>
            {chipStatus(status?.ia_configurada, '🟢 API OK', '🔴 Sem API key')}
          </div>
        </div>

        {/* Horário comercial */}
        <div style={{ background: '#fff', padding: 20, borderRadius: 12, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-light)', textTransform: 'uppercase', marginBottom: 8 }}>Horário Comercial</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
            {horario?.dentro_horario_agora ? '🟢 Aberto' : '🔴 Fechado'}
          </div>
          {horario && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-light)', marginTop: 4 }}>
              {horario.hora_inicio}h–{horario.hora_fim}h ·{' '}
              {(horario.dias_uteis || []).map((d) => DIAS_SEMANA[d]).join(', ')}
            </div>
          )}
        </div>
      </div>

      {/* ========== QR CODE ========== */}
      {qrcode && (
        <div style={{ background: '#fff', padding: 24, borderRadius: 12, border: '1px solid var(--border)', marginBottom: 24 }}>
          <h3 style={{ marginTop: 0 }}>Parear número da ANA</h3>
          <p style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>
            Abra o WhatsApp do <strong>chip dedicado da ANA</strong>, vá em Configurações → Aparelhos conectados →
            Conectar um aparelho, e escaneie o QR abaixo.
          </p>
          {(qrcode.base64 || qrcode.qrcode?.base64) ? (
            <img
              src={(qrcode.base64 || qrcode.qrcode?.base64).startsWith('data:')
                ? (qrcode.base64 || qrcode.qrcode?.base64)
                : `data:image/png;base64,${qrcode.base64 || qrcode.qrcode?.base64}`}
              alt="QR Code"
              style={{ maxWidth: 280, border: '1px solid var(--border)', borderRadius: 8 }}
            />
          ) : qrcode.code ? (
            <div>
              <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', wordBreak: 'break-all', background: '#f8fafc', padding: 12, borderRadius: 8, marginBottom: 8 }}>
                {qrcode.code}
              </div>
              <small style={{ color: 'var(--text-light)' }}>Cole esse código num gerador de QR online se a imagem não apareceu.</small>
            </div>
          ) : (
            <pre style={{ background: '#f8fafc', padding: 12, borderRadius: 8, fontSize: '0.75rem' }}>
              {JSON.stringify(qrcode, null, 2)}
            </pre>
          )}
          <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={() => setQrcode(null)}>
            Fechar
          </button>
        </div>
      )}

      {erroQr && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>{erroQr}</div>
      )}

      {/* ========== AVISO SE NÃO É EVOLUTION ========== */}
      {!isEvolution && (
        <div className="alert alert-warning" style={{ marginBottom: 24 }}>
          <strong>Provider ativo não é a Evolution API.</strong> Para usar a ANA em grupos, configure as env vars{' '}
          <code>WHATSAPP_PROVIDER=evolution</code>, <code>EVOLUTION_API_URL</code>, <code>EVOLUTION_API_KEY</code>,{' '}
          <code>EVOLUTION_INSTANCE</code> no Render. Veja o guia em <code>evolution-api/QUICKSTART-RAILWAY.md</code>.
        </div>
      )}

      {/* ========== CHECKLIST DE GRUPOS ========== */}
      <div style={{ background: '#fff', padding: 24, borderRadius: 12, border: '1px solid var(--border)', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
          <h3 style={{ margin: 0 }}>Checklist de Rollout nos Grupos</h3>
          {checklist && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-light)' }}>
                {checklist.total_presentes} / {checklist.total_esperados} grupos ({checklist.progresso_pct}%)
              </span>
              <div style={{ width: 160, height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${checklist.progresso_pct}%`,
                    height: '100%',
                    background: checklist.progresso_pct >= 100 ? '#22c55e' : '#3b82f6',
                    transition: 'width 0.3s',
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginTop: 8 }}>
          Cadastre aqui os nomes dos grupos em que a ANA precisa entrar. Adicione ela manualmente no WhatsApp do seu
          celular — conforme entrar, os itens vão ficando verdes automaticamente (atualiza a cada 15s).
        </p>

        {/* Adicionar em lote */}
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
            + Adicionar vários grupos de uma vez (colar lista)
          </summary>
          <div style={{ marginTop: 12 }}>
            <textarea
              rows={6}
              value={listaEmMassa}
              onChange={(e) => setListaEmMassa(e.target.value)}
              placeholder={'Um grupo por linha\nEx:\nCliente ABC LTDA\nCondomínio Jardim das Flores\nPizzaria do João'}
              style={{
                width: '100%',
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontFamily: 'inherit',
                fontSize: '0.9rem',
              }}
            />
            <button
              className="btn btn-primary"
              style={{ marginTop: 8 }}
              onClick={adicionarEmLote}
              disabled={salvando || !listaEmMassa.trim()}
            >
              {salvando ? 'Salvando...' : 'Adicionar em lote'}
            </button>
          </div>
        </details>

        {/* Adicionar avulso */}
        <form onSubmit={adicionarGrupoUnico} style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <input
            type="text"
            value={novoGrupo}
            onChange={(e) => setNovoGrupo(e.target.value)}
            placeholder="Nome do grupo (ex: Cliente XYZ LTDA)"
            style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 8 }}
          />
          <button className="btn btn-primary" type="submit" disabled={salvando || !novoGrupo.trim()}>
            Adicionar
          </button>
        </form>

        {/* Filtros */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className={`btn btn-sm ${filtroChecklist === 'todos' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setFiltroChecklist('todos')}
          >
            Todos ({checklist?.total_esperados || 0})
          </button>
          <button
            className={`btn btn-sm ${filtroChecklist === 'presentes' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setFiltroChecklist('presentes')}
          >
            ✓ Presentes ({checklist?.total_presentes || 0})
          </button>
          <button
            className={`btn btn-sm ${filtroChecklist === 'ausentes' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setFiltroChecklist('ausentes')}
          >
            ⏳ Ausentes ({checklist?.total_ausentes || 0})
          </button>
        </div>

        {/* Lista */}
        <div style={{ marginTop: 16, maxHeight: 480, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          {checklistFiltrado.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-light)' }}>
              {checklist?.total_esperados === 0
                ? 'Nenhum grupo cadastrado ainda. Comece adicionando os nomes acima.'
                : 'Nenhum grupo corresponde ao filtro.'}
            </div>
          ) : (
            checklistFiltrado.map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--border)',
                  background: item.presente ? '#f0fdf4' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: '1.2rem' }}>
                    {item.presente ? '✅' : '⏳'}
                  </span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{item.nome}</div>
                    {item.presente && item.participantes != null && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                        {item.participantes} participantes
                      </div>
                    )}
                  </div>
                </div>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => removerGrupo(item.id)}
                  style={{ color: '#dc2626' }}
                >
                  Remover
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ========== CONFIG HORÁRIO COMERCIAL ========== */}
      {horario && (
        <div style={{ background: '#fff', padding: 24, borderRadius: 12, border: '1px solid var(--border)' }}>
          <h3 style={{ marginTop: 0 }}>Config do Horário Comercial</h3>
          <p style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>
            Fora do horário, a ANA fica em silêncio em grupos e manda uma auto-resposta de ausência uma vez a cada
            6h em conversas privadas. Pra alterar, edite as env vars no Render:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, fontSize: '0.85rem', marginTop: 12 }}>
            <strong>Módulo ativo:</strong>
            <span>{horario.ativo ? '✅ sim' : '❌ não (respondendo 24/7)'}</span>
            <strong>Horário:</strong>
            <span>
              {horario.hora_inicio}h às {horario.hora_fim}h
            </span>
            <strong>Dias úteis:</strong>
            <span>{(horario.dias_uteis || []).map((d) => DIAS_SEMANA[d]).join(', ')}</span>
            <strong>Timezone:</strong>
            <span>{horario.timezone}</span>
            <strong>Agora:</strong>
            <span>
              {horario.hora_atual_tz?.hora}:{String(horario.hora_atual_tz?.minuto || 0).padStart(2, '0')} ·{' '}
              {DIAS_SEMANA[horario.hora_atual_tz?.diaSemana]} ·{' '}
              {horario.dentro_horario_agora ? '🟢 dentro do horário' : '🔴 fora do horário'}
            </span>
            <strong>Intervalo auto-resp:</strong>
            <span>{horario.intervalo_ausencia_horas}h</span>
          </div>
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
              Mensagem de ausência que a ANA envia
            </summary>
            <div style={{ marginTop: 8, padding: 12, background: '#f8fafc', borderRadius: 8, fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
              {horario.mensagem_ausencia}
            </div>
          </details>
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
              Variáveis de ambiente (Render)
            </summary>
            <pre style={{ marginTop: 8, padding: 12, background: '#1a1a2e', color: '#e0e0e0', borderRadius: 8, fontSize: '0.75rem', overflow: 'auto' }}>
{`ANA_HORARIO_COMERCIAL_ATIVO=true
ANA_HORARIO_INICIO=8
ANA_HORARIO_FIM=19
ANA_DIAS_UTEIS=1,2,3,4,5
ANA_TIMEZONE=America/Sao_Paulo
ANA_INTERVALO_AUSENCIA_HORAS=6
ANA_MENSAGEM_FORA_HORARIO=Sua mensagem personalizada`}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
