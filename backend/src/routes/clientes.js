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
      'modo_emissao', 'ativo'
    ];

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

module.exports = router;
