require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./database/init');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Inicializa banco de dados
initDatabase();

// Rotas da API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/clientes', require('./routes/clientes'));
app.use('/api', require('./routes/tomadores'));
app.use('/api/notas-fiscais', require('./routes/notasFiscais'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', versao: '1.0.0', timestamp: new Date().toISOString() });
});

// Serve frontend estático em produção
// O frontend é construído com `npm run build` dentro de /frontend
// e os arquivos ficam em /frontend/build (ou copiados para /backend/public)
const publicPath = path.join(__dirname, '../public');
const frontendBuildPath = path.join(__dirname, '../../frontend/build');

// Tenta servir de /backend/public primeiro, depois de /frontend/build
const fs = require('fs');
const staticPath = fs.existsSync(publicPath) ? publicPath :
                   fs.existsSync(frontendBuildPath) ? frontendBuildPath : null;

if (staticPath) {
  app.use(express.static(staticPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(staticPath, 'index.html'));
    }
  });
  console.log(`Servindo frontend de: ${staticPath}`);
}

// Inicia servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  Emissor NFS-e - Marçal Contabilidade`);
  console.log(`  Servidor rodando na porta ${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api`);
  console.log(`========================================\n`);
});

module.exports = app;
