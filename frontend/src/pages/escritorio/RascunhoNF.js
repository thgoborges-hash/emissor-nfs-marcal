// Rascunho de NF — Sprint A+B (2026-05-19)
// Ana cria draft em modo equipe a partir de pedido WhatsApp; operador
// revisa campos aqui e clica "Emitir" pra mandar pro Sefin Nacional.
// PDF DANFSe é gerado e enviado automaticamente (WhatsApp + cockpit)
// pelo mesmo fluxo da emissão direta.

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { notasFiscaisApi } from '../../services/api';

const formatarMoeda = (v) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);

export default function RascunhoNF() {
  const navigate = useNavigate();
  const { id } = useParams();

  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [emitindo, setEmitindo] = useState(false);
  const [sucesso, setSucesso] = useState('');
  const [erro, setErro] = useState('');
  const [erros, setErros] = useState([]); // pré-validação
  const [nota, setNota] = useState(null);
  const [form, setForm] = useState({});

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const { data } = await notasFiscaisApi.buscar(id);
      setNota(data);
      setForm({
        valor_servico: data.valor_servico ?? '',
        descricao_servico: data.descricao_servico ?? '',
        codigo_servico: data.codigo_servico ?? '',
        data_competencia: (data.data_competencia || '').slice(0, 10),
        codigo_municipio_prestacao: data.codigo_municipio_prestacao ?? '',
        nbs: data.nbs ?? '',
        // ISS
        aliquota_iss: data.aliquota_iss != null ? data.aliquota_iss * 100 : '',
        valor_iss: data.valor_iss ?? '',
        iss_retido: !!data.iss_retido,
        valor_iss_retido: data.valor_iss_retido ?? '',
        // PIS/COFINS
        cst_piscofins: data.cst_piscofins ?? '',
        base_calculo_pis_cofins: data.base_calculo_pis_cofins ?? '',
        aliquota_pis: data.aliquota_pis != null ? data.aliquota_pis * 100 : '',
        valor_pis_proprio: data.valor_pis_proprio ?? '',
        valor_pis_retido: data.valor_pis_retido ?? '',
        aliquota_cofins: data.aliquota_cofins != null ? data.aliquota_cofins * 100 : '',
        valor_cofins_proprio: data.valor_cofins_proprio ?? '',
        valor_cofins_retido: data.valor_cofins_retido ?? '',
        // Retenções federais
        valor_ir: data.valor_ir ?? '',
        valor_csll: data.valor_csll ?? '',
        valor_inss: data.valor_inss ?? '',
        // IBPT (Lei 12.741)
        p_tot_trib_fed: data.p_tot_trib_fed ?? '',
        p_tot_trib_est: data.p_tot_trib_est ?? '',
        p_tot_trib_mun: data.p_tot_trib_mun ?? '',
        // Líquido
        valor_liquido: data.valor_liquido ?? '',
        base_calculo: data.base_calculo ?? '',
      });
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao carregar rascunho');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => { carregar(); }, [carregar]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  // Conversões: campos de % no form (5.00) vão pro DB como decimal (0.05)
  function montarPayload() {
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const numPct = (v) => (v === '' || v == null ? null : Number(v) / 100);
    return {
      valor_servico: num(form.valor_servico),
      descricao_servico: form.descricao_servico,
      codigo_servico: form.codigo_servico,
      data_competencia: form.data_competencia,
      codigo_municipio_prestacao: form.codigo_municipio_prestacao || null,
      nbs: form.nbs || null,
      aliquota_iss: numPct(form.aliquota_iss),
      valor_iss: num(form.valor_iss),
      iss_retido: form.iss_retido ? 1 : 0,
      valor_iss_retido: num(form.valor_iss_retido) || 0,
      cst_piscofins: form.cst_piscofins || null,
      base_calculo_pis_cofins: num(form.base_calculo_pis_cofins),
      aliquota_pis: numPct(form.aliquota_pis),
      valor_pis_proprio: num(form.valor_pis_proprio) || 0,
      valor_pis_retido: num(form.valor_pis_retido) || 0,
      aliquota_cofins: numPct(form.aliquota_cofins),
      valor_cofins_proprio: num(form.valor_cofins_proprio) || 0,
      valor_cofins_retido: num(form.valor_cofins_retido) || 0,
      valor_ir: num(form.valor_ir) || 0,
      valor_csll: num(form.valor_csll) || 0,
      valor_inss: num(form.valor_inss) || 0,
      p_tot_trib_fed: num(form.p_tot_trib_fed),
      p_tot_trib_est: num(form.p_tot_trib_est),
      p_tot_trib_mun: num(form.p_tot_trib_mun),
      valor_liquido: num(form.valor_liquido),
      base_calculo: num(form.base_calculo),
    };
  }

  const handleSalvar = async () => {
    setErro(''); setSucesso(''); setErros([]); setSalvando(true);
    try {
      await notasFiscaisApi.atualizarRascunho(id, montarPayload());
      setSucesso('Rascunho atualizado.');
      await carregar();
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao salvar');
    } finally { setSalvando(false); }
  };

  const handleEmitir = async () => {
    if (!window.confirm('Confirma emitir esta NF? A emissão é irreversível e o XML vai pro Sefin Nacional.')) return;
    setErro(''); setSucesso(''); setErros([]); setEmitindo(true);
    try {
      // Salva eventuais alterações antes de emitir
      await notasFiscaisApi.atualizarRascunho(id, montarPayload());
      const { data } = await notasFiscaisApi.emitirRascunho(id);
      const numero = data?.nota?.numero_nfse || '(emitida)';
      setSucesso(`✅ NF emitida com sucesso! Número: ${numero}. PDF será disponibilizado em breve.`);
      setTimeout(() => navigate('/escritorio/notas'), 3000);
    } catch (err) {
      const respErros = err.response?.data?.erros;
      if (Array.isArray(respErros)) setErros(respErros);
      setErro(err.response?.data?.erro || err.response?.data?.detalhes || 'Erro ao emitir');
    } finally { setEmitindo(false); }
  };

  const handleDescartar = async () => {
    if (!window.confirm('Descartar este rascunho? A NF não será emitida.')) return;
    setErro(''); setSalvando(true);
    try {
      await notasFiscaisApi.descartarRascunho(id);
      navigate('/escritorio/notas');
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao descartar');
    } finally { setSalvando(false); }
  };

  if (carregando) return <div style={{ padding: 40 }}>Carregando rascunho...</div>;
  if (!nota) return <div style={{ padding: 40 }}>{erro || 'Rascunho não encontrado'}</div>;

  const isRascunho = nota.status === 'rascunho';
  const totalRetencoes =
    (Number(form.valor_iss_retido) || 0) +
    (Number(form.valor_pis_retido) || 0) +
    (Number(form.valor_cofins_retido) || 0) +
    (Number(form.valor_ir) || 0) +
    (Number(form.valor_csll) || 0) +
    (Number(form.valor_inss) || 0);
  const valorLiquidoCalculado = (Number(form.valor_servico) || 0) - totalRetencoes;

  return (
    <div>
      <h1 className="page-title">📝 Rascunho NF #{nota.id}</h1>
      <div style={{ marginBottom: 16, color: '#64748b' }}>
        <strong>{nota.cliente_razao_social || `Cliente ID ${nota.cliente_id}`}</strong> →{' '}
        <strong>{nota.tomador_razao_social || 'Tomador'}</strong> ·{' '}
        Status: <span style={{ background: isRascunho ? '#fef3c7' : '#e0e7ff', padding: '2px 8px', borderRadius: 4 }}>{nota.status}</span>
      </div>

      {sucesso && <div className="alert alert-success">{sucesso}</div>}
      {erro && <div className="alert alert-danger">{erro}</div>}
      {erros.length > 0 && (
        <div className="alert alert-danger">
          <strong>Pré-validação falhou:</strong>
          <ul style={{ margin: '8px 0 0 16px' }}>
            {erros.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {!isRascunho && (
        <div className="alert alert-danger">
          Esta NF não está em status 'rascunho' (atual: {nota.status}). Edição desabilitada.
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Serviço e valor</h3>
        <div className="form-row-3">
          <div className="form-group">
            <label>Valor do serviço (R$) *</label>
            <input type="number" name="valor_servico" value={form.valor_servico} onChange={handleChange} step="0.01" min="0" />
          </div>
          <div className="form-group">
            <label>Código de serviço (cTribNac) *</label>
            <input type="text" name="codigo_servico" value={form.codigo_servico} onChange={handleChange} maxLength={6} />
          </div>
          <div className="form-group">
            <label>Competência (AAAA-MM)</label>
            <input type="text" name="data_competencia" value={form.data_competencia} onChange={handleChange} placeholder="2026-04" />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>NBS (Nomenclatura Brasileira de Serviços)</label>
            <input type="text" name="nbs" value={form.nbs} onChange={handleChange} />
          </div>
          <div className="form-group">
            <label>Código IBGE local da prestação</label>
            <input type="text" name="codigo_municipio_prestacao" value={form.codigo_municipio_prestacao} onChange={handleChange} maxLength={7} placeholder="ex: 4308805 (Gravataí)" />
          </div>
        </div>
        <div className="form-group">
          <label>Descrição do serviço *</label>
          <textarea name="descricao_servico" value={form.descricao_servico} onChange={handleChange} rows={4} />
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">ISSQN</h3>
        <div className="form-row-3">
          <div className="form-group">
            <label>Alíquota ISS (%)</label>
            <input type="number" name="aliquota_iss" value={form.aliquota_iss} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group">
            <label>Valor ISS apurado</label>
            <input type="number" name="valor_iss" value={form.valor_iss} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group">
            <label>ISS retido pelo tomador?</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" name="iss_retido" checked={!!form.iss_retido} onChange={handleChange} />
              {form.iss_retido ? 'Sim' : 'Não'}
            </label>
          </div>
        </div>
        {form.iss_retido && (
          <div className="form-group">
            <label>Valor ISS efetivamente retido</label>
            <input type="number" name="valor_iss_retido" value={form.valor_iss_retido} onChange={handleChange} step="0.01" />
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">PIS / COFINS</h3>
        <div className="form-row-3">
          <div className="form-group">
            <label>CST PIS/COFINS</label>
            <input type="text" name="cst_piscofins" value={form.cst_piscofins} onChange={handleChange} maxLength={2} placeholder="01" />
          </div>
          <div className="form-group">
            <label>Base de cálculo PIS/COFINS</label>
            <input type="number" name="base_calculo_pis_cofins" value={form.base_calculo_pis_cofins} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group"></div>
        </div>
        <div className="form-row-3">
          <div className="form-group">
            <label>Alíquota PIS (%)</label>
            <input type="number" name="aliquota_pis" value={form.aliquota_pis} onChange={handleChange} step="0.0001" placeholder="0.65" />
          </div>
          <div className="form-group">
            <label>PIS débito apuração própria</label>
            <input type="number" name="valor_pis_proprio" value={form.valor_pis_proprio} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group">
            <label>PIS retido pelo tomador</label>
            <input type="number" name="valor_pis_retido" value={form.valor_pis_retido} onChange={handleChange} step="0.01" />
          </div>
        </div>
        <div className="form-row-3">
          <div className="form-group">
            <label>Alíquota COFINS (%)</label>
            <input type="number" name="aliquota_cofins" value={form.aliquota_cofins} onChange={handleChange} step="0.0001" placeholder="3.00" />
          </div>
          <div className="form-group">
            <label>COFINS débito apuração própria</label>
            <input type="number" name="valor_cofins_proprio" value={form.valor_cofins_proprio} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group">
            <label>COFINS retido pelo tomador</label>
            <input type="number" name="valor_cofins_retido" value={form.valor_cofins_retido} onChange={handleChange} step="0.01" />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Outras retenções federais</h3>
        <div className="form-row-3">
          <div className="form-group">
            <label>IRRF retido</label>
            <input type="number" name="valor_ir" value={form.valor_ir} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group">
            <label>CSLL retida</label>
            <input type="number" name="valor_csll" value={form.valor_csll} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group">
            <label>INSS (Contrib. Previdenciária) retido</label>
            <input type="number" name="valor_inss" value={form.valor_inss} onChange={handleChange} step="0.01" />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">IBPT (Lei 12.741/2012)</h3>
        <div className="form-row-3">
          <div className="form-group">
            <label>% Federal</label>
            <input type="number" name="p_tot_trib_fed" value={form.p_tot_trib_fed} onChange={handleChange} step="0.01" placeholder="6.15" />
          </div>
          <div className="form-group">
            <label>% Estadual</label>
            <input type="number" name="p_tot_trib_est" value={form.p_tot_trib_est} onChange={handleChange} step="0.01" />
          </div>
          <div className="form-group">
            <label>% Municipal</label>
            <input type="number" name="p_tot_trib_mun" value={form.p_tot_trib_mun} onChange={handleChange} step="0.01" placeholder="2.00" />
          </div>
        </div>
      </div>

      <div className="card" style={{ background: '#f1f5f9' }}>
        <h3 className="card-title">Resumo</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          <div>Valor bruto: <strong>{formatarMoeda(form.valor_servico)}</strong></div>
          <div>Total retenções: <strong>{formatarMoeda(totalRetencoes)}</strong></div>
          <div>Valor líquido calculado: <strong>{formatarMoeda(valorLiquidoCalculado)}</strong></div>
          <div>
            Valor líquido salvo:{' '}
            <input
              type="number"
              name="valor_liquido"
              value={form.valor_liquido}
              onChange={handleChange}
              step="0.01"
              style={{ width: 140, display: 'inline-block', marginLeft: 4 }}
            />
            <button
              type="button"
              className="btn btn-outline"
              style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
              onClick={() => setForm((p) => ({ ...p, valor_liquido: valorLiquidoCalculado.toFixed(2) }))}
            >
              Usar calculado
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 }}>
        <button type="button" className="btn btn-outline" onClick={() => navigate('/escritorio/notas')} disabled={salvando || emitindo}>
          Voltar
        </button>
        <button type="button" className="btn btn-outline" onClick={handleDescartar} disabled={!isRascunho || salvando || emitindo} style={{ color: '#dc2626' }}>
          Descartar rascunho
        </button>
        <button type="button" className="btn btn-outline" onClick={handleSalvar} disabled={!isRascunho || salvando || emitindo}>
          {salvando ? 'Salvando...' : 'Salvar alterações'}
        </button>
        <button type="button" className="btn btn-primary" onClick={handleEmitir} disabled={!isRascunho || salvando || emitindo}>
          {emitindo ? 'Emitindo...' : '🚀 Emitir NF'}
        </button>
      </div>
    </div>
  );
}
