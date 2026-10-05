// Identifica pagamentos de fatura de cartão, tanto a entrada no cartão quanto
// o débito na conta. O app web usa isso para não contar o mesmo dinheiro duas vezes.
//
// A descrição não serve: no C6 o mesmo tipo de pagamento já apareceu como
// "PGTO FAT CARTAO C6", "Pagamento Boleto BCO C6 S.A." e "C6 BANK".
// Por isso cruzamos com os pagamentos que a Pluggy registra em cada fatura
// fechada (mesmo valor, data com até 3 dias de diferença). Como reserva,
// também vale a categoria "Credit card payment" da Pluggy.

import type { Bill, Transaction } from "./pluggy.ts";

const TOLERANCIA_DIAS = 3;
const DIA_MS = 86_400_000;

export function billPaymentMatcher(bills: Bill[]): (t: Transaction) => boolean {
  const payments = bills.flatMap((bill) => bill.payments ?? []);

  return (t) => {
    // No cartão o pagamento abate a dívida; na conta é uma saída. Nos dois casos, amount < 0.
    if (t.amount >= 0) return false;
    if (t.category === "Credit card payment") return true;

    const valor = -t.amount;
    const data = Date.parse(t.date.slice(0, 10));
    return payments.some(
      (p) =>
        Math.abs(p.amount - valor) < 0.01 &&
        Math.abs(Date.parse(p.paymentDate.slice(0, 10)) - data) <= TOLERANCIA_DIAS * DIA_MS,
    );
  };
}
