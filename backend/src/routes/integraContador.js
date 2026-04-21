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

// =====================================================
// Novos endpoints (Fase 1)
// =====================================================

// SITFIS — Relatorio de Situacao Fiscal (substituto da Certidao Negativa)
// GET /api/integra-contador/sitfis/:cnpj
router.get('/sitfis/:cnpj', async (req, res) => {
  try {
    const resultado = await integraContadorService.obterRelatorioSitfis(req.params.cnpj);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro obterRelatorioSitfis:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// DAS Simples Avulso (reemissao de DAS)
// POST /api/integra-contador/das/simples/avulso { cnpj, periodoApuracao }
router.post('/das/simples/avulso', async (req, res) => {
  try {
    const { cnpj, periodoApuracao } = req.body;
    if (!cnpj || !periodoApuracao) return res.status(400).json({ erro: 'cnpj e periodoApuracao sao obrigatorios' });
    const resultado = await integraContadorService.gerarDASSimplesAvulso(cnpj, periodoApuracao);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro gerarDASSimplesAvulso:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// DAS Simples Cobranca (reemissao de DAS via Cobranca da RFB)
router.post('/das/simples/cobranca', async (req, res) => {
  try {
    const { cnpj, periodoApuracao } = req.body;
    if (!cnpj || !periodoApuracao) return res.status(400).json({ erro: 'cnpj e periodoApuracao sao obrigatorios' });
    const resultado = await integraContadorService.gerarDASSimplesCobranca(cnpj, periodoApuracao);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro gerarDASSimplesCobranca:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// DARF via Sicalc — consolida e gera o PDF
// POST /api/integra-contador/darf { cnpj, dados: { receita, periodoApuracao, vencimento, valorPrincipal, ... } }
router.post('/darf', async (req, res) => {
  try {
    const { cnpj, dados } = req.body;
    if (!cnpj || !dados) return res.status(400).json({ erro: 'cnpj e dados sao obrigatorios' });
    const resultado = await integraContadorService.gerarDARF(cnpj, dados);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro gerarDARF:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Guia DCTFWeb (gerar DARF dos debitos declarados)
// POST /api/integra-contador/dctfweb/guia { cnpj, dados: { categoria, numDeclaracao, periodoApuracao } }
router.post('/dctfweb/guia', async (req, res) => {
  try {
    const { cnpj, dados } = req.body;
    if (!cnpj || !dados) return res.status(400).json({ erro: 'cnpj e dados sao obrigatorios' });
    const resultado = await integraContadorService.gerarGuiaDCTFWeb(cnpj, dados);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro gerarGuiaDCTFWeb:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Pagamentos PAGTOWEB
// GET /api/integra-contador/pagamentos/:cnpj?dataInicio=&dataFim=
router.get('/pagamentos/:cnpj', async (req, res) => {
  try {
    const filtros = {};
    if (req.query.dataInicio) filtros.dataInicio = req.query.dataInicio;
    if (req.query.dataFim) filtros.dataFim = req.query.dataFim;
    const resultado = await integraContadorService.consultarPagamentos(req.params.cnpj, filtros);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro consultarPagamentos:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// CCMEI — emite Certificado de Condicao de MEI
// GET /api/integra-contador/ccmei/:cnpj
router.get('/ccmei/:cnpj', async (req, res) => {
  try {
    const resultado = await integraContadorService.emitirCCMEI(req.params.cnpj);
    res.json(resultado);
  } catch (err) {
    console.error('[IntegraContador] Erro emitirCCMEI:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Entrega de PDF gerado por acao SERPRO (sem auth de escritorio, usa token JWT)
// GET /api/integra-contador/documento/:token?jwt=...
// Nota: essa rota e publica (bypass do router.use(autenticado, apenasEscritorio))
//       porque o Z-API baixa o link sem contexto de sessao. Protegida por JWT.
// Implementacao: precisamos registrar esse endpoint ANTES dos middlewares ou
// reiniciar o router. Como ja passou pelo router.use no topo, vamos expor via
// outro router que o server.js montar ANTES.
// => Solucao: gravamos e exportamos router2 separado no final; server.js monta /api/integra-contador/documento/:token via router2.

// ======================================================
// Snapshot de obrigacoes (alimentado pelo worker diario)
// ======================================================

const serproSnapshotService = require('../services/serproSnapshotService');

// GET /api/integra-contador/snapshot — matriz completa (pra tela Entregas)
router.get('/snapshot', async (req, res) => {
  try {
    const dados = serproSnapshotService.lerSnapshotsTodos();
    res.json({ dados, total: dados.length });
  } catch (err) {
    console.error('[IntegraContador] Erro lendo snapshot:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/integra-contador/snapshot/:clienteId — detalhe por cliente
router.get('/snapshot/:clienteId', async (req, res) => {
  try {
    const dados = serproSnapshotService.lerSnapshot(parseInt(req.params.clienteId));
    res.json({ clienteId: parseInt(req.params.clienteId), dados });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/integra-contador/snapshot/rodar — dispara varredura manual (admin)
// Perigoso — vai bater em 156 clientes com intervalo de 5s (~13 min + SERPRO latencia).
// Executa em background e retorna imediato.
router.post('/snapshot/rodar', async (req, res) => {
  serproSnapshotService.rodarSnapshotCompleto().catch(err => {
    console.error('[IntegraContador] Erro na varredura:', err);
  });
  res.json({ ok: true, mensagem: 'Varredura iniciada em background. Acompanhe nos logs.' });
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


// Router separado pra rotas publicas (sem auth) — usado pelo Z-API pra baixar documentos
const jwt = require('jsonwebtoken');
const routerPublico = express.Router();
const serproDocumentoService = require('../services/serproDocumentoService');
const { JWT_SECRET } = require('../middleware/auth');

routerPublico.get('/documento/:token', async (req, res) => {
  try {
    const jwtToken = req.query.jwt || req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!jwtToken) return res.status(401).json({ erro: 'JWT obrigatorio (?token=...)' });
    let payload;
    try {
      payload = jwt.verify(jwtToken, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ erro: 'JWT invalido' });
    }
    if (payload.uso !== 'serpro-doc' && payload.uso !== 'danfse') {
      return res.status(403).json({ erro: 'JWT sem permissao pra documentos SERPRO' });
    }
    const hit = serproDocumentoService.ler(req.params.token);
    if (!hit) return res.status(404).json({ erro: 'Documento expirado ou nao encontrado' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${hit.nomeArquivo}"`);
    res.send(hit.pdf);
  } catch (err) {
    console.error('[IntegraContador] Erro entregando documento:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

module.exports.routerPublico = routerPublico;

module.exports = router;
module.exports.routerPublico = routerPublico;
