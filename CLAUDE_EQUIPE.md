# Projeto Marçal Contabilidade — Equipe

Este workspace é o ambiente compartilhado de trabalho do escritório **Marçal Contabilidade** (Curitiba/PR), do Thiago Borges, para evolução diária do **Emissor NFs**, **Cockpit interno**, **ANA (agente IA no WhatsApp)**, integrações **SERPRO/Integra Contador**, **Domínio (Thomson Reuters)**, **OneDrive Marçal** e dashboards gerenciais.

> Este `CLAUDE.md` é lido automaticamente pelo Claude de cada pessoa da equipe ao abrir este workspace. Mantém todo mundo no mesmo contexto sem depender de memória individual.

## Quem é a equipe

| Pessoa | Papel | GitHub |
|---|---|---|
| Thiago Borges | Owner do projeto, responsável técnico | thgoborges-hash |
| Janaina | Operadora Domínio, colabora no projeto | (a preencher) |
| Lucas | Operador Domínio, colabora no projeto | (a preencher) |

Todos têm Claude Desktop com licença individual e usam Cowork mode. Memória pessoal de cada um continua privada — o contexto compartilhado fica neste arquivo e nos docs do repositório.

## Repositórios (todos concentrados na conta `thgoborges-hash`)

| Repo | Propósito | URL |
|---|---|---|
| `emissor-nfs-marcal` | Código-fonte do sistema (backend Node + frontend React + integrações + ANA) | github.com/thgoborges-hash/emissor-nfs-marcal |
| `marcal-skills-marketplace` | Marketplace privado com as skills do Claude (dashboard-dre, portal-dre, dre-extrato, fluxo-racco) | github.com/thgoborges-hash/marcal-skills-marketplace |

A Janaina e o Lucas têm permissão de **push direto** em ambos. Isso significa: trabalhem sempre em `git pull --rebase origin main` antes de começar, e não façam force-push em main.

## Como cada pessoa configura o ambiente

Passo a passo completo em `ONBOARDING_EQUIPE.md` (raiz deste workspace).

Resumo:

1. Aceitar convite GitHub e clonar `emissor-nfs-marcal` em alguma pasta local (ex: `~/Documents/Claude/Projects/Emissor NFs - Marçal/emissor-nfs/`)
2. No Claude Desktop, selecionar a pasta-pai (`Emissor NFs - Marçal/`) como workspace do Cowork
3. Instalar o marketplace de skills: `/plugin marketplace add github.com/thgoborges-hash/marcal-skills-marketplace`
4. Instalar o plugin: `/plugin install marcal-financeiro@marcal-skills-marketplace`
5. Configurar credenciais externas próprias (SERPRO, Domínio, OneDrive) — ver `ONBOARDING_EQUIPE.md`

## Convenções de trabalho

### Git

- **Branch principal:** `main` (Render auto-deploy em ~2min)
- **Push direto em main:** OK, mas avisar no grupo do escritório se for em horário comercial e mexer em ANA/produção
- **Mudanças em ANA (`backend/src/services/agenteIAService.js` e afins):** rodar `node --check` antes de commitar
- **Migrações de banco** (`backend/src/db/`) ou env novas: avisar no grupo + atualizar este `CLAUDE.md`
- **Mensagens de commit** em português, formato curto: `feat(ana): ...`, `fix(emissor): ...`, `chore: ...`

### Push do GitHub via Cowork

Push pelo terminal do Cowork pode falhar (proxy bloqueia tráfego git em algumas máquinas). Se acontecer:

- Use o terminal nativo do macOS/Windows (fora do Cowork) pra rodar `git push`
- Token fine-grained do GitHub fica salvo no keychain/credential manager do SO
- Alternativa: usar Claude Code (CLI) que não tem o proxy

### Modo equipe da ANA

Cada operador (Thiago, Janaina, Lucas) precisa estar cadastrado em `ANA_OPERADORES` (env do Render) ou na tabela `ana_operadores` para a ANA reconhecer mensagens com prefixo "Nome:" como modo equipe. Sem isso, mensagens da equipe são interpretadas como cliente final e podem disparar emissão de NF involuntária.

Cadastro atual em `ANA_OPERADORES`:
```
Janaina Alves,Lucas Silva,Thiago Borges
```

Se o nome de alguém não estiver exato (incluindo sobrenome), pedir ao Thiago para atualizar.

### Modo equipe — `cliente_id` default é Marçal

Quando a ANA opera em modo equipe e o operador não especificou cliente, o `cliente_id` default vira o registro da Marçal. **Não usar `cliente_id` como filtro em ações novas sem checar isso primeiro** — vira bug fiscal silencioso (emite NF da Marçal em vez do cliente certo).

## Documentos importantes

- `emissor-nfs/CLAUDE.md` — contexto técnico detalhado do código (stack, decisões arquiteturais, sprints da ANA)
- `emissor-nfs/ana-revisao-arquitetural.md` — proposta arquitetural completa da ANA (10 mudanças ordenadas por impacto)
- `ONBOARDING_EQUIPE.md` — passo a passo de setup pra novos membros
- `ROADMAP_EQUIPE.html` — roadmap visual do projeto (abre no navegador)
- `VISAO_SOLUCAO.md` — visão de produto

## Pontos de atenção / regras gerais

- **Nunca commitar credenciais.** Chaves SERPRO, tokens Domínio, certificados A1, JWT secrets — tudo em variáveis de ambiente do Render. Nada em arquivo versionado.
- **Não tocar em `/app/data/` em produção** sem alinhar — é onde fica o SQLite e os certificados A1 dos clientes.
- **Render auto-deploya `main`** em ~2min. Mudança quebrada em produção afeta NF emitida em tempo real.
- **NFs emitidas em produção desde 07/04/2026** (NF 111+). Não é mais ambiente de teste.
- **Push do código só do terminal do Thiago** historicamente, mas com a Janaina e o Lucas como collaborators isso muda — eles têm push direto, mas devem comunicar mudanças sensíveis no grupo antes.

## Estado atual dos projetos (resumo)

| Projeto | Status | Próximo passo |
|---|---|---|
| Emissor NFs (NFS-e Nacional) | Em produção desde 07/04/2026 | NFs 111+ emitidas |
| ANA no WhatsApp | Em produção (Z-API) | Sprint 1.1 (Router Haiku) e 1.3 (Grounding) prontos pra plugar — código em `emissor-nfs/backend/src/services/anaRouterService.js` e `anaGroundingValidator.js`, **não pushados** ainda |
| Integra Contador (SERPRO) | Fase 1 produção (procuração coletiva ativa) | Fase 2 = expor ações na ANA do WhatsApp |
| Domínio API (Thomson Reuters) | Em produção (OAuth2 + upload XML Onvio) | Manter |
| OneDrive Marçal (Microsoft Graph) | Etapas 1+2 em produção (26/04/2026), 12 A1 cadastrados auto | Etapa 3 = OCR cartão CNPJ → IM (pendente) |
| Dashboards (DRE, Portal, Racco) | Em produção (skills do marketplace) | Manter |

## Como reportar problemas / pedir ajuda

- Bug em produção: avisar o Thiago direto (WhatsApp / grupo do escritório)
- Dúvida arquitetural: abrir issue no repo `emissor-nfs-marcal` ou perguntar no grupo
- Conflito de merge: rebase local + pedir review do Thiago se mexer em ANA ou rotas de pagamento

---

Última atualização: 2026-05-08 — Thiago Borges
