import React, { createContext, useContext, useState, useEffect } from 'react';
import { authApi } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [usuario, setUsuario] = useState(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const dados = localStorage.getItem('usuario');
    if (token && dados) {
      try {
        setUsuario(JSON.parse(dados));
      } catch {
        localStorage.clear();
      }
    }
    setCarregando(false);
  }, []);

  const loginEscritorio = async (email, senha) => {
    const { data } = await authApi.loginEscritorio(email, senha);
    localStorage.setItem('token', data.token);
    localStorage.setItem('usuario', JSON.stringify({ ...data.usuario, tipo: 'escritorio' }));
    setUsuario({ ...data.usuario, tipo: 'escritorio' });
    return data;
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('usuario');
    setUsuario(null);
  };

  return (
    <AuthContext.Provider value={{ usuario, carregando, loginEscritorio, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return context;
}
