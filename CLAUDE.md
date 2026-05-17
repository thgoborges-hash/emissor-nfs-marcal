# Emissor NFs — Marçal Contabilidade

Cockpit interno do escritório + ANA (agente IA no WhatsApp) + integrações Integra Contador (SERPRO), SIEG, Domínio API.

## Contexto rápido

- **Escritório:** Marçal Contabilidade (Curitiba/PR), Thiago Borges, ~155-203 clientes ativos
- **Repo:** github.com/thgoborges-hash/emissor-nfs-marcal
- **Deploy:** Render Starter, auto-deploy pra `main` (~2min)
- **URL produção:** https://emissor-nfs-marcal.onrender.com
- **Disco persistente:** `/app/data/` (SQLite + certificados A1)
- **WhatsApp provider:** Z-API (Evolution API descontinuada)
- **Modelo Claude:** `claude-sonnet-4-20250514` (Sonnet) + `claude-haiku-4-5-20251001` (validador)

## Stack

- **Backend:** Node.js / Express / SQLite (better-sqlite3) — `backend/src/`
- **Frontend:** React 18 — `frontend/src/`
- **Deploy:** Docker + Render — `Dockerfile` + `render.yaml`

## ANA — visão geral

Agente conversacional em WhatsApp da Marçal. Atende clientes finais (PMEs, MEIs) e equipe interna (modo equipe).

**Arquivos-chave:**

| Arquivo | Linhas | Função |
|---|---:|---|
| `backend/src/services/agenteIAService.js` | ~3000 | Loop principal, system prompt, tools, validação |
| `backend/src/services/anaModoEquipeService.js` | 276 | Detecção de modo equipe em 3 camadas (admin → grupo staff → prefixo+whitelist) |
| `backend/src/routes/whatsapp.js` | ~950 | Webhooks Z-API/Blip/Evolution, dispatchers |
| `backend/src/services/zapiService.js` | 399 | Provider WhatsApp ativo |
| `backend/src/routes/debug.js` | ~430 | Endpoints de export/análise (incluindo conversas ANA) |

**Tools disponíveis na ANA** (via tags `[ACAO:TIPO:params]`):
- `EMITIR_NF` (cliente + equipe), `CANCELAR_NF` (equipe)
- `BUSCAR_DANFSE`, `LISTAR_NFS`, `CONSULTAR_NF`
- `CONSULTAR_PGDASD_ULTIMA`, `CONSULTAR_PROCURACOES`, `CONSULTAR_DCTFWEB`, `LISTAR_CAIXA_POSTAL`
- `GERAR_DAS_SIMPLES`, `GERAR_DAS_SIMPLES_AVULSO`, `GERAR_DAS_MEI`
- `SOLICITAR_SITFIS`, `EMITIR_CCMEI`, `EMITIR_DARF`
- `CADASTRAR_A1`, `ATUALIZAR_CLIENTE`
- `TRANSFERIR_HUMANO`, `VINCULAR_CLIENTE`, `IGNORAR`

**Detecção de modo equipe (anaModoEquipeService):**
1. Telefone bate com `ANA_ADMIN_WHATSAPP` → modo equipe (fonte: `admin`)
2. Conversa em grupo dentro de `ANA_STAFF_GROUP_IDS` → modo equipe (fonte: `staff_group`)
3. Mensagem com prefixo "Nome:" + nome em whitelist (`ANA_OPERADORES` env ou tabela `ana_operadores`) → modo equipe (fonte: `prefixo`)
4. Senão → modo cliente. Se prefixo detectado mas nome não validado → flag `ambiguo`, alerta admin (throttled 1h)

## Status dos sprints (revisão arquitetural ANA)

Plano completo em `ana-revisao-arquitetural.md` (raiz do projeto). Diagnóstico original: prompt monolítico de 462 linhas + 20 actions planas. 3 sintomas reportados pelo Thiago: (1) não entende intenção, (2) inventa info, (3) erra ações sensíveis.

