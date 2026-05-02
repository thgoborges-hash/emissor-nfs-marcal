// =====================================================
// Rotas de debug / diagnóstico (uso interno)
// =====================================================

const express = require('express');
const https = require('https');
const { URL } = require('url');
const router = express.Router();
const { getDb } = require('../database/init');
const certificadoService = require('../services/certificadoService');

// Endpoint público pra diagnóstico — DANFSe oficial PDF via ADN
// GET /api/debug/testar-danfse-adn
// Pega a última NF emitida, carrega cert do cliente, tenta os endpoints oficiais
// Retorna status, tamanho, se é PDF, preview do corpo
router.get('/testar-danfse-adn', async (req, res) => {
  try {
    const db = getDb();
    const nf = db.prepare(`
      SELECT nf.id, nf.chave_acesso, nf.numero_nfse,
             c.id as cliente_id, c.razao_social, c.certificado_a1_senha_encrypted
      FROM notas_fiscais nf
      INNER JOIN clientes c ON nf.cliente_id = c.id
      WHERE nf.status = 'emitida' AND nf.chave_acesso IS NOT NULL
      ORDER BY nf.id DESC LIMIT 1
    `).get();

    if (!nf) {
      return res.json({ erro: 'Nenhuma NF emitida com chave de acesso encontrada no banco' });
    }

    let cert;
    try {
      cert = certificadoService.carregarCertificado(nf.cliente_id, nf.certificado_a1_senha_encrypted);
    } catch (err) {
      return res.json({ erro: 'Erro ao carregar cert do cliente: ' + err.message });
    }

    const urls = [
      { nome: 'ADN produção', url: `https://adn.nfse.gov.br/danfse/${nf.chave_acesso}` },
      { nome: 'ADN produção restrita', url: `https://adn.producaorestrita.nfse.gov.br/danfse/${nf.chave_acesso}` },
      { nome: 'SEFIN (caminho antigo)', url: `https://sefin.nfse.gov.br/SefinNacional/danfse/${nf.chave_acesso}` },
    ];

    const resultados = [];

    for (const { nome, url } of urls) {
      const inicio = Date.now();
      const r = await tentarRequisicao(url, cert.pfxBuffer, cert.senha).catch(err => ({ erro: err.message }));
      const tempo = Date.now() - inicio;

      if (r.erro) {
        resultados.push({ nome, url, erro: r.erro, tempo_ms: tempo });
        continue;
      }

      const primeirosBytes = r.bodyBuffer?.slice(0, 4)?.toString() || '';
      const ePdf = primeirosBytes === '%PDF';
      const preview = r.bodyBuffer
        ? r.bodyBuffer.slice(0, 400).toString('utf-8').replace(/[^\x20-\x7E\n]/g, '·')
        : '';

      resultados.push({
        nome, url,
        status: r.statusCode,
        tempo_ms: tempo,
        content_type: r.headers['content-type'] || null,
        content_length: r.headers['content-length'] || r.bodyBuffer?.length,
        e_pdf: ePdf,
        body_preview: preview,
      });
    }

    res.json({
      chave_testada: nf.chave_acesso,
      nf_numero: nf.numero_nfse,
      cliente: nf.razao_social,
      cert_titular: cert.info?.titular || '?',
      cert_validade: cert.info?.validade?.fim,
      resultados,
    });
  } catch (err) {
    console.error('[debug testar-danfse-adn] erro:', err);
    res.status(500).json({ erro: err.message });
  }
});

function tentarRequisicao(urlStr, pfxBuffer, senha) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      pfx: pfxBuffer,
      passphrase: senha,
      headers: { 'Accept': 'application/pdf' },
      timeout: 15000,
    };
    const req = https.request(options, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({
        statusCode: r.statusCode,
        headers: r.headers,
        bodyBuffer: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('Timeout 15s')); });
    req.on('error', reject);
    req.end();
  });
}


