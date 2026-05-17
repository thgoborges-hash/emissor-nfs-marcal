// =====================================================
// Rotas API João — fila de jobs + daemon local
// =====================================================
//
// Endpoints divididos em 2 famílias:
//
//  PAINEL/Ana (auth via JWT do escritório):
//    GET    /api/joao/status                 — status do daemon + resumo fila
//    GET    /api/joao/jobs                   — lista jobs (filtros: status, cliente_id, tipo)
//    GET    /api/joao/jobs/:id               — detalhe de um job
//    POST   /api/joao/jobs                   — enfileirar novo job
//    POST   /api/joao/jobs/:id/aprovar       — aprovar pending_approval
//    POST   /api/joao/jobs/:id/cancelar      — cancelar
//
//  DAEMON (auth via shared secret JOAO_DAEMON_SECRET):
//    POST   /api/joao/daemon/ping            — heartbeat
//    GET    /api/joao/daemon/proximo         — pega próximo job (atômico)
//    POST   /api/joao/daemon/jobs/:id/concluir — marca done com resultado
//    POST   /api/joao/daemon/jobs/:id/falhar   — marca failed com erro
//
// O daemon NÃO usa JWT — usa header `X-Joao-Daemon-Secret: <segredo>` configurado
// via env `JOAO_DAEMON_SECRET`. O segredo é compartilhado entre Render e Mac do Thiago.

const express = require('express');
const router = express.Router();
const joaoService = require('../services/joaoService');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

// Notifica a origem via WhatsApp quando job finaliza (fire-and-forget).
// Carrega zapiService lazy pra não criar dependência circular se tiver no boot.
function _notificarOrigemJob(job) {
  if (!job || !job.origem_telefone) return;
  // Não bloqueia o response do daemon — dispatch async
  setImmediate(async () => {
    try {
      const zapi = require('../services/zapiService');
      if (!zapi.isConfigured || !zapi.isConfigured()) return;
      const titulo = job.status === 'done' ? '✅ João terminou' : '⚠️ João falhou';
      const detalhes = job.status === 'done'
        ? (typeof job.resultado === 'object' ? (job.resultado.mensagem || JSON.stringify(job.resultado).slice(0, 600)) : String(job.resultado || ''))
        : (job.erro || 'erro não especificado');
      const msg = `${titulo} — job #${job.id} (${job.tipo})\n\n${detalhes}`;
      await zapi.enviarTexto(job.origem_telefone, msg);
    } catch (e) {
      console.warn('[joao] falha notificando origem do job:', e.message);
    }
  });
}

// ── Middleware do daemon ────────────────────────────────────────────────────
function autenticarDaemon(req, res, next) {
  const segredo = process.env.JOAO_DAEMON_SECRET;
  if (!segredo) {
    return res.status(503).json({ erro: 'JOAO_DAEMON_SECRET não configurada no servidor' });
  }
  const enviado = req.headers['x-joao-daemon-secret'] || '';
  if (enviado !== segredo) {
    return res.status(401).json({ erro: 'segredo do daemon inválido' });
  }
  next();
}

// ── Endpoints do daemon (têm que vir ANTES do middleware autenticado, senão
//    o JWT seria exigido) ─────────────────────────────────────────────────────

router.post('/daemon/ping', autenticarDaemon, (req, res) => {
  const { hostname, versao, jobs_ativos, metadata } = req.body || {};
  joaoService.registrarHeartbeat({ hostname, versao, jobs_ativos, metadata });
  res.json({ ok: true, ts: new Date().toISOString() });
});

router.get('/daemon/proximo', autenticarDaemon, (req, res) => {
  // ?tipos=importar_txt,classificar_extrato
  const tiposParam = (req.query.tipos || '').trim();
  const tipos = tiposParam ? tiposParam.split(',').map(s => s.trim()).filter(Boolean) : null;
  try {
    const job = joaoService.pegarProximo(tipos);
    if (!job) return res.json({ job: null });
    res.json({ job });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

router.post('/daemon/jobs/:id/concluir', autenticarDaemon, express.json(), (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = joaoService.concluir(jobId, req.body || {});
    _notificarOrigemJob(job);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.post('/daemon/jobs/:id/falhar', autenticarDaemon, express.json(), (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const { erro } = req.body || {};
    const job = joaoService.falhar(jobId, erro || 'erro não informado');
    _notificarOrigemJob(job);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// ── A partir daqui, endpoints do painel/Ana (autenticação JWT) ─────────────
router.use(autenticado, apenasEscritorio);

router.get('/status', (req, res) => {
  try {
    res.json({
      daemon: joaoService.statusDaemon(),
      fila: joaoService.resumoStatus(),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

router.get('/jobs', (req, res) => {
  try {
    const status = req.query.status ? req.query.status.split(',') : undefined;
    const tipo = req.query.tipo ? req.query.tipo.split(',') : undefined;
    const cliente_id = req.query.cliente_id ? parseInt(req.query.cliente_id, 10) : undefined;
    const limite = req.query.limite ? parseInt(req.query.limite, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const jobs = joaoService.listar({ status, tipo, cliente_id, limite, offset });
    res.json({ jobs, total: jobs.length });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.get('/jobs/:id', (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  const job = joaoService.obter(jobId);
  if (!job) return res.status(404).json({ erro: 'job não encontrado' });
  res.json({ job });
});

router.post('/jobs', express.json(), (req, res) => {
  try {
    const { tipo, cliente_id, parametros, prioridade, requer_aprovacao,
            origem_conversa_id, origem_telefone } = req.body || {};
    const criado_por = req.usuario?.nome || req.usuario?.email || 'painel';
    const r = joaoService.enfileirar({
      tipo, cliente_id, parametros,
      criado_por,
      prioridade,
      requer_aprovacao,
      origem_conversa_id,
      origem_telefone,
    });
    res.status(201).json({ ok: true, id: r.id, status: r.status });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.post('/jobs/:id/aprovar', express.json(), (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const aprovado_por = req.usuario?.nome || req.usuario?.email || 'desconhecido';
    const job = joaoService.aprovar(jobId, aprovado_por);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.post('/jobs/:id/cancelar', express.json(), (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const { motivo } = req.body || {};
    const job = joaoService.cancelar(jobId, motivo);
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

module.exports = router;
