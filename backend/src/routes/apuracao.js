// =====================================================
// Rotas — Apuração Tributária Comparativa
// =====================================================

const express = require('express');
const router = express.Router();
const apuracaoService = require('../services/apuracaoService');
const painelService = require('../services/painelService');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

router.use(autenticado, apenasEscritorio);

// Metadados pra UI (setores e limites)
router.get('/metadados', (req, res) => {
  res.json(apuracaoService.metadados());
});

// Simulação comparativa dos regimes
// POST /api/apuracao/simular
// { receitaMes, rbt12?, setor, issMunicipal?, margemLucroReal? }
router.post('/simular', (req, res) => {
  try {
    const resultado = apuracaoService.simular(req.body || {});
    res.json(resultado);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// Envia apuração pra fila da ANA (pra ser aprovada e transmitida)
// POST /api/apuracao/enviar-fila
// { clienteId, clienteNome, mes, simulacao }
router.post('/enviar-fila', (req, res) => {
  try {
    const { clienteId, clienteNome, mes, simulacao, regimeEscolhido } = req.body || {};
    if (!simulacao || !regimeEscolhido) {
      return res.status(400).json({ erro: 'simulacao e regimeEscolhido obrigatórios' });
    }
    const regime = simulacao.regimes?.[regimeEscolhido];
    if (!regime) return res.status(400).json({ erro: 'regime inválido' });

    const valor = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(regime.totalMes || 0);
    const descricao = `Apuração ${regime.nome} — ${clienteNome || 'cliente'} — ${mes || 'período atual'}: ${valor}`;

    const pendencia = painelService.criarPendencia({
      tipoAcao: regimeEscolhido === 'simples' ? 'TRANSMITIR_PGDASD' :
                regimeEscolhido === 'mei'    ? 'EMITIR_DAS_MEI'
                                             : 'TRANSMITIR_APURACAO',
      clienteId,
      descricao,
      payload: { simulacao, regimeEscolhido, mes },
      origem: 'painel',
    });

    res.status(201).json(pendencia);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

module.exports = router;
