# SIEG API — Setup

Integração com o SIEG pra download automático de XMLs de notas fiscais (entrada e saída) da carteira de clientes da Marçal. Base do pipeline SIEG → Domínio (em breve).

**Importante:** a API antiga do SIEG (`https://api.sieg.com.br/...`) é depreciada em **31/07/2026**. Este módulo já nasce na API nova (`https://api.sieg.com/BaixarXmls`).

## Passo a passo

### 1. Gerar API Key no painel SIEG
- Entrar em https://app.sieg.com
- Minha Conta → Integrações API SIEG → Gerar nova API Key
- Nome identificador: "Emissor NFs Marçal"
- Validade: 60 meses (5 anos)
- Permissão: Full Access
- Copiar a key gerada

### 2. Configurar variáveis de ambiente no Render
```
SIEG_API_KEY=<valor copiado>
SIEG_EMAIL=<email da conta SIEG Marçal>
SIEG_SYNC_ENABLED=false
SIEG_SYNC_CRON=30 6 * * *
```

Mantém `SIEG_SYNC_ENABLED=false` até validar os endpoints manualmente — evita o cron disparar antes da gente testar.

### 3. Testar manualmente

```bash
TOKEN=<jwt do escritório>
BASE=https://emissor-nfs-marcal.onrender.com/api/sieg

# status
curl -H "Authorization: Bearer $TOKEN" "$BASE/status"

# teste de conexão (pede 1 XML da última semana só pra validar credenciais)
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/testar-conexao"

# baixar notas de ENTRADA (notas recebidas pelo cliente, ex: fornecedores)
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/entradas/12345678000199?dataIni=2026-04-01&dataFim=2026-04-18&tipoDoc=55"

# baixar notas de SAÍDA (notas emitidas pelo cliente, ex: vendas)
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/saidas/12345678000199?dataIni=2026-04-01&dataFim=2026-04-18&tipoDoc=55"
```

Códigos de tipoDoc:
- `55` — NFe (padrão)
- `65` — NFCe
- `57` — CTe
- `59` — CFe-SAT
- `99` — NFSe

### 4. Ativar sync diário (depois que validar)
Quando os testes manuais estiverem OK, setar `SIEG_SYNC_ENABLED=true` no Render. O worker roda todo dia às 06:30 puxando tudo que caiu na janela anterior.

*(Worker ainda não implementado — chegará na Fase 2 junto com integração Domínio.)*

## Endpoints disponíveis

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/sieg/status` | Healthcheck do módulo |
| POST | `/api/sieg/testar-conexao` | Testa credenciais SIEG |
| GET | `/api/sieg/entradas/:cnpj` | Notas de entrada do cliente (paginado automático) |
| GET | `/api/sieg/saidas/:cnpj` | Notas de saída do cliente (paginado automático) |
| POST | `/api/sieg/baixar` | Chamada genérica ao `BaixarXmls` (com conteúdo completo) |

## Arquitetura

- `config/sieg.js` — endpoints, tipos de documento, limites, cron schedule
- `services/siegService.js` — chamadas HTTPS + pagination automática + decodificação base64 + extração de chave de acesso
- `routes/sieg.js` — REST endpoints (todos protegidos por JWT de escritório)

A API SIEG devolve JSON com array de strings base64 (até 50 XMLs por chamada). O service pagina automaticamente nas funções `baixarNotasDeEntrada` e `baixarNotasDeSaida` até esgotar.

## Próximos passos (Fase 2)

1. Worker diário: cron que varre a carteira inteira e baixa XMLs novos
2. Armazenamento estruturado: tabela `notas_recebidas` no banco (chave, cliente, emitente, valor, data, status processamento)
3. **Pipeline SIEG → Domínio**: encaminha XMLs automaticamente pro Contábil via API Domínio (depende da chave Thomson Reuters)
4. Dashboard interno: visão por cliente de NFs recebidas + emitidas + impostos a pagar
5. Alerta via ANA: "cliente X recebeu 12 NFe esta semana, total R$ 48.500 — confira no dashboard"
