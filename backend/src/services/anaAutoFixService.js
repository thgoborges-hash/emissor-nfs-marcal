/**
 * ANA Auto-Fix — diagnóstico mecânico + correção de cadastros
 *
 * Sprint 1.5 da revisão arquitetural. Diretiva do Thiago: "ela tem que parar
 * de ficar jogando pro Thiago resolver. Teria que sempre achar uma alternativa
 * ou corrigir o problema."
 *
 * Quando emissão de NF falha por causa mecanicamente identificável (regex no
 * erro + condição clara no banco), corrige sozinha via UPDATE direto e
 * sinaliza ao caller que pode re-emitir. NUNCA chuta — só age em padrões
 * deterministicos.
 *
 * Regras de operação:
 * - Máximo 1 correção por NF por execução (evita loop)
 * - Sempre loga em console + retorna `motivo` pra anotar em observações
 * - Se o erro não bate com nenhum padrão conhecido, retorna null → caller
 *   escala pro humano normalmente
 * - Se o auto-fix der erro DIFERENTE na re-tentativa, caller também escala
 *   (não fica chutando em cadeia)
 *
 * Inspirado em: padrão de "self-healing agents" do AutoGen e do Adept ACT-1,
 * mas escopo intencionalmente restrito a correções determinísticas pra evitar
 * que ANA invente fatos.
 */

const cnpjService = require('./cnpjService');

/**
 * Tenta diagnosticar o erro e aplicar correção determinística no banco.
 *
 * @param {Object} params
 * @param {string} params.erroMsg     - mensagem de erro (já normalizada do SEFIN se possível)
 * @param {string[]} [params.codigosSefin=[]] - códigos extraídos do SEFIN (E0116, E0617, RNG6110, ...)
 * @param {Object} params.cliente     - cliente prestador (linha completa de `clientes`)
 * @param {Object} params.tomador     - tomador (linha completa de `tomadores`)
 * @param {Object} params.nota        - NF (linha completa de `notas_fiscais`)
 * @param {Object} params.db          - handle do better-sqlite3 (já aberto)
 * @returns {Promise<null | {aplicou:true, motivo:string, recarregar:{cliente?:boolean, tomador?:boolean}}>}
 *   null = não há correção determinística aplicável (escala humano)
 *   objeto = correção aplicada; caller deve recarregar entidades indicadas e re-emitir
 */
