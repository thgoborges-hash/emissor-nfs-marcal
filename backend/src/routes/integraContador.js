// =====================================================
// Rotas REST — Integra Contador (SERPRO)
// Uso: painel do escritório e agente ANA (via WhatsApp)
// =====================================================

const express = require('express');
const multer = require('multer');
const router = express.Router();
const integraContadorService = require('../services/integraContadorService');
const certificadoService = require('../services/certificadoService');
const nfseConfig = require('../config/nfse');
const integraConfig = require('../config/integraContador');
const fs = require('fs');
const path = require('path');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

// Upload em memória pra validar antes de persistir o cert
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Todas as rotas aqui exigem autenticação de escritório (operações contábeis sensíveis)
router.use(autenticado, apenasEscritorio);

// -------------------------------------------------
// Upload do e-CNPJ A1 da Marçal
// -------------------------------------------------
router.post('/certificado/upload', upload.single('certificado'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo .pfx obrigatório (campo: certificado)' });
    if (!req.body.senha) return res.status(400).json({ erro: 'Senha obrigatória (campo: senha)' });

    // Valida o certificado
    const info = certificadoService.validarCertificado(req.file.buffer, req.body.senha);

    // Salva no disco (slot fixo do escritório)
    const certPath = path.join(nfseConfig.certificadosDir, `${integraConfig.marcal.certSlotId}.pfx`);
    fs.writeFileSync(certPath, req.file.buffer);

    // Criptografa a senha e devolve no response pra ser adicionada manualmente no Render
    // (ou persistida numa tabela configuracoes_escritorio no futuro)
    const senhaEncrypted = certificadoService.encryptPassword(req.body.senha);

    res.json({
      ok: true,
      info,
      proximoPasso: 'Adicione MARCAL_CERT_SENHA_ENCRYPTED no .env com o valor abaixo e reinicie o servidor.',
      senhaEncrypted,
    });
  } catch (err) {
    console.error('[IntegraContador] Erro no upload do certificado:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

// -------------------------------------------------
// Status / healthcheck do módulo
// -------------------------------------------------
router.get('/status', async (req, res) => {
  const fontes = integraContadorService.diagnosticarFontesCertificado();
  const credenciaisConfig = !!(integraConfig.credenciais.consumerKey && integraConfig.credenciais.consumerSecret);
  const certificadoDisponivel = fontes.via_cliente_marcal || fontes.via_slot_dedicado;

  res.json({
    pronto: certificadoDisponivel && credenciaisConfig && fontes.marcal_cnpj_configurado,
    checks: {
      certificado_marcal_localizado: certificadoDisponivel,
      consumer_key_secret: credenciaisConfig,
      marcal_cnpj: fontes.marcal_cnpj_configurado,
    },
    marcalCnpj: integraConfig.marcal.cnpj,
    fontes_certificado: fontes,
  });
});

// -------------------------------------------------
// Teste de autenticação (útil pra validar setup)
// -------------------------------------------------
router.post('/autenticar/teste', async (req, res) => {
  try {
    const token = await integraContadorService.autenticar();
    res.json({
      ok: true,
      expiresEmSegundos: Math.round((token.expiresAt - Date.now()) / 1000),
      // Não devolvemos o token em si por segurança
    });
  } catch (err) {
    console.error('[IntegraContador] Falha no teste de autenticação:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// -------------------------------------------------
// Endpoints de negócio
// -------------------------------------------------

// Gera DAS do Simples Nacional
// POST /api/integra-contador/das/simples { cnpj: '...', periodoApuracao: '202604' }
router.post('/das/simples', async (req, res) => {
  try {
    const { cnpj, periodoApuracao } = req.body;
    if (!cnpj || !periodoApuracao) return res.status(400).json({ erro: 'cnpj e periodoApuracao são obrigatórios' });
    const resultado = await integraContadorService.gerarDASSimples(cnpj, periodoApuracao);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro gerarDASSimples:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Gera DAS do MEI
// POST /api/integra-contador/das/mei { cnpj, periodoApuracao }
router.post('/das/mei', async (req, res) => {
  try {
    const { cnpj, periodoApuracao } = req.body;
    if (!cnpj || !periodoApuracao) return res.status(400).json({ erro: 'cnpj e periodoApuracao são obrigatórios' });
    const resultado = await integraContadorService.gerarDASMEI(cnpj, periodoApuracao);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro gerarDASMEI:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Consulta última declaração PGDAS-D transmitida
router.get('/pgdasd/ultima-declaracao/:cnpj', async (req, res) => {
  try {
    const resultado = await integraContadorService.consultarUltimaDeclaracaoPGDASD(req.params.cnpj);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro consultarUltimaDeclaracao:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Consulta extrato de um DAS específico
router.get('/das/:cnpj/:numeroDas', async (req, res) => {
  try {
    const resultado = await integraContadorService.consultarExtratoDAS(req.params.cnpj, req.params.numeroDas);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro consultarExtratoDAS:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Consulta procurações eletrônicas vigentes
router.get('/procuracoes/:cnpj', async (req, res) => {
  try {
    const resultado = await integraContadorService.consultarProcuracoes(req.params.cnpj);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro consultarProcuracoes:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Caixa Postal e-CAC — lista mensagens
router.get('/caixa-postal/:cnpj', async (req, res) => {
  try {
    const resultado = await integraContadorService.listarMensagensCaixaPostal(req.params.cnpj);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro listarMensagensCaixaPostal:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// DCTFWeb — relação de declarações
router.get('/dctfweb/:cnpj', async (req, res) => {
  try {
    const resultado = await integraContadorService.consultarRelacaoDCTFWeb(req.params.cnpj);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro consultarRelacaoDCTFWeb:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Chamada genérica (escape hatch pra serviços não cobertos pelos wrappers)
// POST /api/integra-contador/chamar
// { acao: 'Consultar', cnpj: '...', idSistema: '...', idServico: '...', versaoSistema: '1.0', dados: {...} }
router.post('/chamar', async (req, res) => {
  try {
    const { acao, cnpj, idSistema, idServico, versaoSistema, dados } = req.body;
    if (!acao || !cnpj || !idSistema || !idServico || !versaoSistema) {
      return res.status(400).json({ erro: 'Parâmetros obrigatórios: acao, cnpj, idSistema, idServico, versaoSistema' });
    }
    const resultado = await integraContadorService.chamar(acao, cnpj, idSistema, idServico, versaoSistema, dados || {});
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro chamada genérica:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
