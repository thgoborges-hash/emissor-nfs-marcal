# Quickstart — Evolution API no Railway

Guia otimizado pra deploy em ~10 minutos. O Thiago vai seguir esses passos quando voltar com o chip.

## Pré-requisitos

- Conta no Railway (railway.app). Se não tem, cria com GitHub ou email.
- Cartão cadastrado (plano Hobby $5/mês de crédito inclui tudo que precisa).
- Chip/número dedicado comprado e com WhatsApp Business App instalado em um celular (pode ser um Android velho, até emulador serve).

## API Key pré-gerada

Gerei uma API key forte pra você usar:

```
1f54bee11f1d5271b35c2e0ed303c006c47ab5d1441fec4ec3e421530ec74c39
```

Vamos chamar essa de `AUTHENTICATION_API_KEY`. Guarda — vai ser usada no Railway **e** no Render (backend precisa dela pra chamar a Evolution).

---

## Passo 1 — Criar projeto novo no Railway

1. Entra em https://railway.app → **New Project** → **Empty Project**
2. Nome do projeto: `ana-marcal-evolution`

## Passo 2 — Adicionar Postgres

Dentro do projeto, clica **+ New** → **Database** → **Add PostgreSQL**.

Pronto. O Railway sobe um Postgres e já expõe a variável `DATABASE_URL` via reference.

## Passo 3 — Adicionar Redis

Mesmo processo: **+ New** → **Database** → **Add Redis**.

Expõe `REDIS_URL` automaticamente.

## Passo 4 — Adicionar Evolution API (serviço principal)

Clica **+ New** → **Empty Service** → renomeia pra `evolution-api`.

Agora configura a fonte:

1. Aba **Settings** → **Source** → **Connect Repo** e escolhe `thgoborges-hash/emissor-nfs-marcal`
2. Em **Root Directory** coloca: `evolution-api`
3. **Build Command**: deixa em branco (vai usar Dockerfile)
4. **Start Command**: deixa em branco (imagem já tem)
5. **Watch Paths**: `evolution-api/**`

> Alternativa mais rápida: se preferir não usar o repo, em vez de Connect Repo, escolhe **Deploy from Docker Image** e cola `atendai/evolution-api:v2.1.1`. Mesmo resultado, um clique a menos.

## Passo 5 — Configurar variáveis de ambiente

Na aba **Variables** do serviço `evolution-api`, clica **Raw Editor** e cola tudo isso:

```env
SERVER_TYPE=http
SERVER_PORT=8080
SERVER_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}

AUTHENTICATION_API_KEY=1f54bee11f1d5271b35c2e0ed303c006c47ab5d1441fec4ec3e421530ec74c39
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true

DATABASE_ENABLED=true
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=${{Postgres.DATABASE_URL}}
DATABASE_CONNECTION_CLIENT_NAME=ana_marcal
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=false
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
DATABASE_SAVE_DATA_LABELS=false
DATABASE_SAVE_DATA_HISTORIC=false

CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=${{Redis.REDIS_URL}}
CACHE_REDIS_PREFIX_KEY=ana_marcal
CACHE_REDIS_SAVE_INSTANCES=true
CACHE_LOCAL_ENABLED=false

WEBHOOK_GLOBAL_URL=https://emissor-nfs-marcal.onrender.com/api/whatsapp/webhook/evolution
WEBHOOK_GLOBAL_ENABLED=true
WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS=false
WEBHOOK_EVENTS_APPLICATION_STARTUP=false
WEBHOOK_EVENTS_QRCODE_UPDATED=true
WEBHOOK_EVENTS_MESSAGES_UPSERT=true
WEBHOOK_EVENTS_MESSAGES_UPDATE=false
WEBHOOK_EVENTS_MESSAGES_DELETE=false
WEBHOOK_EVENTS_SEND_MESSAGE=false
WEBHOOK_EVENTS_CONTACTS_UPSERT=false
WEBHOOK_EVENTS_CONTACTS_UPDATE=false
WEBHOOK_EVENTS_PRESENCE_UPDATE=false
WEBHOOK_EVENTS_CHATS_UPSERT=false
WEBHOOK_EVENTS_CHATS_UPDATE=false
WEBHOOK_EVENTS_CHATS_DELETE=false
WEBHOOK_EVENTS_GROUPS_UPSERT=true
WEBHOOK_EVENTS_GROUPS_UPDATE=true
WEBHOOK_EVENTS_GROUP_PARTICIPANTS_UPDATE=true
WEBHOOK_EVENTS_CONNECTION_UPDATE=true
WEBHOOK_EVENTS_CALL=false
WEBHOOK_EVENTS_NEW_JWT_TOKEN=false

CONFIG_SESSION_PHONE_CLIENT=Ana Marcal
CONFIG_SESSION_PHONE_NAME=Chrome
QRCODE_LIMIT=30
QRCODE_COLOR=#175EA0

CLEAN_STORE_CLEANING_INTERVAL=7200
CLEAN_STORE_MESSAGES=true
CLEAN_STORE_MESSAGE_UP=true
CLEAN_STORE_CONTACTS=true
CLEAN_STORE_CHATS=true

LOG_LEVEL=ERROR,WARN,INFO
LOG_COLOR=true
LOG_BAILEYS=error
DEL_INSTANCE=false
LANGUAGE=pt-BR
```

