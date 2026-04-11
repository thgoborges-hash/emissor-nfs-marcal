# Setup Evolution API (ANA em grupos)

Guia completo pra configurar a **ANA** usando Evolution API — a única rota que permite o bot ler e responder em **grupos do WhatsApp**.

## Arquitetura

```
Cliente no grupo → WhatsApp → Chip da ANA
                                 ↓
                     Evolution API (Railway/self-hosted)
                                 ↓ webhook
                     Backend Emissor (Render) → Claude (Agente ANA)
                                 ↓
                     Resposta volta pelo mesmo caminho
```

## Por que Evolution API?

As APIs oficiais (Meta Cloud API, Blip, Twilio, 360dialog) **não suportam grupos**. A Meta proíbe deliberadamente pra evitar spam. Evolution API é uma wrapper open-source do Baileys (biblioteca Node que se conecta ao WhatsApp Web) — funciona como se fosse o app, então suporta tudo o que o WhatsApp Web suporta, inclusive grupos.

**Trade-off:** risco de ban pelo Meta (raro se uso legítimo), menos estável que API oficial.

## Mitigação de ban

1. **Chip dedicado** — nunca usar o número principal do escritório
2. **Uso legítimo** — só atendimento real, nunca disparo em massa
3. **Horário comercial** — bot só responde entre 8h-19h
4. **Delay humano** — já configurado (~1.2s) antes de cada envio
5. **Sem spam** — nunca adicionar em grupos sem autorização
6. **Se banir** — compra chip novo, reconecta, readiciona nos grupos. Isola o risco.

## Passo 1 — Comprar chip e ativar

- Chip de qualquer operadora (Vivo, Claro, TIM, Oi)
- Ativa o WhatsApp normalmente no chip (precisa de um aparelho físico pra SMS de verificação)
- Depois de ativar, o chip pode ficar numa gaveta — a sessão vai rodar 100% na Evolution API
- **NÃO** instale o WhatsApp Business (app verde) — use o WhatsApp normal. Tudo vai migrar pra Cloud.

## Passo 2 — Subir a Evolution API

**Opção A: Railway (mais fácil)**

1. Cria conta em https://railway.app (login com GitHub)
2. New Project → Deploy from Template → pesquisa "Evolution API" (tem template oficial)
3. Railway provisiona:
   - Instância da Evolution API
   - Postgres (pra armazenar sessão)
   - Redis (pra cache)
4. Gera uma URL pública tipo `https://evolution-api-production.up.railway.app`
5. Anota a `AUTHENTICATION_API_KEY` que o Railway gerou (está em Variables)

Custo estimado: Plano Hobby do Railway = US$ 5/mês (inclui tudo).

**Opção B: Render (já temos conta)**

Mais complexo porque Evolution API precisa de Postgres + Redis. Dá pra montar via Docker no Render, mas tem mais partes móveis. Recomendo Railway pra simplicidade.

**Opção C: Self-hosted VPS (mais barato, mais trabalho)**

Sobe num VPS R$20-30/mês (Contabo, Hetzner) via Docker Compose. Só faz sentido se for escalar.

## Passo 3 — Criar a instância da ANA na Evolution

Com a Evolution rodando:

```bash
curl -X POST 'https://sua-evolution.up.railway.app/instance/create' \
  -H 'apikey: SUA_API_KEY_GLOBAL' \
  -H 'Content-Type: application/json' \
  -d '{
    "instanceName": "ana-marcal",
    "qrcode": true,
    "integration": "WHATSAPP-BAILEYS"
  }'
```

Vai retornar um JSON com dados da instância e eventualmente o QR code base64.

**Alternativa pelo dashboard:** Evolution API geralmente tem um painel web em `https://sua-evolution.up.railway.app/manager` — dá pra criar a instância clicando.

## Passo 4 — Escanear o QR code e parear

Usa o endpoint do nosso próprio backend (mais prático):

```
GET https://emissor-nfs-marcal.onrender.com/api/whatsapp/evolution/qrcode
```

Autenticado como admin, retorna o QR code em base64.

Ou diretamente da Evolution:

```bash
curl 'https://sua-evolution.up.railway.app/instance/connect/ana-marcal' \
  -H 'apikey: SUA_API_KEY_GLOBAL'
```

**Como parear:**
1. Abre o WhatsApp no aparelho com o chip novo
2. WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho
3. Escaneia o QR code que a Evolution gerou
4. Pronto — a sessão fica ativa na Evolution API

