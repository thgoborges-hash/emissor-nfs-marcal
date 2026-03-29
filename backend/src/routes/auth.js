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

// POST /api/auth/login/cliente - Login do cliente
router.post('/login/cliente', (req, res) => {
  try {
    const { cnpj, senha } = req.body;
    if (!cnpj || !senha) {
      return res.status(400).json({ erro: 'CNPJ e senha são obrigatórios' });
    }

    const db = getDb();
    const cliente = db.prepare('SELECT * FROM clientes WHERE cnpj = ? AND ativo = 1').get(cnpj);

    if (!cliente || !cliente.senha_hash || !bcrypt.compareSync(senha, cliente.senha_hash)) {
      return res.status(401).json({ erro: 'CNPJ ou senha incorretos' });
    }

    const token = gerarToken({
      tipo: 'cliente',
      clienteId: cliente.id,
      cnpj: cliente.cnpj,
      razaoSocial: cliente.razao_social,
      modoEmissao: cliente.modo_emissao
    });

    // Log
    db.prepare(`
      INSERT INTO log_atividades (tipo, descricao, usuario_tipo, cliente_id)
      VALUES ('login', ?, 'cliente', ?)
    `).run(`Login do cliente ${cliente.razao_social}`, cliente.id);

    res.json({
      token,
      cliente: {
        id: cliente.id,
        razaoSocial: cliente.razao_social,
        nomeFantasia: cliente.nome_fantasia,
        cnpj: cliente.cnpj,
        modoEmissao: cliente.modo_emissao,
        codigoServico: cliente.codigo_servico,
        descricaoServicoPadrao: cliente.descricao_servico_padrao,
        aliquotaIss: cliente.aliquota_iss,
        tipo: 'cliente'
      }
    });
  } catch (err) {
    console.error('Erro no login cliente:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

module.exports = router;
