# Guia de Integração - NFS-e Nacional
## Marçal Contabilidade - Emissor de NFs

---

## O QUE VOCE PRECISA FAZER (Thiago)

### Passo 1: Cadastro no Portal NFS-e Nacional
1. Acesse: https://www.nfse.gov.br/EmissorNacional/Acesso/PrimeiroAcesso
2. Clique em "Primeiro Acesso"
3. Informe o CNPJ do escritório (Marçal Contabilidade)
4. Preencha: CPF, data de nascimento, titulo de eleitor, e-mail
5. Crie uma senha
6. Pronto! Voce terá acesso ao Portal do Contribuinte

### Passo 2: Solicitar Acesso ao Ambiente de Homologação (Teste)
1. Após o cadastro, acesse: https://www.nfse.gov.br
2. Faça login com certificado digital ou senha
3. No menu, procure "Configurações" ou "Ambiente de Testes"
4. O ambiente de Produção Restrita (homologação) permite testar sem gerar notas reais
5. URL do ambiente de teste: https://sefin.producaorestrita.nfse.gov.br

### Passo 3: Preparar os Certificados A1
Para cada cliente que emite NFs, voce precisa do certificado A1 (.pfx ou .p12):
- Baixe os certificados do Google Drive
- Anote a senha de cada um
- O sistema vai permitir fazer upload pelo painel do escritório

### Passo 4: Verificar Municípios
- Consulte se os municípios dos seus clientes já aderiram: https://www.gov.br/nfse
- A maioria já aderiu ao padrão nacional em 2025/2026

---

## INFORMAÇÕES TÉCNICAS (para referência)

### Arquitetura da API NFS-e Nacional

**Ambientes:**
- Produção Restrita (testes): `https://sefin.producaorestrita.nfse.gov.br`
- Produção (real): `https://sefin.nfse.gov.br`
- Swagger: `https://www.nfse.gov.br/swagger/contribuintesissqn/`

**Autenticação:** mTLS (mutual TLS) com certificado ICP-Brasil A1 ou A3

**Endpoints Principais:**
- `POST /sefin/contribuinte/nfse/DPS` - Enviar DPS (gera NFS-e)
- `GET /sefin/contribuinte/nfse/DPS/{id}` - Consultar DPS
- `POST /sefin/contribuinte/nfse/{chaveAcesso}/eventos` - Cancelamento e outros eventos
- `GET /sefin/contribuinte/danfse/{chaveAcesso}` - Baixar DANFSe (PDF)

**Formato dos Dados:**
- Rotas JSON (envio e resposta)
- DPS contém XML comprimido com GZip e codificado em Base64
- XML deve ser assinado digitalmente (XMLDSIG / W3C)

### Fluxo de Emissão
1. Sistema monta o DPS (JSON com dados da nota)
2. Gera XML da NFS-e
3. Assina o XML com certificado A1 (XMLDSIG)
4. Comprime com GZip e codifica em Base64
5. Envia via POST com mTLS
6. API retorna chave de acesso e número da NFS-e
7. Sistema salva e disponibiliza o DANFSe (PDF)

---

## STATUS DA IMPLEMENTAÇÃO

- [x] Sistema web funcionando (emissão simulada)
- [x] Banco de dados preparado para certificados
- [ ] Upload de certificados A1 (EM ANDAMENTO)
- [ ] Conexão mTLS com API
- [ ] Assinatura XMLDSIG
- [ ] Geração do DPS
- [ ] Emissão real via API
- [ ] Download do DANFSe (PDF)
- [ ] Cancelamento via API
