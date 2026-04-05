import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LayoutCliente, LayoutEscritorio } from './components/Layout';
import Login from './pages/Login';

// Páginas do Cliente
import DashboardCliente from './pages/cliente/Dashboard';
import EmitirNF from './pages/cliente/EmitirNF';
import Historico from './pages/cliente/Historico';
import Tomadores from './pages/cliente/Tomadores';

// Páginas do Escritório
import DashboardEscritorio from './pages/escritorio/DashboardEscritorio';
import Aprovacoes from './pages/escritorio/Aprovacoes';
import TodasNotas from './pages/escritorio/TodasNotas';
import GestaoClientes from './pages/escritorio/GestaoClientes';
import EmitirNFEscritorio from './pages/escritorio/EmitirNFEscritorio';
import Certificados from './pages/escritorio/Certificados';
import WhatsAppPainel from './pages/escritorio/WhatsApp';
import Relatorios from './pages/escritorio/Relatorios';

import './styles/global.css';

// Rota protegida
function RotaProtegida({ tipo, children }) {
  const { usuario, carregando } = useAuth();

  if (carregando) return <div style={{ padding: 40 }}>Carregando...</div>;
  if (!usuario) return <Navigate to="/login" />;
  if (tipo && usuario.tipo !== tipo) {
    return <Navigate to={usuario.tipo === 'escritorio' ? '/escritorio' : '/cliente'} />;
  }

  return children;
}

// Redireciona para o portal correto após login
function RedirecionarInicial() {
  const { usuario, carregando } = useAuth();

  if (carregando) return <div style={{ padding: 40 }}>Carregando...</div>;
  if (!usuario) return <Navigate to="/login" />;
  if (usuario.tipo === 'escritorio') return <Navigate to="/escritorio" />;
  return <Navigate to="/cliente" />;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Login */}
          <Route path="/login" element={<Login />} />

          {/* Redireciona raiz */}
          <Route path="/" element={<RedirecionarInicial />} />

          {/* Portal do Cliente */}
          <Route path="/cliente" element={
            <RotaProtegida tipo="cliente">
              <LayoutCliente />
            </RotaProtegida>
          }>
            <Route index element={<DashboardCliente />} />
            <Route path="emitir" element={<EmitirNF />} />
            <Route path="historico" element={<Historico />} />
            <Route path="tomadores" element={<Tomadores />} />
          </Route>

          {/* Painel do Escritório */}
          <Route path="/escritorio" element={
            <RotaProtegida tipo="escritorio">
              <LayoutEscritorio />
            </RotaProtegida>
          }>
            <Route index element={<DashboardEscritorio />} />
            <Route path="aprovacoes" element={<Aprovacoes />} />
            <Route path="notas" element={<TodasNotas />} />
            <Route path="clientes" element={<GestaoClientes />} />
            <Route path="emitir" element={<EmitirNFEscritorio />} />
            <Route path="certificados" element={<Certificados />} />
            <Route path="whatsapp" element={<WhatsAppPainel />} />
            <Route path="relatorios" element={<Relatorios />} />
          </Route>

          {/* 404 */}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
