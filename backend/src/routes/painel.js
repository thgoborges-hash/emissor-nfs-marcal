// =====================================================
// Rotas do Painel Operacional
// =====================================================

const express = require('express');
const router = express.Router();
const painelService = require('../services/painelService');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

router.use(autenticado, apenasEscritorio);

// Home "Operações Hoje" — resumo consolidado
router.get('/operacoes-hoje', (req, res) => {
  try {
    res.json(painelService.resumoOperacoesHoje());
  } catch (err) {
    console.error('[Painel] Erro operacoes-hoje:', err);
    res.status(500).json({ erro: err.message });
  }
});

// Fila de aprovação ANA — listar
router.get('/fila-aprovacao', (req, res) => {
  try {
    const { status = 'pendente', limit = 50 } = req.query;
    res.json({
      status_filtro: status,
      itens: painelService.listar({ status, limit: Number(limit) }),
    });
  } catch (err) {
    console.error('[Painel] Erro listar fila:', err);
    res.status(500).json({ erro: err.message });
  }
});

// Buscar item específico
router.get('/fila-aprovacao/:id', (req, res) => {
  try {
    const item = painelService.buscarPendencia(Number(req.params.id));
    if (!item) return res.status(404).json({ erro: 'Pendência não encontrada' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Aprovar
router.post('/fila-aprovacao/:id/aprovar', (req, res) => {
  try {
    const { observacao } = req.body || {};
    const result = painelService.aprovar(Number(req.params.id), req.usuario.id, observacao || null);
    res.json(result);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// Rejeitar
router.post('/fila-aprovacao/:id/rejeitar', (req, res) => {
  try {
    const { motivo } = req.body || {};
    const result = painelService.rejeitar(Number(req.params.id), req.usuario.id, motivo);
    res.json(result);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// Criar pendência manual (útil pra testes e pra ANA no futuro)
router.post('/fila-aprovacao', (req, res) => {
  try {
    const { tipo_acao, cliente_id, descricao, payload, origem_operador } = req.body || {};
    if (!tipo_acao || !descricao) {
      return res.status(400).json({ erro: 'tipo_acao e descricao são obrigatórios' });
    }
    const result = painelService.criarPendencia({
      tipoAcao: tipo_acao,
      clienteId: cliente_id,
      descricao,
      payload,
      origem: 'manual',
      origemOperador: origem_operador,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

module.exports = router;
