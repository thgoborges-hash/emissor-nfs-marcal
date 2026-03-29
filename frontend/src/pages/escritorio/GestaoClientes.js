import React, { useState, useEffect } from 'react';
import { clientesApi } from '../../services/api';

export default function GestaoClientes() {
  const [clientes, setClientes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [sucesso, setSucesso] = useState('');
  const [erro, setErro] = useState('');

  const formVazio = {
    razao_social: '', nome_fantasia: '', cnpj: '', email: '', telefone: '',
    codigo_servico: '', descricao_servico_padrao: '', aliquota_iss: '5',
    modo_emissao: 'aprovacao', senha: '', municipio: '', uf: '', codigo_municipio: ''
  };
  const [form, setForm] = useState(formVazio);

  const carregarClientes = async () => {
    try {
      const { data } = await clientesApi.listar();
      setClientes(data);
    } catch (err) { console.error(err); }
    finally { setCarregando(false); }
  };

  useEffect(() => { carregarClientes(); }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
  };

  const formatarCnpj = (valor) => {
    const nums = valor.replace(/\D/g, '').slice(0, 14);
    return nums
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro('');
    try {
      await clientesApi.criar({
        ...form,
        aliquota_iss: parseFloat(form.aliquota_iss) / 100
      });
      setSucesso('Cliente cadastrado com sucesso!');
      setForm(formVazio);
      setMostrarForm(false);
      carregarClientes();
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao cadastrar cliente');
    }
  };

  const toggleAtivo = async (id, ativo) => {
    try {
      await clientesApi.atualizar(id, { ativo: ativo ? 0 : 1 });
      carregarClientes();
    } catch (err) {
      alert('Erro ao atualizar status');
    }
  };

  const alterarModo = async (id, modoAtual) => {
    const novoModo = modoAtual === 'autonomo' ? 'aprovacao' : 'autonomo';
    try {
      await clientesApi.atualizar(id, { modo_emissao: novoModo });
      carregarClientes();
    } catch (err) {
      alert('Erro ao alterar modo');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Gestão de Clientes</h1>
        <button className="btn btn-primary" onClick={() => setMostrarForm(!mostrarForm)}>
          {mostrarForm ? 'Cancelar' : '+ Novo Cliente'}
        </button>
      </div>

      {sucesso && <div className="alert alert-success">{sucesso}</div>}
      {erro && <div className="alert alert-danger">{erro}</div>}

      {mostrarForm && (
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Cadastrar Novo Cliente</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-row">
              <div className="form-group">
                <label>Razão Social *</label>
                <input type="text" name="razao_social" value={form.razao_social} onChange={handleChange} required />
              </div>
              <div className="form-group">
                <label>Nome Fantasia</label>
                <input type="text" name="nome_fantasia" value={form.nome_fantasia} onChange={handleChange} />
              </div>
            </div>
            <div className="form-row-3">
              <div className="form-group">
                <label>CNPJ *</label>
                <input type="text" name="cnpj" value={form.cnpj} onChange={(e) => setForm(prev => ({ ...prev, cnpj: formatarCnpj(e.target.value) }))} required />
              </div>
              <div className="form-group">
                <label>Email *</label>
                <input type="email" name="email" value={form.email} onChange={handleChange} required />
              </div>
              <div className="form-group">
                <label>Telefone</label>
                <input type="text" name="telefone" value={form.telefone} onChange={handleChange} />
              </div>
            </div>
            <div className="form-row-3">
              <div className="form-group">
                <label>Código Serviço Padrão</label>
                <input type="text" name="codigo_servico" value={form.codigo_servico} onChange={handleChange} placeholder="Ex: 01.01" />
              </div>
              <div className="form-group">
                <label>Alíquota ISS (%)</label>
                <input type="number" name="aliquota_iss" value={form.aliquota_iss} onChange={handleChange} step="0.01" />
              </div>
              <div className="form-group">
                <label>Modo de Emissão</label>
                <select name="modo_emissao" value={form.modo_emissao} onChange={handleChange}>
                  <option value="aprovacao">Precisa de aprovação</option>
                  <option value="autonomo">Autônomo (emite direto)</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Município</label>
                <input type="text" name="municipio" value={form.municipio} onChange={handleChange} />
              </div>
              <div className="form-group">
                <label>UF</label>
                <input type="text" name="uf" value={form.uf} onChange={handleChange} maxLength={2} />
              </div>
            </div>
            <div className="form-group">
              <label>Descrição Padrão do Serviço</label>
              <textarea name="descricao_servico_padrao" value={form.descricao_servico_padrao} onChange={handleChange} rows={2} />
            </div>
            <div className="form-group">
              <label>Senha de Acesso do Cliente (portal)</label>
              <input type="password" name="senha" value={form.senha} onChange={handleChange} placeholder="Senha para o cliente acessar o portal" />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={() => setMostrarForm(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary">Cadastrar Cliente</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {carregando ? <p>Carregando...</p> : clientes.length === 0 ? (
          <div className="empty-state">
            <div className="icon">🏢</div>
            <p>Nenhum cliente cadastrado.</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Razão Social</th>
                  <th>CNPJ</th>
                  <th>Município</th>
                  <th>Modo</th>
                  <th>NFs</th>
                  <th>Pendentes</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {clientes.map(c => (
                  <tr key={c.id}>
                    <td><strong>{c.razao_social}</strong>{c.nome_fantasia ? <br /> : null}{c.nome_fantasia && <small style={{ color: 'var(--text-light)' }}>{c.nome_fantasia}</small>}</td>
                    <td>{c.cnpj}</td>
                    <td>{c.municipio ? `${c.municipio}/${c.uf}` : '-'}</td>
                    <td>
                      <button className="btn btn-outline btn-sm" onClick={() => alterarModo(c.id, c.modo_emissao)} title="Clique para alternar">
                        {c.modo_emissao === 'autonomo' ? '🟢 Autônomo' : '🟡 Aprovação'}
                      </button>
                    </td>
                    <td>{c.total_nfs}</td>
                    <td>{c.nfs_pendentes > 0 ? <span className="badge badge-pendente_aprovacao">{c.nfs_pendentes}</span> : '0'}</td>
                    <td>{c.ativo ? <span style={{ color: 'var(--success)' }}>Ativo</span> : <span style={{ color: 'var(--text-light)' }}>Inativo</span>}</td>
                    <td>
                      <button className="btn btn-outline btn-sm" onClick={() => toggleAtivo(c.id, c.ativo)}>
                        {c.ativo ? 'Desativar' : 'Ativar'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
