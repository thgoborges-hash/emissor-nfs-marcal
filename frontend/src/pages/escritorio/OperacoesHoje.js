import React, { useState, useEffect } from 'react';
import { painelApi } from '../../services/api';

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
    // Auto-refresh a cada 60s
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

  if (carregando && !dados) return <div style={{ padding: 40 }}>Carregando operações do dia...</div>;
  if (erro) return <div style={{ padding: 40, color: '#c00' }}>Erro: {erro}</div>;

  const c = dados.cards;
  const obrigs = dados.obrigacoes_proximas || [];
  const nfs = dados.ultimas_nfs || [];

  return (
    <div>
      <h1 className="page-title">🌅 Operações Hoje</h1>
      <p style={{ color: '#666', marginTop: -8, marginBottom: 24 }}>
        Atualizado em {formatarData(dados.geradoEm)} · auto-refresh 1min
      </p>

      {/* Linha de KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 32 }}>
        <Card titulo="NFs aguardando aprovação" valor={c.nfs_aprovacao.total} subtitulo={formatarMoeda(c.nfs_aprovacao.valor_total)} cor="#f39c12" />
        <Card titulo="NFs emitidas hoje" valor={c.nfs_hoje.total} subtitulo={formatarMoeda(c.nfs_hoje.valor_total)} cor="#27ae60" />
        <Card titulo="WhatsApp aguardando humano" valor={c.whatsapp_aguardando} subtitulo="conversas paradas" cor="#e74c3c" />
        <Card titulo="Fila ANA pendente" valor={c.ana_fila_pendente} subtitulo="ações aguardando aprovação" cor="#9b59b6" />
      </div>

      {/* Duas colunas */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Obrigações próximas */}
        <section style={sectionStyle}>
          <h3 style={sectionTitle}>📅 Obrigações nos próximos dias</h3>
          {obrigs.length === 0 ? (
            <p style={{ color: '#666' }}>Nenhuma obrigação próxima.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {obrigs.map(o => (
                <li key={o.nome} style={{
                  padding: '12px 16px', borderLeft: `4px solid ${o.cor}`,
                  background: o.urgente ? '#fff5f5' : '#fafafa',
                  marginBottom: 8, borderRadius: 4,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <strong>{o.nome}</strong>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      {o.regime} · dia {o.dia} · vence {o.data_vencimento}
                    </div>
                  </div>
                  <div style={{ fontWeight: 'bold', color: o.urgente ? '#e74c3c' : '#333' }}>
                    {o.dias_para_vencimento === 0 ? 'HOJE' :
                     o.dias_para_vencimento === 1 ? 'amanhã' :
                     `em ${o.dias_para_vencimento}d`}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 11, color: '#999', marginTop: 12 }}>
            Calendário fiscal padrão. Quando o Integra Contador estiver ativo, vai puxar vencimentos reais por cliente.
          </p>
        </section>

        {/* Últimas NFs */}
        <section style={sectionStyle}>
          <h3 style={sectionTitle}>📋 Últimas NFs emitidas</h3>
          {nfs.length === 0 ? (
            <p style={{ color: '#666' }}>Nenhuma NF emitida recentemente.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {nfs.map(nf => (
                <li key={nf.id} style={{
                  padding: '10px 0', borderBottom: '1px solid #eee',
                  display: 'flex', justifyContent: 'space-between',
                }}>
                  <div>
                    <strong>NF {nf.numero_nfse || nf.numero_dps || '?'}</strong>
                    <div style={{ fontSize: 12, color: '#666' }}>{nf.cliente_nome}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 'bold', color: '#27ae60' }}>{formatarMoeda(nf.valor_servico)}</div>
                    <div style={{ fontSize: 11, color: '#999' }}>{formatarData(nf.created_at)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Decisões ANA hoje */}
      {dados.ana_decisoes_hoje?.length > 0 && (
        <section style={{ ...sectionStyle, marginTop: 24 }}>
          <h3 style={sectionTitle}>🤖 Decisões da fila ANA hoje</h3>
          <div style={{ display: 'flex', gap: 16 }}>
            {dados.ana_decisoes_hoje.map(d => (
              <div key={d.status} style={{ padding: '8px 16px', background: '#f5f5f5', borderRadius: 4 }}>
                <strong>{d.total}</strong> {d.status}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Card({ titulo, valor, subtitulo, cor }) {
  return (
    <div style={{
      background: '#fff', borderRadius: 8, padding: 20,
      borderTop: `4px solid ${cor}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    }}>
      <div style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{titulo}</div>
      <div style={{ fontSize: 32, fontWeight: 'bold', marginTop: 8, color: cor }}>{valor}</div>
      <div style={{ fontSize: 13, color: '#999', marginTop: 4 }}>{subtitulo}</div>
    </div>
  );
}

const sectionStyle = {
  background: '#fff', borderRadius: 8, padding: 20,
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
};

const sectionTitle = { margin: '0 0 16px 0', fontSize: 16, fontWeight: 600 };
