import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { pgdasdApi, clientesApi } from '../../services/api';

// =====================================================
// Fechamento Simples Nacional (PGDAS-D)
// -----------------------------------------------------
// Pipeline: calcular draft → revisar → aprovar → transmitir → DAS gerado
// Receita vem do EMISSOR (notas_fiscais), DAS calculado via fórmula
// LC 123/2006. Transmissão é IRREVERSÍVEL — exige aprovação prévia.
// =====================================================

const STATUS_INFO = {
  draft:             { label: 'Rascunho',             cor: 'info',    icon: '📝', explica: 'Calculado, aguarda revisão' },
  pending_approval:  { label: 'Aguarda aprovação',    cor: 'warning', icon: '⏸️', explica: 'Pronto pra transmitir, aguardando OK humano' },
  transmitting:      { label: 'Transmitindo',         cor: 'primary', icon: '📡', explica: 'Enviando ao SERPRO…' },
  transmitted:       { label: 'Transmitido',          cor: 'success', icon: '✅', explica: 'Declaração entregue, recibo SERPRO obtido' },
  das_generated:     { label: 'DAS gerado',           cor: 'success', icon: '💰', explica: 'Guia DAS disponível' },
  contab_lancado:    { label: 'Contábil lançado',     cor: 'success', icon: '📚', explica: 'Apuração no Domínio feita pelo João' },
  done:              { label: 'Concluído',            cor: 'success', icon: '🎯', explica: 'Ciclo completo' },
  failed:            { label: 'Falhou',               cor: 'danger',  icon: '⚠️', explica: 'Erro durante o processo' },
  cancelled:         { label: 'Cancelado',            cor: 'muted',   icon: '⊘', explica: 'Cancelado por humano' },
};

const ANEXOS = [
  { v: 'I',   label: 'I — Comércio' },
  { v: 'III', label: 'III — Serviços (limpeza, vigilância, folha + Fator R)' },
  { v: 'IV',  label: 'IV — Serviços técnicos (advocacia, construção, engenharia)' },
  { v: 'V',   label: 'V — Serviços (tecnologia, intelectual sem Fator R)' },
];

const fmtMoeda = (v) => v == null ? '—' :
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));

const fmtPct = (v) => v == null ? '—' : `${(Number(v) * 100).toFixed(2)}%`;

const fmtPeriodo = (yyyymm) => {
  if (!yyyymm || yyyymm.length !== 6) return yyyymm || '—';
  return `${yyyymm.slice(4, 6)}/${yyyymm.slice(0, 4)}`;
};

const fmtDataHora = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
};