**Sprint 1 — todo em produção:**
- ✅ **1.1 — Router Haiku como pré-classificador** (`backend/src/services/anaRouterService.js`, 241 linhas, plugado em `agenteIAService.js:143-168`). Early-exit em `deve_ignorar` (grupo) e `deve_handoff` (confiança <60). Hint da intenção injetada no system prompt do Sonnet.
- ✅ **1.2 — Detecção de modo equipe robusta** (commit `fc8515f`). 3 camadas: admin → grupo staff → prefixo+whitelist.
- ✅ **1.3 — Grounding obrigatório com validação pré-envio** (`backend/src/services/anaGroundingValidator.js`, 329 linhas, plugado em `agenteIAService.js:179-194`). Regex pré-filtro pra promessa vazia + fato sem fonte; Haiku confirma antes de bloquear. Bloqueia → substitui por transferência humana sem cliente ver promessa vazia.
- ✅ **1.5 — ANA pró-ativa (auto-fix antes de transferir)** (commit `55225fa`). Quando detecta erro de emissão tratável, tenta corrigir antes de pedir humano.

**Sprint 2 — parcial:**
- ✅ **2.1 — Confirmação antes de emitir** (commit `408509b`, modo cliente externo). Plano-antes-de-executar pra EMITIR_NF — pede "Confirma?" antes de disparar.
- 🔲 **2.2 — Tier de autonomia por ação** via tabela `ana_acoes_config`

**Refactor prompt** (commit `32b8ac8`): system prompt podado 460→250 linhas. Reduz vazamento de regras de equipe pra modo cliente.

**Sprint 3 (refactor estrutural):**
- 🔲 **3.1 — Tool design hierárquico** (6 meta-tools no lugar de 20 planas)
- 🔲 **3.2 — Skills folder-based** (`backend/src/ana/skills/*.md`)

**Sprint 4 (avançado):**
- 🔲 **4.1 — Modo Consulta vs Modo Ação separados**
- 🔲 **4.2 — State machine pra emissão NF**

**Sprint 5 (memória):**
- 🔲 **5.1 — Memória em 3 camadas** (short, mid resumo, long perfil cliente)

## Fusão com projeto João — Analista Contábil

Projeto irmão em `/Users/thgob/Documents/Claude/Projects/joao-analista-contabil/` (plugin Claude Code, agente + 9 skills). João é o "back-office" — opera o Domínio Web via computer-use no GO-Global pra coisas que NÃO têm API: importação TXT de lançamentos, classificação de extrato, ECD/PVA, integração Fiscal/Folha→Contábil.

**Arquitetura cliente-servidor proposta (em construção 2026-05-17):**
- Emissor expõe `POST /api/joao/jobs` que enfileira tarefas na tabela `joao_jobs` (SQLite).
- Daemon local no Mac do Thiago faz long-poll na fila, executa skill correspondente via computer-use, devolve resultado.
- Ana ganha 4 novas tools: `EXECUTAR_NO_DOMINIO`, `CLASSIFICAR_EXTRATO`, `GERAR_OBRIGACAO`, `MONITORAR_ONVIO`.
- Ações irreversíveis (importar TXT, transmitir ECD) entram em `pending_approval` no painel.

Detalhamento completo em `STATUS.md` do projeto João.

## Decisões arquiteturais não-óbvias

### Detecção de modo equipe via whitelist
Sem whitelist (env `ANA_OPERADORES` vazia + tabela `ana_operadores` vazia), o serviço cai em comportamento legado (heurística "nome próprio"). **Configure ANA_OPERADORES** em produção pra eliminar falsos positivos:
```
ANA_OPERADORES=Janaina Alves,Lucas Silva,Thiago Borges
```

### Cert lookup dual no Integra Contador
`integraContadorService._carregarCertificadoMarcal()` procura cert em 2 fontes: (1) cliente cujo CNPJ == `MARCAL_CNPJ` na tabela `clientes`, (2) fallback em `/app/data/certificados/escritorio_marcal.pfx`.

### Procuração coletiva SERPRO
Marçal tem procuração eletrônica no e-CAC pra carteira inteira. Payload SERPRO: `contratante=MARCAL_CNPJ`, `contribuinte=CNPJ_DO_CLIENTE_CONSULTADO`. Não precisa de gestão por cliente.

### NFS-e Nacional
- Série DPS = **1** (API). Série 70000 é exclusiva do Portal Web (E0010 se usar via API).
- Resposta SEFIN tem `nNFSe` dentro do XML comprimido em `nfseXmlGZipB64` — extrair via regex `<nNFSe>(\d+)<\/nNFSe>`.
- NFs 111+ emitidas em produção desde 07/04/2026.

### DANFSe PDF
SEFIN não fornece PDF (501) e a consulta pública tem hCaptcha. Geração local via Puppeteer com template oficial v1.0 (`backend/src/services/danfsePdfService.js`).

