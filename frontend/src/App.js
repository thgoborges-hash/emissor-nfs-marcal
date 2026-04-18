import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LayoutEscritorio } from './components/Layout';
import Login from './pages/Login';

// Páginas do Escritório
import DashboardEscritorio from './pages/escritorio/DashboardEscritorio';
import Aprovacoes from './pages/escritorio/Aprovacoes';
import TodasNotas from './pages/escritorio/TodasNotas';
import GestaoClientes from './pages/escritorio/GestaoClientes';
import EmitirNFEscritorio from './pages/escritorio/EmitirNFEscritorio';
import Certificados from './pages/escritorio/Certificados';
import WhatsAppPainel from './pages/escritorio/WhatsApp';
import PainelAna from './pages/escritorio/PainelAna';
import Relatorios from './pages/escritorio/Relatorios';
import TestarAgente from './pages/escritorio/TestarAgente';
import OperacoesHoje from './pages/escritorio/OperacoesHoje';
import FilaAprovacaoAna from './pages/escritorio/FilaAprovacaoAna';
import CertificadoSerpro from './pages/escritorio/CertificadoSerpro';

import './styles/global.css';

// Rota protegida
function RotaProtegida({ children }) {
  const { usuario, carregando } = useAuth();

  if (carregando) return <div style={{ padding: 40 }}>Carregando...</div>;
  if (!usuario) return <Navigate to="/login" />;

  return children;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Login */}
          <Route path="/login" element={<Login />} />

          {/* Redireciona raiz para o painel */}
          <Route path="/" element={<Navigate to="/escritorio" />} />

          {/* Painel do Escritório */}
          <Route path="/escritorio" element={
            <RotaProtegida>
              <LayoutEscritorio />
            </RotaProtegida>
          }>
            <Route index element={<DashboardEscritorio />} />
            <Route path="operacoes" element={<OperacoesHoje />} />
            <Route path="fila-ana" element={<FilaAprovacaoAna />} />
            <Route path="aprovacoes" element={<Aprovacoes />} />
            <Route path="notas" element={<TodasNotas />} />
            <Route path="clientes" element={<GestaoClientes />} />
            <Route path="emitir" element={<EmitirNFEscritorio />} />
            <Route path="certificados" element={<Certificados />} />
            <Route path="certificado-serpro" element={<CertificadoSerpro />} />
            <Route path="whatsapp" element={<WhatsAppPainel />} />
            <Route path="ana" element={<PainelAna />} />
            <Route path="relatorios" element={<Relatorios />} />
            <Route path="testar-agente" element={<TestarAgente />} />
          </Route>

          {/* 404 */}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
