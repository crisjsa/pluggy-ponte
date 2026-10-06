// Identifica pagamentos de fatura de cartão, tanto a entrada no cartão quanto
// o débito na conta. O app web usa isso para não contar o mesmo dinheiro duas vezes.
//
// A descrição não serve: no C6 o mesmo tipo de pagamento já apareceu como
// "PGTO FAT CARTAO C6", "Pagamento Boleto BCO C6 S.A." e "C6 BANK".
//
// Cartão: é pagamento a entrada que a Pluggy categoriza como "Credit card payment"
//   e, para cada pagamento registrado nas faturas do cartão que ainda não tenha
//   uma entrada marcada, UMA entrada de mesmo valor (data com até 3 dias de
//   diferença, a mais próxima). Uma por pagamento: no atraso, o Nubank lança
//   "Pagamento recebido" e "Crédito de atraso" com o mesmo valor, e só o
//   primeiro é pagamento. Exceção: uma cópia PENDENTE de um pagamento já
//   marcado também é pagamento (o C6 mantém as duas versões por um tempo).
// Conta corrente: só é pagamento se tiver PAR num cartão conectado: bater com
//   um pagamento registrado nas faturas desses cartões ou com uma entrada de
//   pagamento num deles. Pagar um cartão que não está conectado é um gasto real.

import { amountBRL, type Bill, type Transaction } from "./pluggy.ts";

const TOLERANCIA_DIAS = 3;
const DIA_MS = 86_400_000;

interface Pagamento {
  amount: number;
  date: string;
}

const distanciaDias = (a: string, b: string) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / DIA_MS;
const mesmoPagamento = (valor: number, data: string, p: Pagamento) =>
  Math.abs(p.amount - valor) < 0.01 && distanciaDias(p.date, data) <= TOLERANCIA_DIAS;

const pagamentosRegistrados = (bills: Bill[]): Pagamento[] =>
  bills.flatMap((bill) => (bill.payments ?? []).map((p) => ({ amount: p.amount, date: p.paymentDate })));

export interface BillPaymentMatcher {
  cartao: (t: Transaction) => boolean;
  contaCorrente: (t: Transaction) => boolean;
}

// billsByCard: faturas fechadas de cada cartão conectado (chave = id da conta do cartão).
// cardTransactions: transações dos cartões conectados.
export function billPaymentMatcher(billsByCard: Map<string, Bill[]>, cardTransactions: Transaction[] = []): BillPaymentMatcher {
  const marcadas = new Set<string>();

  for (const [cartaoId, bills] of billsByCard) {
    const entradas = cardTransactions.filter((t) => t.accountId === cartaoId && amountBRL(t) < 0);
    for (const t of entradas) if (t.category === "Credit card payment") marcadas.add(t.id);

    const usadas = new Set<string>();
    for (const p of pagamentosRegistrados(bills)) {
      const candidatas = entradas
        .filter((t) => !usadas.has(t.id) && mesmoPagamento(-amountBRL(t), t.date, p))
        .toSorted((a, b) => distanciaDias(a.date, p.date) - distanciaDias(b.date, p.date));
      const escolhida = candidatas.find((t) => marcadas.has(t.id)) ?? candidatas[0];
      if (escolhida) {
        marcadas.add(escolhida.id);
        usadas.add(escolhida.id);
      }
    }

    // Eco pendente: o C6 mantém "Inclusao de Pagamento" (PENDING) junto do "Pagamento recebido"
    // (POSTED) do mesmo pagamento. A cópia pendente também é pagamento, não um crédito a mais.
    const pagamentosDoCartao = entradas.filter((t) => marcadas.has(t.id));
    for (const t of entradas) {
      if (t.status !== "PENDING" || marcadas.has(t.id)) continue;
      const eco = pagamentosDoCartao.some(
        (p) => Math.abs(amountBRL(p) - amountBRL(t)) < 0.01 && distanciaDias(p.date, t.date) <= TOLERANCIA_DIAS,
      );
      if (eco) marcadas.add(t.id);
    }
  }

  // Pares para o débito em conta: pagamentos registrados + entradas de pagamento marcadas nos cartões.
  const pares: Pagamento[] = [
    ...pagamentosRegistrados([...billsByCard.values()].flat()),
    ...cardTransactions.filter((t) => marcadas.has(t.id)).map((t) => ({ amount: -amountBRL(t), date: t.date })),
  ];

  return {
    cartao: (t) => marcadas.has(t.id),
    contaCorrente: (t) => amountBRL(t) < 0 && pares.some((p) => mesmoPagamento(-amountBRL(t), t.date, p)),
  };
}
