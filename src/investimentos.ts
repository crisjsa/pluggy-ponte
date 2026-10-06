// Converte investimentos e movimentações da Pluggy para o formato do app web.

import * as z from "zod/v4";
import { amountBRL, type Investment, type InvestmentTransaction, type Transaction } from "./pluggy.ts";
import type { Provento } from "./proventos.ts";

export const InvestimentoSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  banco: z.string().nullable().describe("Onde o investimento está (na XP, a corretora)"),
  titular: z.string().nullable().describe("Dono, pelas contas da mesma conexão (a Pluggy não informa no investimento)"),
  tipo: z.string().describe("ação, FII, BDR, ETF, fundo, renda fixa, Tesouro, previdência, COE, outro"),
  subtipo: z.string().nullable().describe("ex.: CDB, LCA, ação, FII, fundo de renda fixa"),
  tipoPluggy: z.string(),
  subtipoPluggy: z.string().nullable(),
  nome: z.string(),
  codigo: z.string().nullable().describe("Ticker em ações/FIIs; CNPJ em fundos; código do título em renda fixa"),
  quantidade: z.number().nullable(),
  precoAtual: z.number().nullable(),
  valorAtual: z.number().nullable().describe("Valor bruto atual, em reais"),
  valorLiquido: z.number().nullable().describe("Valor atual descontados impostos, em reais"),
  valorInvestido: z.number().nullable().describe("Quando a Pluggy informa (nos dados reais, só renda fixa)"),
  rentabilidade: z.number().nullable().describe("Ganho em reais"),
  rentabilidadeFonte: z
    .enum(["pluggy", "calculada"])
    .nullable()
    .describe("calculada = valorAtual − valorInvestido (a Pluggy não informou)"),
  taxa: z.string().nullable().describe("Renda fixa: taxa contratada, ex.: \"104% CDI\""),
  vencimento: z.string().nullable(),
  moeda: z.string().nullable(),
  status: z.string().nullable().describe("ativo, resgatado ou o status original da Pluggy"),
  dataAtualizacao: z.string().nullable().describe("Data da posição (AAAA-MM-DD)"),
});
export type Investimento = z.infer<typeof InvestimentoSchema>;

export const MovimentoSchema = z.object({
  id: z.string().describe("Na origem \"conta\", é o id da transação em listar_transacoes"),
  origem: z
    .enum(["investimento", "conta"])
    .describe("investimento = movimentação informada pela corretora; conta = provento achado no extrato da conta"),
  investimentoId: z.string().nullable().describe("null se o provento não pôde ser ligado a um investimento pelo ticker"),
  investimentoNome: z.string(),
  ticker: z.string().nullable(),
  data: z.string().describe("AAAA-MM-DD"),
  tipo: z.enum(["compra", "venda", "dividendo", "JCP", "rendimento", "amortização", "imposto", "transferência", "outro"]),
  tipoPluggy: z.string().describe("Tipo do movimento na Pluggy; na origem \"conta\", a categoria da transação"),
  quantidade: z.number().nullable().describe("Em proventos: cotas/ações que geraram o provento"),
  precoUnitario: z.number().nullable().describe("Em proventos: valor por cota/ação"),
  valor: z.number().nullable().describe("Valor bruto"),
  valorLiquido: z.number().nullable(),
  descricao: z.string().nullable(),
});
export type Movimento = z.infer<typeof MovimentoSchema>;

const SUBTIPOS: Record<string, string> = {
  STOCK: "ação",
  REAL_ESTATE_FUND: "FII",
  BDR: "BDR",
  ETF: "ETF",
  DERIVATIVES: "derivativo",
  OPTION: "opção",
  CDB: "CDB",
  LCI: "LCI",
  LCA: "LCA",
  LC: "LC",
  LF: "LF",
  LIG: "LIG",
  CRI: "CRI",
  CRA: "CRA",
  DEBENTURES: "debênture",
  CORPORATE_DEBT: "título privado",
  TREASURY: "Tesouro Direto",
  INVESTMENT_FUND: "fundo de investimento",
  FIXED_INCOME_FUND: "fundo de renda fixa",
  MULTIMARKET_FUND: "fundo multimercado",
  STOCK_FUND: "fundo de ações",
  EXCHANGE_FUND: "fundo cambial",
  ETF_FUND: "fundo de índice",
  OFFSHORE_FUND: "fundo no exterior",
  FIP_FUND: "FIP",
  RETIREMENT: "previdência",
  PGBL: "PGBL",
  VGBL: "VGBL",
  STRUCTURED_NOTE: "COE",
};

function tipoEmPortugues(type: string, subtype: string | null): string {
  if (subtype === "TREASURY") return "Tesouro";
  switch (type) {
    case "FIXED_INCOME":
      return "renda fixa";
    case "MUTUAL_FUND":
      return "fundo";
    case "ETF":
      return "ETF";
    case "SECURITY":
      return "previdência";
    case "COE":
      return "COE";
    case "EQUITY":
      if (subtype === "STOCK") return "ação";
      if (subtype === "REAL_ESTATE_FUND") return "FII";
      if (subtype === "BDR") return "BDR";
      if (subtype === "ETF") return "ETF";
      return "renda variável";
    default:
      return "outro";
  }
}

