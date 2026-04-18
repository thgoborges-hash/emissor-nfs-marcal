import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

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
          <NavLink to="/escritorio/operacoes">🌅 Operações Hoje</NavLink>
          <NavLink to="/escritorio/fila-ana">🤖 Fila ANA</NavLink>
          <NavLink to="/escritorio/aprovacoes">✅ Aprovações NF</NavLink>
          <NavLink to="/escritorio/notas">📋 Todas as NFs</NavLink>
          <NavLink to="/escritorio/clientes">🏢 Clientes</NavLink>
          <NavLink to="/escritorio/emitir">📝 Emitir NF</NavLink>
          <NavLink to="/escritorio/certificados">🔐 Certificados</NavLink>
          <NavLink to="/escritorio/certificado-serpro">🏛️ Cert. SERPRO</NavLink>
          <NavLink to="/escritorio/whatsapp">💬 WhatsApp</NavLink>
          <NavLink to="/escritorio/ana">🤖 Painel ANA</NavLink>
          <NavLink to="/escritorio/relatorios">📈 Relatorios</NavLink>
          <NavLink to="/escritorio/testar-agente">🧪 Testar IA</NavLink>
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
