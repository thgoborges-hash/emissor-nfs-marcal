// =====================================================
// Rotas REST — SIEG (notas fiscais de entrada/saída)
// =====================================================

const express = require('express');
const router = express.Router();
const siegService = require('../services/siegService');
const siegConfig = require('../config/sieg');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

router.use(autenticado, apenasEscritorio);

// Status / healthcheck
router.get('/status', async (req, res) => {
  res.json({
    configurado: siegService.isConfigured(),
    checks: {
      api_key: !!siegConfig.apiKey,
      email: !!siegConfig.email,
      sync_habilitado: siegConfig.sync.habilitado,
    },
    cronSchedule: siegConfig.sync.cronSchedule,
  });
});

// Teste de conexão
router.post('/testar-conexao', async (req, res) => {
  try {
    const r = await siegService.testarConexao();
    res.json(r);
  } catch (err) {
    console.error('[SIEG] Teste de conexão falhou:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Baixa notas de entrada de um cliente específico
// GET /api/sieg/entradas/:cnpj?dataIni=2026-04-01&dataFim=2026-04-18&tipoDoc=55
router.get('/entradas/:cnpj', async (req, res) => {
  try {
    const { dataIni, dataFim, tipoDoc } = req.query;
    if (!dataIni || !dataFim) return res.status(400).json({ erro: 'dataIni e dataFim (YYYY-MM-DD) obrigatórios' });
    const cnpj = req.params.cnpj.replace(/\D/g, '');
    const xmls = await siegService.baixarNotasDeEntrada(
      cnpj, dataIni, dataFim,
      tipoDoc ? Number(tipoDoc) : undefined
    );
    // Retorna só metadados (chave + tamanho) pra não pesar o JSON
    res.json({
      cnpj,
      janela: { dataIni, dataFim },
      total: xmls.length,
      xmls: xmls.map(x => ({ chave: x.chave, tipo: x.tipo, tamanho: x.xml.length })),
    });
  } catch (err) {
    console.error('[SIEG] Erro baixar entradas:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Baixa notas de saída
router.get('/saidas/:cnpj', async (req, res) => {
  try {
    const { dataIni, dataFim, tipoDoc } = req.query;
    if (!dataIni || !dataFim) return res.status(400).json({ erro: 'dataIni e dataFim (YYYY-MM-DD) obrigatórios' });
    const cnpj = req.params.cnpj.replace(/\D/g, '');
    const xmls = await siegService.baixarNotasDeSaida(
      cnpj, dataIni, dataFim,
      tipoDoc ? Number(tipoDoc) : undefined
    );
    res.json({
      cnpj,
      janela: { dataIni, dataFim },
      total: xmls.length,
      xmls: xmls.map(x => ({ chave: x.chave, tipo: x.tipo, tamanho: x.xml.length })),
    });
  } catch (err) {
    console.error('[SIEG] Erro baixar saídas:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Baixa XMLs (retorna o conteúdo completo)
// POST /api/sieg/baixar  { tipoDoc, dataIni, dataFim, cnpjDest, cnpjEmit, ... }
router.post('/baixar', async (req, res) => {
  try {
    const xmls = await siegService.baixarXMLs(req.body);
    res.json({ total: xmls.length, xmls });
  } catch (err) {
    console.error('[SIEG] Erro baixar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
