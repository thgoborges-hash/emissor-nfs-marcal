import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { tomadoresApi, notasFiscaisApi } from '../../services/api';

export default function EmitirNF() {
  const { usuario } = useAuth();
  const navigate = useNavigate();

  const [tomadores, setTomadores] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [sucesso, setSucesso] = useState('');
  const [erro, setErro] = useState('');

  const clienteId = usuario?.id || usuario?.clienteId;

  const [form, setForm] = useState({
    tomador_id: '',
    codigo_servico: usuario?.codigoServico || '',
    descricao_servico: usuario?.descricaoServicoPadrao || '',
    valor_servico: '',
    valor_deducoes: '0',
    aliquota_iss: usuario?.aliquotaIss ? (usuario.aliquotaIss * 100).toString() : '5',
    iss_retido: false,
    valor_pis: '0',
    valor_cofins: '0',
    valor_inss: '0',
    valor_ir: '0',
    valor_csll: '0',
    data_competencia: new Date().toISOString().slice(0, 7), // YYYY-MM
    observacoes: ''
  });

  useEffect(() => {
    if (clienteId) {
      tomadoresApi.listar(clienteId)
        .then(({ data }) => setTomadores(data))
        .catch(console.error);
    }
  }, [clienteId]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  // Cálculos em tempo real
  const valorServico = parseFloat(form.valor_servico) || 0;
  const valorDeducoes = parseFloat(form.valor_deducoes) || 0;
  const baseCalculo = valorServico - valorDeducoes;
  const aliquotaIss = parseFloat(form.aliquota_iss) / 100 || 0;
  const valorIss = baseCalculo * aliquotaIss;
  const retencoes = (parseFloat(form.valor_pis) || 0) + (parseFloat(form.valor_cofins) || 0) +
    (parseFloat(form.valor_inss) || 0) + (parseFloat(form.valor_ir) || 0) +
    (parseFloat(form.valor_csll) || 0);
  const issRetidoValor = form.iss_retido ? valorIss : 0;
  const valorLiquido = valorServico - retencoes - issRetidoValor;

  const formatarMoeda = (valor) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro('');
    setSucesso('');
    setCarregando(true);

    try {
      const dados = {
        cliente_id: clienteId,
        tomador_id: form.tomador_id ? parseInt(form.tomador_id) : null,
        codigo_servico: form.codigo_servico,
        descricao_servico: form.descricao_servico,
        valor_servico: valorServico,
        valor_deducoes: valorDeducoes,
        aliquota_iss: aliquotaIss,
        iss_retido: form.iss_retido,
        valor_pis: parseFloat(form.valor_pis) || 0,
        valor_cofins: parseFloat(form.valor_cofins) || 0,
        valor_inss: parseFloat(form.valor_inss) || 0,
        valor_ir: parseFloat(form.valor_ir) || 0,
        valor_csll: parseFloat(form.valor_csll) || 0,
        data_competencia: form.data_competencia + '-01',
        observacoes: form.observacoes
      };

      const { data } = await notasFiscaisApi.criar(dados);
      setSucesso(data.mensagem);

      // Se a nota já foi aprovada (modo autônomo), oferece emitir
      if (data.status === 'aprovada') {
        if (window.confirm('Nota criada! Deseja emitir agora?')) {
          await notasFiscaisApi.emitir(data.id);
          setSucesso('Nota fiscal emitida com sucesso!');
        }
      }

      // Limpa o formulário depois de 2s
      setTimeout(() => navigate('/cliente/historico'), 2000);
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao criar nota fiscal');
    } finally {
      setCarregando(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Emitir Nota Fiscal</h1>

      {sucesso && <div className="alert alert-success">{sucesso}</div>}
      {erro && <div className="alert alert-danger">{erro}</div>}

      <form onSubmit={handleSubmit}>
        {/* Tomador */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Tomador do Serviço</h3>

          <div className="form-group">
            <label>Selecione o tomador</label>
            <select name="tomador_id" value={form.tomador_id} onChange={handleChange}>
              <option value="">-- Selecione um tomador --</option>
              {tomadores.map(t => (
                <option key={t.id} value={t.id}>
                  {t.favorito ? '⭐ ' : ''}{t.razao_social} ({t.documento})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => navigate('/cliente/tomadores?novo=1')}
          >
            + Cadastrar novo tomador
          </button>
        </div>

        {/* Serviço */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Dados do Serviço</h3>

          <div className="form-row">
            <div className="form-group">
              <label>Código do Serviço (Subitem LC 116)</label>
              <input
                type="text"
                name="codigo_servico"
                value={form.codigo_servico}
                onChange={handleChange}
                placeholder="Ex: 01.01"
                required
              />
            </div>
            <div className="form-group">
              <label>Competência</label>
              <input
                type="month"
                name="data_competencia"
                value={form.data_competencia}
                onChange={handleChange}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label>Descrição do Serviço</label>
            <textarea
              name="descricao_servico"
              value={form.descricao_servico}
              onChange={handleChange}
              rows={3}
              placeholder="Descreva o serviço prestado..."
              required
            />
          </div>
        </div>

        {/* Valores */}
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Valores</h3>

          <div className="form-row">
            <div className="form-group">
              <label>Valor do Serviço (R$)</label>
              <input
                type="number"
                name="valor_servico"
                value={form.valor_servico}
                onChange={handleChange}
                step="0.01"
                min="0.01"
                placeholder="0,00"
                required
              />
            </div>
            <div className="form-group">
              <label>Deduções (R$)</label>
              <input
                type="number"
                name="valor_deducoes"
                value={form.valor_deducoes}
                onChange={handleChange}
                step="0.01"
                min="0"
              />
            </div>
          </div>

          <div className="form-row-3">
            <div className="form-group">
              <label>Alíquota ISS (%)</label>
              <input
                type="number"
                name="aliquota_iss"
                value={form.aliquota_iss}
                onChange={handleChange}
                step="0.01"
                min="0"
                max="5"
              />
            </div>
            <div className="form-group">
              <label>ISS Retido?</label>
              <select name="iss_retido" value={form.iss_retido} onChange={(e) => setForm(prev => ({ ...prev, iss_retido: e.target.value === 'true' }))}>
                <option value="false">Não</option>
                <option value="true">Sim</option>
              </select>
            </div>
            <div className="form-group">
              <label>Valor ISS</label>
              <input type="text" value={formatarMoeda(valorIss)} readOnly style={{ background: '#f1f5f9' }} />
            </div>
          </div>

          {/* Retenções federais */}
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-light)', fontSize: 13, marginBottom: 12 }}>
              Retenções federais (opcional)
            </summary>
            <div className="form-row-3">
              <div className="form-group">
                <label>PIS (R$)</label>
                <input type="number" name="valor_pis" value={form.valor_pis} onChange={handleChange} step="0.01" min="0" />
              </div>
              <div className="form-group">
                <label>COFINS (R$)</label>
                <input type="number" name="valor_cofins" value={form.valor_cofins} onChange={handleChange} step="0.01" min="0" />
              </div>
              <div className="form-group">
                <label>INSS (R$)</label>
                <input type="number" name="valor_inss" value={form.valor_inss} onChange={handleChange} step="0.01" min="0" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>IR (R$)</label>
                <input type="number" name="valor_ir" value={form.valor_ir} onChange={handleChange} step="0.01" min="0" />
              </div>
              <div className="form-group">
                <label>CSLL (R$)</label>
                <input type="number" name="valor_csll" value={form.valor_csll} onChange={handleChange} step="0.01" min="0" />
              </div>
            </div>
          </details>
        </div>

        {/* Resumo */}
        <div className="card" style={{ background: '#f0f9ff' }}>
          <h3 className="card-title" style={{ marginBottom: 12 }}>Resumo</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, textAlign: 'center' }}>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-light)' }}>Base de Cálculo</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{formatarMoeda(baseCalculo)}</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-light)' }}>Total Retenções</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--danger)' }}>{formatarMoeda(retencoes + issRetidoValor)}</div>
            </div>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-light)' }}>Valor Líquido</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--success)' }}>{formatarMoeda(valorLiquido)}</div>
            </div>
          </div>
        </div>

        {/* Observações */}
        <div className="card">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Observações (opcional)</label>
            <textarea
              name="observacoes"
              value={form.observacoes}
              onChange={handleChange}
              rows={2}
              placeholder="Informações adicionais..."
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/cliente')}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={carregando}>
            {carregando ? 'Enviando...' : usuario?.modoEmissao === 'autonomo' ? 'Criar e Emitir NF' : 'Solicitar Emissão'}
          </button>
        </div>
      </form>
    </div>
  );
}
