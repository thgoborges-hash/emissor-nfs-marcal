const express = require('express');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio } = require('../middleware/auth');
const nfseNacionalService = require('../services/nfseNacionalService');
const danfsePdfService = require('../services/danfsePdfService');

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
    const linkDanfse = `${baseUrl}/api/notas-fiscais/${notaId}/danfse`;

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

function gerarHtmlDanfse(nota) {
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

    return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DANFSe - DPS ${nota.numero_dps}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Arial', sans-serif; background: #f5f5f5; padding: 20px; }
    .print-hide { display: block; margin-bottom: 20px; text-align: center; gap: 10px; }
    .print-hide button { padding: 10px 20px; margin: 0 5px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; font-weight: 600; }
    .print-hide .btn-primary { background: #3498db; color: white; }
    .print-hide .btn-primary:hover { background: #2980b9; }
    .danfse-container { max-width: 900px; margin: 0 auto; background: white; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .warning-banner { background: #fff3cd; border: 2px solid #ffc107; color: #856404; padding: 12px 16px; text-align: center; font-weight: bold; font-size: 14px; }
    .header { background: linear-gradient(135deg, #1a2332 0%, #2c3e50 100%); color: white; padding: 24px; display: flex; align-items: center; gap: 20px; }
    .header-info { flex: 1; }
    .header-info h1 { font-size: 28px; margin-bottom: 4px; font-weight: bold; }
    .header-info p { font-size: 13px; opacity: 0.9; margin: 2px 0; }
    .header-badge { background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.5); padding: 12px 16px; border-radius: 4px; text-align: center; min-width: 140px; }
    .header-badge .label { font-size: 11px; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.5px; }
    .header-badge .value { font-size: 20px; font-weight: bold; margin-top: 4px; }
    .section { border: 1px solid #e0e0e0; margin: 20px; border-radius: 4px; overflow: hidden; }
    .section-title { background: #2c3e50; color: white; padding: 12px 16px; font-weight: bold; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
    .section-content { padding: 16px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 12px; }
    .info-grid.full { grid-template-columns: 1fr; }
    .info-item { display: flex; flex-direction: column; }
    .info-item label { font-size: 11px; color: #666; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
    .info-item .value { font-size: 14px; color: #333; word-break: break-word; }
    .table-section { padding: 0; }
    .table-section table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .table-section th { background: #3498db; color: white; padding: 12px; text-align: left; font-weight: bold; font-size: 12px; }
    .table-section td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
    .table-section tr:last-child td { border-bottom: none; }
    .table-section tr:nth-child(even) { background: #f9f9f9; }
    .valores-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .valor-item { display: flex; justify-content: space-between; padding: 8px 0; font-size: 13px; border-bottom: 1px solid #f0f0f0; }
    .valor-item label { color: #666; font-weight: 500; }
    .valor-item .value { color: #333; font-weight: bold; }
    .valor-item.total { border: 2px solid #27ae60; border-radius: 4px; padding: 10px; margin-top: 8px; background: #f0fdf4; }
    .valor-item.total label { color: #27ae60; font-weight: bold; text-transform: uppercase; }
    .valor-item.total .value { color: #27ae60; font-size: 16px; }
    .footer { text-align: center; padding: 20px; border-top: 1px solid #e0e0e0; color: #999; font-size: 12px; }
    .footer p { margin: 4px 0; }
    @media print {
      body { background: white; padding: 0; }
      .print-hide { display: none !important; }
      .danfse-container { box-shadow: none; max-width: 100%; margin: 0; }
      .section { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="print-hide">
    <button class="btn-primary" onclick="window.print()">Imprimir / Salvar PDF</button>
  </div>

  <div class="danfse-container">
    ${isSimulacao ? '<div class="warning-banner">DOCUMENTO DE SIMULA\u00c7\u00c3O - N\u00c3O POSSUI VALIDADE FISCAL</div>' : ''}

    <div class="header">
      <div class="header-info">
        <h1>DANFSe</h1>
        <p>Documento Auxiliar da Nota Fiscal de Servi\u00e7o Eletr\u00f4nica</p>
        <p style="margin-top: 8px; font-size: 12px;">DPS n\u00ba <strong>${nota.numero_dps}</strong></p>
      </div>
      <div class="header-badge">
        <div class="label">Situa\u00e7\u00e3o</div>
        <div class="value" style="color: ${nota.status === 'emitida' ? '#27ae60' : '#f39c12'}">${
          nota.status === 'emitida' ? 'EMITIDA' : nota.status.toUpperCase()
        }</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Prestador (Emissor)</div>
      <div class="section-content">
        <div class="info-grid">
          <div class="info-item"><label>Raz\u00e3o Social</label><div class="value">${nota.cliente_razao_social || '-'}</div></div>
          <div class="info-item"><label>Nome Fantasia</label><div class="value">${nota.cliente_nome_fantasia || '-'}</div></div>
          <div class="info-item"><label>CNPJ</label><div class="value">${formatarCNPJ(nota.cliente_cnpj)}</div></div>
          <div class="info-item"><label>Contato</label><div class="value">${nota.cliente_telefone || '-'} | ${nota.cliente_email || '-'}</div></div>
        </div>
        <div class="info-grid full">
          <div class="info-item"><label>Localiza\u00e7\u00e3o</label><div class="value">${nota.cliente_municipio || '-'}, ${nota.cliente_uf || '-'}</div></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Tomador (Cliente)</div>
      <div class="section-content">
        ${nota.tomador_razao_social ? `
          <div class="info-grid">
            <div class="info-item"><label>Raz\u00e3o Social</label><div class="value">${nota.tomador_razao_social || '-'}</div></div>
            <div class="info-item"><label>Nome Fantasia</label><div class="value">${nota.tomador_nome_fantasia || '-'}</div></div>
            <div class="info-item"><label>${nota.tipo_documento === 'CNPJ' ? 'CNPJ' : 'CPF'}</label><div class="value">${nota.tipo_documento === 'CNPJ' ? formatarCNPJ(nota.tomador_documento) : formatarCPF(nota.tomador_documento)}</div></div>
            <div class="info-item"><label>Contato</label><div class="value">${nota.tomador_telefone || '-'} | ${nota.tomador_email || '-'}</div></div>
            <div class="info-item full"><label>Endere\u00e7o</label><div class="value">${nota.tomador_endereco || '-'}, ${nota.tomador_numero || '-'} - ${nota.tomador_bairro || '-'}, ${nota.tomador_cep || '-'}</div></div>
            <div class="info-item"><label>Localiza\u00e7\u00e3o</label><div class="value">${nota.tomador_municipio || '-'}, ${nota.tomador_uf || '-'}</div></div>
          </div>
        ` : '<p style="color: #999; font-style: italic;">Tomador n\u00e3o cadastrado</p>'}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Servi\u00e7o Prestado</div>
      <div class="section-content">
        <div class="table-section">
          <table>
            <thead><tr><th style="width: 60px;">C\u00f3digo</th><th style="flex: 1;">Descri\u00e7\u00e3o</th><th style="width: 120px; text-align: right;">Valor</th></tr></thead>
            <tbody><tr><td>${nota.codigo_servico || '-'}</td><td>${nota.descricao_servico || '-'}</td><td style="text-align: right;">${formatarMoeda(nota.valor_servico)}</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Valores</div>
      <div class="section-content">
        <div class="valores-grid">
          <div>
            <div class="valor-item"><label>Valor do Servi\u00e7o</label><div class="value">${formatarMoeda(nota.valor_servico)}</div></div>
            <div class="valor-item"><label>Dedu\u00e7\u00f5es / Descontos</label><div class="value">${formatarMoeda(nota.valor_deducoes)}</div></div>
            <div class="valor-item"><label>Base de C\u00e1lculo</label><div class="value">${formatarMoeda(nota.base_calculo)}</div></div>
            <div class="valor-item"><label>Al\u00edquota ISS</label><div class="value">${(parseFloat(nota.aliquota_iss) * 100).toFixed(2)}%</div></div>
            <div class="valor-item"><label>ISS ${nota.iss_retido ? '(Retido)' : ''}</label><div class="value">${formatarMoeda(nota.valor_iss)}</div></div>
          </div>
          <div>
            <div class="valor-item"><label>PIS</label><div class="value">${formatarMoeda(nota.valor_pis)}</div></div>
            <div class="valor-item"><label>COFINS</label><div class="value">${formatarMoeda(nota.valor_cofins)}</div></div>
            <div class="valor-item"><label>INSS</label><div class="value">${formatarMoeda(nota.valor_inss)}</div></div>
            <div class="valor-item"><label>IR</label><div class="value">${formatarMoeda(nota.valor_ir)}</div></div>
            <div class="valor-item"><label>CSLL</label><div class="value">${formatarMoeda(nota.valor_csll)}</div></div>
            <div class="valor-item total"><label>Valor L\u00edquido</label><div class="value">${formatarMoeda(nota.valor_liquido)}</div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Informa\u00e7\u00f5es Complementares</div>
      <div class="section-content">
        <div class="info-grid">
          <div class="info-item"><label>Data de Compet\u00eancia</label><div class="value">${formatarData(nota.data_competencia)}</div></div>
          <div class="info-item"><label>Data de Emiss\u00e3o</label><div class="value">${formatarData(nota.data_emissao)}</div></div>
          <div class="info-item"><label>NFS-e</label><div class="value">${nota.numero_nfse || 'N\u00e3o emitida'}</div></div>
          <div class="info-item"><label>Chave de Acesso</label><div class="value" style="word-break: break-all; font-family: monospace; font-size: 11px;">${nota.chave_acesso || 'N\u00e3o dispon\u00edvel'}</div></div>
        </div>
        ${nota.observacoes ? `
          <div class="info-grid full">
            <div class="info-item"><label>Observa\u00e7\u00f5es</label><div class="value">${nota.observacoes}</div></div>
          </div>
        ` : ''}
      </div>
    </div>

    <div class="footer">
      <p><strong>Este \u00e9 um documento auxiliar da Nota Fiscal de Servi\u00e7o Eletr\u00f4nica</strong></p>
      <p>Gerado em ${formatarData(new Date().toISOString())} \u00e0s ${new Date().toLocaleTimeString('pt-BR')}</p>
      <p>Sistema de Emiss\u00e3o de NFS-e</p>
    </div>
  </div>
</body>
</html>`;
}

// GET /api/notas-fiscais/:id/danfse - Gera HTML de uma NF-e (DANFSe)
router.get('/:id/danfse', autenticado, (req, res) => {
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

    const html = gerarHtmlDanfse(nota);


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

// GET /api/notas-fiscais/:id/danfse-pdf - Captura DANFSe oficial da SEFIN como PDF
router.get('/:id/danfse-pdf', autenticado, async (req, res) => {
  try {
    const notaId = parseInt(req.params.id);
    const nota = buscarDadosNota(notaId);

    if (!nota) {
      return res.status(404).json({ erro: 'Nota fiscal não encontrada' });
    }

    // Verifica permissão
    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== nota.cliente_id) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    if (!nota.chave_acesso) {
      return res.status(400).json({ erro: 'NF não possui chave de acesso (ainda não foi emitida na SEFIN)' });
    }

    const numDisplay = nota.numero_nfse || nota.numero_dps || nota.id;
    let pdfBuffer;

    try {
      // Tenta capturar o DANFSe oficial do portal SEFIN
      console.log(`[DANFSe-PDF] Capturando DANFSe oficial para NF ${numDisplay} (chave: ${nota.chave_acesso})...`);
      pdfBuffer = await danfsePdfService.gerarPdfOficial(nota.chave_acesso);
    } catch (oficialErr) {
      // Fallback: gera PDF a partir do nosso HTML
      console.warn(`[DANFSe-PDF] Portal SEFIN indisponível, usando fallback HTML: ${oficialErr.message}`);
      const html = gerarHtmlDanfse(nota);
      pdfBuffer = await danfsePdfService.gerarPdfHtml(html);
    }

    console.log(`[DANFSe-PDF] PDF pronto: ${pdfBuffer.length} bytes`);

    const nomeArquivo = `DANFSe_NF_${numDisplay}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}"`);
    }
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
    const linkDanfse = `${baseUrl}/api/notas-fiscais/${notaId}/danfse`;

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
