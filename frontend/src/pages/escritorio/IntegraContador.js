import React, { useState, useEffect } from 'react';
import { integraContadorApi, clientesApi } from '../../services/api';

// =====================================================
// Integra Contador (SERPRO) — painel operacional
// =====================================================
// 10 operacoes disponiveis. Cada uma tem formulario proprio.
// Resultado renderiza PDF inline quando vier base64.

const OPERACOES = [
  { id: 'sitfis',        label: 'Certidao (SITFIS)',      icon: '📄', grupo: 'Gargalos' },
  { id: 'das_avulso',    label: 'Reemitir DAS Simples',   icon: '💸', grupo: 'Gargalos' },
  { id: 'das_cobranca',  label: 'DAS Simples (Cobranca)', icon: '🧾', grupo: 'Gargalos' },
  { id: 'das_simples',   label: 'DAS Simples (periodo)',  icon: '💰', grupo: 'Simples Nacional' },
  { id: 'das_mei',       label: 'DAS MEI',                icon: '🏷️',  grupo: 'MEI' },
  { id: 'ultima_pgdasd', label: 'Ultima PGDAS-D',         icon: '📊', grupo: 'Simples Nacional' },
  { id: 'procuracoes',   label: 'Procuracoes e-CAC',      icon: '🔑', grupo: 'Cadastro' },
  { id: 'caixa_postal',  label: 'Caixa Postal e-CAC',     icon: '📬', grupo: 'Cadastro' },
  { id: 'dctfweb',       label: 'Declaracoes DCTFWeb',    icon: '📑', grupo: 'DCTFWeb' },
  { id: 'pagamentos',    label: 'Pagamentos',             icon: '🏦', grupo: 'Consultas' },
  { id: 'ccmei',         label: 'Certificado MEI',        icon: '📜', grupo: 'MEI' },
  { id: 'darf',          label: 'Emitir DARF',            icon: '💳', grupo: 'Consultas' },
];

function agruparOperacoes() {
  const out = {};
  for (const op of OPERACOES) (out[op.grupo] = out[op.grupo] || []).push(op);
  return out;
}

