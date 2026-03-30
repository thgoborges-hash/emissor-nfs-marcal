const express = require('express');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio, clienteOuEscritorio } = require('../middleware/auth');
const nfseNacionalService = require('../services/nfseNacionalService');

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
             nf.criado_por, nf.origem, nf.created_at,
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
    if (nota.status !== 'aprovada') {
      return res.status(400).json({ erro: `Nota precisa estar aprovada para ser emitida (status atual: ${nota.status})` });
    }

    // Busca dados do cliente e tomador
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(nota.cliente_id);
    const tomador = nota.tomador_id
      ? db.prepare('SELECT * FROM tomadores WHERE id = ?').get(nota.tomador_id)
      : null;

    if (!tomador) {
      return res.status(400).json({ erro: 'Tomador é obrigatório para emissão' });
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

    res.json({
      mensagem: `Nota fiscal emitida com sucesso${modoSimulacao ? ' (modo simulação)' : ''}`,
      numero_nfse: numeroNfse,
      chave_acesso: chaveAcesso,
      simulacao: modoSimulacao,
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

module.exports = router;
