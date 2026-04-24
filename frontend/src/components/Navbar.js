import React, { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// 5 tabs principais (cada uma pode ter sub-navegação interna dentro da página)
const TABS = [
  { to: '/escritorio/operacoes', label: 'Início', icon: '🌅' },
  {
    label: 'Notas Fiscais', icon: '🧾', match: ['/escritorio/notas', '/escritorio/emitir', '/escritorio/aprovacoes'],
    sub: [
      { to: '/escritorio/notas', label: 'Todas' },
      { to: '/escritorio/aprovacoes', label: 'Aprovações' },
      { to: '/escritorio/emitir', label: 'Emitir nova' },
      { to: '/escritorio/emitir-lote', label: 'Emitir em lote' },
    ],
  },
  {
    label: 'Clientes', icon: '🏢', match: ['/escritorio/clientes', '/escritorio/certificados'],
    sub: [
      { to: '/escritorio/clientes', label: 'Lista' },
      { to: '/escritorio/certificados', label: 'Certificados A1' },
    ],
  },
  { to: '/escritorio/apuracao', label: 'Apuração', icon: '💰', destaque: true },
  { to: '/escritorio/entregas', label: 'Entregas', icon: '📦', destaque: true },
  {
    label: 'ANA', icon: '🤖', match: ['/escritorio/fila-ana', '/escritorio/ana', '/escritorio/testar-agente'],
    sub: [
      { to: '/escritorio/fila-ana', label: 'Fila de aprovação' },
      { to: '/escritorio/ana', label: 'Painel' },
      { to: '/escritorio/testar-agente', label: 'Sandbox' },
    ],
  },
];

// Config (menu engrenagem à direita)
const CONFIG = [
  { to: '/escritorio/integra-contador', label: 'Integra Contador', icon: '🏛️' },
  { to: '/escritorio/dominio', label: 'API Domínio', icon: '🔗' },
  { to: '/escritorio/certificado-serpro', label: 'Certificado SERPRO', icon: '🔐' },
  { to: '/escritorio/whatsapp', label: 'WhatsApp', icon: '💬' },
  { to: '/escritorio/relatorios', label: 'Relatórios', icon: '📈' },
  { to: '/escritorio', label: 'Dashboard clássico', icon: '📊' },
];

export default function Navbar() {
  const { usuario, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [configAberto, setConfigAberto] = useState(false);
  const [userAberto, setUserAberto] = useState(false);
  const [tabAberta, setTabAberta] = useState(null);
  const configRef = useRef(null);
  const userRef = useRef(null);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  // Fecha dropdowns ao clicar fora
  useEffect(() => {
    const handler = (e) => {
      if (configRef.current && !configRef.current.contains(e.target)) setConfigAberto(false);
      if (userRef.current && !userRef.current.contains(e.target)) setUserAberto(false);
      setTabAberta(null);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const abrirCmdK = () => window.__abrirCommandPalette?.();

  const handleLogout = () => { logout(); navigate('/login'); };

  const estaAtivo = (tab) => {
    if (tab.to) return location.pathname === tab.to;
    if (tab.match) return tab.match.some(m => location.pathname.startsWith(m));
    return false;
  };

  return (
    <header className="navbar">
      <div className="navbar-inner">
        {/* Logo */}
        <div className="navbar-brand" onClick={() => navigate('/escritorio/operacoes')}>
          <span className="navbar-pulse"></span>
          <div>
            <div className="navbar-brand-title">Marçal Cockpit</div>
            <div className="navbar-brand-sub">Painel Interno</div>
          </div>
        </div>

        {/* Tabs principais */}
        <nav className="navbar-tabs">
          {TABS.map((tab, i) => {
            const ativa = estaAtivo(tab);
            if (tab.sub) {
              return (
                <div
                  key={i}
                  className={`navbar-tab has-sub ${ativa ? 'ativa' : ''} ${tabAberta === i ? 'aberta' : ''}`}
                  onClick={(e) => { e.stopPropagation(); setTabAberta(tabAberta === i ? null : i); }}
                >
                  <span className="navbar-tab-icon">{tab.icon}</span>
                  <span>{tab.label}</span>
                  <span className="navbar-tab-arrow">▾</span>
                  {tabAberta === i && (
                    <div className="navbar-dropdown" onClick={e => e.stopPropagation()}>
                      {tab.sub.map(s => (
                        <NavLink key={s.to} to={s.to} onClick={() => setTabAberta(null)}>
                          {s.label}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <NavLink
                key={i}
                to={tab.to}
                className={({ isActive }) => `navbar-tab ${isActive ? 'ativa' : ''} ${tab.destaque ? 'destaque' : ''}`}
              >
                <span className="navbar-tab-icon">{tab.icon}</span>
                <span>{tab.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Ações à direita */}
        <div className="navbar-actions">
          <button className="navbar-search" onClick={abrirCmdK} title="Buscar (Cmd+K)">
            <span>🔎</span>
            <span className="navbar-search-label">Buscar</span>
            <kbd>{isMac ? '⌘' : 'Ctrl'}K</kbd>
          </button>

          <div className="navbar-dropdown-wrap" ref={configRef}>
            <button className="navbar-icon-btn" onClick={(e) => { e.stopPropagation(); setConfigAberto(!configAberto); }} title="Configurações">
              ⚙️
            </button>
            {configAberto && (
              <div className="navbar-dropdown navbar-dropdown-right">
                <div className="navbar-dropdown-label">Configurações</div>
                {CONFIG.map(c => (
                  <NavLink key={c.to} to={c.to} onClick={() => setConfigAberto(false)}>
                    <span style={{ marginRight: 8 }}>{c.icon}</span>{c.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>

          <div className="navbar-dropdown-wrap" ref={userRef}>
            <button className="navbar-user" onClick={(e) => { e.stopPropagation(); setUserAberto(!userAberto); }}>
              <span className="navbar-avatar">{(usuario?.nome || '?').charAt(0).toUpperCase()}</span>
              <span className="navbar-user-name">{usuario?.nome || '—'}</span>
              <span style={{ opacity: 0.5, fontSize: 10 }}>▾</span>
            </button>
            {userAberto && (
              <div className="navbar-dropdown navbar-dropdown-right">
                <div className="navbar-dropdown-label">{usuario?.email}</div>
                <button className="navbar-dropdown-btn" onClick={handleLogout}>Sair da conta</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