const periodoMesAnterior = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function FechamentoSimples() {
  const [fechamentos, setFechamentos] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [filtroStatus, setFiltroStatus] = useState('todos');
  const [processando, setProcessando] = useState(null);
  const [detalhe, setDetalhe] = useState(null);  // fechamento expandido
  const [novoOpen, setNovoOpen] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const filtros = {};
      if (filtroStatus !== 'todos') filtros.status = filtroStatus;
      filtros.limite = 100;
      const [fRes, cRes] = await Promise.all([
        pgdasdApi.listar(filtros),
        clientesApi.listar(),
      ]);
      setFechamentos(fRes.data.fechamentos || []);
      // Filtra só Simples Nacional pra dropdown
      const simples = (cRes.data.clientes || cRes.data || []).filter(c =>
        c.regime_tributario === 'simples' || c.optante_simples === 1
      );
      setClientes(simples);
      setErro(null);
    } catch (err) {
      setErro(err.response?.data?.erro || err.message);
    } finally {
      setCarregando(false);
    }
  }, [filtroStatus]);

  useEffect(() => {
    carregar();
    const id = setInterval(carregar, 10000);
    return () => clearInterval(id);
  }, [carregar]);

  const aprovar = async (id) => {
    if (!window.confirm(`Aprovar fechamento #${id}? Depois disso ele pode ser transmitido.`)) return;
    setProcessando(id);
    try { await pgdasdApi.aprovar(id); await carregar(); }
    catch (err) { alert(err.response?.data?.erro || err.message); }
    finally { setProcessando(null); }
  };

  const transmitir = async (id) => {
    if (!window.confirm(
      `⚠️ TRANSMITIR PGDAS-D do fechamento #${id} ao SERPRO?\n\n` +
      `Esta ação é IRREVERSÍVEL. A declaração será entregue à Receita Federal.\n\n` +
      `Tem certeza?`
    )) return;
    setProcessando(id);
    try { await pgdasdApi.transmitir(id); await carregar(); }
    catch (err) { alert(err.response?.data?.erro || err.message); }
    finally { setProcessando(null); }
  };

  const cancelar = async (id) => {
    const motivo = window.prompt('Motivo do cancelamento (obrigatório):');
    if (!motivo || !motivo.trim()) return;
    setProcessando(id);
    try { await pgdasdApi.cancelar(id, motivo); await carregar(); }
    catch (err) { alert(err.response?.data?.erro || err.message); }
    finally { setProcessando(null); }
  };

  const contagem = useMemo(() => {
    const c = {};
    for (const f of fechamentos) c[f.status] = (c[f.status] || 0) + 1;
    return c;
  }, [fechamentos]);

  if (carregando && fechamentos.length === 0) {
    return <div className="empty-state"><div className="icon">⏳</div>Carregando…</div>;
  }

  return (
    <div className="fechamento-simples">
      <div className="page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="page-title">
            <span style={{ marginRight: 10 }}>💼</span>
            Fechamento Simples Nacional
          </h1>
          <p className="page-subtitle">
            Calcula DAS a partir das NFs do mês, transmite PGDAS-D na Receita.
            Receita vem do Emissor, não do Domínio (fechamentos rodam na 1ª semana).
          </p>
        </div>
        <button
          onClick={() => setNovoOpen(true)}
          className="btn btn-primary"
        >
          + Novo fechamento
        </button>
      </div>

      {erro && <div className="alert alert-danger" style={{ marginBottom: 16 }}>Erro: {erro}</div>}

      {/* Contadores por status */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        {Object.entries(STATUS_INFO).map(([s, info]) => {
          const count = contagem[s] || 0;
          const ativo = count > 0;
          return (
            <button
              key={s}
              onClick={() => setFiltroStatus(filtroStatus === s ? 'todos' : s)}
              className="card"
              style={{
                padding: '10px 14px', minWidth: 100,
                border: filtroStatus === s ? `2px solid var(--${info.cor})` : '1px solid var(--border)',
                cursor: 'pointer',
                opacity: ativo ? 1 : 0.5,
                transition: 'all 0.15s',
              }}
              title={info.explica}
            >
              <div style={{ fontSize: 11, color: 'var(--text-light)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {info.icon} {info.label}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: ativo ? `var(--${info.cor})` : 'var(--text-muted)' }}>
                {count}
              </div>
            </button>
          );
        })}
        {filtroStatus !== 'todos' && (
          <button
            onClick={() => setFiltroStatus('todos')}
            className="btn btn-ghost btn-sm"
            style={{ alignSelf: 'center', marginLeft: 8 }}
          >
            Limpar filtro
          </button>
        )}
      </div>

      {/* Lista */}
      {fechamentos.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📊</div>
          <div style={{ fontSize: 15, marginBottom: 6 }}>
            {filtroStatus === 'todos' ? 'Nenhum fechamento ainda.' : `Nenhum em "${STATUS_INFO[filtroStatus]?.label}".`}
          </div>
          <div className="text-muted text-sm">
            Clica em "Novo fechamento" pra calcular o DAS de um cliente.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {fechamentos.map(f => (
            <LinhaFechamento
              key={f.id}
              f={f}
              expandido={detalhe === f.id}
              processando={processando === f.id}
              onToggle={() => setDetalhe(detalhe === f.id ? null : f.id)}
              onAprovar={() => aprovar(f.id)}
              onTransmitir={() => transmitir(f.id)}
              onCancelar={() => cancelar(f.id)}
            />
          ))}
        </div>
      )}

      {novoOpen && (
        <ModalNovoFechamento
          clientes={clientes}
          onClose={() => setNovoOpen(false)}
          onSuccess={(novo) => {
            setNovoOpen(false);
            carregar();
            setDetalhe(novo.id);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function LinhaFechamento({ f, expandido, processando, onToggle, onAprovar, onTransmitir, onCancelar }) {
  const info = STATUS_INFO[f.status] || STATUS_INFO.draft;
  return (
    <div
      className="card"
      style={{
        padding: 14,
        borderLeft: `3px solid var(--${info.cor})`,
        cursor: 'pointer',
        transition: 'background 0.12s',
      }}
      onClick={onToggle}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{f.razao_social || `Cliente #${f.cliente_id}`}</span>
              <span className="text-muted" style={{ fontSize: 12 }}>#{f.id}</span>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px', borderRadius: 999,
                  background: `var(--${info.cor}-subtle)`,
                  color: `var(--${info.cor})`,
                  fontSize: 11, fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}
              >
                {info.icon} {info.label}
              </span>
            </div>
            <div className="text-light" style={{ fontSize: 12, marginTop: 4 }}>
              {fmtPeriodo(f.periodo_apuracao)} · Anexo {f.anexo || '—'} · {f.total_nfs || 0} NF{f.total_nfs === 1 ? '' : 's'}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 120 }}>
            <div className="text-muted" style={{ fontSize: 10, textTransform: 'uppercase' }}>DAS</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
              {fmtMoeda(f.valor_das)}
            </div>
            <div className="text-light" style={{ fontSize: 11 }}>
              {fmtPct(f.aliquota_efetiva)} efetiva
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
            {(f.status === 'draft') && (
              <button disabled={processando} onClick={onAprovar} className="btn btn-warning btn-sm">
                ⏭ Aprovar
              </button>
            )}
            {(f.status === 'pending_approval') && (
              <button disabled={processando} onClick={onTransmitir} className="btn btn-success btn-sm">
                📡 Transmitir
              </button>
            )}
            {['draft', 'pending_approval', 'failed'].includes(f.status) && (
              <button disabled={processando} onClick={onCancelar} className="btn btn-outline btn-sm">
                ✗ Cancelar
              </button>
            )}
          </div>
        </div>

        {expandido && <DetalheFechamento f={f} />}
      </div>
    </div>
  );
}

function DetalheFechamento({ f }) {
  return (
    <div style={{ width: '100%', marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 12 }}>
        <Campo label="CNPJ" valor={f.cnpj} />
        <Campo label="Receita bruta mês" valor={fmtMoeda(f.receita_bruta_mes)} />
        <Campo label="RBA 12m" valor={fmtMoeda(f.rba12m)} />
        <Campo label="Alíquota nominal" valor={fmtPct(f.aliquota_nominal)} />
        <Campo label="Parcela a deduzir" valor={fmtMoeda(f.parcela_deduzir)} />
        <Campo label="Alíquota efetiva" valor={fmtPct(f.aliquota_efetiva)} highlight />
        <Campo label="DAS calculado" valor={fmtMoeda(f.valor_das)} highlight />
        <Campo label="ISS retido total" valor={fmtMoeda(f.iss_retido_total)} />
      </div>

      {f.recibo_serpro && (
        <div className="alert" style={{ background: 'var(--success-subtle)', border: '1px solid var(--success)', padding: 10, borderRadius: 8, marginBottom: 12 }}>
          <strong>Recibo SERPRO:</strong> <code>{f.recibo_serpro}</code>
          {f.transmitido_em && <span style={{ marginLeft: 12, fontSize: 12, opacity: 0.8 }}>· transmitido em {fmtDataHora(f.transmitido_em)}</span>}
        </div>
      )}

      {f.erro && (
        <div className="alert" style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', padding: 10, borderRadius: 8, marginBottom: 12 }}>
          <strong>Erro:</strong> <code style={{ fontSize: 12 }}>{f.erro}</code>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-light)', flexWrap: 'wrap' }}>
        <span>Criado: {fmtDataHora(f.created_at)} por {f.criado_por || '—'}</span>
        {f.aprovado_em && <span>Aprovado: {fmtDataHora(f.aprovado_em)} por {f.aprovado_por}</span>}
        {f.cancelado_em && <span>Cancelado: {fmtDataHora(f.cancelado_em)}</span>}
        <span>Tentativas: {f.tentativas || 0}</span>
      </div>
    </div>
  );
}

function Campo({ label, valor, highlight }) {
  return (
    <div>
      <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: highlight ? 16 : 13, marginTop: 2, fontWeight: highlight ? 700 : 400, color: highlight ? 'var(--primary)' : 'var(--text)' }}>{valor}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ModalNovoFechamento({ clientes, onClose, onSuccess }) {
  const [clienteId, setClienteId] = useState('');
  const [periodo, setPeriodo] = useState(periodoMesAnterior());
  const [anexo, setAnexo] = useState('III');
  const [rba12m, setRba12m] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [erro, setErro] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro(null);

    if (!clienteId) return setErro('Selecione um cliente');
    if (!/^\d{6}$/.test(periodo)) return setErro('Período deve ser YYYYMM (ex: 202604)');
    const rba = parseFloat(String(rba12m).replace(',', '.'));
    if (!Number.isFinite(rba) || rba < 0) return setErro('RBA 12m inválido');

    setSubmitting(true);
    try {
      const { data } = await pgdasdApi.calcular({
        cliente_id: Number(clienteId),
        periodo_apuracao: periodo,
        anexo,
        rba12m: rba,
        origem: 'painel',
      });
      onSuccess(data.fechamento);
    } catch (err) {
      setErro(err.response?.data?.erro || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
        backdropFilter: 'blur(4px)',
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ padding: 24, maxWidth: 540, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h2 style={{ marginBottom: 6 }}>Novo fechamento PGDAS-D</h2>
        <p className="text-light" style={{ fontSize: 13, marginBottom: 20 }}>
          O sistema busca as NFs emitidas no mês e calcula o DAS conforme a faixa.
          Você aprova/transmite depois.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Cliente (Simples Nacional)
            </label>
            <select
              value={clienteId}
              onChange={(e) => setClienteId(e.target.value)}
              className="form-control"
              style={{ width: '100%' }}
              required
            >
              <option value="">— Selecione —</option>
              {clientes.map(c => (
                <option key={c.id} value={c.id}>
                  {c.razao_social} ({c.cnpj})
                </option>
              ))}
            </select>
            {clientes.length === 0 && (
              <div className="text-muted text-sm" style={{ marginTop: 6 }}>
                Nenhum cliente classificado como Simples Nacional. Defina <code>regime_tributario='simples'</code> no cadastro.
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Período (YYYYMM)
              </label>
              <input
                type="text"
                value={periodo}
                onChange={(e) => setPeriodo(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="202604"
                pattern="\d{6}"
                className="form-control"
                style={{ width: '100%' }}
                required
              />
              <div className="text-muted text-sm" style={{ marginTop: 4 }}>
                {periodo.length === 6 ? fmtPeriodo(periodo) : 'Ex: 202604 = abril/2026'}
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Anexo
              </label>
              <select
                value={anexo}
                onChange={(e) => setAnexo(e.target.value)}
                className="form-control"
                style={{ width: '100%' }}
                required
              >
                {ANEXOS.map(a => <option key={a.v} value={a.v}>{a.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              RBA 12m (Receita Bruta Acumulada últimos 12 meses)
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={rba12m}
              onChange={(e) => setRba12m(e.target.value.replace(/[^\d.,]/g, ''))}
              placeholder="Ex: 60000.00"
              className="form-control"
              style={{ width: '100%' }}
              required
            />
            <div className="text-muted text-sm" style={{ marginTop: 4 }}>
              Define a faixa de alíquota. Próxima versão vai buscar automático do SERPRO. Por enquanto, informe manualmente.
            </div>
          </div>
        </div>

        {erro && <div className="alert alert-danger" style={{ marginTop: 16 }}>{erro}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" onClick={onClose} className="btn btn-outline" disabled={submitting}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '⏳ Calculando…' : '📊 Calcular DAS'}
          </button>
        </div>
      </form>
    </div>
  );
}