### Push do GitHub
Push só do terminal do Thiago (proxy do Cowork bloqueava — no Claude Code não tem esse problema, push direto). Token em fine-grained (scope: contents read+write no repo `emissor-nfs-marcal`), salvo no keychain do macOS.

### Render Auto-Deploy
Push pra `main` → Render builda + deploya em ~2min (não Manual Deploy — confirmado validado).

## Comandos comuns

```bash
# Rodar local
cd backend && npm install && npm start

# Validar sintaxe sem rodar
node --check backend/src/services/agenteIAService.js

# Testar endpoint debug (precisa estar logado pra pegar JWT do localStorage)
curl 'https://emissor-nfs-marcal.onrender.com/api/debug/exportar-conversas-ana?dias=30' \
  -H "Authorization: Bearer $JWT"

# Pegar 1 conversa específica (paginada)
curl 'https://emissor-nfs-marcal.onrender.com/api/debug/exportar-conversas-ana?conversa_id=16&msg_offset=0&msg_limite=20' \
  -H "Authorization: Bearer $JWT"

# Script local de export (precisa do emissor.db)
node backend/scripts/exportar-conversas-ana.js --db ./emissor.db --dias 30
```

## Variáveis de ambiente (Render)

**Configuradas:**
- `JWT_SECRET`, `NODE_ENV`, `ANTHROPIC_API_KEY`, `WHATSAPP_VERIFY_TOKEN`
- `CERT_ENCRYPTION_KEY`, `DB_PATH`, `CERTIFICADOS_DIR`
- `NFSE_AMBIENTE=producao`, `NFSE_SIMULACAO=false`
- `WHATSAPP_PROVIDER=zapi` + `ZAPI_*`

**A configurar (caso falte):**
- `ANA_ADMIN_WHATSAPP` (telefone admin Thiago, formato 5541999999999)
- `ANA_STAFF_GROUP_IDS` (id do grupo staff Marçal, separado por vírgula)
- `ANA_OPERADORES` (nomes dos operadores Domínio, ex: "Janaina Alves,Lucas Silva,Thiago Borges")
- `SERPRO_CONSUMER_KEY`, `SERPRO_CONSUMER_SECRET`, `MARCAL_CNPJ`
- `SIEG_API_KEY`, `SIEG_EMAIL` (após contratar plano)

## Lixo a limpar (não-urgente)

Working tree tem arquivos órfãos que podem ser apagados:
- `backend/src/services/.fuse_hidden0000000a*` (10 arquivos) — sobra do FUSE/sync
- `backend/src/services/XXBunySr` — órfão suspeito
- `backend/src/services/agenteIAService.js.bak_marcal_fixes` — backup antigo

Adicionar ao `.gitignore`:
```
.fuse_hidden*
*.bak*
```

## Próximos passos pra Claude Code

> **Nota 2026-05-17**: Sprints 1.1/1.3/1.5/2.1 e refactor do prompt JÁ ESTÃO EM PRODUÇÃO. As instruções abaixo de "validar e plugar Sprint 1.1/1.3" são históricas — preservadas como referência mas não precisam mais ser executadas. Para diagnóstico do sintoma "Ana com dificuldade pra emitir NF no Portal Nacional", a tarefa real agora é: pegar logs de produção e fazer análise causa-raiz.

### 1. Pegar logs reais da ANA (~10 min)

Como `/app/data` no Render não tem SSH em planos pagos sem Standard, o caminho mais simples é via endpoint que já existe:

```bash
# Você precisa de um JWT válido. Loga no app, abre DevTools > Application > Local Storage e copia o valor de "token". Cola abaixo.
JWT="cole_aqui"

# Pega o sumário (lista de conversas + counts)
curl "https://emissor-nfs-marcal.onrender.com/api/debug/exportar-conversas-ana?dias=30" \
  -H "Authorization: Bearer $JWT" > ana-sumario.json

# Pra cada conversa, pega detalhe (script bash que itera)
mkdir -p ana-logs
for id in $(cat ana-sumario.json | jq -r '.conversas[].conversa_id'); do
  curl -s "https://emissor-nfs-marcal.onrender.com/api/debug/exportar-conversas-ana?conversa_id=$id&msg_limite=500" \
    -H "Authorization: Bearer $JWT" > "ana-logs/conv-$id.json"
  echo "✓ conv $id"
done

# Junta tudo num só
jq -s '{ total: length, conversas: . }' ana-logs/conv-*.json > ana-conversas-completo.json
```

Alternativamente, se você baixar o `emissor.db` da Render dashboard, roda:
```bash
node backend/scripts/exportar-conversas-ana.js --db ./emissor.db --dias 30
```

