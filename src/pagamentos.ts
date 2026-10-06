// Identifica pagamentos de fatura de cartão, tanto a entrada no cartão quanto
// o débito na conta. O app web usa isso para não contar o mesmo dinheiro duas vezes.
//
// A descrição não serve: no C6 o mesmo tipo de pagamento já apareceu como
// "PGTO FAT CARTAO C6", "Pagamento Boleto BCO C6 S.A." e "C6 BANK".
//
// Cartão: é pagamento se bater com um pagamento registrado nas faturas
//   (mesmo valor, data com até 3 dias de diferença) ou se a Pluggy
//   categorizar como "Credit card payment".
// Conta corrente: só é pagamento se tiver PAR num cartão conectado: bater com
//   um pagamento registrado nas faturas desses cartões ou com uma entrada de
//   pagamento num deles. A categoria sozinha não basta: pagar um cartão que
//   não está conectado é um gasto real, que o app precisa contar.

import type { Bill, Transaction } from "./pluggy.ts";

const TOLERANCIA_DIAS = 3;
const DIA_MS = 86_400_000;

interface Pagamento {
  amount: number;
  date: string;
}

const mesmoPagamento = (valor: number, data: string, p: Pagamento) =>
  Math.abs(p.amount - valor) < 0.01 &&
  Math.abs(Date.parse(p.date.slice(0, 10)) - Date.parse(data.slice(0, 10))) <= TOLERANCIA_DIAS * DIA_MS;

export interface BillPaymentMatcher {
  cartao: (t: Transaction) => boolean;
  contaCorrente: (t: Transaction) => boolean;
}

// bills: faturas fechadas dos cartões conectados.
// cardTransactions: transações dos cartões conectados (para achar o par dos débitos em conta).
export function billPaymentMatcher(bills: Bill[], cardTransactions: Transaction[] = []): BillPaymentMatcher {
  const registrados: Pagamento[] = bills.flatMap((bill) =>
    (bill.payments ?? []).map((p) => ({ amount: p.amount, date: p.paymentDate })),
  );

  const cartao = (t: Transaction) =>
    t.amount < 0 &&
    (t.category === "Credit card payment" || registrados.some((p) => mesmoPagamento(-t.amount, t.date, p)));

  // Entradas de pagamento já identificadas nos cartões: servem de par para o débito na conta.
  const entradasNosCartoes: Pagamento[] = cardTransactions.filter(cartao).map((t) => ({ amount: -t.amount, date: t.date }));
  const pares = [...registrados, ...entradasNosCartoes];

  const contaCorrente = (t: Transaction) => t.amount < 0 && pares.some((p) => mesmoPagamento(-t.amount, t.date, p));

  return { cartao, contaCorrente };
}
