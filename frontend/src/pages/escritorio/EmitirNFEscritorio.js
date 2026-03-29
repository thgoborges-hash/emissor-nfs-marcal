import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { clientesApi, tomadoresApi, notasFiscaisApi } from '../../services/api';

export default function EmitirNFEscritorio() {
  const navigate = useNavigate();
  const [clientes, setClientes] = useState([]);
  const [tomadores, setTomadores] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [sucesso, setSucesso] = useState('');
  const [erro, setErro] = useState('');

  const [form, setForm] = useState({
    cliente_id: '',
    tomador_id: '',
    codigo_servico: '',
    descricao_servico: '',
    valor_servico: '',
    valor_deducoes: '0',
    aliquota_iss: '5',
    iss_retido: false,
    data_competencia: new Date().toISOString().slice(0, 7),
    observacoes: ''
  });

  useEffect(() => {
    clientesApi.listar().then(({ data }) => setClientes(data)).catch(console.error);
  }, []);

  // Quando seleciona o cliente, carrega tomadores e preenche dados padrão
  useEffect(() => {
    if (form.cliente_id) {
      const cliente = clientes.find(c => c.id === parseInt(form.cliente_id));
      if (cliente) {
        setForm(prev => ({
          ...prev,
          codigo_servico: prev.codigo_servico || cliente.codigo_servico || '',
          aliquota_iss: prev.aliquota_iss || (cliente.aliquota_iss ? (cliente.aliquota_iss * 100).toString() : '5'),
        }));
      }
      tomadoresApi.listar(form.cliente_id).then(({ data }) => setTomadores(data)).catch(console.error);
    } else {
      setTomadores([]);
    }
  }, [form.cliente_id, clientes]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const valorServico = parseFloat(form.valor_servico) || 0;
  const aliquotaIss = parseFloat(form.aliquota_iss) / 100 || 0;
  const valorIss = (valorServico - (parseFloat(form.valor_deducoes) || 0)) * aliquotaIss;
  const formatarMoeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro(''); setSucesso(''); setCarregando(true);

    try {
      const dados = {
        cliente_id: parseInt(form.cliente_id),
        tomador_id: form.tomador_id ? parseInt(form.tomador_id) : null,
        codigo_servico: form.codigo_servico,
        descricao_servico: form.descricao_servico,
        valor_servico: valorServico,
        valor_deducoes: parseFloat(form.valor_deducoes) || 0,
        aliquota_iss: aliquotaIss,
        iss_retido: form.iss_retido,
        data_competencia: form.data_competencia + '-01',
        observacoes: form.observacoes
      };

      const { data } = await notasFiscaisApi.criar(dados);

      // Escritório já cria aprovada, oferece emitir
      if (window.confirm('Nota criada! Deseja emitir agora?')) {
        await notasFiscaisApi.emitir(data.id);
        setSucesso('Nota fiscal emitida com sucesso!');
      } else {
        setSucesso(data.mensagem);
      }

      setTimeout(() => navigate('/escritorio/notas'), 2000);
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao criar nota fiscal');
    } finally {
      setCarregando(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Emitir NF (Escritório)</h1>

      {sucesso && <div className="alert alert-success">{sucesso}</div>}
      {erro && <div className="alert alert-danger">{erro}</div>}

      <form onSubmit={handleSubmit}>
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Cliente e Tomador</h3>
          <div className="form-row">
            <div className="form-group">
              <label>Cliente *</label>
              <select name="cliente_id" value={form.cliente_id} onChange={handleChange} required>
                <option value="">-- Selecione --</option>
                {clientes.filter(c => c.ativo).map(c => (
                  <option key={c.id} value={c.id}>{c.razao_social} ({c.cnpj})</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Tomador</label>
              <select name="tomador_id" value={form.tomador_id} onChange={handleChange} disabled={!form.cliente_id}>
                <option value="">-- Selecione --</option>
                {tomadores.map(t => (
                  <option key={t.id} value={t.id}>{t.favorito ? '⭐ ' : ''}{t.razao_social} ({t.documento})</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Serviço e Valores</h3>
          <div className="form-row-3">
            <div className="form-group">
              <label>Código Serviço *</label>
              <input type="text" name="codigo_servico" value={form.codigo_servico} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>Valor do Serviço (R$) *</label>
              <input type="number" name="valor_servico" value={form.valor_servico} onChange={handleChange} step="0.01" min="0.01" required />
            </div>
            <div className="form-group">
              <label>Competência *</label>
              <input type="month" name="data_competencia" value={form.data_competencia} onChange={handleChange} required />
            </div>
          </div>
          <div className="form-group">
            <label>Descrição do Serviço *</label>
            <textarea name="descricao_servico" value={form.descricao_servico} onChange={handleChange} rows={2} required />
          </div>
          <div className="form-row-3">
            <div className="form-group">
              <label>Alíquota ISS (%)</label>
              <input type="number" name="aliquota_iss" value={form.aliquota_iss} onChange={handleChange} step="0.01" />
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
          <div className="form-group">
            <label>Observações</label>
            <textarea name="observacoes" value={form.observacoes} onChange={handleChange} rows={2} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/escritorio')}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={carregando}>
            {carregando ? 'Processando...' : 'Criar e Emitir NF'}
          </button>
        </div>
      </form>
    </div>
  );
}
