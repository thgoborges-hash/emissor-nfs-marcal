import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);

  const { loginEscritorio } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErro('');
    setCarregando(true);

    try {
      await loginEscritorio(email, senha);
      navigate('/escritorio');
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao fazer login');
    } finally {
      setCarregando(false);
    }
  };

  return (
    <div className="login-v4">
      <div className="login-orb login-orb-1" />
      <div className="login-orb login-orb-2" />
      <div className="login-orb login-orb-3" />
      <div className="login-grid-overlay" />

      <div className="login-panel">
        <div className="login-brand">
          <div className="login-brand-pulse" />
          <div>
            <div className="login-brand-title">Marçal Cockpit</div>
            <div className="login-brand-sub">Emissor NFS-e · Painel Interno</div>
          </div>
        </div>

        <h1 className="login-greeting">Bem-vindo de volta</h1>
        <p className="login-greeting-sub">Acesse o painel do escritório</p>

        {erro && <div className="login-error">{erro}</div>}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label>E-mail</label>
            <input
              type="email"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="login-field">
            <label>Senha</label>
            <input
              type="password"
              placeholder="Sua senha"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="login-btn" disabled={carregando}>
            {carregando ? (
              <span className="login-btn-loading">
                <span className="login-btn-spinner" />
                Entrando…
              </span>
            ) : (
              <>Entrar <span className="login-btn-arrow">→</span></>
            )}
          </button>
        </form>

        <div className="login-footer">
          <span className="login-footer-dot" /> Sistema operacional · v1.0
        </div>
      </div>
    </div>
  );
}