### 2. Categorizar caneladas (~30 min)

Lê `ana-conversas-completo.json` e classifica cada problema por causa-raiz:
- prompt (instrução faltando ou ambígua)
- tool (ação errada ou parâmetro mal extraído)
- roteamento (modo cliente vs equipe errado)
- contexto (histórico curto demais)
- regra (regra não codificada)

Saída em `ana-caneladas-categorizadas.md` com 30-50 casos representativos das 3 categorias que o Thiago reportou (não entende intenção / inventa info / erra ações sensíveis).

### 3. Validar e plugar Sprint 1.1 (Router Haiku)

Arquivo pronto: `backend/src/services/anaRouterService.js`. Falta:

- Plugar em `agenteIAService.processarMensagem` ANTES da chamada do Sonnet:
  ```js
  const anaRouterService = require('./anaRouterService');
  // ... dentro de processarMensagem, depois de detectar modoEquipe:
  const router = await anaRouterService.classificar({
    mensagem,
    modoDetectado: modoEquipe.ehEquipe ? 'equipe' : 'cliente',
    tipoContato: contato?.tipo,
    ultimas3Msgs: historico.slice(-3),
  });

  if (router.deve_ignorar) {
    return { texto: '', acoes: [{ tipo: 'IGNORAR' }] };
  }
  if (router.deve_handoff) {
    return {
      texto: 'Essa eu prefiro deixar o Thiago te responder com calma — já tô chamando ele aqui mesmo 👍 [ACAO:TRANSFERIR_HUMANO]',
      acoes: [{ tipo: 'TRANSFERIR_HUMANO' }],
    };
  }
  // hint pra Sonnet:
  const hintIntencao = `\n\n[ROUTER]: intenção=${router.intencao}, modo_inferido=${router.modo_inferido}, confiança=${router.confianca}, campos_faltantes=${JSON.stringify(router.campos_faltantes)}, motivo="${router.motivo}"`;
  // adicionar hintIntencao no fim do systemPrompt
  ```
- `node --check` no agenteIAService.js
- Testar localmente: `node backend/scripts/exportar-conversas-ana.js --db ./emissor.db --dias 30` então script de regressão (escrever)
- Commit: `feat(ana): Sprint 1.1 - Router Haiku como pre-classificador`
- Push, esperar Render deployar, smoke test

### 4. Validar e plugar Sprint 1.3 (Grounding pré-envio)

Arquivo pronto: `backend/src/services/anaGroundingValidator.js`. Falta:

- Substituir a chamada atual de `_validarResposta` (pós-fato) por `anaGroundingValidator.validarPreEnvio` (pré-envio) em `processarMensagem`:
  ```js
  const anaGroundingValidator = require('./anaGroundingValidator');
  // depois de Sonnet gerar `resposta`, ANTES de extrair ações:
  const grounding = await anaGroundingValidator.validarPreEnvio({
    mensagemCliente: mensagem,
    respostaAna: resposta,
    historico,
    modoEquipe: modoEquipe.ehEquipe,
  });
  resposta = grounding.resposta_final; // se bloqueou, vira sugestão de transferência
  ```
- Remover (ou deprecar) `_validarResposta` e `_chamarClaudeValidacao` antigos no agenteIAService — agora estão em anaGroundingValidator
- `node --check` em tudo
- Commit: `feat(ana): Sprint 1.3 - grounding obrigatorio pre-envio`
- Push, smoke test

### 5. Regressão (~1h)

Script `backend/scripts/regressao-ana.js` (criar): replay das 30-50 conversas-problema offline contra ANA atualizada. Comparar respostas antes/depois. Métricas: % melhoradas, % regredidas, falsos positivos do router/grounding.

### 6. Limpeza do working tree

```bash
rm backend/src/services/.fuse_hidden*
rm backend/src/services/XXBunySr
rm backend/src/services/agenteIAService.js.bak_marcal_fixes
echo -e "\n.fuse_hidden*\n*.bak*" >> .gitignore
git add -A && git commit -m "chore: limpa lixo do working tree + .gitignore"
git push origin main
```

### 7. Sprint 2 em diante

Ver `ana-revisao-arquitetural.md` na raiz pra plano completo.

## Arquivos auxiliares

- `ana-revisao-arquitetural.md` — proposta arquitetural completa (10 mudanças, ordenadas por impacto)
- `backend/scripts/exportar-conversas-ana.js` — script local pra dump das conversas
