// =====================================================
// Rotas API Dominio (Thomson Reuters / Onvio)
// =====================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const dominioService = require('../services/dominioService');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB por XML
});

router.use(autenticado, apenasEscritorio);

// GET /api/dominio/status — info de configuracao + teste rapido do token
router.get('/status', async (req, res) => {
  try {
    const s = await dominioService.statusGeral();
    res.json(s);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/dominio/autenticar/teste — forca geracao de token novo
router.post('/autenticar/teste', async (req, res) => {
  try {
    dominioService.tokenCache = null;
    await dominioService.obterToken();
    res.json({ ok: true, mensagem: 'Token Dominio obtido com sucesso.' });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// GET /api/dominio/clientes/:id/ativacao — verifica ativacao da integracao pro cliente
router.get('/clientes/:id/ativacao', async (req, res) => {
  try {
    const key = dominioService.buscarIntegrationKeyDoCliente(req.params.id);
    if (!key) return res.status(400).json({ erro: 'Cliente sem dominio_integration_key cadastrada. Cadastre no cliente antes.' });
    const info = await dominioService.verificarAtivacao(key);
    res.json(info);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// POST /api/dominio/clientes/:id/integration-key — grava integration key recebida da Dominio
router.post('/clientes/:id/integration-key', (req, res) => {
  try {
    const { integrationKey } = req.body || {};
    if (!integrationKey) return res.status(400).json({ erro: 'integrationKey obrigatorio no body' });
    dominioService.gravarIntegrationKeyDoCliente(parseInt(req.params.id), integrationKey);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// POST /api/dominio/clientes/:id/ativar — chama activation/enable pra gerar nova key
router.post('/clientes/:id/ativar', async (req, res) => {
  try {
    const keyAtual = dominioService.buscarIntegrationKeyDoCliente(req.params.id);
    if (!keyAtual) return res.status(400).json({ erro: 'Cliente sem integration key inicial cadastrada.' });
    const novaKey = await dominioService.gerarIntegrationKey(keyAtual);
    if (novaKey && novaKey !== keyAtual) {
      dominioService.gravarIntegrationKeyDoCliente(parseInt(req.params.id), novaKey);
    }
    res.json({ ok: true, integrationKey: novaKey });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// POST /api/dominio/clientes/:id/enviar-xml — upload de XML (multipart)
// form fields:
//   arquivo: file (xml)
//   boxeFile: 'true' | 'false' (opcional)
router.post('/clientes/:id/enviar-xml', upload.single('arquivo'), async (req, res) => {
  try {
    const key = dominioService.buscarIntegrationKeyDoCliente(req.params.id);
    if (!key) return res.status(400).json({ erro: 'Cliente sem dominio_integration_key cadastrada.' });
    if (!req.file) return res.status(400).json({ erro: 'Campo \'arquivo\' obrigatorio no multipart.' });

    const boxe = req.body && String(req.body.boxeFile || '').toLowerCase() === 'true';
    const resultado = await dominioService.enviarXml({
      integrationKey: key,
      xmlBuffer: req.file.buffer,
      filename: req.file.originalname || 'arquivo.xml',
      boxeFile: boxe,
    });
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// GET /api/dominio/clientes/:id/lote/:loteId — consulta status de um lote
router.get('/clientes/:id/lote/:loteId', async (req, res) => {
  try {
    const key = dominioService.buscarIntegrationKeyDoCliente(req.params.id);
    if (!key) return res.status(400).json({ erro: 'Cliente sem dominio_integration_key cadastrada.' });
    const info = await dominioService.consultarLote(key, req.params.loteId);
    res.json(info);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

module.exports = router;
