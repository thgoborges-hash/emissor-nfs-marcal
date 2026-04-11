# evolution-api/

Tudo relacionado à infra da Evolution API (agente ANA do WhatsApp via Baileys).

## Arquivos

- **QUICKSTART-RAILWAY.md** — guia passo-a-passo de 10 min pra subir no Railway. **Começa por aqui.**
- **RENDER-ENV-VARS.txt** — as 4 env vars que vão no Render depois que a Evolution estiver rodando.
- **docker-compose.yml** — stack completa (Evolution + Postgres + Redis) pra rodar local ou em VPS.
- **.env.example** — template de variáveis da Evolution API.
- **Dockerfile** — fallback caso queira deploy via Git no Railway em vez de Docker Image.
- **railway.json** — config do Railway quando apontando pro Dockerfile.

## Ordem de execução (quando o chip chegar)

1. Segue o `QUICKSTART-RAILWAY.md` até o passo 7 (Evolution rodando)
2. Passo 8: cria instância `ana-marcal`
3. Abre o QR code (via rota do backend ou base64 direto)
4. Escaneia com o WhatsApp do chip dedicado
5. Passo 9: cola as env vars do `RENDER-ENV-VARS.txt` no Render
6. Passo 10: teste em 1 grupo piloto
7. Se 24h OK, adiciona aos outros 79 grupos

## Chave API gerada

```
1f54bee11f1d5271b35c2e0ed303c006c47ab5d1441fec4ec3e421530ec74c39
```

Essa chave é usada:
- Na Evolution API como `AUTHENTICATION_API_KEY`
- No backend Render como `EVOLUTION_API_KEY`
- Nos headers `apikey: ...` de qualquer curl manual

## Webhook do backend

O backend Render expõe:

```
POST https://emissor-nfs-marcal.onrender.com/api/whatsapp/webhook/evolution
```

É pra lá que a Evolution API envia eventos (mensagens, status, grupos). A config já está no `.env.example` como `WEBHOOK_GLOBAL_URL`.