> Os `${{Postgres.DATABASE_URL}}` e `${{Redis.REDIS_URL}}` são references do Railway — ele resolve automaticamente.

## Passo 6 — Gerar domínio público

Na aba **Settings** do serviço `evolution-api` → **Networking** → **Generate Domain**.

Vai gerar algo tipo `ana-marcal-evolution-production.up.railway.app`. **Copia esse domínio** — precisa dele pro próximo passo.

## Passo 7 — Deploy

Clica **Deploy** no topo. Espera 2-3 min até ficar verde. Testa:

```bash
curl https://SEU-DOMINIO.up.railway.app/
```

Deve responder algo tipo `{"status":200,"message":"Welcome to the Evolution API"}`.

Se responder, a Evolution está online.

## Passo 8 — Criar a instância `ana-marcal`

No terminal local:

```bash
curl --request POST \
  --url https://SEU-DOMINIO.up.railway.app/instance/create \
  --header 'Content-Type: application/json' \
  --header 'apikey: 1f54bee11f1d5271b35c2e0ed303c006c47ab5d1441fec4ec3e421530ec74c39' \
  --data '{
    "instanceName": "ana-marcal",
    "qrcode": true,
    "integration": "WHATSAPP-BAILEYS"
  }'
```

A resposta vai trazer um QR code em base64. Opções:

**A)** Copia a string base64 (depois de `data:image/png;base64,`) e cola num decoder online tipo https://codebeautify.org/base64-to-image-converter — lê o QR com o WhatsApp do chip dedicado.

**B)** Mais fácil: depois de criar a instância, abre no navegador:

```
https://SEU-DOMINIO.up.railway.app/instance/connect/ana-marcal?number=
```

E inclui no header `apikey` a chave. (Ou usa a rota que criei no backend: `GET /api/whatsapp/evolution/qrcode` — retorna JSON com QR pronto.)

## Passo 9 — Configurar o Render

No dashboard do Render (https://dashboard.render.com), serviço `emissor-nfs-marcal` → **Environment** → adiciona/atualiza:

```
WHATSAPP_PROVIDER=evolution
EVOLUTION_API_URL=https://SEU-DOMINIO.up.railway.app
EVOLUTION_API_KEY=1f54bee11f1d5271b35c2e0ed303c006c47ab5d1441fec4ec3e421530ec74c39
EVOLUTION_INSTANCE=ana-marcal
```

Save → Manual Deploy. Espera ficar verde.

## Passo 10 — Teste inicial

1. Envia uma mensagem do seu WhatsApp pessoal pro chip da ANA
2. A mensagem deve chegar no webhook e gerar resposta do agente
3. Ve os logs no Render: `Evolution webhook recebido` → `processando com agenteIAService`
4. Se tudo OK, adiciona o chip da ANA em **1 grupo piloto** primeiro (não nos 80 de uma vez)
5. Observa por 24h como ela se comporta antes de expandir

---

## Troubleshooting rápido

| Sintoma | Causa provável | Fix |
|---|---|---|
| Railway build falha em Postgres/Redis | Plano free sem crédito | Adiciona cartão no billing |
| Evolution responde 401 Unauthorized | `apikey` errada no header | Verifica se copiou a chave exata |
| QR code não gera | Instância já conectada | `DELETE /instance/logout/ana-marcal` e recria |
| Webhook não chega no Render | URL errada ou Render pausado | Curl manual: `POST /api/whatsapp/webhook/evolution` com body dummy |
| Banimento rápido do chip | Muito envio inicial | Aquece 7 dias: só recebe, não envia nada automatizado |

## Custos estimados

- Railway Hobby: **$5/mês** (inclui Evolution + Postgres + Redis)
- Chip dedicado: ~R$20-40/mês (pré-pago mínimo)
- Claude API (ANA): já existente, mesmo custo
- **Total extra: ~R$60-100/mês**

## Plano B — se der ruim no Railway

Mesmo docker-compose roda em:
- **Contabo VPS** (~R$30/mês, mas você administra)
- **Hetzner CX11** (~R$25/mês, Europa)
- **Localmente** no iMac do escritório (grátis, mas depende de internet fixa)

O `docker-compose.yml` deste diretório roda igual em qualquer uma dessas.
