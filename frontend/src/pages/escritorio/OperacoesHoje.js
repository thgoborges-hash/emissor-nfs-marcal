import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { painelApi } from '../../services/api';

// =====================================================
// HOME do Cockpit — redesign v3 em cards de intencao
// -----------------------------------------------------
// Foco: o operador entra aqui de manha e decide POR ONDE COMECAR.
// Prioridades (top -> bottom):
//   1) Hero DCTFWeb      — multa cai no bolso do escritorio, destaque total
//   2) KPIs do dia       — NFs pendentes, emitidas, WhatsApp, fila ANA
//   3) 6 cards grandes   — portas de entrada pra cada area (Emitir, Clientes, etc)
//   4) Obrigacoes proximas + ultimas NFs — feed de contexto
// =====================================================

export default function OperacoesHoje() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [saudacao, setSaudacao] = useState('Bom dia');

  const carregar = async () => {
    try {
      setErro(null);
      const { data } = await painelApi.operacoesHoje();
      setDados(data);
    } catch (err) {
      setErro(err.response?.data?.erro || err.message);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    const h = new Date().getHours();
    setSaudacao(h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite');
    carregar();
    const id = setInterval(carregar, 60000);
    return () => clearInterval(id);
  }, []);

  const fmtMoeda = (v) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

  const fmtDataHora = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  if (erro && !dados) return <div className="alert alert-danger">Erro: {erro}</div>;

  const c = dados?.cards || {};
  const dctf = c.dctfweb || { em_dia: 0, atrasada: 0, pendente: 0, sem_dados: 0 };
  const totalCarteira = (dctf.em_dia || 0) + (dctf.atrasada || 0) + (dctf.pendente || 0) + (dctf.sem_dados || 0);
  const atrasadosPreview = dados?.dctfweb_atrasados_preview || [];
  const obrigs = dados?.obrigacoes_proximas || [];
  const nfs = dados?.ultimas_nfs || [];

  // Monta os 6 cards de intencao
  const cardsIntent = [
    {
      to: '/escritorio/fila-ana',
      icon: '🤖',
      titulo: 'ANA',
      destaque: c.ana_fila_pendente || 0,
      sub: 'ações aguardando aprovação',
      tom: c.ana_fila_pendente > 0 ? 'warning' : 'neutral',
    },
    {
      to: '/escritorio/emitir',
      icon: '🧾',
      titulo: 'Emitir NF',
      destaque: c.nfs_hoje?.total ?? 0,
      sub: `emitidas hoje · ${fmtMoeda(c.nfs_hoje?.valor_total)}`,
      tom: 'success',
    },
    {
      to: '/escritorio/aprovacoes',
      icon: '✅',
      titulo: 'Aprovações NF',
      destaque: c.nfs_aprovacao?.total ?? 0,
      sub: 'pendentes · ' + fmtMoeda(c.nfs_aprovacao?.valor_total),
      tom: c.nfs_aprovacao?.total > 0 ? 'warning' : 'neutral',
    },
    {
      to: '/escritorio/entregas',
      icon: '📦',
      titulo: 'Entregas',
      destaque: dctf.atrasada || 0,
      sub: dctf.atrasada > 0 ? 'cliente(s) em atraso' : 'matriz obrigacoes x cliente',
      tom: dctf.atrasada > 0 ? 'danger' : 'neutral',
    },
    {
      to: '/escritorio/integra-contador',
      icon: '🏛️',
      titulo: 'Fiscal & Tributos',
      destaque: '',
      sub: 'DAS · DARF · SITFIS · DCTFWeb',
      tom: 'primary',
    },
    {
      to: '/escritorio/clientes',
      icon: '🏢',
      titulo: 'Clientes',
      destaque: totalCarteira || '',
      sub: totalCarteira ? 'ativos na carteira' : 'cadastros e certificados',
      tom: 'neutral',
    },
  ];

  return (
    <div>
      {/* Saudacao */}
      <div style={{ marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 4 }}>{saudacao}, Thiago 👋</h1>
        <p className="page-subtitle" style={{ margin: 0 }}>
          {dados ? `Atualizado em ${fmtDataHora(dados.geradoEm)} · auto-refresh 1min` : 'Carregando dashboard…'}
        </p>
      </div>

      {/* HERO DCTFWeb — destaque absoluto: multa por atraso vem do bolso do escritorio */}
      <HeroDctfweb dctf={dctf} atrasados={atrasadosPreview} total={totalCarteira} carregando={carregando} />

      {/* 6 cards de intencao */}
      <div className="intent-grid">
        {cardsIntent.map((card) => (
          <Link key={card.titulo} to={card.to} className={`intent-card intent-${card.tom}`}>
            <div className="intent-icon">{card.icon}</div>
            <div className="intent-body">
              <div className="intent-title">{card.titulo}</div>
              {card.destaque !== '' && <div className="intent-destaque">{card.destaque}</div>}
              <div className="intent-sub">{card.sub}</div>
            </div>
            <div className="intent-arrow">→</div>
          </Link>
        ))}
      </div>

      {/* Feed de contexto: obrigacoes + ultimas NFs */}
      <div className="grid-2" style={{ marginTop: 24 }}>
        <section className="section-card">
          <h3 className="section-title">📅 Obrigações nos próximos dias</h3>
          {obrigs.length === 0 ? (
            <div className="empty-state">Nenhuma obrigação próxima.</div>
          ) : (
            <div>
              {obrigs.map((o) => (
                <div key={o.nome}
                  className={`obrig-item ${o.urgente ? 'urgente' : ''}`}
                  style={{ '--obrig-color': o.cor }}>
                  <div>
                    <div className="obrig-item-title">{o.nome}</div>
                    <div className="obrig-item-sub">{o.regime} · dia {o.dia} · vence {o.data_vencimento}</div>
                  </div>
                  <div className={`obrig-item-due ${o.urgente ? 'urgente' : ''}`}>
                    {o.dias_para_vencimento === 0 ? 'HOJE' :
                      o.dias_para_vencimento === 1 ? 'amanhã' :
                      `em ${o.dias_para_vencimento}d`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="section-card">
          <h3 className="section-title">📋 Últimas NFs emitidas</h3>
          {nfs.length === 0 ? (
            <div className="empty-state">Nenhuma NF emitida recentemente.</div>
          ) : (
            <div>
              {nfs.map((nf) => (
                <div key={nf.id} className="flex-between" style={{
                  padding: '12px 0', borderBottom: '1px solid var(--border-subtle)'
                }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>
                      NF {nf.numero_nfse || nf.numero_dps || '?'}
                    </div>
                    <div className="text-light text-sm">{nf.cliente_nome}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="text-success" style={{ fontWeight: 600 }}>{fmtMoeda(nf.valor_servico)}</div>
                    <div className="text-muted text-sm">{fmtDataHora(nf.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Decisões ANA hoje */}
      {dados?.ana_decisoes_hoje?.length > 0 && (
        <section className="section-card mt-3">
          <h3 className="section-title">🤖 Decisões da fila ANA hoje</h3>
          <div className="flex-gap">
            {dados.ana_decisoes_hoje.map((d) => (
              <span key={d.status} className={`badge badge-${d.status}`}>{d.total} {d.status}</span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// =====================================================
// Hero DCTFWeb — quanto maior o risco, mais gritante o card
// =====================================================
function HeroDctfweb({ dctf, atrasados, total, carregando }) {
  const emAtraso = dctf.atrasada || 0;
  const pendentes = dctf.pendente || 0;
  const emDia = dctf.em_dia || 0;
  const pctEmDia = total > 0 ? Math.round((emDia / total) * 100) : 0;

  // Estado visual: perigo (tem atraso), atencao (so pendente), ok (tudo em dia), neutro (sem dados)
  const estado =
    emAtraso > 0 ? 'danger' :
    pendentes > 0 ? 'warning' :
    emDia > 0 ? 'success' :
    'neutral';

  const titulo = {
    danger: `⚠️ ${emAtraso} cliente(s) com DCTFWeb em ATRASO`,
    warning: `⏳ ${pendentes} cliente(s) com DCTFWeb dentro do prazo`,
    success: `✅ Toda a carteira em dia com a DCTFWeb`,
    neutral: 'DCTFWeb — varredura ainda não rodou',
  }[estado];

  const subtitulo = {
    danger: 'Multa cai pro bolso do escritório. Resolva isso antes de qualquer coisa.',
    warning: `Prazo: dia 15. ${emDia} cliente(s) já transmitiram.`,
    success: `${emDia} de ${total} clientes transmitidos.`,
    neutral: 'Rode a varredura do Integra Contador pra popular esse indicador.',
  }[estado];

  return (
    <section className={`dctf-hero dctf-${estado}`}>
      <div className="dctf-hero-main">
        <div className="dctf-hero-titulo">{titulo}</div>
        <div className="dctf-hero-sub">{subtitulo}</div>

        {total > 0 && (
          <div className="dctf-bar">
            <div className="dctf-bar-fill" style={{ width: `${pctEmDia}%` }} />
            <span className="dctf-bar-label">{pctEmDia}% em dia</span>
          </div>
        )}

        {carregando && <div className="text-muted text-sm" style={{ marginTop: 8 }}>Carregando…</div>}
      </div>

      <div className="dctf-hero-metrics">
        <MiniMetric label="Em atraso" valor={emAtraso} tom="danger" />
        <MiniMetric label="Pendentes" valor={pendentes} tom="warning" />
        <MiniMetric label="Em dia" valor={emDia} tom="success" />
        <MiniMetric label="Sem dados" valor={dctf.sem_dados || 0} tom="muted" />
      </div>

      {estado === 'danger' && atrasados.length > 0 && (
        <div className="dctf-atrasados-list">
          <div className="dctf-atrasados-header">Clientes em atraso:</div>
          <ul>
            {atrasados.map(a => (
              <li key={a.cliente_id}>
                <strong>{a.razao_social}</strong> — {a.resumo}
              </li>
            ))}
          </ul>
          <Link to="/escritorio/entregas" className="dctf-atrasados-link">Ver matriz completa →</Link>
        </div>
      )}
    </section>
  );
}

function MiniMetric({ label, valor, tom }) {
  return (
    <div className={`dctf-mini dctf-mini-${tom}`}>
      <div className="dctf-mini-valor">{valor}</div>
      <div className="dctf-mini-label">{label}</div>
    </div>
  );
}