function periodoAtualYYYYMM() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function IntegraContador() {
  const [status, setStatus] = useState(null);
  const [opAtiva, setOpAtiva] = useState('sitfis');
  const [clientes, setClientes] = useState([]);
  const [cnpj, setCnpj] = useState('');
  const [params, setParams] = useState({ periodoApuracao: periodoAtualYYYYMM() });
  const [resultado, setResultado] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    // Status do modulo
    integraContadorApi.status().then(r => setStatus(r.data)).catch(() => setStatus({ pronto: false }));
    // Carteira de clientes p/ autocomplete
    clientesApi.listar().then(r => {
      const arr = r.data?.clientes || r.data?.dados || r.data || [];
      setClientes(Array.isArray(arr) ? arr : []);
    }).catch(() => setClientes([]));
  }, []);

  const op = OPERACOES.find(o => o.id === opAtiva);

  const executar = async () => {
    const cnpjLimpo = (cnpj || '').replace(/\D/g, '');
    if (cnpjLimpo.length !== 14) { setErro('CNPJ invalido (14 digitos)'); return; }
    setErro(null);
    setResultado(null);
    setCarregando(true);
    try {
      let r;
      switch (opAtiva) {
        case 'sitfis':        r = await integraContadorApi.obterSitfis(cnpjLimpo); break;
        case 'das_simples':   r = await integraContadorApi.gerarDasSimples(cnpjLimpo, params.periodoApuracao); break;
        case 'das_avulso':    r = await integraContadorApi.gerarDasSimplesAvulso(cnpjLimpo, params.periodoApuracao); break;
        case 'das_cobranca':  r = await integraContadorApi.gerarDasSimplesCobranca(cnpjLimpo, params.periodoApuracao); break;
        case 'das_mei':       r = await integraContadorApi.gerarDasMei(cnpjLimpo, params.periodoApuracao); break;
        case 'ultima_pgdasd': r = await integraContadorApi.consultarUltimaPgdasd(cnpjLimpo); break;
        case 'procuracoes':   r = await integraContadorApi.consultarProcuracoes(cnpjLimpo); break;
        case 'caixa_postal':  r = await integraContadorApi.caixaPostal(cnpjLimpo); break;
        case 'dctfweb':       r = await integraContadorApi.consultarDctfweb(cnpjLimpo); break;
        case 'pagamentos':    r = await integraContadorApi.consultarPagamentos(cnpjLimpo, params.dataInicio, params.dataFim); break;
        case 'ccmei':         r = await integraContadorApi.emitirCcmei(cnpjLimpo); break;
        case 'darf':          r = await integraContadorApi.gerarDarf(cnpjLimpo, params); break;
        default: throw new Error('Operacao desconhecida');
      }
      setResultado(r.data);
    } catch (e) {
      setErro(e.response?.data?.erro || e.message);
    } finally {
      setCarregando(false);
    }
  };

  const grupos = agruparOperacoes();

  return (
    <div>
      <h1 className="page-title">Integra Contador (SERPRO)</h1>
      <p className="page-subtitle">
        Consultas e emissoes oficiais via API da Receita Federal. Usa o e-CNPJ A1 da Marcal + procuracao coletiva da carteira.
      </p>

      {/* Status */}
      <div className={status?.pronto ? 'alert alert-success' : 'alert alert-warning'}>
        <strong>{status?.pronto ? '✅ Conectado ao SERPRO' : '⚠️ Setup incompleto'}</strong>
        <div className="mt-1 text-sm">
          {status?.pronto
            ? 'Todas as operacoes abaixo chamam a API oficial em tempo real.'
            : <a href="/escritorio/certificado-serpro">Configure em Certificado SERPRO →</a>}
        </div>
      </div>

      {/* Layout 2 colunas: sidebar + painel */}
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 20, marginTop: 20 }}>
        {/* Sidebar de operacoes */}
        <aside className="section-card" style={{ padding: 12, position: 'sticky', top: 20, alignSelf: 'flex-start' }}>
          {Object.entries(grupos).map(([grupo, ops]) => (
            <div key={grupo} style={{ marginBottom: 14 }}>
              <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 8px' }}>{grupo}</div>
              {ops.map(o => (
                <button
                  key={o.id}
                  onClick={() => { setOpAtiva(o.id); setResultado(null); setErro(null); }}
                  style={{
                    width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6,
                    background: opAtiva === o.id ? 'var(--primary-subtle)' : 'transparent',
                    color: opAtiva === o.id ? 'var(--primary)' : 'var(--text)',
                    border: 'none', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center',
                    fontSize: 14, fontWeight: opAtiva === o.id ? 600 : 400,
                  }}
                >
                  <span style={{ fontSize: 16 }}>{o.icon}</span> {o.label}
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* Painel da operacao */}
        <main>
          <section className="section-card">
            <h3 className="section-title">{op.icon} {op.label}</h3>
            <OperacaoDescricao id={opAtiva} />

            <div style={{ marginTop: 16 }}>
              <label className="form-label">Cliente / CNPJ</label>
              <CnpjInput clientes={clientes} value={cnpj} onChange={setCnpj} />
            </div>

            <FormulariosEspecificos id={opAtiva} params={params} onChange={setParams} />

            <div style={{ marginTop: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                onClick={executar}
                disabled={carregando || !status?.pronto}
                className="btn btn-primary"
              >
                {carregando ? 'Processando...' : `Executar ${op.label.toLowerCase()}`}
              </button>
              {carregando && op.id === 'sitfis' && (
                <span className="text-light text-sm">SITFIS leva ~5-30s (Receita gera o relatorio sob demanda)</span>
              )}
            </div>

            {erro && (
              <div className="alert alert-danger mt-2">
                <strong>❌ Erro</strong>
                <div className="mt-1" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{erro}</div>
              </div>
            )}

            {resultado && <Resultado dados={resultado} />}
          </section>
        </main>
      </div>
    </div>
  );
}

// =====================================================
// Autocomplete de CNPJ
// =====================================================
function CnpjInput({ clientes, value, onChange }) {
  const [busca, setBusca] = useState('');
  const [mostraLista, setMostraLista] = useState(false);

  const filtrados = busca
    ? clientes.filter(c => {
        const n = (c.razao_social || '').toLowerCase();
        const cnpjLimpo = (c.cnpj || '').replace(/\D/g, '');
        return n.includes(busca.toLowerCase()) || cnpjLimpo.includes(busca.replace(/\D/g, ''));
      }).slice(0, 8)
    : [];

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="form-control"
        placeholder="Digite CNPJ (so digitos) ou nome do cliente"
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setBusca(e.target.value);
          setMostraLista(true);
        }}
        onFocus={() => setMostraLista(true)}
        onBlur={() => setTimeout(() => setMostraLista(false), 150)}
      />
      {mostraLista && filtrados.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 6, marginTop: 4, maxHeight: 240, overflowY: 'auto', zIndex: 10,
        }}>
          {filtrados.map(c => (
            <div
              key={c.id}
              onMouseDown={() => { onChange(c.cnpj.replace(/\D/g, '')); setBusca(c.razao_social); setMostraLista(false); }}
              style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)' }}
              className="hover-bg"
            >
              <div style={{ fontSize: 13, fontWeight: 500 }}>{c.razao_social}</div>
              <div className="text-muted" style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{c.cnpj}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =====================================================
// Descricao curta por operacao
// =====================================================
function OperacaoDescricao({ id }) {
  const d = {
    sitfis:        'Relatorio oficial de Situacao Fiscal (substituto da CND). Mostra pendencias, divida ativa, parcelamentos.',
    das_simples:   'Gera DAS do Simples Nacional para um periodo de apuracao ja declarado.',
    das_avulso:    'Gera DAS avulso (use quando o cliente nao tem declaracao no periodo).',
    das_cobranca:  'Gera DAS via sistema de Cobranca da RFB — util pra reemitir guias vencidas/atrasadas.',
    das_mei:       'Gera DAS anual do MEI em PDF.',
    ultima_pgdasd: 'Consulta a ultima declaracao PGDAS-D transmitida.',
    procuracoes:   'Valida se a procuracao coletiva da Marcal esta ativa pro cliente no e-CAC.',
    caixa_postal:  'Lista mensagens da Caixa Postal do e-CAC (util pra ver intimacoes/comunicados).',
    dctfweb:       'Lista declaracoes DCTFWeb entregues pelo cliente.',
    pagamentos:    'Consulta historico de pagamentos (DARF/DAS) feitos pelo contribuinte.',
    ccmei:         'Emite o Certificado de Condicao de MEI em PDF.',
    darf:          'Consolida calculo e gera DARF em PDF via Sicalc.',
  };
  return <p className="text-light text-sm" style={{ marginTop: 4 }}>{d[id] || ''}</p>;
}

// =====================================================
// Formularios especificos (parametros extras)
// =====================================================
function FormulariosEspecificos({ id, params, onChange }) {
  const set = (k, v) => onChange({ ...params, [k]: v });

  if (['das_simples', 'das_avulso', 'das_cobranca', 'das_mei'].includes(id)) {
    return (
      <div style={{ marginTop: 16 }}>
        <label className="form-label">Periodo de Apuracao (YYYYMM)</label>
        <input
          className="form-control"
          style={{ maxWidth: 200 }}
          placeholder="202604"
          value={params.periodoApuracao || ''}
          onChange={e => set('periodoApuracao', e.target.value)}
        />
        <div className="text-muted text-sm" style={{ marginTop: 4 }}>Exemplo: 202604 para abril/2026</div>
      </div>
    );
  }

  if (id === 'pagamentos') {
    return (
      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label className="form-label">Data inicio (YYYYMMDD)</label>
          <input className="form-control" placeholder="20260101"
            value={params.dataInicio || ''} onChange={e => set('dataInicio', e.target.value)} />
        </div>
        <div>
          <label className="form-label">Data fim (YYYYMMDD)</label>
          <input className="form-control" placeholder="20260430"
            value={params.dataFim || ''} onChange={e => set('dataFim', e.target.value)} />
        </div>
      </div>
    );
  }

  if (id === 'darf') {
    return (
      <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        <div className="alert alert-warning text-sm">
          DARF exige varios campos especificos. Preencha abaixo OU use o endpoint <code>/chamar</code> pra controle total.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="form-label">Codigo Receita</label>
            <input className="form-control" placeholder="ex: 0220"
              value={params.codigoReceita || ''} onChange={e => set('codigoReceita', e.target.value)} />
          </div>
          <div>
            <label className="form-label">Periodo Apuracao (YYYYMM)</label>
            <input className="form-control" placeholder="202604"
              value={params.periodoApuracao || ''} onChange={e => set('periodoApuracao', e.target.value)} />
          </div>
          <div>
            <label className="form-label">Data Vencimento (DDMMYYYY)</label>
            <input className="form-control" placeholder="30042026"
              value={params.dataVencimento || ''} onChange={e => set('dataVencimento', e.target.value)} />
          </div>
          <div>
            <label className="form-label">Valor Principal</label>
            <input className="form-control" placeholder="1500.00"
              value={params.valorPrincipal || ''} onChange={e => set('valorPrincipal', parseFloat(e.target.value) || 0)} />
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// =====================================================
// Renderiza resultado — PDF inline quando detecta base64
// =====================================================
function Resultado({ dados }) {
  const [mostrarBruto, setMostrarBruto] = useState(false);

  const dadosInternos = dados?.dados ? (typeof dados.dados === 'string' ? tentarJson(dados.dados) : dados.dados) : dados;
  const pdfBase64 = dados?.pdfBase64 || dadosInternos?.pdf || dadosInternos?.relatorio || dadosInternos?.pdfBase64;

  return (
    <div style={{ marginTop: 20 }}>
      <div className="alert alert-success">
        <strong>✅ Resposta recebida</strong>
      </div>

      {pdfBase64 && typeof pdfBase64 === 'string' && pdfBase64.length > 100 && (
        <div style={{ marginTop: 12 }}>
          <div className="mb-1 text-sm">
            <strong>PDF:</strong> {(pdfBase64.length / 1024).toFixed(1)} KB
            {' · '}
            <a
              href={`data:application/pdf;base64,${pdfBase64}`}
              download={`serpro-${Date.now()}.pdf`}
              className="btn-link"
            >Baixar</a>
          </div>
          <iframe
            title="PDF SERPRO"
            src={`data:application/pdf;base64,${pdfBase64}`}
            style={{ width: '100%', height: 600, border: '1px solid var(--border)', borderRadius: 6 }}
          />
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button onClick={() => setMostrarBruto(!mostrarBruto)} className="btn-link text-sm">
          {mostrarBruto ? '▾ Ocultar' : '▸ Ver'} JSON bruto
        </button>
        {mostrarBruto && (
          <pre style={{
            marginTop: 8, padding: 12, background: 'var(--bg-elevated)',
            borderRadius: 6, maxHeight: 400, overflow: 'auto',
            fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap',
          }}>{JSON.stringify(dados, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

function tentarJson(s) { try { return JSON.parse(s); } catch (e) { return s; } }
