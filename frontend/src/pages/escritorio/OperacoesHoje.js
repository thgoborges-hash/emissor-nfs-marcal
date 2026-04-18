import React, { useState, useEffect } from 'react';
import { painelApi } from '../../services/api';
import Sparkline from '../../components/Sparkline';
import { KpiGridSkeleton, ListSkeleton } from '../../components/Skeleton';

export default function OperacoesHoje() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);

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
    carregar();
    const id = setInterval(carregar, 60000);
    return () => clearInterval(id);
  }, []);

  const formatarMoeda = (valor) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);

  const formatarData = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  // Loading com skeletons — preserva layout em vez de aparição brusca
  if (carregando && !dados) {
    return (
      <div>
        <h1 className="page-title">Operações Hoje</h1>
        <p className="page-subtitle">Carregando dados do dia…</p>
        <KpiGridSkeleton total={4} />
        <div className="grid-2">
          <section className="section-card"><h3 className="section-title">📅 Obrigações</h3><ListSkeleton rows={4} /></section>
          <section className="section-card"><h3 className="section-title">📋 Últimas NFs</h3><ListSkeleton rows={5} /></section>
        </div>
      </div>
    );
  }
  if (erro) return <div className="alert alert-danger">Erro: {erro}</div>;

  const c = dados.cards;
  const obrigs = dados.obrigacoes_proximas || [];
  const nfs = dados.ultimas_nfs || [];

  return (
    <div>
      <h1 className="page-title">Operações Hoje</h1>
      <p className="page-subtitle">
        Atualizado em {formatarData(dados.geradoEm)} · auto-refresh 1min
      </p>

      {/* KPIs com sparklines (14 dias) */}
      <div className="kpi-grid">
        <div className="kpi-card accent-warning">
          <div className="label">NFs aguardando aprovação</div>
          <div className="valor warning">{c.nfs_aprovacao.total}</div>
          <div className="sub">{formatarMoeda(c.nfs_aprovacao.valor_total)}</div>
          <Sparkline data={c.nfs_aprovacao.serie || []} />
        </div>
        <div className="kpi-card accent-success">
          <div className="label">NFs emitidas hoje</div>
          <div className="valor success">{c.nfs_hoje.total}</div>
          <div className="sub">{formatarMoeda(c.nfs_hoje.valor_total)}</div>
          <Sparkline data={c.nfs_hoje.serie || []} />
        </div>
        <div className="kpi-card accent-danger">
          <div className="label">WhatsApp aguardando humano</div>
          <div className="valor danger">{c.whatsapp_aguardando}</div>
          <div className="sub">conversas paradas</div>
        </div>
        <div className="kpi-card accent-primary">
          <div className="label">Fila ANA pendente</div>
          <div className="valor primary">{c.ana_fila_pendente}</div>
          <div className="sub">ações aguardando aprovação</div>
        </div>
      </div>

      <div className="grid-2">
        {/* Obrigações */}
        <section className="section-card">
          <h3 className="section-title">📅 Obrigações nos próximos dias</h3>
          {obrigs.length === 0 ? (
            <div className="empty-state">Nenhuma obrigação próxima.</div>
          ) : (
            <div>
              {obrigs.map(o => (
                <div
                  key={o.nome}
                  className={`obrig-item ${o.urgente ? 'urgente' : ''}`}
                  style={{ '--obrig-color': o.cor }}
                >
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
          <p className="text-muted text-sm mt-2">
            Calendário fiscal padrão. Integra Contador vai enriquecer com vencimentos reais por cliente quando ativo.
          </p>
        </section>

        {/* Últimas NFs */}
        <section className="section-card">
          <h3 className="section-title">📋 Últimas NFs emitidas</h3>
          {nfs.length === 0 ? (
            <div className="empty-state">Nenhuma NF emitida recentemente.</div>
          ) : (
            <div>
              {nfs.map(nf => (
                <div key={nf.id} className="flex-between" style={{
                  padding: '12px 0',
                  borderBottom: '1px solid var(--border-subtle)'
                }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>NF {nf.numero_nfse || nf.numero_dps || '?'}</div>
                    <div className="text-light text-sm">{nf.cliente_nome}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="text-success" style={{ fontWeight: 600 }}>{formatarMoeda(nf.valor_servico)}</div>
                    <div className="text-muted text-sm">{formatarData(nf.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Decisões ANA hoje */}
      {dados.ana_decisoes_hoje?.length > 0 && (
        <section className="section-card mt-3">
          <h3 className="section-title">🤖 Decisões da fila ANA hoje</h3>
          <div className="flex-gap">
            {dados.ana_decisoes_hoje.map(d => (
              <span key={d.status} className={`badge badge-${d.status}`}>
                {d.total} {d.status}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
