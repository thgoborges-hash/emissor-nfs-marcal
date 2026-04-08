# Integração WhatsApp via Blip

Guia para conectar o WhatsApp do escritório à Ana usando a Blip como BSP (Business Solution Provider).

## Por que Blip?

A Blip é uma BSP brasileira que faz toda a ponte com a Meta. Ela cuida da verificação do Facebook Business, então **não precisa do 2FA do Facebook** — a Blip resolve isso internamente.

## Passo a passo

### 1. Criar conta na Blip

1. Acesse [blip.ai](https://www.blip.ai) e crie uma conta
2. Crie um novo **bot** (pode chamar de "Ana - Marçal Contabilidade")
3. Na configuração do bot, escolha **Webhook** como tipo de integração (não Builder)

### 2. Configurar o canal WhatsApp na Blip

1. No painel do bot, vá em **Canais** > **WhatsApp**
2. A Blip vai guiar o processo de vincular o número do escritório
3. Isso inclui a verificação do Facebook Business — a Blip ajuda nessa parte
4. Ao final, o número do escritório estará conectado ao bot

### 3. Configurar o Webhook na Blip

1. No painel do bot, vá em **Configurações** > **Informações de conexão**
2. Copie a **API Key** do bot (vai precisar para as variáveis de ambiente)
3. Vá em **Integrações** > **Webhook**
4. Configure a URL do webhook:
   ```
   https://emissor-nfs-marcal.onrender.com/api/whatsapp/webhook/blip
   ```
5. Marque para receber **Mensagens** (Messages)
6. Salve

### 4. Configurar variáveis de ambiente no Render

No dashboard do Render, adicione estas variáveis:

| Variável | Valor | Descrição |
|----------|-------|-----------|
| `WHATSAPP_PROVIDER` | `blip` | Ativa o modo Blip |
| `BLIP_API_KEY` | `(sua key)` | API Key do bot na Blip |
| `BLIP_BOT_IDENTIFIER` | `(seu bot)@msging.net` | Identificador do bot |

**Importante:** As variáveis da Meta (`WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`) podem ser removidas ou deixadas como estão — elas serão ignoradas quando `WHATSAPP_PROVIDER=blip`.

### 5. Fazer deploy

Após configurar as variáveis, faça um novo deploy no Render para aplicar as mudanças.

### 6. Testar

1. Mande uma mensagem pro WhatsApp do escritório de um número qualquer
2. A Ana deve responder normalmente
3. Verifique os logs no Render para confirmar que está funcionando:
   ```
   [WhatsApp] Provider: Blip (BSP)
   [Blip] Mensagem recebida: type=text/plain, from=5541999999999@wa.gw.msging.net
   ```

## Formato das mensagens (referência técnica)

### Mensagem recebida (Blip → nosso webhook)

```json
{
  "type": "text/plain",
  "content": "Oi, preciso emitir uma NF",
  "id": "wamid.xxx",
  "from": "5541999999999@wa.gw.msging.net",
  "to": "meubot@msging.net",
  "metadata": {
    "#wa.timestamp": "1736354097",
    "#contactName": "João da Silva"
  }
}
```

### Mensagem enviada (nosso backend → Blip)

```json
{
  "id": "uuid-gerado",
  "to": "5541999999999@wa.gw.msging.net",
  "type": "text/plain",
  "content": "Oi João! Tudo bem? Me fala o que precisa 😊"
}
```

Endpoint: `POST https://http.msging.net/messages`
Header: `Authorization: Key {BLIP_API_KEY}`

## Custos

- Blip cobra mensalidade (planos a partir de ~R$399/mês para WhatsApp Business)
- Além disso, a Meta cobra por mensagem (~R$0,35 por marketing template no Brasil)
- Mensagens de resposta dentro da janela de 24h são gratuitas na Meta

## Alternando entre Blip e Meta

Para voltar à Meta Cloud API, basta mudar a variável:

```
WHATSAPP_PROVIDER=meta
```

O sistema suporta ambos os providers sem precisar alterar código.
