# === Build do Frontend ===
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# === Backend + Frontend estático ===
FROM node:20-alpine
WORKDIR /app

# Instala dependências do backend
COPY backend/package*.json ./
RUN npm ci --production

# Copia código do backend
COPY backend/ ./

# Copia build do frontend para a pasta public do backend
COPY --from=frontend-build /app/frontend/build ./public

# Cria diretório de dados
RUN mkdir -p /app/data

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data/emissor.db

EXPOSE 3001

CMD ["node", "src/server.js"]