async function tentarCorrecao({ erroMsg, codigosSefin = [], cliente, tomador, nota, db } = {}) {
  if (!erroMsg || !cliente || !db) return null;

  const erro = String(erroMsg).toLowerCase();
  const codigos = (codigosSefin || []).map(c => String(c || '').toUpperCase());

  // ────────────────────────────────────────────────────────────────────
  // Padrão 1: erro de endereço do tomador (xLgr ausente / element 'end')
  // Sintomas: 'xlgr', 'element \'end\'', 'logradouro' no erro + tomador.logradouro vazio
  // ────────────────────────────────────────────────────────────────────
  if (
    tomador && !tomador.logradouro &&
    (/xlgr/i.test(erro) || /element\s+'end'/i.test(erro) || /logradouro/i.test(erro))
  ) {
    if (tomador.tipo_documento === 'CNPJ' && tomador.documento) {
      try {
        const dados = await cnpjService.consultarCNPJ(tomador.documento);
        if (dados?.logradouro) {
          const updates = { logradouro: dados.logradouro };
          if (!tomador.numero && dados.numero) updates.numero = dados.numero;
          if (!tomador.bairro && dados.bairro) updates.bairro = dados.bairro;
          if (!tomador.complemento && dados.complemento) updates.complemento = dados.complemento;
          _updateTomador(db, tomador.id, updates);
          return {
            aplicou: true,
            motivo: `endereço do tomador estava incompleto (sem logradouro); preenchido via Receita: "${dados.logradouro}, ${dados.numero || 's/n'}"`,
            recarregar: { tomador: true },
          };
        }
      } catch (err) {
        console.warn('[AutoFix] consulta Receita falhou no padrão 1:', err.message);
      }
    }
    // Sem caminho de correção automática
    return null;
  }

  // ────────────────────────────────────────────────────────────────────
  // Padrão 2: IM do prestador com caracteres não-numéricos no cadastro
  // O fix de ontem (commit f31c534) já strip-a no XML, mas se o erro veio antes
  // dessa cobertura ou o cadastro tem lixo, normaliza preventivamente.
  // ────────────────────────────────────────────────────────────────────
  if (
    cliente.inscricao_municipal &&
    /\D/.test(String(cliente.inscricao_municipal)) &&
    (/inscri[çc][ãa]o\s+municipal/i.test(erro) || /\bim\b/i.test(erro))
  ) {
    const limpa = String(cliente.inscricao_municipal).replace(/\D/g, '');
    if (limpa && limpa !== cliente.inscricao_municipal) {
      _updateCliente(db, cliente.id, { inscricao_municipal: limpa });
      return {
        aplicou: true,
        motivo: `IM do prestador tinha caracteres não-numéricos ("${cliente.inscricao_municipal}"); normalizada para "${limpa}"`,
        recarregar: { cliente: true },
      };
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Padrão 3: E0617 / E0713 — regime tributário inconsistente
  // Cliente cadastrado como Simples Nacional sem regApTribSN → default '1' (Receita Bruta)
  // ────────────────────────────────────────────────────────────────────
  if (codigos.some(c => c === 'E0617' || c === 'E0713') || /regime\s+tribut/i.test(erro)) {
    const isSimples = String(cliente.optante_simples || cliente.regime_simples_nacional || '0') !== '0';
    if (isSimples && !cliente.reg_ap_trib_sn) {
      _updateCliente(db, cliente.id, { reg_ap_trib_sn: '1' });
      return {
        aplicou: true,
        motivo: 'cliente é Simples Nacional mas estava sem regApTribSN; setado "1" (Receita Bruta — padrão ME/EPP)',
        recarregar: { cliente: true },
      };
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Padrão 4: E0116 — "A IM deve ser informada para o emitente prestador"
  //
  // Significado real: município tem CNC ativo e EXIGE IM no XML.
  // (Não é "IM não confere" como o código histórico assumia.)
  //
  // Bug histórico (corrigido em 2026-05-19): este padrão REMOVIA a IM do
  // cadastro quando vinha E0116, fazendo a próxima tentativa cair no mesmo
  // E0116 (agora sem IM no cadastro pra ser incluída). Causa raiz dos loops
  // de erro vistos em DDA CLINICA MEDICA (3 NFs travadas, R$ 500 cada).
  //
  // Comportamento correto:
  //   - Cliente SEM IM cadastrada → não há auto-fix; escala humano cadastrar.
  //   - Cliente COM IM cadastrada com lixo (alfanum) → Padrão 2 acima normaliza.
  //   - Cliente COM IM cadastrada válida → o XML builder agora inclui <IM> sempre
  //     que cliente.inscricao_municipal estiver preenchida. Re-emissão deveria
  //     funcionar sem mais ação. Se chegar aqui mesmo com IM válida, é cenário
  //     inesperado → escala.
  // ────────────────────────────────────────────────────────────────────
  if (codigos.includes('E0116')) {
    if (!cliente.inscricao_municipal) {
      // Sem IM cadastrada — humano precisa cadastrar.
      return null;  // escala
    }
    // Tem IM cadastrada mas E0116 mesmo assim — possível timing (re-emissão
    // antes do deploy do fix do XML builder) ou IM com lixo. Padrão 2 já
    // cobre normalização; aqui só evita o comportamento antigo de REMOVER.
    return null;  // sem auto-fix mecânico
  }

  // ────────────────────────────────────────────────────────────────────
  // Padrão 4.5: E0120 — "A IM não deve ser informada, pois não existem
  // informações complementares registradas no CNC NFS-e do município emissor"
  //
  // Significado: município SEM CNC ativo e o XML enviou <IM>. Operador
  // pode ter cadastrado IM em município que não exige (ou IM de outro
  // contexto). Remove do cadastro pra próximas emissões não incluírem.
  // ────────────────────────────────────────────────────────────────────
  if (codigos.includes('E0120') && cliente.inscricao_municipal) {
    const imAntiga = cliente.inscricao_municipal;
    _updateCliente(db, cliente.id, { inscricao_municipal: null });
    return {
      aplicou: true,
      motivo: `município do prestador não tem CNC NFS-e ativo — IM "${imAntiga}" removida do cadastro (E0120). Re-emissão sem IM.`,
      recarregar: { cliente: true },
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Padrão 5: codigo_municipio do tomador inválido (pode acontecer pra CPF
  // ou tomador novo importado sem IBGE)
  // ────────────────────────────────────────────────────────────────────
  if (
    tomador && (/c[óo]digo[\s_]*munic[íi]pio/i.test(erro) || /cMun/i.test(erro)) &&
    (!tomador.codigo_municipio || !/^\d{7}$/.test(String(tomador.codigo_municipio)))
  ) {
    if (tomador.tipo_documento === 'CNPJ' && tomador.documento) {
      try {
        const dados = await cnpjService.consultarCNPJ(tomador.documento);
        if (dados?.codigoMunicipio && /^\d{7}$/.test(String(dados.codigoMunicipio))) {
          _updateTomador(db, tomador.id, {
            codigo_municipio: dados.codigoMunicipio,
            municipio: dados.municipio || tomador.municipio,
            uf: dados.uf || tomador.uf,
          });
          return {
            aplicou: true,
            motivo: `codigo_municipio do tomador inválido; corrigido via Receita para ${dados.codigoMunicipio} (${dados.municipio}/${dados.uf})`,
            recarregar: { tomador: true },
          };
        }
      } catch (err) {
        console.warn('[AutoFix] consulta Receita falhou no padrão 5:', err.message);
      }
    }
  }

  // Nenhum padrão bateu — escala pro humano
  return null;
}

// ── helpers internos ────────────────────────────────────────────────────────

function _updateCliente(db, id, campos) {
  const sets = [];
  const values = [];
  for (const [k, v] of Object.entries(campos)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE clientes SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
}

function _updateTomador(db, id, campos) {
  const sets = [];
  const values = [];
  for (const [k, v] of Object.entries(campos)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE tomadores SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
}

module.exports = {
  tentarCorrecao,
};
