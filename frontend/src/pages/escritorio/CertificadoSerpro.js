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

  if (carregando) return <div className="empty-state"><div className="icon">⏳</div>Verificando configuração...</div>;

  const fontes = status?.fontes_certificado || {};
  const checks = status?.checks || {};

  return (
    <div>
      <h1 className="page-title">Certificado SERPRO</h1>
      <p className="page-subtitle">
        Status da integração com Integra Contador (DAS, DCTFWeb, PGDAS-D, DARF). Usa e-CNPJ A1 da Marçal + procuração coletiva da carteira.
      </p>

      <div className={status?.pronto ? 'alert alert-success' : 'alert alert-warning'}>
        <strong>{status?.pronto ? '✅ Tudo configurado' : '⚠️  Configuração incompleta'}</strong>
        <div className="mt-1 text-sm">
          {status?.pronto
            ? 'A ANA e a equipe já podem fazer consultas ao SERPRO (DAS, DCTFWeb, PGDAS-D, Caixa Postal e-CAC, etc).'
            : 'Faltam itens pra ativar. Veja abaixo o que precisa configurar.'}
        </div>
      </div>

      {/* Checklist */}
      <section className="section-card mt-3">
        <h3 className="section-title">Checklist de ativação</h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          <Check ok={checks.marcal_cnpj} label="CNPJ da Marçal configurado"
            hint="Set MARCAL_CNPJ no Render → Environment (só dígitos)"
            valor={status?.marcalCnpj} />
          <Check ok={checks.consumer_key_secret} label="Consumer Key + Secret do SERPRO"
            hint="Obter em cliente.serpro.gov.br após contratar. Set SERPRO_CONSUMER_KEY e SERPRO_CONSUMER_SECRET no Render" />
          <Check ok={checks.certificado_marcal_localizado} label="Certificado e-CNPJ da Marçal localizado"
            hint="O sistema procura o cert no cliente cadastrado com MARCAL_CNPJ, ou no slot dedicado" />
        </ul>
      </section>

      {/* Fontes do certificado */}
      <section className="section-card mt-3">
        <h3 className="section-title">📁 Fontes do certificado Marçal</h3>

        <div style={{
          padding: 16,
          background: fontes.via_cliente_marcal ? 'var(--success-subtle)' : 'var(--bg-elevated)',
          borderRadius: 'var(--radius-sm)',
          marginBottom: 12,
          border: `1px solid ${fontes.via_cliente_marcal ? 'rgba(16, 185, 129, 0.25)' : 'var(--border)'}`
        }}>
          <strong style={{ color: fontes.via_cliente_marcal ? 'var(--success)' : 'var(--text-light)' }}>
            {fontes.via_cliente_marcal ? '✅' : '⚪'} Via cliente cadastrado
          </strong>
          <div className="mt-1 text-sm text-light">
            {fontes.via_cliente_marcal
              ? <>Usando o cert anexado ao cliente <strong style={{color: 'var(--text)'}}>{fontes.cliente_marcal.razao_social}</strong> (CNPJ {fontes.cliente_marcal.cnpj}). Titular: {fontes.cliente_marcal.titular}, válido até {fontes.cliente_marcal.validade}.</>
              : 'Nenhum cliente cadastrado com o CNPJ da Marçal possui certificado A1 anexado. Se a Marçal já está cadastrada como cliente, anexe o A1 pela tela Certificados.'}
          </div>
        </div>

        <div style={{
          padding: 16,
          background: fontes.via_slot_dedicado ? 'var(--success-subtle)' : 'var(--bg-elevated)',
          borderRadius: 'var(--radius-sm)',
          border: `1px solid ${fontes.via_slot_dedicado ? 'rgba(16, 185, 129, 0.25)' : 'var(--border)'}`
        }}>
          <strong style={{ color: fontes.via_slot_dedicado ? 'var(--success)' : 'var(--text-light)' }}>
            {fontes.via_slot_dedicado ? '✅' : '⚪'} Via slot dedicado (fallback)
          </strong>
          <div className="mt-1 text-sm text-light">
            {fontes.via_slot_dedicado
              ? <>Cert dedicado em <code>{fontes.slot_dedicado.path}</code>.</>
              : <>Não configurado. Este caminho é opcional — use se preferir não cadastrar a Marçal como cliente. Upload via <code>POST /api/integra-contador/certificado/upload</code> + <code>MARCAL_CERT_SENHA_ENCRYPTED</code>.</>}
          </div>
        </div>
      </section>

      {/* Teste de autenticação */}
      <section className="section-card mt-3">
        <h3 className="section-title">🧪 Teste de autenticação SERPRO</h3>
        <p className="text-light text-sm" style={{ marginBottom: 16 }}>
          Dispara uma chamada real ao endpoint de autenticação do SERPRO usando o cert e as credenciais. Se passar, a integração está funcional.
        </p>
        <button
          onClick={testarAutenticacao}
          disabled={testando || !status?.pronto}
          className="btn btn-primary"
        >
          {testando ? 'Testando...' : 'Testar conexão SERPRO'}
        </button>
        {!status?.pronto && <div className="text-danger text-sm mt-1">Resolva o checklist acima antes de testar.</div>}

        {resultadoTeste && (
          <div className={resultadoTeste.sucesso ? 'alert alert-success mt-2' : 'alert alert-danger mt-2'}>
            {resultadoTeste.sucesso ? (
              <>
                <strong>✅ Autenticação OK</strong>
                <div className="mt-1 text-sm">Token gerado com sucesso (expira em {resultadoTeste.expiresEmSegundos}s). O Integra Contador está funcional.</div>
              </>
            ) : (
              <>
                <strong>❌ Falha</strong>
                <div className="mt-1" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{resultadoTeste.erro}</div>
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
    <li style={{
      padding: '12px 0',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12
    }}>
      <span style={{ fontSize: 18, lineHeight: 1 }}>{ok ? '✅' : '⬜'}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500 }}>{label}</div>
        {valor && <div className="text-muted text-sm" style={{ fontFamily: 'var(--font-mono)', marginTop: 4 }}>{valor}</div>}
        {!ok && <div className="text-light text-sm" style={{ marginTop: 4 }}>{hint}</div>}
      </div>
    </li>
  );
}
