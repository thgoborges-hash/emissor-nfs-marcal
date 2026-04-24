// =====================================================
// Rotas — Dashboard de Entregas Mensais
// =====================================================

const express = require('express');
const router = express.Router();
const entregasService = require('../services/entregasService');
const alertasService = require('../services/alertasService');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

router.use(autenticado, apenasEscritorio);

// Dashboard consolidado (KPIs + matriz + ranking + tendência)
// GET /api/entregas/dashboard?competencia=YYYY-MM
router.get('/dashboard', (req, res) => {
  try {
    const resultado = entregasService.dashboard(req.query.competencia);
    res.json(resultado);
  } catch (err) {
    console.error('[Entregas] Erro dashboard:', err);
    res.status(500).json({ erro: err.message });
  }
});

// Atualiza status de uma entrega
// POST /api/entregas/status
// { clienteId, competencia, tipoEntrega, status, observacao? }
router.post('/status', (req, res) => {
  try {
    const { clienteId, competencia, tipoEntrega, status, observacao } = req.body || {};
    if (!clienteId || !competencia || !tipoEntrega || !status) {
      return res.status(400).json({ erro: 'clienteId, competencia, tipoEntrega e status obrigatórios' });
    }
    const id = entregasService.atualizarStatus({
      clienteId, competencia, tipoEntrega, status, observacao,
      responsavelId: req.usuario.id,
      responsavelNome: req.usuario.nome,
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// Preview do resumo de alertas (texto pronto pra enviar ao grupo Staff)
// GET /api/entregas/alertas/preview
router.get('/alertas/preview', (req, res) => {
  try {
    const resumo = alertasService.gerarResumoAlertas();
    res.json(resumo);
  } catch (err) {
    console.error('[Entregas] Erro preview alertas:', err);
    res.status(500).json({ erro: err.message });
  }
});

// Dispara envio de alertas agora (forcar=true manda mesmo se não tiver pendência)
// POST /api/entregas/alertas/disparar  { forcar?: boolean }
router.post('/alertas/disparar', async (req, res) => {
  try {
    const forcar = !!(req.body && req.body.forcar);
    const resultado = await alertasService.enviarAlertasDiarios({ forcar });
    res.json(resultado);
  } catch (err) {
    console.error('[Entregas] Erro disparar alertas:', err);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