// Probe com variacoes de header pra isolar causa do 502.
// GET /api/debug/testar-danfse-variacoes
router.get('/testar-danfse-variacoes', async (req, res) => {
  try {
    const db = getDb();
    const nf = db.prepare(`
      SELECT nf.id, nf.chave_acesso, nf.numero_nfse,
             c.id as cliente_id, c.razao_social, c.certificado_a1_senha_encrypted
      FROM notas_fiscais nf
      INNER JOIN clientes c ON nf.cliente_id = c.id
      WHERE nf.status = 'emitida' AND nf.chave_acesso IS NOT NULL
      ORDER BY nf.id DESC LIMIT 1
    `).get();
    if (!nf) return res.json({ erro: 'Nenhuma NF emitida encontrada' });

    const cert = certificadoService.carregarCertificado(nf.cliente_id, nf.certificado_a1_senha_encrypted);
    const url = `https://adn.nfse.gov.br/danfse/${nf.chave_acesso}`;

    const variacoes = [
      { nome: 'minimo',              headers: {} },
      { nome: 'so-accept',           headers: { Accept: 'application/pdf' } },
      { nome: 'accept+ua',           headers: { Accept: 'application/pdf', 'User-Agent': 'emissor-nfs-marcal/1.0' } },
      { nome: 'accept+ua+conn',      headers: { Accept: 'application/pdf', 'User-Agent': 'emissor-nfs-marcal/1.0', Connection: 'close' } },
      { nome: 'accept-any',          headers: { Accept: '*/*' } },
      { nome: 'browser-like',        headers: { Accept: 'application/pdf,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 (compatible; emissor-nfs-marcal/1.0)', 'Accept-Language': 'pt-BR,pt;q=0.9', Connection: 'close' } },
    ];

    const resultados = [];
    for (const v of variacoes) {
      const inicio = Date.now();
      const r = await tentarRequisicaoComHeaders(url, cert.pfxBuffer, cert.senha, v.headers).catch(err => ({ erro: err.message }));
      const tempo = Date.now() - inicio;
      if (r.erro) { resultados.push({ ...v, erro: r.erro, tempo_ms: tempo }); continue; }
      const ePdf = r.bodyBuffer.slice(0, 4).toString() === '%PDF';
      resultados.push({
        ...v,
        status: r.statusCode,
        tempo_ms: tempo,
        content_type: r.headers['content-type'] || null,
        content_length: r.headers['content-length'] || r.bodyBuffer.length,
        e_pdf: ePdf,
        body_preview: r.bodyBuffer.slice(0, 300).toString('utf-8').replace(/[^\x20-\x7E\n]/g, '.'),
      });
    }

    res.json({
      chave_testada: nf.chave_acesso,
      nf_numero: nf.numero_nfse,
      cliente: nf.razao_social,
      resultados,
    });
  } catch (err) {
    console.error('[debug testar-danfse-variacoes] erro:', err);
    res.status(500).json({ erro: err.message });
  }
});

function tentarRequisicaoComHeaders(urlStr, pfxBuffer, senha, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const options = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      pfx: pfxBuffer,
      passphrase: senha,
      headers,
      timeout: 15000,
    };
    const req = https.request(options, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({
        statusCode: r.statusCode,
        headers: r.headers,
        bodyBuffer: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('Timeout 15s')); });
    req.on('error', reject);
    req.end();
  });
}

// =====================================================
// Backup SQLite — disparar manual + listar
// =====================================================
const backupService = require('../services/backupService');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

