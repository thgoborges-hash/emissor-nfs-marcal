# === Build do Frontend ===
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# === Backend + Frontend estático ===
FROM node:20-alpine
WORKDIR /app

# Instala Chromium e dependências necessárias para Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto \
    font-noto-emoji

# Configura Puppeteer para usar o Chromium do sistema (não baixar o próprio)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Instala dependências do backend
COPY backend/package*.json ./
RUN npm install --production

# Copia código do backend
COPY backend/ ./

# Copia build do frontend para a pasta public do backend
COPY --from=frontend-build /app/frontend/build ./public

# Cria diretórios de dados e certificados
RUN mkdir -p /app/data /app/data/certificados

# Variáveis de ambiente padrão
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data/emissor.db
ENV CERTIFICADOS_DIR=/app/data/certificados
ENV NFSE_AMBIENTE=homologacao
ENV NFSE_SIMULACAO=true

EXPOSE 3001

CMD ["node", "src/server.js"]
