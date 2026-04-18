import React, { useState, useEffect } from 'react';
import { integraContadorApi } from '../../services/api';

export default function CertificadoSerpro() {
  const [status, setStatus] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [testando, setTestando] = useState(false);
  const [resultadoTeste, setResultadoTeste] = useState(null);

  const carregar = async () => {
    setCarregando(true);
    try {
      const { data } = await integraContadorApi.status();
      setStatus(data);
    } catch (err) {
      setStatus({ erro: err.response?.data?.erro || err.message });
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => { carregar(); }, []);

  const testarAutenticacao = async () => {
    setTestando(true);
    setResultadoTeste(null);
    try {
      const { data } = await integraContadorApi.testarAutenticacao();
      setResultadoTeste({ sucesso: true, ...data });
    } catch (err) {
      setResultadoTeste({ sucesso: false, erro: err.response?.data?.erro || err.message });
    } finally {
      setTestando(false);
    }
  };

  if (carregando) return <div style={{ padding: 40 }}>Verificando configuração...</div>;

  const fontes = status?.fontes_certificado || {};
  const checks = status?.checks || {};

  return (
    <div>
      <h1 className="page-title">🔐 Certificado SERPRO (Integra Contador)</h1>
      <p style={{ color: '#666', marginTop: -8, marginBottom: 24 }}>
        Status da integração com a API do SERPRO (DAS, DCTFWeb, PGDAS-D, DARF). Usa o e-CNPJ A1 da Marçal + procuração coletiva da carteira.
      </p>

      {/* Status geral */}
      <div style={{
        padding: 20, borderRadius: 8, marginBottom: 24,
        background: status?.pronto ? '#e8f8f0' : '#fff5e6',
        borderLeft: `4px solid ${status?.pronto ? '#27ae60' : '#f39c12'}`,
      }}>
        <h3 style={{ margin: 0 }}>
          {status?.pronto ? '✅ Tudo configurado' : '⚠️  Configuração incompleta'}
        </h3>
        <p style={{ margin: '8px 0 0', color: '#555' }}>
          {status?.pronto
            ? 'A ANA e a equipe já podem fazer consultas ao SERPRO (DAS, DCTFWeb, PGDAS-D, Caixa Postal e-CAC, etc).'
            : 'Faltam itens pra ativar. Veja abaixo o que precisa configurar.'}
        </p>
      </div>

      {/* Checklist */}
      <section style={sectionStyle}>
        <h3 style={sectionTitle}>Checklist de ativação</h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          <Check ok={checks.marcal_cnpj} label="CNPJ da Marçal configurado" hint="Set MARCAL_CNPJ no Render → Environment" valor={status?.marcalCnpj} />
          <Check ok={checks.consumer_key_secret} label="Consumer Key + Secret do SERPRO" hint="Obter em cliente.serpro.gov.br após contratar em loja.serpro.gov.br/integracontador. Set SERPRO_CONSUMER_KEY e SERPRO_CONSUMER_SECRET no Render" />
          <Check ok={checks.certificado_marcal_localizado} label="Certificado e-CNPJ da Marçal localizado" hint="O sistema procura o cert no cliente cadastrado com MARCAL_CNPJ ou no slot dedicado" />
        </ul>
      </section>

      {/* Fontes do certificado */}
      <section style={{ ...sectionStyle, marginTop: 24 }}>
        <h3 style={sectionTitle}>📁 Fontes do certificado Marçal</h3>

        <div style={{ padding: 16, background: fontes.via_cliente_marcal ? '#e8f8f0' : '#fafafa', borderRadius: 6, marginBottom: 12 }}>
          <strong>{fontes.via_cliente_marcal ? '✅' : '⚪'} Via cliente cadastrado</strong>
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#666' }}>
            {fontes.via_cliente_marcal
              ? <>Usando o cert anexado ao cliente <strong>{fontes.cliente_marcal.razao_social}</strong> (CNPJ {fontes.cliente_marcal.cnpj}). Titular: {fontes.cliente_marcal.titular}, válido até {fontes.cliente_marcal.validade}.</>
              : 'Nenhum cliente cadastrado com o CNPJ da Marçal possui certificado A1 anexado. Se a Marçal já está cadastrada como cliente, anexe o A1 pela tela Certificados.'}
          </p>
        </div>

        <div style={{ padding: 16, background: fontes.via_slot_dedicado ? '#e8f8f0' : '#fafafa', borderRadius: 6 }}>
          <strong>{fontes.via_slot_dedicado ? '✅' : '⚪'} Via slot dedicado (fallback)</strong>
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#666' }}>
            {fontes.via_slot_dedicado
              ? <>Cert dedicado em <code>{fontes.slot_dedicado.path}</code>.</>
              : <>Não configurado. Este caminho é opcional — use se preferir não cadastrar a Marçal como cliente no sistema. Upload via <code>POST /api/integra-contador/certificado/upload</code> + setar <code>MARCAL_CERT_SENHA_ENCRYPTED</code> no Render.</>}
          </p>
        </div>
      </section>

      {/* Teste de autenticação */}
      <section style={{ ...sectionStyle, marginTop: 24 }}>
        <h3 style={sectionTitle}>🧪 Teste de autenticação SERPRO</h3>
        <p style={{ color: '#666', fontSize: 13 }}>
          Dispara uma chamada real ao endpoint de autenticação do SERPRO usando o cert e as credenciais. Se passar, a integração está funcional.
        </p>
        <button
          onClick={testarAutenticacao}
          disabled={testando || !status?.pronto}
          style={{
            padding: '10px 24px', border: 'none', borderRadius: 4,
            background: status?.pronto ? '#3498db' : '#ccc',
            color: '#fff', fontWeight: 600, cursor: status?.pronto ? 'pointer' : 'not-allowed',
          }}
        >
          {testando ? 'Testando...' : 'Testar conexão SERPRO'}
        </button>
        {!status?.pronto && <p style={{ color: '#c00', fontSize: 12, marginTop: 8 }}>Resolva o checklist acima antes de testar.</p>}

        {resultadoTeste && (
          <div style={{
            marginTop: 16, padding: 16, borderRadius: 6,
            background: resultadoTeste.sucesso ? '#e8f8f0' : '#ffebee',
            borderLeft: `4px solid ${resultadoTeste.sucesso ? '#27ae60' : '#c62828'}`,
          }}>
            {resultadoTeste.sucesso ? (
              <>
                <strong>✅ Autenticação OK</strong>
                <p style={{ margin: '8px 0 0', fontSize: 13 }}>Token gerado com sucesso (expira em {resultadoTeste.expiresEmSegundos}s). O Integra Contador está funcional.</p>
              </>
            ) : (
              <>
                <strong>❌ Falha</strong>
                <p style={{ margin: '8px 0 0', fontSize: 13, fontFamily: 'monospace' }}>{resultadoTeste.erro}</p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Check({ ok, label, hint, valor }) {
  return (
    <li style={{ padding: '12px 0', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <span style={{ fontSize: 20 }}>{ok ? '✅' : '⬜'}</span>
      <div style={{ flex: 1 }}>
        <strong>{label}</strong>
        {valor && <div style={{ fontSize: 12, color: '#666', fontFamily: 'monospace', marginTop: 4 }}>{valor}</div>}
        {!ok && <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>{hint}</div>}
      </div>
    </li>
  );
}

const sectionStyle = {
  background: '#fff', borderRadius: 8, padding: 20,
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
};
const sectionTitle = { margin: '0 0 16px 0', fontSize: 16, fontWeight: 600 };