## Passo 5 — Configurar webhook da Evolution pro backend

A Evolution precisa saber pra onde enviar as mensagens recebidas. Configura o webhook:

```bash
curl -X POST 'https://sua-evolution.up.railway.app/webhook/set/ana-marcal' \
  -H 'apikey: SUA_API_KEY_GLOBAL' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://emissor-nfs-marcal.onrender.com/api/whatsapp/webhook/evolution",
    "webhook_by_events": false,
    "events": [
      "MESSAGES_UPSERT"
    ]
  }'
```

Isso diz: "toda vez que uma mensagem chegar nessa instância, faz POST pro nosso backend".

## Passo 6 — Configurar variáveis no Render

No dashboard do Render (serviço `emissor-nfs-marcal`) → Environment, adiciona/atualiza:

```
WHATSAPP_PROVIDER=evolution
EVOLUTION_API_URL=https://sua-evolution.up.railway.app
EVOLUTION_API_KEY=<a mesma API key global da Evolution>
EVOLUTION_INSTANCE=ana-marcal
```

Salva e faz Manual Deploy.

## Passo 7 — Testar em 1 privado

Antes de adicionar nos grupos, teste em conversa privada:

1. No seu celular pessoal, salva o número da ANA como contato
2. Manda "oi"
3. A ANA deve responder via webhook → backend → Claude → volta pela Evolution

Se funcionou, bom sinal.

## Passo 8 — Adicionar a ANA num grupo piloto

1. Escolhe 1 grupo de cliente (idealmente um que você tenha boa relação) como piloto
2. Avisa o cliente: *"Pessoal, adicionamos nossa assistente ANA (IA) pra agilizar pedidos de NF. Quando precisar emitir nota, é só mencionar @ANA ou pedir diretamente que ela faz."*
3. Adiciona o número da ANA no grupo (você precisa ser admin)
4. Pede pra alguém da equipe do cliente testar: "ANA, preciso emitir uma nota pra tal CNPJ, valor R$ 1000, serviço de consultoria"
5. Valida o fluxo end-to-end

## Passo 9 — Rollout pros outros grupos

Depois que o piloto validou (uns 2-3 dias), adiciona nos outros grupos aos poucos. Sugestão:

- **Semana 1:** 5 grupos (mais ativos ou mais receptivos)
- **Semana 2:** +15 grupos
- **Semana 3:** +30 grupos
- **Semana 4:** resto

Monitora o log do Render e a DB pra ver se está respondendo certo ou se está "se intrometendo" onde não deve. Ajusta o prompt se precisar.

## Monitoramento

**Endpoints úteis:**

- `GET /api/whatsapp/status` — status geral (provider, conexão, webhook url)
- `GET /api/whatsapp/evolution/grupos` — lista todos os grupos em que a ANA está
- `GET /api/whatsapp/evolution/qrcode` — QR code pra reconectar se a sessão cair
- `GET /api/whatsapp/conversas` — conversas armazenadas no emissor

**O que monitorar:**

- Sessão caída (Evolution desconectou) → reconecta com QR code
- Bot respondendo demais → ajusta o prompt pra ser mais conservador
- Bot não respondendo quando deveria → checa o log, pode ser filtro de palavra-chave
- Uso da Anthropic API (custo) → endpoint `/api/whatsapp/agente/creditos`

## Rollback plano B

Se algo der errado, basta:

1. No Render: `WHATSAPP_PROVIDER=meta` (volta pra Cloud API, que já está criada)
2. OU `WHATSAPP_PROVIDER=blip` (volta pra Blip)
3. Redeploy

O emissor continua funcionando 100% — só perde a automação via grupos.

## Custos estimados

| Item | Custo |
|------|-------|
| Chip dedicado (comprar) | R$ 20 (uma vez) |
| Plano básico do chip | R$ 10-30/mês |
| Railway (Evolution API) | US$ 5/mês (~R$ 25) |
| Render (já existente) | US$ 7/mês (já pago) |
| Anthropic Claude (IA) | US$ 5-20/mês (conforme uso) |
| **Total Evolution extra** | **~R$ 60-100/mês** |

Comparado com Emitte (R$ 59-120/mês por cliente × 155 clientes) ou Blip BSP (R$ 200+/mês), é ordens de grandeza mais barato.

## Referências

- Evolution API: https://doc.evolution-api.com
- Baileys (lib base): https://github.com/WhiskeySockets/Baileys
- Railway template: https://railway.app/template/evolution-api
