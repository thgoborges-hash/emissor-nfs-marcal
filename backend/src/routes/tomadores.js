const express = require('express');
const { getDb } = require('../database/init');
const { autenticado, apenasEscritorio } = require('../middleware/auth');

const router = express.Router();

// GET /api/clientes/:clienteId/tomadores - Lista tomadores de um cliente
router.get('/clientes/:clienteId/tomadores', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const clienteId = parseInt(req.params.clienteId);

    const tomadores = db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM notas_fiscais WHERE tomador_id = t.id) as total_nfs
      FROM tomadores t
      WHERE t.cliente_id = ? AND t.ativo = 1
      ORDER BY t.favorito DESC, t.razao_social ASC
    `).all(clienteId);

    res.json(tomadores);
  } catch (err) {
    console.error('Erro ao listar tomadores:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// GET /api/tomadores/:id - Detalhe de um tomador
router.get('/tomadores/:id', autenticado, (req, res) => {
  try {
    const db = getDb();
    const tomador = db.prepare('SELECT * FROM tomadores WHERE id = ? AND ativo = 1').get(parseInt(req.params.id));

    if (!tomador) {
      return res.status(404).json({ erro: 'Tomador não encontrado' });
    }

    // Verifica acesso
    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== tomador.cliente_id) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    res.json(tomador);
  } catch (err) {
    console.error('Erro ao buscar tomador:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// POST /api/clientes/:clienteId/tomadores - Cadastra novo tomador
router.post('/clientes/:clienteId/tomadores', autenticado, apenasEscritorio, (req, res) => {
  try {
    const db = getDb();
    const clienteId = parseInt(req.params.clienteId);
    const {
      tipo_documento, documento, razao_social, nome_fantasia,
      inscricao_municipal, logradouro, numero, complemento, bairro,
      codigo_municipio, municipio, uf, cep, email, telefone, favorito
    } = req.body;

    if (!documento || !razao_social) {
      return res.status(400).json({ erro: 'Documento e razão social são obrigatórios' });
    }

    // Verifica duplicidade
    const existente = db.prepare(
      'SELECT id FROM tomadores WHERE cliente_id = ? AND documento = ? AND ativo = 1'
    ).get(clienteId, documento);

    if (existente) {
      return res.status(409).json({ erro: 'Tomador com este documento já está cadastrado' });
    }

    const result = db.prepare(`
      INSERT INTO tomadores (
        cliente_id, tipo_documento, documento, razao_social, nome_fantasia,
        inscricao_municipal, logradouro, numero, complemento, bairro,
        codigo_municipio, municipio, uf, cep, email, telefone, favorito
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clienteId, tipo_documento || 'CNPJ', documento, razao_social, nome_fantasia,
      inscricao_municipal, logradouro, numero, complemento, bairro,
      codigo_municipio, municipio, uf, cep, email, telefone, favorito || 0
    );

    res.status(201).json({
      id: result.lastInsertRowid,
      mensagem: 'Tomador cadastrado com sucesso'
    });
  } catch (err) {
    console.error('Erro ao cadastrar tomador:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// PUT /api/tomadores/:id - Atualiza tomador
router.put('/tomadores/:id', autenticado, (req, res) => {
  try {
    const db = getDb();
    const tomadorId = parseInt(req.params.id);

    const tomador = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomadorId);
    if (!tomador) {
      return res.status(404).json({ erro: 'Tomador não encontrado' });
    }

    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== tomador.cliente_id) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    const campos = req.body;
    const permitidos = [
      'razao_social', 'nome_fantasia', 'inscricao_municipal',
      'logradouro', 'numero', 'complemento', 'bairro',
      'codigo_municipio', 'municipio', 'uf', 'cep',
      'email', 'telefone', 'favorito'
    ];

    const updates = [];
    const values = [];

    for (const campo of permitidos) {
      if (campos[campo] !== undefined) {
        updates.push(`${campo} = ?`);
        values.push(campos[campo]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(tomadorId);

    db.prepare(`UPDATE tomadores SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json({ mensagem: 'Tomador atualizado com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar tomador:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// DELETE /api/tomadores/:id - Desativa tomador (soft delete)
router.delete('/tomadores/:id', autenticado, (req, res) => {
  try {
    const db = getDb();
    const tomadorId = parseInt(req.params.id);

    const tomador = db.prepare('SELECT * FROM tomadores WHERE id = ?').get(tomadorId);
    if (!tomador) {
      return res.status(404).json({ erro: 'Tomador não encontrado' });
    }

    if (req.usuario.tipo === 'cliente' && req.usuario.clienteId !== tomador.cliente_id) {
      return res.status(403).json({ erro: 'Acesso não autorizado' });
    }

    db.prepare('UPDATE tomadores SET ativo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tomadorId);

    res.json({ mensagem: 'Tomador removido com sucesso' });
  } catch (err) {
    console.error('Erro ao remover tomador:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

module.exports = router;
