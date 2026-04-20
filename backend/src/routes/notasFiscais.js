const express = require('express');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio } = require('../middleware/auth');
const nfseNacionalService = require('../services/nfseNacionalService');
const danfsePdfService = require('../services/danfsePdfService');
let QRCode;
try { QRCode = require('qrcode'); } catch (e) { QRCode = null; }

const router = express.Router();

// Gera próximo número de DPS para o cliente
function proximoNumeroDps(db, clienteId) {
  const ultima = db.prepare(`
    SELECT numero_dps FROM notas_fiscais
    WHERE cliente_id = ? AND numero_dps IS NOT NULL
    ORDER BY CAST(numero_dps AS INTEGER) DESC LIMIT 1
  `).get(clienteId);

  return ultima ? String(parseInt(ultima.numero_dps) + 1) : '1';
}

// GET /api/notas-fiscais - Lista NFs (escritório vê todas, cliente vê as suas)
router.get('/', autenticado, (req, res) => {
  try {
    const db = getDb();
    const { status, cliente_id, data_inicio, data_fim, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = [];
    let params = [];

    // Cliente só vê as próprias NFs
    if (req.usuario.tipo === 'cliente') {
      where.push('nf.cliente_id = ?');
      params.push(req.usuario.clienteId);
    } else if (cliente_id) {
      where.push('nf.cliente_id = ?');
      params.push(parseInt(cliente_id));
    }

    if (status) {
      where.push('nf.status = ?');
      params.push(status);
    }

    if (data_inicio) {
      where.push('nf.data_competencia >= ?');
      params.push(data_inicio);
    }

    if (data_fim) {
      where.push('nf.data_competencia <= ?');
      params.push(data_fim);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Total
    const total = db.prepare(`
      SELECT COUNT(*) as total FROM notas_fiscais nf ${whereClause}
    `).get(...params).total;

    // Dados
    const notas = db.prepare(`
      SELECT nf.id, nf.numero_dps, nf.numero_nfse, nf.chave_acesso,
             nf.status, nf.codigo_servico, nf.descricao_servico,
             nf.valor_servico, nf.valor_iss, nf.aliquota_iss, nf.valor_liquido,
             nf.iss_retido, nf.data_competencia, nf.data_emissao,
             nf.criado_por, nf.origem, nf.observacoes, nf.created_at,
             c.razao_social as cliente_razao_social, c.cnpj as cliente_cnpj,
             t.razao_social as tomador_razao_social, t.documento as tomador_documento
      FROM notas_fiscais nf
      JOIN clientes c ON c.id = nf.cliente_id
      LEFT JOIN tomadores t ON t.id = nf.tomador_id
      ${whereClause}
      ORDER BY nf.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({
      dados: notas,
      paginacao: {
        total,
        pagina: parseInt(page),
        limite: parseInt(limit),
        totalPaginas: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Erro ao listar NFs:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/notas-fiscais/:id - Detalhe de uma NF
router.get('/:id', autenticado, (req, res) => {
  try {
    const db = getDb();
    const nota = db.prepare(`
      SELECT nf.*,
             c.razao_social as cliente_razao_social, c.cnpj as cliente_cnpj,
             c.nome_fantasia as cliente_nome_fantasia,
             t.razao_social as tomador_razao_social, t.documento as tomador_documento,
             t.email as tomador_email,
             u.nome as aprovado_por_nome
      FROM notas_fiscais nf
      JOIN clientes c ON c.id = nf.cliente_id
      LEFT JOIN tomadores t ON t.id = nf.tomador_id
      LEFT JOIN usuarios_escritorio u ON u.id = nf.aprovado_por
      WHERE nf.id = ?
    `).get(parseInt(req.params.id));

    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }

    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== nota.cliente_id) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    res.json(nota);
  } catch (err) {
    console.error('Erro ao buscar NF:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// POST /api/notas-fiscais - Cria nova NF
router.post('/', autenticado, (req, res) => {
  try {
    const db = getDb();
    const {
      cliente_id, tomador_id,
      codigo_servico, descricao_servico,
      valor_servico, valor_deducoes,
      valor_pis, valor_cofins, valor_inss, valor_ir, valor_csll,
      aliquota_iss, iss_retido,
      data_competencia, observacoes
    } = req.body;

    // Determina cliente_id
    const clienteId = req.usuario.tipo === 'cliente' ? req.usuario.clienteId : cliente_id;
    if (!clienteId) {
      return res.status(400).json({ erro: 'Cliente é obrigatório' });
    }

    // Validações básicas
    if (!codigo_servico || !descricao_servico || !valor_servico || !data_competencia) {
      return res.status(400).json({
        erro: 'Campos obrigatórios: codigo_servico, descricao_servico, valor_servico, data_competencia'
      });
    }

    // Busca dados do cliente
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    // Calcula valores
    const valorServ = parseFloat(valor_servico);
    const valorDed = parseFloat(valor_deducoes) || 0;
    const baseCalculo = valorServ - valorDed;
    const aliqIss = parseFloat(aliquota_iss) || cliente.aliquota_iss || 0;
    const valorIss = baseCalculo * aliqIss;
    const retencoes = (parseFloat(valor_pis) || 0) + (parseFloat(valor_cofins) || 0) +
                      (parseFloat(valor_inss) || 0) + (parseFloat(valor_ir) || 0) +
                      (parseFloat(valor_csll) || 0);
    const valorIssRetido = iss_retido ? valorIss : 0;
    const valorLiquido = valorServ - retencoes - valorIssRetido;

    // Determina status inicial
    let status;
    let criadoPor;
    if (req.usuario.tipo === 'escritorio') {
      status = 'aprovada'; // Escritório já cria aprovada
      criadoPor = 'escritorio';
    } else if (cliente.modo_emissao === 'autonomo') {
      status = 'aprovada'; // Cliente autônomo
      criadoPor = 'cliente';
    } else {
      status = 'pendente_aprovacao';
      criadoPor = 'cliente';
    }

    // Gera número DPS
    const numeroDps = proximoNumeroDps(db, clienteId);

    const result = db.prepare(`
      INSERT INTO notas_fiscais (
        cliente_id, tomador_id, numero_dps, serie_dps,
        status, codigo_servico, descricao_servico,
        valor_servico, valor_deducoes, valor_pis, valor_cofins,
        valor_inss, valor_ir, valor_csll, valor_iss,
        aliquota_iss, base_calculo, valor_liquido, iss_retido,
        data_competencia, observacoes, criado_por, origem
      ) VALUES (?, ?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'portal')
    `).run(
      clienteId, tomador_id || null, numeroDps,
      status, codigo_servico, descricao_servico,
      valorServ, valorDed, parseFloat(valor_pis) || 0, parseFloat(valor_cofins) || 0,
      parseFloat(valor_inss) || 0, parseFloat(valor_ir) || 0, parseFloat(valor_csll) || 0,
      valorIss, aliqIss, baseCalculo, valorLiquido, iss_retido ? 1 : 0,
      data_competencia, observacoes, criadoPor
    );

    // Log
    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id, nota_fiscal_id)
      VALUES ('nf_criada', ?, ?, ?, ?, ?)
    `).run(
      `NF #${numeroDps} criada - R$ ${valorServ.toFixed(2)}`,
      req.usuario.tipo,
      req.usuario.tipo === 'escritorio' ? req.usuario.id : null,
      clienteId,
      result.lastInsertRowid
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      numero_dps: numeroDps,
      status,
      mensagem: status === 'pendente_aprovacao'
        ? 'NF criada e enviada para aprovação do escritório'
        : 'NF criada e pronta para emissão'
    });
  } catch (err) {
    console.error('Erro ao criar NF:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// PUT /api/notas-fiscais/:id/aprovar - Aprova uma NF (escritório)
router.put('/:id/aprovar', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const notaId = parseInt(req.params.id);

    const nota = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(notaId);
    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }
    if (nota.status !== 'pendente_aprovacao') {
      return res.status(400).json({ erro: `Nota não pode ser aprovada (status atual: ${nota.status})` });
    }

    db.prepare(`
      UPDATE notas_fiscais
      SET status = 'aprovada', aprovado_por = ?, data_aprovacao = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.usuario.id, notaId);

    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id, nota_fiscal_id)
      VALUES ('nf_aprovada', ?, 'escritorio', ?, ?, ?)
    `).run(`NF #${nota.numero_dps} aprovada`, req.usuario.id, nota.cliente_id, notaId);

    res.json({ mensagem: 'Nota fiscal aprovada com sucesso' });
  } catch (err) {
    console.error('Erro ao aprovar NF:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// PUT /api/notas-fiscais/:id/rejeitar - Rejeita uma NF (escritório)
router.put('/:id/rejeitar', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const notaId = parseInt(req.params.id);
    const { motivo } = req.body;

    const nota = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(notaId);
    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }
    if (nota.status !== 'pendente_aprovacao') {
      return res.status(400).json({ erro: `Nota não pode ser rejeitada (status atual: ${nota.status})` });
    }

    db.prepare(`
      UPDATE notas_fiscais
      SET status = 'rejeitada', mensagem_erro = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(motivo || 'Rejeitada pelo escritório', notaId);

    res.json({ mensagem: 'Nota fiscal rejeitada' });
  } catch (err) {
    console.error('Erro ao rejeitar NF:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// PUT /api/notas-fiscais/:id/emitir - Emite a NF via API NFS-e Nacional
router.put('/:id/emitir', autenticado, async (req, res) => {
  try {
    const db = getDb();
    const notaId = parseInt(req.params.id);
    const modoSimulacao = process.env.NFSE_SIMULACAO === 'true';

    const nota = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(notaId);
    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }
    const statusPermitidos = ['aprovada', 'erro_emissao', 'pendente_emissao'];
    if (!statusPermitidos.includes(nota.status)) {
      return res.status(400).json({ erro: `Nota precisa estar aprovada ou com erro para ser (re-)emitida (status atual: ${nota.status})` });
    }

    // Busca dados do cliente e tomador
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(nota.cliente_id);
    const tomador = nota.tomador_id
      ? db.prepare('SELECT * FROM tomadores WHERE id = ?').get(nota.tomador_id)
      : null;

    if (!tomador) {
      return res.status(400).json({ erro: 'Tomador é obrigatório para emissão' });
    }

    // === PRÉ-VALIDAÇÃO E ENRIQUECIMENTO AUTOMÁTICO ===
    const preValidacaoService = require('../services/preValidacaoNfseService');
    const validacao = await preValidacaoService.validarEEnriquecer(nota, cliente, tomador);

    if (!validacao.valido) {
      // Registra os erros e volta status
      const msgErros = validacao.erros.join('; ');
      db.prepare(`
        INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id, nota_fiscal_id)
        VALUES ('nf_validacao', ?, ?, ?, ?, ?)
      `).run(
        `Pré-validação falhou para NF #${nota.numero_dps}: ${msgErros}`,
        req.usuario.tipo,
        req.usuario.tipo === 'escritorio' ? req.usuario.id : null,
        nota.cliente_id,
        notaId
      );
      return res.status(400).json({
        erro: 'Dados incompletos para emissão',
        errosValidacao: validacao.erros,
        correcoes: validacao.correcoes,
        avisos: validacao.avisos,
      });
    }

    // Log das correções automáticas (se houve)
    if (validacao.correcoes.length > 0) {
      db.prepare(`
        INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id, nota_fiscal_id)
        VALUES ('nf_autocorrecao', ?, ?, ?, ?, ?)
      `).run(
        `Correções automáticas na NF #${nota.numero_dps}: ${validacao.correcoes.join('; ')}`,
        req.usuario.tipo,
        req.usuario.tipo === 'escritorio' ? req.usuario.id : null,
        nota.cliente_id,
        notaId
      );
    }

    // Marca como processando
    db.prepare(`
      UPDATE notas_fiscais SET status = 'processando', updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(notaId);

    let numeroNfse, chaveAcesso, xmlEnvio, xmlRetorno;

    if (modoSimulacao) {
      // === MODO SIMULAÇÃO (para testes sem certificado) ===
      numeroNfse = String(Math.floor(Math.random() * 900000) + 100000);
      chaveAcesso = Array.from({ length: 50 }, () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]
      ).join('');
      xmlEnvio = '[SIMULAÇÃO] DPS não enviada';
      xmlRetorno = '[SIMULAÇÃO] Retorno simulado';
    } else {
      // === MODO REAL - API NFS-e Nacional ===
      // Verifica se o cliente tem certificado
      if (!cliente.certificado_a1_path || !cliente.certificado_a1_senha_encrypted) {
        db.prepare(`UPDATE notas_fiscais SET status = 'aprovada', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(notaId);
        return res.status(400).json({
          erro: 'Cliente não possui certificado digital A1 cadastrado. Faça upload do certificado antes de emitir.',
        });
      }

      try {
        const resultado = await nfseNacionalService.emitirNFSe(nota, cliente, tomador);
        numeroNfse = resultado.numeroNfse;
        chaveAcesso = resultado.chaveAcesso;
        xmlEnvio = resultado.xmlEnvio;
        xmlRetorno = resultado.xmlRetorno;
      } catch (apiErr) {
        // Falha na API - volta o status para aprovada
        const msgErro = apiErr.mensagem || apiErr.message || 'Erro desconhecido na API';
        db.prepare(`
          UPDATE notas_fiscais
          SET status = 'rejeitada', mensagem_erro = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(msgErro, notaId);

        db.prepare(`
          INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id, nota_fiscal_id)
          VALUES ('nf_erro', ?, ?, ?, ?, ?)
        `).run(
          `Erro na emissão da NF #${nota.numero_dps}: ${msgErro}`,
          req.usuario.tipo,
          req.usuario.tipo === 'escritorio' ? req.usuario.id : null,
          nota.cliente_id,
          notaId
        );

        return res.status(502).json({
          erro: 'Erro na comunicação com a API NFS-e Nacional',
          detalhes: msgErro,
        });
      }
    }

    // Atualiza a nota com os dados da emissão
    db.prepare(`
      UPDATE notas_fiscais
      SET status = 'emitida', numero_nfse = ?, chave_acesso = ?,
          data_emissao = CURRENT_TIMESTAMP, xml_envio = ?, xml_retorno = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(numeroNfse, chaveAcesso, xmlEnvio, xmlRetorno, notaId);

    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id, nota_fiscal_id)
      VALUES ('nf_emitida', ?, ?, ?, ?, ?)
    `).run(
      `NF #${nota.numero_dps} emitida (NFS-e ${numeroNfse})${modoSimulacao ? ' [SIMULAÇÃO]' : ''}`,
      req.usuario.tipo,
      req.usuario.tipo === 'escritorio' ? req.usuario.id : null,
      nota.cliente_id,
      notaId
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    // Usa /danfse-pdf (cascata ADN oficial → Puppeteer fallback) em vez de HTML
    const linkDanfse = `${baseUrl}/api/notas-fiscais/${notaId}/danfse-pdf`;

    // Envia notificação via WhatsApp (se configurado e tomador tem telefone)
    try {
      const whatsappService = require('../services/whatsappService');
      if (whatsappService.isConfigured() && tomador.telefone) {
        whatsappService.notificarNFEmitida(tomador.telefone, {
          razao_social_tomador: tomador.razao_social,
          numero_dps: nota.numero_dps,
          valor_servico: nota.valor_servico,
          descricao_servico: nota.descricao_servico,
          link_danfse: linkDanfse
        }).catch(err => console.error('[WhatsApp] Erro ao notificar NF:', err));
      }
    } catch (whatsErr) {
      console.error('[WhatsApp] Erro ao carregar serviço:', whatsErr);
    }

    // Envia notificação por e-mail (se configurado e tomador tem e-mail)
    let emailEnviado = false;
    try {
      const emailService = require('../services/emailService');
      if (emailService.isConfigured() && tomador.email) {
        emailService.notificarNFEmitida({
          tomador,
          cliente,
          nota: { ...nota, numero_nfse: numeroNfse, data_emissao: new Date().toISOString() },
          linkDanfse
        }).then(() => {
          console.log(`[Email] NF ${numeroNfse} enviada para ${tomador.email}`);
        }).catch(err => console.error('[Email] Erro ao notificar NF:', err));
        emailEnviado = true;
      }
    } catch (emailErr) {
      console.error('[Email] Erro ao carregar serviço:', emailErr);
    }

    res.json({
      mensagem: `Nota fiscal emitida com sucesso${modoSimulacao ? ' (modo simulação)' : ''}`,
      numero_nfse: numeroNfse,
      chave_acesso: chaveAcesso,
      simulacao: modoSimulacao,
      email_enviado: emailEnviado,
    });
  } catch (err) {
    console.error('Erro ao emitir NF:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// PUT /api/notas-fiscais/:id/cancelar - Cancela uma NF emitida
router.put('/:id/cancelar', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const db = getDb();
    const notaId = parseInt(req.params.id);
    const { motivo } = req.body;

    const nota = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(notaId);
    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }
    if (nota.status !== 'emitida') {
      return res.status(400).json({ erro: 'Apenas notas emitidas podem ser canceladas' });
    }

    const modoSimulacao = process.env.NFSE_SIMULACAO === 'true';

    if (!modoSimulacao && nota.chave_acesso && nota.chave_acesso.length === 50) {
      // Cancelamento real via API
      try {
        const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(nota.cliente_id);
        await nfseNacionalService.cancelarNFSe(
          nota.chave_acesso,
          motivo || 'Cancelamento solicitado pelo contribuinte',
          cliente.id,
          cliente.certificado_a1_senha_encrypted
        );
      } catch (apiErr) {
        console.error('Erro ao cancelar na API:', apiErr);
        return res.status(502).json({
          erro: 'Erro ao cancelar na API NFS-e Nacional',
          detalhes: apiErr.mensagem || apiErr.message,
        });
      }
    }

    db.prepare(`
      UPDATE notas_fiscais
      SET status = 'cancelada', data_cancelamento = CURRENT_TIMESTAMP,
          mensagem_erro = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(motivo || 'Cancelada pelo escritório', notaId);

    res.json({ mensagem: 'Nota fiscal cancelada com sucesso' });
  } catch (err) {
    console.error('Erro ao cancelar NF:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/notas-fiscais/dashboard/resumo - Resumo para dashboard
router.get('/dashboard/resumo', autenticado, (req, res) => {
  try {
    const db = getDb();
    let clienteFilter = '';
    let params = [];

    if (req.usuario.tipo === 'cliente') {
      clienteFilter = 'WHERE cliente_id = ?';
      params.push(req.usuario.clienteId);
    }

    const mesAtual = new Date().toISOString().slice(0, 7); // YYYY-MM

    const resumo = {
      total_mes: db.prepare(`
        SELECT COUNT(*) as total, COALESCE(SUM(valor_servico), 0) as valor
        FROM notas_fiscais
        ${clienteFilter ? clienteFilter + ' AND' : 'WHERE'} data_competencia LIKE ? AND status != 'cancelada'
      `).get(...params, `${mesAtual}%`),

      pendentes: db.prepare(`
        SELECT COUNT(*) as total FROM notas_fiscais
        ${clienteFilter ? clienteFilter + ' AND' : 'WHERE'} status = 'pendente_aprovacao'
      `).get(...params),

      emitidas_mes: db.prepare(`
        SELECT COUNT(*) as total FROM notas_fiscais
        ${clienteFilter ? clienteFilter + ' AND' : 'WHERE'} status = 'emitida' AND data_competencia LIKE ?
      `).get(...params, `${mesAtual}%`),

      ultimas_notas: db.prepare(`
        SELECT nf.id, nf.numero_dps, nf.numero_nfse, nf.status,
               nf.valor_servico, nf.data_competencia, nf.created_at,
               c.nome_fantasia as cliente, t.razao_social as tomador
        FROM notas_fiscais nf
        JOIN clientes c ON c.id = nf.cliente_id
        LEFT JOIN tomadores t ON t.id = nf.tomador_id
        ${clienteFilter}
        ORDER BY nf.created_at DESC LIMIT 5
      `).all(...params)
    };

    res.json(resumo);
  } catch (err) {
    console.error('Erro no resumo:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// =====================================================
// Helper: Busca dados da NF e gera HTML da DANFSe
// =====================================================
function buscarDadosNota(notaId) {
  const db = getDb();
  return db.prepare(`
    SELECT nf.*,
           c.razao_social as cliente_razao_social, c.cnpj as cliente_cnpj,
           c.nome_fantasia as cliente_nome_fantasia, c.email as cliente_email,
           c.telefone as cliente_telefone, c.municipio as cliente_municipio,
           c.uf as cliente_uf,
           c.certificado_a1_path, c.certificado_a1_senha_encrypted,
           t.razao_social as tomador_razao_social, t.nome_fantasia as tomador_nome_fantasia,
           t.tipo_documento, t.documento as tomador_documento, t.email as tomador_email,
           t.telefone as tomador_telefone, t.municipio as tomador_municipio, t.uf as tomador_uf,
           t.logradouro as tomador_endereco, t.numero as tomador_numero, t.bairro as tomador_bairro,
           t.cep as tomador_cep
    FROM notas_fiscais nf
    JOIN clientes c ON c.id = nf.cliente_id
    LEFT JOIN tomadores t ON t.id = nf.tomador_id
    WHERE nf.id = ?
  `).get(notaId);
}

async function gerarHtmlDanfse(nota) {
    // Gera QR Code como data URL (base64 PNG)
    let qrDataUrl = '';
    if (QRCode && nota.chave_acesso) {
      try {
        const consultaUrl = `https://www.nfse.gov.br/consultapublica`;
        qrDataUrl = await QRCode.toDataURL(consultaUrl, { width: 120, margin: 1 });
      } catch (e) { qrDataUrl = ''; }
    }

    const formatarData = (data) => {
      if (!data) return '-';
      const d = new Date(data);
      const dia = String(d.getDate()).padStart(2, '0');
      const mes = String(d.getMonth() + 1).padStart(2, '0');
      const ano = d.getFullYear();
      return `${dia}/${mes}/${ano}`;
    };

    const formatarMoeda = (valor) => {
      if (!valor) return 'R$ 0,00';
      const num = parseFloat(valor);
      return `R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    const formatarCNPJ = (cnpj) => {
      if (!cnpj) return '-';
      const clean = cnpj.replace(/\D/g, '');
      return clean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    };

    const formatarCPF = (cpf) => {
      if (!cpf) return '-';
      const clean = cpf.replace(/\D/g, '');
      if (clean.length === 11) {
        return clean.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
      }
      return cpf;
    };

    const isSimulacao = nota.xml_envio && nota.xml_envio.includes('[SIMULAÇÃO]');

    const chaveFormatada = nota.chave_acesso
      ? nota.chave_acesso.replace(/(.{4})/g, '$1 ').trim()
      : 'Não disponível';

    const nfseNum = nota.numero_nfse || 'Pendente';
    const dpsNum = nota.numero_dps || '-';

    return `
<\!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>DANFSe - NFS-e ${nfseNum}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #222; background: white; }
    .page { width: 100%; max-width: 800px; margin: 0 auto; padding: 10px; }

    /* Header */
    .header { display: flex; align-items: stretch; border: 2px solid #333; margin-bottom: 0; }
    .header-left { flex: 1; padding: 12px 16px; border-right: 1px solid #333; }
    .header-left h1 { font-size: 22px; color: #003366; margin-bottom: 2px; }
    .header-left .subtitle { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
    .header-left .version { font-size: 8px; color: #888; margin-top: 4px; }
    .header-center { display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 8px 16px; border-right: 1px solid #333; min-width: 140px; }
    .header-center .label { font-size: 9px; color: #555; text-transform: uppercase; margin-bottom: 4px; }
    .header-center .nfse-num { font-size: 20px; font-weight: bold; color: #003366; }
    .header-center .dps-info { font-size: 9px; color: #666; margin-top: 2px; }
    .header-right { display: flex; align-items: center; justify-content: center; padding: 8px; min-width: 130px; }
    .header-right img { width: 110px; height: 110px; }
    .qr-placeholder { width: 110px; height: 110px; border: 1px dashed #ccc; display: flex; align-items: center; justify-content: center; font-size: 8px; color: #999; text-align: center; }

    /* Chave de acesso */
    .chave-box { border: 2px solid #333; border-top: none; padding: 8px 16px; background: #f8f8f8; text-align: center; margin-bottom: 0; }
    .chave-box .label { font-size: 8px; color: #555; text-transform: uppercase; letter-spacing: 1px; }
    .chave-box .chave { font-family: 'Courier New', monospace; font-size: 12px; font-weight: bold; letter-spacing: 2px; color: #222; margin-top: 2px; }

    /* Sections */
    .section { border: 2px solid #333; border-top: none; }
    .section-title { background: #003366; color: white; padding: 6px 12px; font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }
    .section-body { padding: 10px 12px; }

    /* Field grid */
    .fields { display: flex; flex-wrap: wrap; gap: 0; }
    .field { padding: 4px 8px 6px 0; }
    .field.w50 { width: 50%; }
    .field.w33 { width: 33.33%; }
    .field.w25 { width: 25%; }
    .field.w100 { width: 100%; }
    .field .label { font-size: 8px; color: #666; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 1px; }
    .field .val { font-size: 11px; color: #222; font-weight: 500; }

    /* Tabela serviço */
    .svc-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .svc-table th { background: #e8e8e8; padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; border-bottom: 1px solid #ccc; }
    .svc-table td { padding: 6px 8px; border-bottom: 1px solid #eee; }
    .svc-table .right { text-align: right; }

    /* Valores */
    .val-grid { display: flex; gap: 0; }
    .val-col { flex: 1; }
    .val-row { display: flex; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid #f0f0f0; font-size: 10px; }
    .val-row .label { color: #555; }
    .val-row .val { font-weight: 600; }
    .val-total { background: #e6f4ea; border: 2px solid #27ae60; border-radius: 3px; padding: 8px 12px; margin-top: 6px; display: flex; justify-content: space-between; }
    .val-total .label { color: #27ae60; font-weight: bold; text-transform: uppercase; font-size: 12px; }
    .val-total .val { color: #27ae60; font-weight: bold; font-size: 14px; }

    /* Situação */
    .situacao { display: inline-block; padding: 3px 10px; border-radius: 3px; font-size: 10px; font-weight: bold; text-transform: uppercase; }
    .situacao.emitida { background: #e6f4ea; color: #27ae60; border: 1px solid #27ae60; }
    .situacao.pendente { background: #fff8e1; color: #f39c12; border: 1px solid #f39c12; }
    .situacao.cancelada { background: #fde8e8; color: #e74c3c; border: 1px solid #e74c3c; }

    /* Footer */
    .footer { text-align: center; padding: 10px; font-size: 8px; color: #999; border: 2px solid #333; border-top: none; }
    .footer p { margin: 2px 0; }

    /* Simulação */
    .sim-banner { background: #fff3cd; border: 2px solid #ffc107; color: #856404; padding: 8px; text-align: center; font-weight: bold; font-size: 12px; }

    @media print {
      body { background: white; }
      .page { padding: 0; max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="page">
    ${nota.xml_envio && nota.xml_envio.includes('[SIMULAÇÃO]') ? '<div class="sim-banner">*** DOCUMENTO DE SIMULAÇÃO - SEM VALIDADE FISCAL ***</div>' : ''}

    <div class="header">
      <div class="header-left">
        <h1>DANFSe</h1>
        <div class="subtitle">Documento Auxiliar da Nota Fiscal de Serviço Eletrônica</div>
        <div class="version">Padrão Nacional NFS-e</div>
        <div style="margin-top:8px;">
          <span class="situacao ${nota.status === 'emitida' ? 'emitida' : nota.status === 'cancelada' ? 'cancelada' : 'pendente'}">
            ${nota.status === 'emitida' ? 'AUTORIZADA' : nota.status.toUpperCase()}
          </span>
        </div>
      </div>
      <div class="header-center">
        <div class="label">Número NFS-e</div>
        <div class="nfse-num">${nfseNum}</div>
        <div class="dps-info">DPS nº ${dpsNum} / Série 1</div>
        <div class="dps-info">${formatarData(nota.data_emissao)}</div>
      </div>
      <div class="header-right">
        ${qrDataUrl ? '<img src="' + qrDataUrl + '" alt="QR Code" />' : '<div class="qr-placeholder">QR Code<br>Consulta Pública</div>'}
      </div>
    </div>

    <div class="chave-box">
      <div class="label">Chave de Acesso da NFS-e</div>
      <div class="chave">${chaveFormatada}</div>
    </div>

    <div class="section">
      <div class="section-title">Prestador de Serviços</div>
      <div class="section-body">
        <div class="fields">
          <div class="field w50"><div class="label">Razão Social</div><div class="val">${nota.cliente_razao_social || '-'}</div></div>
          <div class="field w50"><div class="label">Nome Fantasia</div><div class="val">${nota.cliente_nome_fantasia || '-'}</div></div>
          <div class="field w33"><div class="label">CNPJ</div><div class="val">${formatarCNPJ(nota.cliente_cnpj)}</div></div>
          <div class="field w33"><div class="label">Município/UF</div><div class="val">${nota.cliente_municipio || '-'}/${nota.cliente_uf || '-'}</div></div>
          <div class="field w33"><div class="label">Contato</div><div class="val">${nota.cliente_email || '-'}</div></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Tomador de Serviços</div>
      <div class="section-body">
        ${nota.tomador_razao_social ? `
        <div class="fields">
          <div class="field w50"><div class="label">Razão Social</div><div class="val">${nota.tomador_razao_social}</div></div>
          <div class="field w25"><div class="label">${nota.tipo_documento === 'CNPJ' ? 'CNPJ' : 'CPF'}</div><div class="val">${nota.tipo_documento === 'CNPJ' ? formatarCNPJ(nota.tomador_documento) : formatarCPF(nota.tomador_documento)}</div></div>
          <div class="field w25"><div class="label">Telefone</div><div class="val">${nota.tomador_telefone || '-'}</div></div>
          <div class="field w100"><div class="label">Endereço</div><div class="val">${nota.tomador_endereco || '-'}, ${nota.tomador_numero || 'S/N'} - ${nota.tomador_bairro || '-'} - CEP ${nota.tomador_cep || '-'}</div></div>
          <div class="field w50"><div class="label">Município/UF</div><div class="val">${nota.tomador_municipio || '-'}/${nota.tomador_uf || '-'}</div></div>
          <div class="field w50"><div class="label">E-mail</div><div class="val">${nota.tomador_email || '-'}</div></div>
        </div>
        ` : '<div style="color:#999;font-style:italic;">Tomador não identificado</div>'}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Descrição dos Serviços</div>
      <div class="section-body" style="padding:0;">
        <table class="svc-table">
          <thead><tr><th style="width:80px;">Código</th><th>Discriminação do Serviço</th><th class="right" style="width:120px;">Valor (R$)</th></tr></thead>
          <tbody><tr><td>${nota.codigo_servico || '-'}</td><td>${nota.descricao_servico || '-'}</td><td class="right">${formatarMoeda(nota.valor_servico)}</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Valores da NFS-e</div>
      <div class="section-body">
        <div class="val-grid">
          <div class="val-col">
            <div class="val-row"><span class="label">Valor dos Serviços</span><span class="val">${formatarMoeda(nota.valor_servico)}</span></div>
            <div class="val-row"><span class="label">Deduções / Descontos</span><span class="val">${formatarMoeda(nota.valor_deducoes)}</span></div>
            <div class="val-row"><span class="label">Base de Cálculo</span><span class="val">${formatarMoeda(nota.base_calculo)}</span></div>
            <div class="val-row"><span class="label">Alíquota ISS</span><span class="val">${(parseFloat(nota.aliquota_iss || 0) * 100).toFixed(2)}%</span></div>
            <div class="val-row"><span class="label">ISS ${nota.iss_retido ? '(Retido)' : ''}</span><span class="val">${formatarMoeda(nota.valor_iss)}</span></div>
          </div>
          <div class="val-col">
            <div class="val-row"><span class="label">PIS</span><span class="val">${formatarMoeda(nota.valor_pis)}</span></div>
            <div class="val-row"><span class="label">COFINS</span><span class="val">${formatarMoeda(nota.valor_cofins)}</span></div>
            <div class="val-row"><span class="label">INSS</span><span class="val">${formatarMoeda(nota.valor_inss)}</span></div>
            <div class="val-row"><span class="label">IR</span><span class="val">${formatarMoeda(nota.valor_ir)}</span></div>
            <div class="val-row"><span class="label">CSLL</span><span class="val">${formatarMoeda(nota.valor_csll)}</span></div>
          </div>
        </div>
        <div class="val-total">
          <span class="label">Valor Líquido da NFS-e</span>
          <span class="val">${formatarMoeda(nota.valor_liquido)}</span>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Outras Informações</div>
      <div class="section-body">
        <div class="fields">
          <div class="field w25"><div class="label">Competência</div><div class="val">${formatarData(nota.data_competencia)}</div></div>
          <div class="field w25"><div class="label">Data Emissão</div><div class="val">${formatarData(nota.data_emissao)}</div></div>
          <div class="field w25"><div class="label">Nº NFS-e</div><div class="val">${nfseNum}</div></div>
          <div class="field w25"><div class="label">Nº DPS</div><div class="val">${dpsNum}</div></div>
        </div>
        ${nota.observacoes ? '<div class="fields"><div class="field w100"><div class="label">Observações</div><div class="val">' + nota.observacoes + '</div></div></div>' : ''}
      </div>
    </div>

    <div class="footer">
      <p><strong>Documento Auxiliar da NFS-e - Consulte a autenticidade em www.nfse.gov.br/consultapublica</strong></p>
      <p>A validade fiscal deste documento depende da verificação junto ao portal nacional da NFS-e.</p>
      <p>Gerado em ${formatarData(new Date().toISOString())} às ${new Date().toLocaleTimeString('pt-BR')}</p>
    </div>
  </div>
</body>
</html>`;
}

// GET /api/notas-fiscais/:id/danfse - Gera HTML de uma NF-e (DANFSe)
router.get('/:id/danfse', autenticado, async (req, res) => {
  try {
    const notaId = parseInt(req.params.id);
    const nota = buscarDadosNota(notaId);

    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }

    // Verifica permissão (cliente só vê as suas notas)
    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== nota.cliente_id) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    const html = await gerarHtmlDanfse(nota);


    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    // Se ?download=1, força download do arquivo
    if (req.query.download === '1') {
      const nomeArquivo = `DANFSe_DPS_${nota.numero_dps || nota.id}.html`;
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    }

    res.send(html);
  } catch (err) {
    console.error('Erro ao gerar DANFSe:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// Cache compartilhado em danfseCacheService — permite warmup a partir de outros módulos (ex: whatsapp.js).
const danfseCacheService = require('../services/danfseCacheService');

/**
 * Gera o PDF do DANFSe pra uma NF (roda cascata ADN oficial → Puppeteer local com retry).
 * Usa e popula o cache compartilhado. Chamável tanto pelo endpoint HTTP quanto pelo
 * warmup do whatsapp.js (pre-aquecimento antes do Z-API baixar o link).
 *
 * @param {number} notaId
 * @returns {Promise<{ pdf: Buffer, fonte: 'oficial'|'local'|'oficial-cache', numDisplay: string, nomeArquivo: string } | null>}
 *   Retorna null se a nota não existir.
 */
async function obterDanfsePdf(notaId) {
  const nota = buscarDadosNota(notaId);
  if (!nota) return null;

  const numDisplay = nota.numero_nfse || nota.numero_dps || nota.id;
  const nomeArquivo = `DANFSe_NF_${numDisplay}.pdf`;

  const cache = danfseCacheService.ler(notaId);
  if (cache) {
    console.log(`[DANFSe-PDF] ⚡ Cache HIT (${cache.fonte}) NF ${numDisplay}: ${cache.pdf.length} bytes`);
    return { pdf: cache.pdf, fonte: `${cache.fonte}-cache`, numDisplay, nomeArquivo };
  }

  console.log(`[DANFSe-PDF] Gerando PDF para NF ${numDisplay} (cascata: ADN oficial → fallback local)...`);
  const html = await gerarHtmlDanfse(nota);

  let pfxBuffer = null, senha = null;
  try {
    if (nota.chave_acesso && nota.certificado_a1_senha_encrypted) {
      const certificadoService = require('../services/certificadoService');
      const cert = certificadoService.carregarCertificado(nota.cliente_id, nota.certificado_a1_senha_encrypted);
      pfxBuffer = cert.pfxBuffer;
      senha = cert.senha;
    }
  } catch (err) {
    console.warn(`[DANFSe-PDF] Não conseguiu carregar cert p/ tentar oficial: ${err.message}`);
  }

  const { pdf: pdfBuffer, fonte } = await danfsePdfService.obterDanfseCascata({
    chaveAcesso: nota.chave_acesso,
    pfxBuffer, senha,
    htmlLocal: html,
  });

  console.log(`[DANFSe-PDF] ✅ PDF entregue (${fonte}): ${pdfBuffer.length} bytes`);
  danfseCacheService.gravar(notaId, pdfBuffer, fonte);

  return { pdf: pdfBuffer, fonte, numDisplay, nomeArquivo };
}

// GET /api/notas-fiscais/:id/danfse-pdf - Gera DANFSe padrão oficial como PDF
router.get('/:id/danfse-pdf', autenticado, async (req, res) => {
  try {
    const notaId = parseInt(req.params.id);
    const nota = buscarDadosNota(notaId);

    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }
    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== nota.cliente_id) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    const resultado = await obterDanfsePdf(notaId);
    if (!resultado) return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    const { pdf: pdfBuffer, fonte, nomeArquivo } = resultado;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-DANFSe-Fonte', fonte); // 'oficial' ou 'local' — útil pra monitorar adoção
    res.setHeader('Content-Disposition',
      req.query.download === '1'
        ? `attachment; filename="${nomeArquivo}"`
        : `inline; filename="${nomeArquivo}"`
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro ao gerar DANFSe PDF:', err);
    res.status(500).json({ erro: err.message || 'Erro ao gerar PDF da DANFSe' });
  }
});

// =====================================================
// Rotas de E-mail
// =====================================================

// POST /api/notas-fiscais/:id/enviar-email - Envia NF por e-mail
router.post('/:id/enviar-email', autenticado, apenasEscritorio, async (req, res) => {
  try {
    const db = getDb();
    const notaId = parseInt(req.params.id);
    const { email_destino, mensagem_extra } = req.body;

    const nota = db.prepare('SELECT * FROM notas_fiscais WHERE id = ?').get(notaId);
    if (!nota) return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    if (nota.status !== 'emitida') return res.status(400).json({ erro: 'Apenas NFs emitidas podem ser enviadas por e-mail' });

    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(nota.cliente_id);
    const tomador = nota.tomador_id
      ? db.prepare('SELECT * FROM tomadores WHERE id = ?').get(nota.tomador_id)
      : { razao_social: 'Não informado', email: email_destino };

    const emailService = require('../services/emailService');
    if (!emailService.isConfigured()) {
      return res.status(400).json({ erro: 'Serviço de e-mail não configurado. Configure EMAIL_USER e EMAIL_PASS nas variáveis de ambiente.' });
    }

    const para = email_destino || tomador.email;
    if (!para) {
      return res.status(400).json({ erro: 'Nenhum e-mail de destino fornecido e tomador não tem e-mail cadastrado.' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    // Usa /danfse-pdf (cascata ADN oficial → Puppeteer fallback) em vez de HTML
    const linkDanfse = `${baseUrl}/api/notas-fiscais/${notaId}/danfse-pdf`;

    await emailService.enviarNFManual({
      para,
      nota,
      cliente,
      tomador,
      linkDanfse,
      mensagemExtra: mensagem_extra,
    });

    // Registra no log
    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id, nota_fiscal_id)
      VALUES ('email_nf', ?, 'escritorio', ?, ?, ?)
    `).run(
      `E-mail da NF #${nota.numero_dps} enviado para ${para}`,
      req.usuario.id,
      nota.cliente_id,
      notaId
    );

    res.json({ mensagem: `E-mail enviado com sucesso para ${para}` });
  } catch (err) {
    console.error('Erro ao enviar e-mail:', err);
    res.status(500).json({ erro: 'Erro ao enviar e-mail', detalhes: err.message });
  }
});

// GET /api/notas-fiscais/email/status - Verifica se e-mail está configurado
router.get('/email/status', autenticado, (req, res) => {
  try {
    const emailService = require('../services/emailService');
    res.json({ configurado: emailService.isConfigured() });
  } catch {
    res.json({ configurado: false });
  }
});

// =====================================================
// Rotas de Relatórios
// =====================================================

// GET /api/notas-fiscais/relatorios/faturamento - Relatório de faturamento por período
router.get('/relatorios/faturamento', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const { periodo_inicio, periodo_fim, cliente_id, agrupamento } = req.query;

    // Default: últimos 12 meses
    const hoje = new Date();
    const inicio = periodo_inicio || new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1).toISOString().slice(0, 10);
    const fim = periodo_fim || hoje.toISOString().slice(0, 10);

    let query, params;

    if (agrupamento === 'cliente') {
      query = `
        SELECT c.id as cliente_id, c.razao_social, c.nome_fantasia, c.cnpj,
               COUNT(*) as total_nfs,
               SUM(nf.valor_servico) as faturamento,
               SUM(nf.valor_iss) as total_iss,
               AVG(nf.valor_servico) as ticket_medio
        FROM notas_fiscais nf
        JOIN clientes c ON c.id = nf.cliente_id
        WHERE nf.status = 'emitida'
          AND nf.data_competencia >= ? AND nf.data_competencia <= ?
          ${cliente_id ? 'AND nf.cliente_id = ?' : ''}
        GROUP BY c.id
        ORDER BY faturamento DESC
      `;
      params = cliente_id ? [inicio, fim, parseInt(cliente_id)] : [inicio, fim];
    } else {
      // Agrupamento por mês (padrão)
      query = `
        SELECT strftime('%Y-%m', nf.data_competencia) as mes,
               COUNT(*) as total_nfs,
               SUM(nf.valor_servico) as faturamento,
               SUM(nf.valor_iss) as total_iss,
               COUNT(DISTINCT nf.cliente_id) as clientes_ativos
        FROM notas_fiscais nf
        WHERE nf.status = 'emitida'
          AND nf.data_competencia >= ? AND nf.data_competencia <= ?
          ${cliente_id ? 'AND nf.cliente_id = ?' : ''}
        GROUP BY mes
        ORDER BY mes ASC
      `;
      params = cliente_id ? [inicio, fim, parseInt(cliente_id)] : [inicio, fim];
    }

    const dados = db.prepare(query).all(...params);

    // Totais gerais
    const totais = db.prepare(`
      SELECT COUNT(*) as total_nfs,
             COALESCE(SUM(valor_servico), 0) as faturamento_total,
             COALESCE(SUM(valor_iss), 0) as iss_total,
             COUNT(DISTINCT cliente_id) as clientes_ativos,
             COALESCE(AVG(valor_servico), 0) as ticket_medio
      FROM notas_fiscais
      WHERE status = 'emitida'
        AND data_competencia >= ? AND data_competencia <= ?
        ${cliente_id ? 'AND cliente_id = ?' : ''}
    `).get(...params);

    res.json({ dados, totais, periodo: { inicio, fim } });
  } catch (err) {
    console.error('Erro no relatório de faturamento:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/notas-fiscais/relatorios/status - Relatório por status
router.get('/relatorios/status', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const { periodo_inicio, periodo_fim } = req.query;

    const hoje = new Date();
    const inicio = periodo_inicio || new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1).toISOString().slice(0, 10);
    const fim = periodo_fim || hoje.toISOString().slice(0, 10);

    const porStatus = db.prepare(`
      SELECT status, COUNT(*) as total, COALESCE(SUM(valor_servico), 0) as valor
      FROM notas_fiscais
      WHERE data_competencia >= ? AND data_competencia <= ?
      GROUP BY status
    `).all(inicio, fim);

    const porMesStatus = db.prepare(`
      SELECT strftime('%Y-%m', data_competencia) as mes, status, COUNT(*) as total
      FROM notas_fiscais
      WHERE data_competencia >= ? AND data_competencia <= ?
      GROUP BY mes, status
      ORDER BY mes ASC
    `).all(inicio, fim);

    res.json({ por_status: porStatus, por_mes_status: porMesStatus, periodo: { inicio, fim } });
  } catch (err) {
    console.error('Erro no relatório de status:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/notas-fiscais/relatorios/ranking-tomadores - Ranking de tomadores
router.get('/relatorios/ranking-tomadores', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const { periodo_inicio, periodo_fim, cliente_id, limit: limite } = req.query;

    const hoje = new Date();
    const inicio = periodo_inicio || new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1).toISOString().slice(0, 10);
    const fim = periodo_fim || hoje.toISOString().slice(0, 10);
    const top = parseInt(limite) || 20;

    const ranking = db.prepare(`
      SELECT t.id, t.razao_social, t.documento, t.tipo_documento,
             c.razao_social as cliente_razao_social,
             COUNT(*) as total_nfs,
             SUM(nf.valor_servico) as faturamento,
             MAX(nf.data_competencia) as ultima_nf
      FROM notas_fiscais nf
      JOIN tomadores t ON t.id = nf.tomador_id
      JOIN clientes c ON c.id = nf.cliente_id
      WHERE nf.status = 'emitida'
        AND nf.data_competencia >= ? AND nf.data_competencia <= ?
        ${cliente_id ? 'AND nf.cliente_id = ?' : ''}
      GROUP BY t.id
      ORDER BY faturamento DESC
      LIMIT ?
    `).all(...(cliente_id ? [inicio, fim, parseInt(cliente_id), top] : [inicio, fim, top]));

    res.json({ ranking, periodo: { inicio, fim } });
  } catch (err) {
    console.error('Erro no ranking de tomadores:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

module.exports = router;
// Exporta helpers usados por outros módulos (ex: warmup do whatsapp.js).
module.exports.obterDanfsePdf = obterDanfsePdf;
