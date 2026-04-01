import React, { useState, useEffect } from 'react';
import { clientesApi } from '../../services/api';

export default function GestaoClientes() {
  const [clientes, setClientes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [mostrarImportacao, setMostrarImportacao] = useState(false);
  const [importando, setImportando] = useState(false);
  const [resultadoImportacao, setResultadoImportacao] = useState(null);
  const [dadosImportacao, setDadosImportacao] = useState(null);
  const [senhaImportacao, setSenhaImportacao] = useState('1234');
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

  const handleArquivoImportacao = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const dados = JSON.parse(event.target.result);
        if (!Array.isArray(dados)) {
          setErro('Arquivo deve conter um array de clientes');
          return;
        }
        setDadosImportacao(dados);
        setErro('');
      } catch {
        setErro('Arquivo JSON inválido');
      }
    };
    reader.readAsText(file);
  };

  const executarImportacao = async () => {
    if (!dadosImportacao || dadosImportacao.length === 0) return;
    setImportando(true);
    setErro('');
    try {
      const { data } = await clientesApi.importar(dadosImportacao, senhaImportacao);
      setResultadoImportacao(data);
      setSucesso(data.mensagem);
      carregarClientes();
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro na importação');
    } finally {
      setImportando(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Gestão de Clientes</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={() => { setMostrarImportacao(!mostrarImportacao); setMostrarForm(false); }}>
            {mostrarImportacao ? 'Fechar Importação' : '📥 Importar Clientes'}
          </button>
          <button className="btn btn-primary" onClick={() => { setMostrarForm(!mostrarForm); setMostrarImportacao(false); }}>
            {mostrarForm ? 'Cancelar' : '+ Novo Cliente'}
          </button>
        </div>
      </div>

      {sucesso && <div className="alert alert-success">{sucesso}</div>}
      {erro && <div className="alert alert-danger">{erro}</div>}

      {mostrarImportacao && (
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>Importar Clientes em Massa</h3>
          <p style={{ color: 'var(--text-light)', marginBottom: 16 }}>
            Selecione um arquivo JSON com os dados dos clientes extraídos do sistema Domínio.
          </p>

          <div className="form-row">
            <div className="form-group">
              <label>Arquivo JSON</label>
              <input type="file" accept=".json" onChange={handleArquivoImportacao} />
            </div>
            <div className="form-group">
              <label>Senha Padrão</label>
              <input type="text" value={senhaImportacao} onChange={(e) => setSenhaImportacao(e.target.value)} placeholder="Senha para acesso ao portal" />
            </div>
          </div>

          {dadosImportacao && !resultadoImportacao && (
            <div style={{ marginTop: 16 }}>
              <p><strong>{dadosImportacao.length} clientes</strong> encontrados no arquivo.</p>
              <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 16, border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                <table style={{ fontSize: '0.85rem' }}>
                  <thead>
                    <tr><th>Razão Social</th><th>CNPJ/CPF</th><th>Município/UF</th></tr>
                  </thead>
                  <tbody>
                    {dadosImportacao.map((c, i) => (
                      <tr key={i}>
                        <td>{c.razao_social}</td>
                        <td>{c.documento}</td>
                        <td>{c.municipio ? `${c.municipio}/${c.uf}` : c.uf || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="btn btn-primary" onClick={executarImportacao} disabled={importando}>
                {importando ? 'Importando...' : `Importar ${dadosImportacao.length} Clientes`}
              </button>
            </div>
          )}

          {resultadoImportacao && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
                <div style={{ padding: '12px 20px', background: 'var(--success)', color: '#fff', borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{resultadoImportacao.importados}</div>
                  <div style={{ fontSize: '0.8rem' }}>Importados</div>
                </div>
                <div style={{ padding: '12px 20px', background: '#f59e0b', color: '#fff', borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{resultadoImportacao.duplicados}</div>
                  <div style={{ fontSize: '0.8rem' }}>Duplicados</div>
                </div>
                <div style={{ padding: '12px 20px', background: 'var(--danger)', color: '#fff', borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{resultadoImportacao.erros}</div>
                  <div style={{ fontSize: '0.8rem' }}>Erros</div>
                </div>
              </div>
              {resultadoImportacao.detalhes && resultadoImportacao.detalhes.filter(d => d.status !== 'importado').length > 0 && (
                <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                  <table style={{ fontSize: '0.85rem' }}>
                    <thead>
                      <tr><th>Razão Social</th><th>Documento</th><th>Status</th><th>Motivo</th></tr>
                    </thead>
                    <tbody>
                      {resultadoImportacao.detalhes.filter(d => d.status !== 'importado').map((d, i) => (
                        <tr key={i}>
                          <td>{d.razao_social}</td>
                          <td>{d.documento}</td>
                          <td><span style={{ color: d.status === 'duplicado' ? '#f59e0b' : 'var(--danger)' }}>{d.status}</span></td>
                          <td>{d.motivo || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button className="btn btn-outline" style={{ marginTop: 12 }} onClick={() => { setMostrarImportacao(false); setResultadoImportacao(null); setDadosImportacao(null); }}>
                Fechar
              </button>
            </div>
          )}
        </div>
      )}

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
