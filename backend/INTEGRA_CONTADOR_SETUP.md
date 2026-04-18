# Integra Contador (SERPRO) — Setup

Integração com as APIs oficiais do SERPRO/RFB pra consulta e emissão de obrigações fiscais em nome dos clientes da Marçal. Usa o e-CNPJ A1 da Marçal + procuração coletiva (todos os clientes já outorgaram procuração eletrônica à Marçal no e-CAC).

## Passo a passo

### 1. Contratar o serviço
- Acessar: https://loja.serpro.gov.br/integracontador
- Clicar em "Quero contratar", fazer login com e-CNPJ Marçal
- Escolher os módulos. Recomendado começar com:
  - `Integra-SN` (PGDAS-D, DAS do Simples)
  - `Integra-MEI` (DAS do MEI)
  - `Integra-DCTFWeb`
  - `Integra-Sicalc` (DARF)
  - `Integra-Procurações` (validação)
  - `Integra-CaixaPostal` (mensagens e-CAC)
- Modelo é pay-per-use (por chamada). Pra volumes de escritório médio, o custo fica em dezenas de reais por mês.

### 2. Obter Consumer Key + Secret
- Após contratação ativa: https://cliente.serpro.gov.br
- Entrar em "Minhas APIs" → "Integra Contador"
- Copiar `ConsumerKey` e `ConsumerSecret`

### 3. Configurar variáveis de ambiente (Render)
No painel do Render → Environment:
```
SERPRO_CONSUMER_KEY=<valor>
SERPRO_CONSUMER_SECRET=<valor>
MARCAL_CNPJ=<CNPJ da Marçal, só dígitos>
```

### 4. Fazer upload do e-CNPJ A1 da Marçal
Autenticado no painel do escritório, chamar:
```
POST /api/integra-contador/certificado/upload
Content-Type: multipart/form-data
Authorization: Bearer <jwt>

certificado: <arquivo .pfx>
senha: <senha do certificado>
```

A rota valida o certificado, salva em `CERTIFICADOS_DIR/escritorio_marcal.pfx` e devolve a senha criptografada. Colar o valor retornado em:
```
MARCAL_CERT_SENHA_ENCRYPTED=<valor retornado>
```

### 5. Testar
```bash
# 5.1 — status do módulo (verifica se tudo está configurado)
curl -H "Authorization: Bearer $TOKEN" https://emissor-nfs-marcal.onrender.com/api/integra-contador/status

# 5.2 — teste de autenticação (valida cert + credenciais SERPRO)
curl -X POST -H "Authorization: Bearer $TOKEN" https://emissor-nfs-marcal.onrender.com/api/integra-contador/autenticar/teste

# 5.3 — consulta última PGDAS-D de um cliente (exemplo)
curl -H "Authorization: Bearer $TOKEN" \
  https://emissor-nfs-marcal.onrender.com/api/integra-contador/pgdasd/ultima-declaracao/12345678000199
```

## Endpoints disponíveis

Todos exigem autenticação de escritório (`Authorization: Bearer <jwt>`).

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/integra-contador/status` | Healthcheck do módulo |
| POST | `/api/integra-contador/certificado/upload` | Upload do e-CNPJ A1 |
| POST | `/api/integra-contador/autenticar/teste` | Testa autenticação SERPRO |
| POST | `/api/integra-contador/das/simples` | Gera DAS do Simples Nacional |
| POST | `/api/integra-contador/das/mei` | Gera DAS do MEI |
| GET | `/api/integra-contador/pgdasd/ultima-declaracao/:cnpj` | Última declaração PGDAS-D |
| GET | `/api/integra-contador/das/:cnpj/:numeroDas` | Extrato de um DAS |
| GET | `/api/integra-contador/procuracoes/:cnpj` | Procurações e-CAC vigentes |
| GET | `/api/integra-contador/caixa-postal/:cnpj` | Mensagens da Caixa Postal e-CAC |
| GET | `/api/integra-contador/dctfweb/:cnpj` | Relação DCTFWeb |
| POST | `/api/integra-contador/chamar` | Chamada genérica (escape hatch) |

## Arquitetura

- `config/integraContador.js` — endpoints, catálogo de serviços, credenciais
- `services/integraContadorService.js` — OAuth2 + mTLS + wrappers de alto nível
- `routes/integraContador.js` — REST endpoints pro painel e pra ANA

O service mantém cache do `access_token` em memória (TTL ~33min, folga de 60s pra renovar). Ao receber HTTP 401 de um token expirado, faz retry transparente uma vez.

## Segurança

- A senha do e-CNPJ é criptografada com AES-256-GCM usando `CERT_ENCRYPTION_KEY` (já configurado no Render)
- O arquivo `.pfx` fica em `/app/data/certificados/escritorio_marcal.pfx` (disco persistente)
- As credenciais SERPRO são lidas só das variáveis de ambiente, nunca persistidas no banco
- Todas as rotas exigem JWT de escritório (`apenasEscritorio` middleware)

## Próximos passos (além deste POC)

1. Integrar com a ANA (`agenteIAService.js`) — expor tools de consulta/emissão DAS via function-calling do Claude
2. Adicionar log de auditoria por chamada (quem pediu, qual cliente, qual serviço, resultado)
3. Criar cron job "obrigações da semana" — varre a carteira, lista DAS vencendo e manda resumo no WhatsApp da equipe
4. Expor no painel: botão "Emitir DAS do cliente X" direto da visão 360° do cliente
