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

module.exports = router;
