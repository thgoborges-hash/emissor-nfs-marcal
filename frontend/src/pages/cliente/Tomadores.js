import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { tomadoresApi } from '../../services/api';

export default function Tomadores() {
  const { usuario } = useAuth();
  const [searchParams] = useSearchParams();
  const clienteId = usuario?.id || usuario?.clienteId;

  const [tomadores, setTomadores] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [mostrarForm, setMostrarForm] = useState(searchParams.get('novo') === '1');
  const [editando, setEditando] = useState(null);
  const [sucesso, setSucesso] = useState('');
  const [erro, setErro] = useState('');

  const formVazio = {
    tipo_documento: 'CNPJ', documento: '', razao_social: '', nome_fantasia: '',
    email: '', telefone: '', logradouro: '', numero: '', complemento: '',
    bairro: '', municipio: '', uf: '', cep: '', codigo_municipio: '', favorito: false
  };
  const [form, setForm] = useState(formVazio);

  const carregarTomadores = async () => {
    try {
      const { data } = await tomadoresApi.listar(clienteId);
      setTomadores(data);
    } catch (err) {
      console.error(err);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { if (clienteId) carregarTomadores(); }, [clienteId]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const formatarDocumento = (valor, tipo) => {
    const nums = valor.replace(/\D/g, '');
    if (tipo === 'CPF') {
      return nums.slice(0, 11)
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d)/, '$1.$2')
        .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    }
    return nums.slice(0, 14)
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro('');
    setSucesso('');

    try {
      if (editando) {
        await tomadoresApi.atualizar(editando, form);
        setSucesso('Tomador atualizado com sucesso!');
      } else {
        await tomadoresApi.criar(clienteId, form);
        setSucesso('Tomador cadastrado com sucesso!');
      }
      setForm(formVazio);
      setMostrarForm(false);
      setEditando(null);
      carregarTomadores();
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao salvar tomador');
    }
  };

  const handleEditar = (tomador) => {
    setForm({
      tipo_documento: tomador.tipo_documento,
      documento: tomador.documento,
      razao_social: tomador.razao_social,
      nome_fantasia: tomador.nome_fantasia || '',
      email: tomador.email || '',
      telefone: tomador.telefone || '',
      logradouro: tomador.logradouro || '',
      numero: tomador.numero || '',
      complemento: tomador.complemento || '',
      bairro: tomador.bairro || '',
      municipio: tomador.municipio || '',
      uf: tomador.uf || '',
      cep: tomador.cep || '',
      codigo_municipio: tomador.codigo_municipio || '',
      favorito: !!tomador.favorito
    });
    setEditando(tomador.id);
    setMostrarForm(true);
  };

  const handleRemover = async (id) => {
    if (!window.confirm('Deseja remover este tomador?')) return;
    try {
      await tomadoresApi.remover(id);
      carregarTomadores();
      setSucesso('Tomador removido.');
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao remover');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>Tomadores</h1>
        <button className="btn btn-primary" onClick={() => { setMostrarForm(!mostrarForm); setEditando(null); setForm(formVazio); }}>
          {mostrarForm ? 'Cancelar' : '+ Novo Tomador'}
        </button>
      </div>

      {sucesso && <div className="alert alert-success">{sucesso}</div>}
      {erro && <div className="alert alert-danger">{erro}</div>}

      {/* Formulário */}
      {mostrarForm && (
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 16 }}>{editando ? 'Editar Tomador' : 'Novo Tomador'}</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-row">
              <div className="form-group">
                <label>Tipo de Documento</label>
                <select name="tipo_documento" value={form.tipo_documento} onChange={handleChange}>
                  <option value="CNPJ">CNPJ</option>
                  <option value="CPF">CPF</option>
                </select>
              </div>
              <div className="form-group">
                <label>{form.tipo_documento}</label>
                <input
                  type="text"
                  name="documento"
                  value={form.documento}
                  onChange={(e) => setForm(prev => ({ ...prev, documento: formatarDocumento(e.target.value, prev.tipo_documento) }))}
                  placeholder={form.tipo_documento === 'CPF' ? '000.000.000-00' : '00.000.000/0001-00'}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Razão Social</label>
                <input type="text" name="razao_social" value={form.razao_social} onChange={handleChange} required />
              </div>
              <div className="form-group">
                <label>Nome Fantasia</label>
                <input type="text" name="nome_fantasia" value={form.nome_fantasia} onChange={handleChange} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Email</label>
                <input type="email" name="email" value={form.email} onChange={handleChange} />
              </div>
              <div className="form-group">
                <label>Telefone</label>
                <input type="text" name="telefone" value={form.telefone} onChange={handleChange} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Município</label>
                <input type="text" name="municipio" value={form.municipio} onChange={handleChange} />
              </div>
              <div className="form-group">
                <label>UF</label>
                <input type="text" name="uf" value={form.uf} onChange={handleChange} maxLength={2} style={{ textTransform: 'uppercase' }} />
              </div>
            </div>

            <div className="form-group">
              <label>
                <input type="checkbox" name="favorito" checked={form.favorito} onChange={handleChange} style={{ width: 'auto', marginRight: 8 }} />
                Marcar como favorito (aparece primeiro na lista)
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={() => { setMostrarForm(false); setEditando(null); }}>Cancelar</button>
              <button type="submit" className="btn btn-primary">{editando ? 'Salvar Alterações' : 'Cadastrar Tomador'}</button>
            </div>
          </form>
        </div>
      )}

      {/* Lista */}
      <div className="card">
        {carregando ? (
          <p>Carregando...</p>
        ) : tomadores.length === 0 ? (
          <div className="empty-state">
            <div className="icon">👥</div>
            <p>Nenhum tomador cadastrado.</p>
            <p style={{ fontSize: 13 }}>Cadastre os tomadores para facilitar a emissão de NFs.</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Razão Social</th>
                  <th>Documento</th>
                  <th>Email</th>
                  <th>Município/UF</th>
                  <th>NFs</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {tomadores.map(t => (
                  <tr key={t.id}>
                    <td>{t.favorito ? '⭐' : ''}</td>
                    <td><strong>{t.razao_social}</strong></td>
                    <td>{t.documento}</td>
                    <td>{t.email || '-'}</td>
                    <td>{t.municipio ? `${t.municipio}/${t.uf}` : '-'}</td>
                    <td>{t.total_nfs}</td>
                    <td>
                      <button className="btn btn-outline btn-sm" onClick={() => handleEditar(t)}>Editar</button>
                      <button className="btn btn-outline btn-sm" style={{ marginLeft: 4, color: 'var(--danger)' }} onClick={() => handleRemover(t.id)}>Remover</button>
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
