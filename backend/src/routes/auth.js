const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/init');
const { gerarToken } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login/escritorio - Login do escritório
router.post('/login/escritorio', (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ erro: 'Email e senha são obrigatórios' });
    }

    const db = getDb();
    const usuario = db.prepare('SELECT * FROM usuarios_escritorio WHERE email = ? AND ativo = 1').get(email);

    if (!usuario || !bcrypt.compareSync(senha, usuario.senha_hash)) {
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    }

    const token = gerarToken({
      tipo: 'escritorio',
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel
    });

    // Log
    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, usuario_id)
      VALUES ('login', ?, 'escritorio', ?)
    `).run(`Login do usuário ${usuario.nome}`, usuario.id);

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        papel: usuario.papel,
        tipo: 'escritorio'
      }
    });
  } catch (err) {
    console.error('Erro no login escritório:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

module.exports = router;
