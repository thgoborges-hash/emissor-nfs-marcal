/**
 * Serviço de consulta de CNPJ via BrasilAPI
 * Consulta dados públicos da Receita Federal (razão social, endereço, situação cadastral)
 */

const https = require('https');

const BRASIL_API_URL = 'https://brasilapi.com.br/api/cnpj/v1';

class CnpjService {
  /**
   * Consulta CNPJ na BrasilAPI (Receita Federal)
   * @param {string} cnpj - CNPJ com ou sem formatação
   * @returns {object|null} Dados da empresa ou null se não encontrar
   */
  async consultarCNPJ(cnpj) {
    const cnpjLimpo = cnpj.replace(/\D/g, '');

    if (cnpjLimpo.length !== 14) {
      console.log(`[CNPJ] CNPJ inválido (tamanho): ${cnpjLimpo}`);
      return null;
    }

    try {
      const dados = await this._fazerRequisicao(`${BRASIL_API_URL}/${cnpjLimpo}`);

      if (!dados || dados.status === 404) {
        console.log(`[CNPJ] CNPJ não encontrado: ${cnpjLimpo}`);
        return null;
      }

      // Mapeia para formato padronizado
      const resultado = {
        cnpj: cnpjLimpo,
        cnpjFormatado: this._formatarCNPJ(cnpjLimpo),
        razaoSocial: dados.razao_social || '',
        nomeFantasia: dados.nome_fantasia || '',
        situacaoCadastral: dados.descricao_situacao_cadastral || '',
        ativa: (dados.descricao_situacao_cadastral || '').toUpperCase() === 'ATIVA',
        // Endereço
        logradouro: dados.logradouro || '',
        numero: dados.numero || '',
        complemento: dados.complemento || '',
        bairro: dados.bairro || '',
        municipio: dados.municipio || '',
        uf: dados.uf || '',
        cep: (dados.cep || '').replace(/\D/g, ''),
        codigoMunicipioSIAFI: dados.codigo_municipio ? String(dados.codigo_municipio) : '',
        codigoMunicipio: '', // Será preenchido com código IBGE de 7 dígitos
        // Contato
        email: dados.email || '',
        telefone: dados.ddd_telefone_1 || '',
        // Atividade
        cnaePrincipal: dados.cnae_fiscal ? String(dados.cnae_fiscal) : '',
        descricaoCnae: dados.cnae_fiscal_descricao || '',
        // Natureza jurídica
        naturezaJuridica: dados.natureza_juridica || '',
        porte: dados.porte || '',
        // Dados originais completos (caso precise de algo extra)
        _raw: dados
      };

      // Tenta obter o código IBGE (7 dígitos) a partir do município e UF
      if (resultado.municipio && resultado.uf) {
        try {
          const codigoIBGE = await this._buscarCodigoIBGE(resultado.municipio, resultado.uf);
          if (codigoIBGE) {
            resultado.codigoMunicipio = codigoIBGE;
            console.log(`[CNPJ] Código IBGE obtido: ${codigoIBGE} (${resultado.municipio}/${resultado.uf})`);
          }
        } catch (ibgeErr) {
          console.error(`[CNPJ] Erro ao buscar código IBGE:`, ibgeErr.message);
        }
      }

      console.log(`[CNPJ] Consulta OK: ${resultado.razaoSocial} (${resultado.cnpjFormatado}) - ${resultado.situacaoCadastral}`);
      return resultado;

    } catch (err) {
      console.error(`[CNPJ] Erro ao consultar ${cnpjLimpo}:`, err.message);
      return null;
    }
  }

  /**
   * Faz requisição HTTPS GET
   */
  _fazerRequisicao(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'EmissorNFSe-Marcal/1.0',
          'Accept': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode === 200) {
              resolve(parsed);
            } else {
              console.log(`[CNPJ] API retornou status ${res.statusCode}`);
              resolve(null);
            }
          } catch (e) {
            reject(new Error(`Erro ao parsear resposta: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Timeout na consulta CNPJ'));
      });
    });
  }

  /**
   * Busca código IBGE de 7 dígitos a partir do nome do município e UF
   * Usa a API do IBGE: https://servicodados.ibge.gov.br
   */
  async _buscarCodigoIBGE(municipio, uf) {
    // Cache em memória para evitar consultas repetidas
    if (!this._cacheIBGE) this._cacheIBGE = {};
    const cacheKey = `${uf}_${municipio}`.toUpperCase();
    if (this._cacheIBGE[cacheKey]) return this._cacheIBGE[cacheKey];

    try {
      const url = `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`;
      const municipios = await this._fazerRequisicao(url);

      if (!municipios || !Array.isArray(municipios)) return null;

      // Normaliza o nome para comparação (remove acentos, maiúsculas)
      const normalizar = (str) =>
        str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();

      const nomeNormalizado = normalizar(municipio);

      // Busca exata primeiro
      let encontrado = municipios.find(m => normalizar(m.nome) === nomeNormalizado);

      // Se não achou, tenta busca parcial
      if (!encontrado) {
        encontrado = municipios.find(m => normalizar(m.nome).includes(nomeNormalizado) || nomeNormalizado.includes(normalizar(m.nome)));
      }

      if (encontrado) {
        const codigo = String(encontrado.id);
        this._cacheIBGE[cacheKey] = codigo;
        return codigo;
      }

      console.log(`[IBGE] Município não encontrado: ${municipio}/${uf}`);
      return null;
    } catch (err) {
      console.error(`[IBGE] Erro na consulta: ${err.message}`);
      return null;
    }
  }

  /**
   * Formata CNPJ: 12345678000190 → 12.345.678/0001-90
   */
  _formatarCNPJ(cnpj) {
    const c = cnpj.replace(/\D/g, '');
    if (c.length !== 14) return cnpj;
    return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
  }

  /**
   * Formata CPF: 12345678901 → 123.456.789-01
   */
  _formatarCPF(cpf) {
    const c = cpf.replace(/\D/g, '');
    if (c.length !== 11) return cpf;
    return `${c.slice(0,3)}.${c.slice(3,6)}.${c.slice(6,9)}-${c.slice(9)}`;
  }
}

module.exports = new CnpjService();
