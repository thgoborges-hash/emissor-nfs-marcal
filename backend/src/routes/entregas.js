// =====================================================
// Rotas — Dashboard de Entregas Mensais
// =====================================================

const express = require('express');
const router = express.Router();
const entregasService = require('../services/entregasService');
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

module.exports = router;
