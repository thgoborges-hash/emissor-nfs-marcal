import React, { useState, useEffect } from 'react';
import { dominioApi } from '../../services/api';

export default function ApiDominio() {
  const [status, setStatus] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [testando, setTestando] = useState(false);
  const [msg, setMsg] = useState(null);

  const carregar = async () => {
    setCarregando(true);
    setMsg(null);
    try {
      const { data } = await dominioApi.status();
      setStatus(data);
    } catch (err) {
      setStatus({ configurado: false, erro: err.response?.data?.erro || err.message });
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregar(); }, []);

  const testar = async () => {
    setTestando(true);
    setMsg(null);
    try {
      const { data } = await dominioApi.testarAutenticacao();
      setMsg({ tipo: 'ok', texto: data.mensagem || 'Token obtido com sucesso.' });
      await carregar();
    } catch (err) {
      setMsg({ tipo: 'erro', texto: err.response?.data?.erro || err.message });
    } finally {
      setTestando(false);
    }
  };

  const fmtData = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const autenticacaoOk = status && status.autenticacao === 'ok';

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 className="page-title">API Domínio (Thomson Reuters)</h1>
        <p className="page-subtitle">
          Integração com o Domínio pra envio automático de XMLs (NFe, NFS-e, NFC-e, CT-e, CF-e) e baixas de parcelas.
        </p>
      </div>

      {/* Status principal */}
      <div className={`dominio-status-card ${autenticacaoOk ? 'ok' : status?.configurado ? 'erro' : 'warn'}`}>
        <div className="dominio-status-icon">
          {autenticacaoOk ? '✓' : status?.configurado ? '!' : '○'}
        </div>
        <div className="dominio-status-body">
          <div className="dominio-status-title">
            {carregando ? 'Verificando…'
              : autenticacaoOk ? 'Autenticação OK — pronto pra enviar XMLs'
              : status?.configurado ? 'Credenciais configuradas, mas autenticação falhou'
              : 'Credenciais não configuradas'}
          </div>
          <div className="dominio-status-sub">
            {autenticacaoOk && status?.token_expira_em && <>Token expira em <strong>{fmtData(status.token_expira_em)}</strong></>}
            {status?.erro && <span style={{ color: 'var(--danger)' }}>{status.erro}</span>}
            {!status?.configurado && !carregando && <span>Setar <code>DOMINIO_CLIENT_ID</code> e <code>DOMINIO_CLIENT_SECRET</code> no Render (Settings → Environment).</span>}
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={testar}
          disabled={testando || carregando}
          style={{ whiteSpace: 'nowrap' }}
        >
          {testando ? '⟳ Testando…' : '⟳ Testar autenticação'}
        </button>
      </div>

      {/* Mensagem do teste */}
      {msg && (
        <div className={`alert alert-${msg.tipo === 'ok' ? 'success' : 'danger'} mt-2`}>
          {msg.texto}
        </div>
      )}

      {/* Info tecnica */}
      <section className="section-card mt-3">
        <h3 className="section-title">📡 Configuração técnica</h3>
        <table className="dominio-config-table">
          <tbody>
            <tr><td>Client ID</td><td><code>{status?.configurado ? '●●●●●●●●● (setado via env)' : '— não configurado —'}</code></td></tr>
            <tr><td>Client Secret</td><td><code>{status?.configurado ? '●●●●●●●●● (setado via env)' : '— não configurado —'}</code></td></tr>
            <tr><td>Token endpoint</td><td><code>{status?.endpoint_token || '…'}</code></td></tr>
            <tr><td>API base</td><td><code>{status?.endpoint_api || '…'}</code></td></tr>
            <tr><td>Token em cache</td><td>{status?.token_cache ? 'Sim' : 'Não'}</td></tr>
          </tbody>
        </table>
      </section>

      {/* Como usar */}
      <section className="section-card mt-3">
        <h3 className="section-title">📋 Como usar com um cliente específico</h3>
        <ol style={{ paddingLeft: 20, lineHeight: 1.8, color: 'var(--text-light)' }}>
          <li>O cliente libera a integração pelo software Domínio dele e recebe uma <strong>integration key</strong> inicial da Thomson Reuters.</li>
          <li>Você cadastra essa key no cliente — por enquanto via API direta (<code>POST /api/dominio/clientes/:id/integration-key</code>). Tela de gestão por cliente vem na próxima fase.</li>
          <li>Com a key cadastrada, o cockpit pode enviar XMLs dele automaticamente pro Domínio (NFs emitidas pela Marçal, XMLs capturados do SIEG, etc.).</li>
        </ol>
        <p className="text-muted text-sm" style={{ marginTop: 10 }}>
          Contato Domínio pra dúvidas: <code>api.dominio@thomsonreuters.com</code>
        </p>
      </section>
    </div>
  );
}
