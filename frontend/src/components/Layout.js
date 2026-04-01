import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// Layout do Portal do Cliente
export function LayoutCliente() {
  const { usuario, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Emissor NFS-e</h2>
          <small>{usuario?.razaoSocial || usuario?.nomeFantasia}</small>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/cliente" end>📊 Dashboard</NavLink>
          <NavLink to="/cliente/emitir">📝 Emitir NF</NavLink>
          <NavLink to="/cliente/historico">📋 Histórico</NavLink>
          <NavLink to="/cliente/tomadores">👥 Tomadores</NavLink>
        </nav>
        <div className="sidebar-footer">
          <button onClick={handleLogout}>Sair da conta</button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

// Layout do Painel do Escritório
export function LayoutEscritorio() {
  const { usuario, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="app-layout">
      <aside className="sidebar" style={{ background: '#1a1a2e' }}>
        <div className="sidebar-header">
          <h2>Marçal Contabilidade</h2>
          <small>Painel Administrativo</small>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/escritorio" end>📊 Dashboard</NavLink>
          <NavLink to="/escritorio/aprovacoes">✅ Aprovações</NavLink>
          <NavLink to="/escritorio/notas">📋 Todas as NFs</NavLink>
          <NavLink to="/escritorio/clientes">🏢 Clientes</NavLink>
          <NavLink to="/escritorio/emitir">📝 Emitir NF</NavLink>
          <NavLink to="/escritorio/certificados">🔐 Certificados</NavLink>
          <NavLink to="/escritorio/whatsapp">💬 WhatsApp</NavLink>
        </nav>
        <div className="sidebar-footer">
          <span>{usuario?.nome}</span><br />
          <button onClick={handleLogout}>Sair da conta</button>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