// GET /api/debug/backup/listar — lista backups existentes (autenticado)
router.get('/backup/listar', autenticado, apenasEscritorio, (req, res) => {
  try {
    res.json({ backups: backupService.listarBackups() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/debug/backup/rodar — dispara backup manual (autenticado)
router.post('/backup/rodar', autenticado, apenasEscritorio, (req, res) => {
  try {
    const r = backupService.rodarBackup();
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// =====================================================
// Exportar conversas da ANA — para análise/revisão
// =====================================================
//
// GET /api/debug/exportar-conversas-ana?dias=30&limite=200&sanitizar=1
//
// Devolve JSON com últimas conversas da ANA + suas mensagens, pronto pra análise.
// - dias: janela de tempo (default 30)
// - limite: máximo de conversas a retornar (default 200, max 1000)
// - sanitizar: se 1, remove dígitos do telefone e aplica iniciais nos nomes (default 1)
//
// Restrito a usuários do escritório.
router.get('/exportar-conversas-ana', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const dias = Math.max(1, Math.min(365, parseInt(req.query.dias || '30', 10)));
    const limite = Math.max(1, Math.min(1000, parseInt(req.query.limite || '200', 10)));
    const sanitizar = req.query.sanitizar !== '0';

    const conversas = db.prepare(`
      SELECT
        c.id,
        c.contato_id,
        c.status,
        c.created_at,
        c.ultimo_mensagem_at,
        co.telefone,
        co.nome,
        co.tipo as tipo_contato,
        co.cliente_id,
        cli.razao_social,
        cli.cnpj
      FROM whatsapp_conversas c
      INNER JOIN whatsapp_contatos co ON c.contato_id = co.id
      LEFT JOIN clientes cli ON co.cliente_id = cli.id
      WHERE c.ultimo_mensagem_at >= datetime('now', '-' || ? || ' days')
      ORDER BY c.ultimo_mensagem_at DESC
      LIMIT ?
    `).all(dias, limite);

    const stmtMsgs = db.prepare(`
      SELECT id, direcao, tipo, conteudo, remetente, metadata, created_at
      FROM whatsapp_mensagens
      WHERE conversa_id = ?
      ORDER BY id ASC
    `);

    const sanitizarTelefone = (tel) => {
      if (!tel) return tel;
      if (!sanitizar) return tel;
      // mantém DDI+DDD, mascara restante
      const s = String(tel);
      if (s.length <= 6) return '***';
      return s.slice(0, 4) + '*'.repeat(Math.max(0, s.length - 6)) + s.slice(-2);
    };

    const sanitizarNome = (nome) => {
      if (!nome || !sanitizar) return nome;
      return String(nome).split(/\s+/).map(p => p ? p[0].toUpperCase() + '.' : '').join(' ').trim();
    };

    const sanitizarCnpj = (cnpj) => {
      if (!cnpj || !sanitizar) return cnpj;
      const s = String(cnpj).replace(/\D/g, '');
      if (s.length < 8) return '***';
      return s.slice(0, 2) + '.***.***/****-' + s.slice(-2);
    };

    const resultado = conversas.map(c => {
      const msgs = stmtMsgs.all(c.id).map(m => {
        let metadata = null;
        try { metadata = m.metadata ? JSON.parse(m.metadata) : null; } catch { metadata = m.metadata; }
        return {
          id: m.id,
          direcao: m.direcao,
          tipo: m.tipo,
          remetente: m.remetente,
          conteudo: m.conteudo,
          metadata,
          created_at: m.created_at,
        };
      });
      return {
        conversa_id: c.id,
        status: c.status,
        criada_em: c.created_at,
        ultima_mensagem_em: c.ultimo_mensagem_at,
        contato: {
          telefone: sanitizarTelefone(c.telefone),
          nome: sanitizarNome(c.nome),
          tipo: c.tipo_contato,
          cliente_vinculado: c.cliente_id ? {
            razao_social: sanitizarNome(c.razao_social),
            cnpj: sanitizarCnpj(c.cnpj),
          } : null,
        },
        total_mensagens: msgs.length,
        mensagens: msgs,
      };
    });

    res.json({
      gerado_em: new Date().toISOString(),
      janela_dias: dias,
      sanitizado: sanitizar,
      total_conversas: resultado.length,
      conversas: resultado,
    });
  } catch (err) {
    console.error('[exportar-conversas-ana] erro:', err);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
