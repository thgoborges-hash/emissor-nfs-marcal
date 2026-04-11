# ============================================================
# Dockerfile de fallback — caso queira deploy via Git no Railway
# ============================================================
# Uso normal no Railway: deploy direto da imagem
#   atendai/evolution-api:v2.1.1
# Esse Dockerfile só existe pra quem prefere apontar o Railway
# pra este diretório do repo em vez de usar Docker Image deploy.
# ============================================================

FROM atendai/evolution-api:v2.1.1

EXPOSE 8080

# Healthcheck simples — Evolution responde na raiz
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1
