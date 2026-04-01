import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' }
});

// Interceptor para adicionar token
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Interceptor para tratar erros de autenticação
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('usuario');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// === AUTH ===
export const authApi = {
  loginEscritorio: (email, senha) =>
    api.post('/auth/login/escritorio', { email, senha }),
  loginCliente: (cnpj, senha) =>
    api.post('/auth/login/cliente', { cnpj, senha }),
};

// === CLIENTES ===
export const clientesApi = {
  listar: () => api.get('/clientes'),
  buscar: (id) => api.get(`/clientes/${id}`),
  criar: (dados) => api.post('/clientes', dados),
  atualizar: (id, dados) => api.put(`/clientes/${id}`, dados),
  importar: (clientes, senha_padrao) => api.post('/clientes/importar', { clientes, senha_padrao }),
};

// === TOMADORES ===
export const tomadoresApi = {
  listar: (clienteId) => api.get(`/clientes/${clienteId}/tomadores`),
  buscar: (id) => api.get(`/tomadores/${id}`),
  criar: (clienteId, dados) => api.post(`/clientes/${clienteId}/tomadores`, dados),
  atualizar: (id, dados) => api.put(`/tomadores/${id}`, dados),
  remover: (id) => api.delete(`/tomadores/${id}`),
};

// === NOTAS FISCAIS ===
export const notasFiscaisApi = {
  listar: (params) => api.get('/notas-fiscais', { params }),
  buscar: (id) => api.get(`/notas-fiscais/${id}`),
  criar: (dados) => api.post('/notas-fiscais', dados),
  aprovar: (id) => api.put(`/notas-fiscais/${id}/aprovar`),
  rejeitar: (id, motivo) => api.put(`/notas-fiscais/${id}/rejeitar`, { motivo }),
  emitir: (id) => api.put(`/notas-fiscais/${id}/emitir`),
  cancelar: (id, motivo) => api.put(`/notas-fiscais/${id}/cancelar`, { motivo }),
  resumo: () => api.get('/notas-fiscais/dashboard/resumo'),
};

// === CERTIFICADOS ===
export const certificadosApi = {
  listarTodos: () => api.get('/certificados'),
  consultar: (clienteId) => api.get(`/certificados/${clienteId}`),
  upload: (clienteId, file, senha) => {
    const formData = new FormData();
    formData.append('certificado', file);
    formData.append('senha', senha);
    return api.post(`/certificados/${clienteId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  remover: (clienteId) => api.delete(`/certificados/${clienteId}`),
};

export default api;
