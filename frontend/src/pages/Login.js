import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const [tab, setTab] = useState('cliente'); // 'cliente' ou 'escritorio'
  const [cnpj, setCnpj] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);

  const { loginCliente, loginEscritorio } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro('');
    setCarregando(true);

    try {
      if (tab === 'cliente') {
        await loginCliente(cnpj, senha);
        navigate('/cliente');
      } else {
        await loginEscritorio(email, senha);
        navigate('/escritorio');
      }
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao fazer login');
    } finally {
      setCarregando(false);
    }
  };

  // Formata CNPJ enquanto digita
  const formatarCnpj = (valor) => {
    const nums = valor.replace(/\D/g, '').slice(0, 14);
    return nums
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2');
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>Emissor NFS-e</h1>
        <p className="subtitle">Marçal Contabilidade</p>

        <div className="login-tabs">
          <button
            className={tab === 'cliente' ? 'active' : ''}
            onClick={() => { setTab('cliente'); setErro(''); }}
          >
            Sou Cliente
          </button>
          <button
            className={tab === 'escritorio' ? 'active' : ''}
            onClick={() => { setTab('escritorio'); setErro(''); }}
          >
            Sou do Escritório
          </button>
        </div>

        {erro && <div className="erro-msg">{erro}</div>}

        <form onSubmit={handleSubmit}>
          {tab === 'cliente' ? (
            <div className="form-group">
              <label>CNPJ</label>
              <input
                type="text"
                placeholder="00.000.000/0001-00"
                value={cnpj}
                onChange={(e) => setCnpj(formatarCnpj(e.target.value))}
                required
              />
            </div>
          ) : (
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          )}

          <div className="form-group">
            <label>Senha</label>
            <input
              type="password"
              placeholder="Sua senha"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={carregando}>
            {carregando ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
