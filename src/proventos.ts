// Identifica proventos (rendimentos de FII/fundos, dividendos, JCP) em transações de
// conta corrente. A Pluggy não manda proventos na rota de investimentos; eles só
// aparecem no extrato da conta da corretora, por exemplo:
//   "RENDIMENTOS DE CLIENTES VGIP11 S/ 55"         → rendimento, VGIP11, 55 cotas
//   "JUROS S/ CAPITAL DE CLIENTES BBAS3 S/ 3"      → JCP, BBAS3, 3 ações
//   "RENDIMENTO FUNDO FECHADO BALCÃO TGRI - ..."   → rendimento, TGRI
//
// JCP é identificado pela DESCRIÇÃO: a Pluggy categoriza JCP como "Interests charged"
// (juros cobrados), o que está errado.

import { amountBRL, type Transaction } from "./pluggy.ts";

export type TipoProvento = "rendimento" | "dividendo" | "JCP";

export interface Provento {
  tipo: TipoProvento;
  ticker: string | null;
  quantidade: number | null; // cotas/ações que geraram o provento, quando a descrição informa
}

const JCP = /JUROS\s+S\/?\s*CAP|JUROS\s+SOBRE\s+(O\s+)?CAPITAL|\bJCP\b/i;
const DIVIDENDO = /DIVIDEND/i;
const RENDIMENTO = /RENDIMENTOS?\s+DE\s+CLIENTES|RENDIMENTOS?\s+(DE\s+)?FUNDO|RENDIMENTOS?\s+(DE\s+)?FII|PROVENTO/i;
// Rendimento do saldo parado na conta (conta remunerada): não é provento de um ativo.
const NAO_E_PROVENTO = /RENDIMENTO\s+AUTOM/i;

const TICKER_B3 = /\b([A-Z]{4}\d{1,2}[A-Z]?)\b/; // VGIP11, BBAS3, TAEE11, KNUQ11B...
const CODIGO_BALCAO = /BALC[AÃ]O\s+([A-Z0-9]{3,8})\b/i; // fundo fechado negociado em balcão
const QUANTIDADE = /S\/\s*(\d+)\s*$/; // "... S/ 55" no fim da descrição

export function identificarProvento(t: Transaction): Provento | null {
  if (amountBRL(t) <= 0) return null; // provento é sempre entrada
  const descricao = t.description.replace(/\s+/g, " ").trim();
  if (NAO_E_PROVENTO.test(descricao)) return null;

  let tipo: TipoProvento | null = null;
  if (JCP.test(descricao)) tipo = "JCP";
  else if (DIVIDENDO.test(descricao)) tipo = "dividendo";
  else if (RENDIMENTO.test(descricao) || t.category === "Proceeds interests and dividends") tipo = "rendimento";
  if (!tipo) return null;

  const ticker = (descricao.match(TICKER_B3)?.[1] ?? descricao.match(CODIGO_BALCAO)?.[1] ?? null)?.toUpperCase() ?? null;
  const qtd = descricao.match(QUANTIDADE)?.[1];
  return { tipo, ticker, quantidade: qtd ? Number(qtd) : null };
}
