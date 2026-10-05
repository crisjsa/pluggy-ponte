// Converte os dados da Pluggy para o formato que o app web consome.
// Sem acesso à rede: só transformação de dados.

import * as z from "zod/v4";
import type { Account, Transaction } from "./pluggy.ts";

export const TransacaoSchema = z.object({
  id: z.string().describe("ID da transação na Pluggy. Use para evitar duplicadas."),
  data: z.string().describe("Data no formato AAAA-MM-DD"),
  descricao: z.string(),
  valor: z.number().describe("Sempre positivo; o sentido está em `tipo`"),
  tipo: z.enum(["entrada", "saida"]),
  contaId: z.string(),
  contaNome: z.string(),
  cartao: z.boolean().describe("true se a conta é um cartão de crédito"),
  status: z.enum(["pendente", "confirmada"]),
  categoriaPluggy: z.string().nullable().describe("Categoria da Pluggy, sem tradução (ex.: \"Food delivery\")"),
  categoriaPluggyId: z.string().nullable().describe("ID da categoria na Pluggy"),
  pagamentoFatura: z
    .boolean()
    .describe("true no pagamento de fatura de cartão (débito na conta e entrada no cartão). Some só um dos lados para não contar em dobro."),
});
export type Transacao = z.infer<typeof TransacaoSchema>;

export const ContaSchema = z.object({
  id: z.string(),
  nome: z.string(),
  cartao: z.boolean(),
  saldo: z.number().describe("Conta: saldo disponível. Cartão: limite usado (inclui parcelas futuras)."),
});
export type Conta = z.infer<typeof ContaSchema>;

export const accountName = (acc: Account) => (acc.marketingName ?? acc.name).trim();

export function toConta(acc: Account): Conta {
  return { id: acc.id, nome: accountName(acc), cartao: acc.type === "CREDIT", saldo: acc.balance };
}

// O sinal do amount da Pluggy é invertido entre conta e cartão:
//   conta:  negativo = saída     | cartão: positivo = compra (saída)
export function toTransacao(t: Transaction, acc: Account, pagamentoFatura: boolean): Transacao {
  const cartao = acc.type === "CREDIT";
  const saida = cartao ? t.amount > 0 : t.amount < 0;
  const m = t.creditCardMetadata;
  const parcela = m?.totalInstallments ? ` (${m.installmentNumber}/${m.totalInstallments})` : "";

  return {
    id: t.id,
    data: t.date.slice(0, 10),
    // O banco manda espaços de preenchimento ("ACAI FRUTO DO PARA     BELO HORIZONT").
    descricao: t.description.replace(/\s+/g, " ").trim() + parcela,
    valor: Math.abs(t.amount),
    tipo: saida ? "saida" : "entrada",
    contaId: acc.id,
    contaNome: accountName(acc),
    cartao,
    status: t.status === "PENDING" ? "pendente" : "confirmada",
    categoriaPluggy: t.category ?? null,
    categoriaPluggyId: t.categoryId ?? null,
    pagamentoFatura,
  };
}
