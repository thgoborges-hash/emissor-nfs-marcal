const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

// Gera token JWT
function gerarToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

// Middleware: verifica se o usuário está autenticado
function autenticado(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
}

// Middleware: verifica se é usuário do escritório
function apenasEscritorio(req, res, next) {
  if (req.usuario.tipo !== 'escritorio') {
    return res.status(403).json({ erro: 'Acesso restrito ao escritório' });
  }
  next();
}

// Middleware: verifica se é admin
function apenasAdmin(req, res, next) {
  if (req.usuario.tipo !== 'escritorio' || req.usuario.papel !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito a administradores' });
  }
  next();
}

// Middleware: verifica se é o próprio cliente ou escritório
function clienteOuEscritorio(req, res, next) {
  const clienteId = parseInt(req.params.clienteId || req.body.cliente_id);
  if (req.usuario.tipo === 'escritorio') {
    return next();
  }
  if (req.usuario.tipo === 'cliente' && req.usuario.clienteId === clienteId) {
    return next();
  }
  return res.status(403).json({ erro: 'Acesso não autorizado' });
}

module.exports = {
  gerarToken,
  autenticado,
  apenasEscritorio,
  apenasAdmin,
  clienteOuEscritorio,
  JWT_SECRET
};
