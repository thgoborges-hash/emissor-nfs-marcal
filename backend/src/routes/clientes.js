const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio, apenasAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/clientes - Lista todos os clientes (escritório)
router.get('/', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const clientes = db.prepare(`
      SELECT id, razao_social, nome_fantasia, cnpj, email, telefone,
             modo_emissao, ativo, codigo_servico, aliquota_iss,
             regime_tributario,
             certificado_validade, municipio, uf,
             (SELECT COUNT(*) FROM notas_fiscais WHERE cliente_id = clientes.id) as total_nfs,
             (SELECT COUNT(*) FROM notas_fiscais WHERE cliente_id = clientes.id AND status = 'pendente_aprovacao') as nfs_pendentes
      FROM clientes
      ORDER BY razao_social
    `).all();

    res.json(clientes);
  } catch (err) {
    console.error('Erro ao listar clientes:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/clientes/_resumo-regimes - Conta clientes por regime tributário
// (usado no Dashboard de Apuração pra equipe ver distribuição)
router.get('/_resumo-regimes', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const linhas = db.prepare(`
      SELECT COALESCE(regime_tributario, 'nao_classificado') as regime,
             COUNT(*) as total,
             SUM(CASE WHEN ativo = 1 THEN 1 ELSE 0 END) as ativos
      FROM clientes
      GROUP BY regime
      ORDER BY total DESC
    `).all();
    res.json({ regimes: linhas });
  } catch (err) {
    console.error('Erro no resumo de regimes:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// PUT /api/clientes/_regime-bulk - Atualiza regime_tributario em lote
// Body: { atualizacoes: [{ id, regime_tributario }, ...] }
// regime_tributario aceita: 'simples' | 'presumido' | 'real' | 'mei' | null
router.put('/_regime-bulk', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const { atualizacoes } = req.body || {};
    if (!Array.isArray(atualizacoes) || atualizacoes.length === 0) {
      return res.status(400).json({ erro: 'campo "atualizacoes" deve ser array não-vazio' });
    }
    const REGIMES_VALIDOS = new Set(['simples', 'presumido', 'real', 'mei']);
    const stmt = db.prepare(`
      UPDATE clientes SET regime_tributario = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    const tx = db.transaction((items) => {
      let aplicadas = 0;
      const erros = [];
      for (const item of items) {
        const id = parseInt(item.id);
        const regime = item.regime_tributario;
        if (!id) { erros.push({ id: item.id, erro: 'id inválido' }); continue; }
        if (regime !== null && !REGIMES_VALIDOS.has(regime)) {
          erros.push({ id, erro: `regime "${regime}" inválido (use: ${[...REGIMES_VALIDOS].join(', ')} ou null)` });
          continue;
        }
        const r = stmt.run(regime, id);
        if (r.changes > 0) aplicadas++;
        else erros.push({ id, erro: 'cliente não encontrado' });
      }
      return { aplicadas, erros };
    });
    const resultado = tx(atualizacoes);
    res.json(resultado);
  } catch (err) {
    console.error('Erro no bulk update de regime:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/clientes/:id - Detalhe de um cliente
router.get('/:id', autenticado, (req, res) => {
  try {
    const db = getDb();
    const clienteId = parseInt(req.params.id);

    // Cliente só pode ver seus próprios dados
    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== clienteId) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    const cliente = db.prepare(`
      SELECT id, razao_social, nome_fantasia, cnpj, inscricao_municipal,
             logradouro, numero, complemento, bairro, codigo_municipio,
             municipio, uf, cep, email, telefone,
             codigo_servico, descricao_servico_padrao, aliquota_iss,
             regime_especial, optante_simples, incentivo_fiscal,
             regime_tributario,
             modo_emissao, certificado_validade, ativo
      FROM clientes WHERE id = ?
    `).get(clienteId);

    if (!cliente) {
      return res.status(404).json({ erro: 'Cliente não encontrado' });
    }

    res.json(cliente);
  } catch (err) {
    console.error('Erro ao buscar cliente:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// POST /api/clientes - Cadastra novo cliente (escritório)
router.post('/', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const {
      razao_social, nome_fantasia, cnpj, inscricao_municipal,
      logradouro, numero, complemento, bairro, codigo_municipio,
      municipio, uf, cep, email, telefone,
      codigo_servico, descricao_servico_padrao, aliquota_iss,
      regime_especial, optante_simples, incentivo_fiscal,
      modo_emissao, senha
    } = req.body;

    if (!razao_social || !cnpj || !email) {
      return res.status(400).json({ erro: 'Razão social, CNPJ e email são obrigatórios' });
    }

    // Verifica se CNPJ já existe
    const existente = db.prepare('SELECT id FROM clientes WHERE cnpj = ?').get(cnpj);
    if (existente) {
      return res.status(409).json({ erro: 'CNPJ já cadastrado' });
    }

    const senhaHash = senha ? bcrypt.hashSync(senha, 10) : null;

    const result = db.prepare(`
      INSERT INTO clientes (
        razao_social, nome_fantasia, cnpj, inscricao_municipal,
        logradouro, numero, complemento, bairro, codigo_municipio,
        municipio, uf, cep, email, telefone,
        codigo_servico, descricao_servico_padrao, aliquota_iss,
        regime_especial, optante_simples, incentivo_fiscal,
        modo_emissao, senha_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      razao_social, nome_fantasia, cnpj, inscricao_municipal,
      logradouro, numero, complemento, bairro, codigo_municipio,
      municipio, uf, cep, email, telefone,
      codigo_servico, descricao_servico_padrao, aliquota_iss || 0,
      regime_especial, optante_simples || 0, incentivo_fiscal || 0,
      modo_emissao || 'aprovacao', senhaHash
    );

    // Log
    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id, cliente_id)
      VALUES ('cliente_criado', ?, 'escritorio', ?, ?)
    `).run(`Cliente ${razao_social} cadastrado`, req.usuario.id, result.lastInsertRowid);

    res.status(201).json({ id: result.lastInsertRowid, mensagem: 'Cliente cadastrado com sucesso' });
  } catch (err) {
    console.error('Erro ao cadastrar cliente:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// PUT /api/clientes/:id - Atualiza cliente (escritório)
router.put('/:id', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const clienteId = parseInt(req.params.id);
    const campos = req.body;

    // Campos permitidos para atualização
    const permitidos = [
      'razao_social', 'nome_fantasia', 'inscricao_municipal',
      'logradouro', 'numero', 'complemento', 'bairro', 'codigo_municipio',
      'municipio', 'uf', 'cep', 'email', 'telefone',
      'codigo_servico', 'descricao_servico_padrao', 'aliquota_iss',
      'regime_especial', 'optante_simples', 'incentivo_fiscal',
      'regime_tributario',
      'modo_emissao', 'ativo'
    ];

    // Validação do regime_tributario
    if (campos.regime_tributario !== undefined && campos.regime_tributario !== null) {
      const REGIMES = ['simples', 'presumido', 'real', 'mei'];
      if (!REGIMES.includes(campos.regime_tributario)) {
        return res.status(400).json({ erro: `regime_tributario inválido. Use: ${REGIMES.join(', ')} ou null` });
      }
    }

    const updates = [];
    const values = [];

    for (const campo of permitidos) {
      if (campos[campo] !== undefined) {
        updates.push(`${campo} = ?`);
        values.push(campos[campo]);
      }
    }

    if (campos.senha) {
      updates.push('senha_hash = ?');
      values.push(bcrypt.hashSync(campos.senha, 10));
    }

    if (updates.length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(clienteId);

    db.prepare(`UPDATE clientes SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json({ mensagem: 'Cliente atualizado com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar cliente:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// POST /api/clientes/importar - Importação em massa de clientes (escritório/admin)
router.post('/importar', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const { clientes, senha_padrao } = req.body;

    if (!clientes || !Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ erro: 'Lista de clientes é obrigatória' });
    }

    const senhaHash = senha_padrao ? bcrypt.hashSync(senha_padrao, 10) : null;

    const insertStmt = db.prepare(`
      INSERT INTO clientes (
        razao_social, nome_fantasia, cnpj, inscricao_municipal,
        logradouro, numero, complemento, bairro, codigo_municipio,
        municipio, uf, cep, email, telefone,
        modo_emissao, senha_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const checkStmt = db.prepare('SELECT id FROM clientes WHERE cnpj = ?');

    const resultados = {
      importados: 0,
      duplicados: 0,
      erros: 0,
      detalhes: []
    };

    const importar = db.transaction(() => {
      for (const c of clientes) {
        try {
          if (!c.razao_social || !c.documento) {
            resultados.erros++;
            resultados.detalhes.push({
              documento: c.documento || '?',
              razao_social: c.razao_social || '?',
              status: 'erro',
              motivo: 'Razão social e documento são obrigatórios'
            });
            continue;
          }

          // Limpa documento (remove pontos, barras, traços)
          const docLimpo = c.documento.replace(/[.\-\/]/g, '');
          // Formata CNPJ: XX.XXX.XXX/XXXX-XX ou CPF: XXX.XXX.XXX-XX
          let docFormatado;
          if (docLimpo.length === 14) {
            docFormatado = docLimpo.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
          } else if (docLimpo.length === 11) {
            docFormatado = docLimpo.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
          } else {
            docFormatado = c.documento;
          }

          // Verifica duplicidade
          const existente = checkStmt.get(docFormatado);
          if (existente) {
            resultados.duplicados++;
            resultados.detalhes.push({
              documento: docFormatado,
              razao_social: c.razao_social,
              status: 'duplicado',
              motivo: 'CNPJ/CPF já cadastrado'
            });
            continue;
          }

          // Email placeholder quando não informado (campo NOT NULL no banco)
          const email = c.email || `${docLimpo}@pendente.com`;

          insertStmt.run(
            c.razao_social,
            c.nome_fantasia || null,
            docFormatado,
            c.inscricao_municipal || null,
            c.logradouro || null,
            c.numero || null,
            c.complemento || null,
            c.bairro || null,
            c.codigo_municipio || null,
            c.municipio || null,
            c.uf || null,
            c.cep || null,
            email,
            c.telefone || null,
            c.modo_emissao || 'aprovacao',
            senhaHash
          );

          resultados.importados++;
          resultados.detalhes.push({
            documento: docFormatado,
            razao_social: c.razao_social,
            status: 'importado'
          });
        } catch (err) {
          resultados.erros++;
          resultados.detalhes.push({
            documento: c.documento || '?',
            razao_social: c.razao_social || '?',
            status: 'erro',
            motivo: err.message
          });
        }
      }
    });

    importar();

    // Log da importação
    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id)
      VALUES ('importacao_clientes', ?, 'escritorio', ?)
    `).run(
      `Importação em massa: ${resultados.importados} importados, ${resultados.duplicados} duplicados, ${resultados.erros} erros`,
      req.usuario.id
    );

    res.json({
      mensagem: `Importação concluída: ${resultados.importados} importados, ${resultados.duplicados} duplicados, ${resultados.erros} erros`,
      ...resultados
    });
  } catch (err) {
    console.error('Erro na importação em massa:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

module.exports = router;