function taxa(inv: Investment): string | null {
  if (inv.type !== "FIXED_INCOME") return null;
  const partes: string[] = [];
  if (inv.rate && inv.rateType) partes.push(`${inv.rate}% ${inv.rateType}`);
  else if (inv.rateType) partes.push(inv.rateType);
  if (inv.fixedAnnualRate) partes.push(`${inv.fixedAnnualRate}% a.a.`);
  return partes.length ? partes.join(" + ") : null;
}

const STATUS: Record<string, string> = { ACTIVE: "ativo", TOTAL_WITHDRAWAL: "resgatado" };
const arred = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100) / 100);
const data = (iso: string | null | undefined) => iso?.slice(0, 10) ?? null;

export function toInvestimento(inv: Investment, banco: string | null, titular: string | null): Investimento {
  const investido = inv.amountOriginal && inv.amountOriginal > 0 ? inv.amountOriginal : null;
  const [rentabilidade, rentabilidadeFonte] =
    inv.amountProfit != null
      ? [inv.amountProfit, "pluggy" as const]
      : investido != null && inv.amount != null
        ? [inv.amount - investido, "calculada" as const]
        : [null, null];

  return {
    id: inv.id,
    itemId: inv.itemId,
    banco,
    titular,
    tipo: tipoEmPortugues(inv.type, inv.subtype),
    subtipo: inv.subtype ? (SUBTIPOS[inv.subtype] ?? inv.subtype) : null,
    tipoPluggy: inv.type,
    subtipoPluggy: inv.subtype,
    nome: inv.name.replace(/\s+/g, " ").trim(),
    codigo: inv.code?.trim() || null,
    quantidade: inv.quantity,
    precoAtual: inv.value,
    valorAtual: arred(inv.amount),
    valorLiquido: arred(inv.balance),
    valorInvestido: arred(investido),
    rentabilidade: arred(rentabilidade),
    rentabilidadeFonte,
    taxa: taxa(inv),
    vencimento: data(inv.dueDate),
    moeda: inv.currencyCode,
    status: inv.status ? (STATUS[inv.status] ?? inv.status) : null,
    dataAtualizacao: data(inv.date),
  };
}

// Ticker só faz sentido em renda variável (em fundos o code é o CNPJ; em renda fixa, o código do título).
const tickerDoInvestimento = (inv: Investment) => (inv.type === "EQUITY" || inv.type === "ETF" ? inv.code?.trim() || null : null);

// Liga um provento ao investimento pelo ticker: primeiro na mesma conexão, depois em qualquer uma.
// Também procura o código no nome (fundos fechados como "TGRI" vêm com o CNPJ no code).
export function acharInvestimento(ticker: string | null, itemId: string, investimentos: Investment[]): Investment | null {
  if (!ticker) return null;
  const casa = (inv: Investment) =>
    inv.code?.trim().toUpperCase() === ticker || new RegExp(`\\b${ticker}\\b`, "i").test(inv.name);
  return investimentos.find((inv) => inv.itemId === itemId && casa(inv)) ?? investimentos.find(casa) ?? null;
}

export function proventoToMovimento(t: Transaction, provento: Provento, inv: Investment | null): Movimento {
  const valor = arred(amountBRL(t));
  const descricao = t.description.replace(/\s+/g, " ").trim();
  return {
    id: t.id,
    origem: "conta",
    investimentoId: inv?.id ?? null,
    investimentoNome: inv ? inv.name.replace(/\s+/g, " ").trim() : (provento.ticker ?? descricao),
    ticker: provento.ticker,
    data: t.date.slice(0, 10),
    tipo: provento.tipo,
    tipoPluggy: t.category ?? "(sem categoria)",
    quantidade: provento.quantidade,
    precoUnitario: valor != null && provento.quantidade ? Math.round((valor / provento.quantidade) * 1e6) / 1e6 : null,
    valor,
    valorLiquido: valor, // valor creditado na conta (no JCP, já com o IR retido)
    descricao,
  };
}

// Tipos de movimento. Nos dados reais só vieram BUY e SELL; os demais seguem a API e a
// descrição, para não perder dividendos/JCP se a Pluggy passar a enviá-los.
function tipoDoMovimento(t: InvestmentTransaction): Movimento["tipo"] {
  const texto = `${t.type} ${t.description ?? ""}`.toUpperCase();
  if (t.type === "BUY") return "compra";
  if (t.type === "SELL") return "venda";
  if (/JCP|JUROS SOBRE CAPITAL/.test(texto)) return "JCP";
  if (/DIVIDEND/.test(texto)) return "dividendo";
  if (/AMORTIZ/.test(texto)) return "amortização";
  if (/INTEREST|INCOME|RENDIMENTO|YIELD|COUPON|CUPOM/.test(texto)) return "rendimento";
  if (/TAX|IMPOSTO|IR\b|IOF/.test(texto)) return "imposto";
  if (/TRANSFER/.test(texto)) return "transferência";
  return "outro";
}

export function toMovimento(t: InvestmentTransaction, inv: Investment): Movimento {
  return {
    id: t.id,
    origem: "investimento",
    investimentoId: inv.id,
    investimentoNome: inv.name.replace(/\s+/g, " ").trim(),
    ticker: tickerDoInvestimento(inv),
    data: (t.date ?? t.tradeDate ?? "").slice(0, 10),
    tipo: tipoDoMovimento(t),
    tipoPluggy: t.type,
    quantidade: t.quantity,
    precoUnitario: t.value,
    valor: arred(t.amount),
    valorLiquido: arred(t.netAmount),
    descricao: t.description?.trim() || null,
  };
}
