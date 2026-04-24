import React, { useState, useEffect, useCallback } from 'react';
import { certificadosApi } from '../../services/api';

function Certificados() {
  const [clientes, setClientes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadModal, setUploadModal] = useState(null); // clienteId
  const [arquivo, setArquivo] = useState(null);
  const [senha, setSenha] = useState('');
  const [uploading, setUploading] = useState(false);
  const [mensagem, setMensagem] = useState(null);

  const carregarCertificados = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await certificadosApi.listarTodos();
      setClientes(data);
    } catch (err) {
      console.error('Erro ao carregar certificados:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarCertificados();
  }, [carregarCertificados]);

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!arquivo || !senha) return;

    setUploading(true);
    setMensagem(null);
    try {
      const { data } = await certificadosApi.upload(uploadModal, arquivo, senha);
      setMensagem({ tipo: 'sucesso', texto: `${data.mensagem} - ${data.certificado.titular}` });
      setUploadModal(null);
      setArquivo(null);
      setSenha('');
      carregarCertificados();
    } catch (err) {
      const msg = err.response?.data?.erro || 'Erro ao enviar certificado';
      setMensagem({ tipo: 'erro', texto: msg });
    } finally {
      setUploading(false);
    }
  };

  const statusBadge = (status) => {
    const cores = {
      valido: { bg: '#e8f5e9', color: '#2e7d32', texto: 'Válido' },
      expirando: { bg: '#fff3e0', color: '#e65100', texto: 'Expirando' },
      expirado: { bg: '#ffebee', color: '#c62828', texto: 'Expirado' },
      sem_certificado: { bg: '#f5f5f5', color: '#757575', texto: 'Sem certificado' },
    };
    const c = cores[status] || cores.sem_certificado;
    return (
      <span style={{
        padding: '4px 12px', borderRadius: '12px',
        fontSize: '12px', fontWeight: '600',
        backgroundColor: c.bg, color: c.color,
      }}>
        {c.texto}
      </span>
    );
  };

  if (loading) {
    return <div style={{ padding: '40px', textAlign: 'center' }}>Carregando...</div>;
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ margin: 0, fontSize: '24px', color: '#1a237e' }}>
          Certificados Digitais A1
        </h2>
        <p style={{ color: '#666', margin: '4px 0 0' }}>
          Gerencie os certificados digitais dos clientes para emissão de NFS-e
        </p>
      </div>

      {mensagem && (
        <div style={{
          padding: '12px 16px', borderRadius: '8px', marginBottom: '16px',
          backgroundColor: mensagem.tipo === 'sucesso' ? '#e8f5e9' : '#ffebee',
          color: mensagem.tipo === 'sucesso' ? '#2e7d32' : '#c62828',
          border: `1px solid ${mensagem.tipo === 'sucesso' ? '#a5d6a7' : '#ef9a9a'}`,
        }}>
          {mensagem.texto}
          <button onClick={() => setMensagem(null)} style={{
            float: 'right', background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '16px', color: 'inherit',
          }}>x</button>
        </div>
      )}

      {/* Resumo */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {[
          { label: 'Total', value: clientes.length, color: '#1a237e' },
          { label: 'Válidos', value: clientes.filter(c => c.status === 'valido').length, color: '#2e7d32' },
          { label: 'Expirando', value: clientes.filter(c => c.status === 'expirando').length, color: '#e65100' },
          { label: 'Sem certificado', value: clientes.filter(c => c.status === 'sem_certificado').length, color: '#757575' },
        ].map((item, i) => (
          <div key={i} style={{
            flex: '1', minWidth: '140px', padding: '16px',
            backgroundColor: '#fff', borderRadius: '12px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          }}>
            <div style={{ fontSize: '24px', fontWeight: '700', color: item.color }}>{item.value}</div>
            <div style={{ fontSize: '13px', color: '#666' }}>{item.label}</div>
          </div>
        ))}
      </div>

      {/* Tabela de clientes */}
      <div style={{
        backgroundColor: '#fff', borderRadius: '12px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ backgroundColor: '#f5f5f5' }}>
              <th style={thStyle}>Cliente</th>
              <th style={thStyle}>CNPJ</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Validade</th>
              <th style={thStyle}>Dias Restantes</th>
              <th style={thStyle}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {clientes.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={tdStyleCliente}>{c.razao_social}</td>
                <td style={tdStyleCnpj}>{c.cnpj}</td>
                <td style={tdStyle}>{statusBadge(c.status)}</td>
                <td style={tdStyle}>
                  {c.certificado_validade || '-'}
                </td>
                <td style={tdStyle}>
                  {c.diasRestantes !== null ? `${c.diasRestantes} dias` : '-'}
                </td>
                <td style={tdStyle}>
                  <button
                    onClick={() => {
                      setUploadModal(c.id);
                      setArquivo(null);
                      setSenha('');
                    }}
                    style={{
                      padding: '6px 16px', borderRadius: '6px',
                      border: 'none', cursor: 'pointer', fontSize: '13px',
                      fontWeight: '600',
                      backgroundColor: c.status === 'sem_certificado' ? '#1a237e' : '#e8eaf6',
                      color: c.status === 'sem_certificado' ? '#fff' : '#1a237e',
                    }}
                  >
                    {c.status === 'sem_certificado' ? 'Enviar' : 'Atualizar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {clientes.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: '#999' }}>
            Nenhum cliente cadastrado
          </div>
        )}
      </div>

      {/* Modal de Upload */}
      {uploadModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            backgroundColor: '#fff', borderRadius: '16px', padding: '32px',
            maxWidth: '480px', width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <h3 style={{ margin: '0 0 8px', color: '#1a237e' }}>
              Upload de Certificado A1
            </h3>
            <p style={{ color: '#666', margin: '0 0 24px', fontSize: '14px' }}>
              {clientes.find(c => c.id === uploadModal)?.razao_social}
            </p>

            <form onSubmit={handleUpload}>
              <div style={{ marginBottom: '16px' }}>
                <label style={labelStyle}>Arquivo do Certificado (.pfx ou .p12)</label>
                <input
                  type="file"
                  accept=".pfx,.p12"
                  onChange={(e) => setArquivo(e.target.files[0])}
                  style={{ display: 'block', marginTop: '8px' }}
                  required
                />
              </div>

              <div style={{ marginBottom: '24px' }}>
                <label style={labelStyle}>Senha do Certificado</label>
                <input
                  type="password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  placeholder="Digite a senha do certificado"
                  required
                  style={inputStyle}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setUploadModal(null)}
                  style={{
                    padding: '10px 24px', borderRadius: '8px',
                    border: '1px solid #ddd', backgroundColor: '#fff',
                    cursor: 'pointer', fontSize: '14px',
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={uploading || !arquivo || !senha}
                  style={{
                    padding: '10px 24px', borderRadius: '8px',
                    border: 'none', backgroundColor: '#1a237e', color: '#fff',
                    cursor: uploading ? 'wait' : 'pointer', fontSize: '14px',
                    fontWeight: '600', opacity: uploading ? 0.7 : 1,
                  }}
                >
                  {uploading ? 'Enviando...' : 'Enviar Certificado'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: 'left', padding: '12px 16px',
  fontSize: '12px', fontWeight: '600', color: '#666',
  textTransform: 'uppercase', letterSpacing: '0.5px',
};

const tdStyle = {
  padding: '12px 16px', fontSize: '14px',
  color: '#1a1a1a',
};

const tdStyleCliente = {
  padding: '12px 16px', fontSize: '14px',
  color: '#0f172a', fontWeight: 600,
};

const tdStyleCnpj = {
  padding: '12px 16px', fontSize: '14px',
  color: '#334155', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const labelStyle = {
  display: 'block', fontSize: '13px', fontWeight: '600',
  color: '#333', marginBottom: '4px',
};

const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: '8px',
  border: '1px solid #ddd', fontSize: '14px', marginTop: '4px',
  boxSizing: 'border-box',
};

export default Certificados;
