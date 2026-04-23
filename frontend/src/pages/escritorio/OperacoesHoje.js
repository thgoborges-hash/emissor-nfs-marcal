import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { painelApi } from '../../services/api';

// =====================================================
// HOME do Cockpit — v4 "futurista enxuto"
// -----------------------------------------------------
// Layout vertical: saudacao mini -> banner DCTFWeb so se houver risco
// -> 6 tiles grandes (2x3) -> feed baixo enxuto.
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

  const temRisco = (dctf.atrasada || 0) > 0 || (dctf.pendente || 0) > 0;

  // 6 tiles grandes — layout "intent" v4
  const tiles = [
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
      sub: dctf.atrasada > 0 ? 'cliente(s) em atraso' : 'matriz obrigações × cliente',
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
    <div className="home-v4">
      {/* Saudacao compacta com status ambiente */}
      <header className="home-hello">
        <div>
          <h1 className="home-hello-title">
            <span className="home-hello-dot" />
            {saudacao}, <span className="home-hello-name">Thiago</span>
          </h1>
          <p className="home-hello-sub">
            {dados ? `Atualizado ${fmtDataHora(dados.geradoEm)} · auto-refresh 1min` : 'Sincronizando dashboard…'}
          </p>
        </div>
        {!temRisco && totalCarteira > 0 && (
          <div className="home-status-chip success">
            <span className="home-status-dot" />
            DCTFWeb · {dctf.em_dia}/{totalCarteira} em dia
          </div>
        )}
      </header>

      {/* Banner DCTFWeb — so aparece quando ha risco */}
      {temRisco && (
        <HeroDctfweb dctf={dctf} atrasados={atrasadosPreview} total={totalCarteira} />
      )}

      {/* 6 tiles grandes */}
      <div className="tile-grid">
        {tiles.map((t) => (
          <Link key={t.titulo} to={t.to} className={`tile tile-${t.tom}`}>
            <div className="tile-glow" />
            <div className="tile-head">
              <span className="tile-icon">{t.icon}</span>
              <span className="tile-arrow">→</span>
            </div>
            <div className="tile-body">
              {t.destaque !== '' && <div className="tile-destaque">{t.destaque}</div>}
              <div className="tile-title">{t.titulo}</div>
              <div className="tile-sub">{t.sub}</div>
            </div>
          </Link>
        ))}
      </div>

      {/* Feed baixo enxuto — 2 colunas */}
      <div className="home-feed">
        <section className="feed-card">
          <div className="feed-head">
            <span className="feed-ico">📅</span>
            <h3 className="feed-title">Próximas obrigações</h3>
          </div>
          {obrigs.length === 0 ? (
            <div className="empty-state">Nada próximo do prazo.</div>
          ) : (
            <ul className="feed-list">
              {obrigs.slice(0, 5).map((o) => (
                <li key={o.nome} className={`feed-item ${o.urgente ? 'urgente' : ''}`}>
                  <div className="feed-item-main">
                    <div className="feed-item-title">{o.nome}</div>
                    <div className="feed-item-sub">{o.regime} · dia {o.dia}</div>
                  </div>
                  <div className={`feed-item-due ${o.urgente ? 'urgente' : ''}`}>
                    {o.dias_para_vencimento === 0 ? 'HOJE' :
                      o.dias_para_vencimento === 1 ? 'amanhã' :
                      `${o.dias_para_vencimento}d`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="feed-card">
          <div className="feed-head">
            <span className="feed-ico">📋</span>
            <h3 className="feed-title">Últimas NFs</h3>
          </div>
          {nfs.length === 0 ? (
            <div className="empty-state">Nenhuma NF recente.</div>
          ) : (
            <ul className="feed-list">
              {nfs.slice(0, 5).map((nf) => (
                <li key={nf.id} className="feed-item">
                  <div className="feed-item-main">
                    <div className="feed-item-title">NF {nf.numero_nfse || nf.numero_dps || '?'}</div>
                    <div className="feed-item-sub">{nf.cliente_nome}</div>
                  </div>
                  <div className="feed-item-due success">{fmtMoeda(nf.valor_servico)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Decisoes ANA hoje — rodape minimal */}
      {dados?.ana_decisoes_hoje?.length > 0 && (
        <div className="ana-strip">
          <span className="ana-strip-label">🤖 ANA hoje:</span>
          {dados.ana_decisoes_hoje.map((d) => (
            <span key={d.status} className={`ana-strip-chip ${d.status}`}>
              {d.total} {d.status}
            </span>
          ))}
        </div>
      )}

      {carregando && !dados && <div className="home-loading">Carregando…</div>}
    </div>
  );
}

// =====================================================
// Hero DCTFWeb — so renderiza quando ha risco (atraso/pendente)
// =====================================================
function HeroDctfweb({ dctf, atrasados, total }) {
  const emAtraso = dctf.atrasada || 0;
  const pendentes = dctf.pendente || 0;
  const emDia = dctf.em_dia || 0;
  const pctEmDia = total > 0 ? Math.round((emDia / total) * 100) : 0;

  const estado = emAtraso > 0 ? 'danger' : 'warning';

  const titulo = estado === 'danger'
    ? `${emAtraso} cliente(s) com DCTFWeb em ATRASO`
    : `${pendentes} cliente(s) com DCTFWeb pendente`;

  const subtitulo = estado === 'danger'
    ? 'Multa cai no bolso do escritório. Trate primeiro.'
    : `Prazo: dia 15. ${emDia} cliente(s) já transmitiram.`;

  return (
    <section className={`hero-alert hero-${estado}`}>
      <div className="hero-alert-grid">
        <div className="hero-alert-main">
          <div className="hero-alert-pill">
            <span className="hero-alert-pulse" />
            {estado === 'danger' ? 'ATENÇÃO CRÍTICA' : 'PENDÊNCIA'}
          </div>
          <h2 className="hero-alert-titulo">{titulo}</h2>
          <p className="hero-alert-sub">{subtitulo}</p>
          {total > 0 && (
            <div className="hero-alert-progress">
              <div className="hero-alert-bar"><div style={{ width: `${pctEmDia}%` }} /></div>
              <span>{pctEmDia}% em dia · {emDia}/{total}</span>
            </div>
          )}
        </div>
        <div className="hero-alert-metrics">
          <MiniMetric label="Em atraso" valor={emAtraso} tom="danger" />
          <MiniMetric label="Pendentes" valor={pendentes} tom="warning" />
          <MiniMetric label="Em dia" valor={emDia} tom="success" />
        </div>
      </div>

      {estado === 'danger' && atrasados.length > 0 && (
        <div className="hero-alert-list">
          <div className="hero-alert-list-head">Clientes em atraso</div>
          <ul>
            {atrasados.slice(0, 4).map(a => (
              <li key={a.cliente_id}>
                <strong>{a.razao_social}</strong><span>{a.resumo}</span>
              </li>
            ))}
          </ul>
          <Link to="/escritorio/entregas" className="hero-alert-cta">Ver matriz completa →</Link>
        </div>
      )}
    </section>
  );
}

function MiniMetric({ label, valor, tom }) {
  return (
    <div className={`hero-mini hero-mini-${tom}`}>
      <div className="hero-mini-valor">{valor}</div>
      <div className="hero-mini-label">{label}</div>
    </div>
  );
}
