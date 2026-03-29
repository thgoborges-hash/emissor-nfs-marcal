#!/bin/bash
# =====================================================
# Script de Deploy Local - Emissor NFS-e
# Constrói frontend e prepara backend para produção
# =====================================================

echo "🏗️  Construindo o Emissor NFS-e..."
echo ""

# 1. Instala dependências do frontend
echo "📦 Instalando dependências do frontend..."
cd frontend
npm ci
echo ""

# 2. Build do frontend
echo "⚙️  Construindo frontend (React)..."
REACT_APP_API_URL=/api npm run build
echo ""

# 3. Copia build para pasta public do backend
echo "📁 Copiando build para backend..."
rm -rf ../backend/public
cp -r build ../backend/public
echo ""

# 4. Instala dependências do backend
echo "📦 Instalando dependências do backend..."
cd ../backend
npm ci --production
echo ""

# 5. Inicializa banco de dados
echo "🗄️  Inicializando banco de dados..."
node src/database/init.js
echo ""

echo "✅ Deploy preparado com sucesso!"
echo ""
echo "Para iniciar o servidor:"
echo "  cd backend && npm start"
echo ""
echo "O sistema estará disponível em: http://localhost:3001"
echo ""
echo "Credenciais de teste:"
echo "  Escritório: thgo.borges@gmail.com / admin123"
echo "  Cliente: 12.345.678/0001-90 / cliente123"
