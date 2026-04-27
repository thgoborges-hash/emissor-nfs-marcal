/**
 * Rotas /api/onedrive — admin only.
 * Etapa 1: só leitura (testar conexão, listar pastas de clientes, listar arquivos).
 * Etapa 2 (próxima): cadastro automático de A1 a partir do OneDrive.
 */

const express = require('express');
const router = express.Router();
const { autenticado, apenasEscritorio } = require('../middleware/auth');
const oneDriveService = require('../services/oneDriveService');

// GET /api/onedrive/status — config + teste de auth
router.get('/status', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const cfg = oneDriveService._config;
    if (!cfg.TENANT_set || !cfg.CLIENT_set || !cfg.SECRET_set || !cfg.USER) {
      return res.json({
        configurado: false,
        config: cfg,
        mensagem: 'Configure ONEDRIVE_TENANT_ID, ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET, ONEDRIVE_USER_EMAIL no Render',
      });
    }
    const teste = await oneDriveService.testarConexao();
    res.json({ configurado: true, config: cfg, teste });
  } catch (err) {
    console.error('[OneDrive] /status:', err);
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/onedrive/clientes — lista pastas-filho do ROOT (uma por cliente)
router.get('/clientes', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const pastas = await oneDriveService.listarClientes();
    res.json({ total: pastas.length, pastas });
  } catch (err) {
    console.error('[OneDrive] /clientes:', err);
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/onedrive/clientes/:folderId/arquivos — lista arquivos de uma pasta de cliente
router.get('/clientes/:folderId/arquivos', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const arquivos = await oneDriveService.listarArquivosPasta(req.params.folderId);
    res.json({ total: arquivos.length, arquivos });
  } catch (err) {
    console.error('[OneDrive] /clientes/:id/arquivos:', err);
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/onedrive/preview-xlsx/:fileId — baixa um xlsx e retorna preview (50 linhas)
router.get('/preview-xlsx/:fileId', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const data = await oneDriveService.previewXlsx(req.params.fileId, 50);
    res.json(data);
  } catch (err) {
    console.error('[OneDrive] /preview-xlsx:', err);
    res.status(500).json({ erro: err.message });
  }
});


const { getDb } = require('../database/init');

// POST /api/onedrive/sync-regime — lê planilha do Controle Geral e atualiza regime/município
router.post('/sync-regime', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const { planilhaId } = req.body;
    if (!planilhaId) return res.status(400).json({ erro: 'planilhaId obrigatório' });
    const result = await oneDriveService.syncRegimeTributario(planilhaId, getDb());
    res.json(result);
  } catch (err) {
    console.error('[OneDrive] /sync-regime:', err);
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/onedrive/sync-a1 — itera pastas de clientes e cadastra A1
router.post('/sync-a1', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const { folderId, forcar } = req.body;
    if (!folderId) return res.status(400).json({ erro: 'folderId obrigatório (ex: pasta "02 - CLIENTES CONTABILIDADE")' });
    const result = await oneDriveService.syncCertificadosA1(folderId, getDb(), { forcar: !!forcar });
    res.json(result);
  } catch (err) {
    console.error('[OneDrive] /sync-a1:', err);
    res.status(500).json({ erro: err.message });
  }
});


module.exports = router;
