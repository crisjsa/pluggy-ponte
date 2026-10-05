// Cálculo da fatura aberta (corrente) de um cartão.
//
// A Pluggy só devolve faturas já fechadas em /bills. Para estimar a aberta:
//   - transações COM billId já pertencem a uma fatura fechada → ignoradas;
//   - pagamentos de faturas fechadas não são gastos → ignorados
//     (regra em pagamentos.ts);
//   - o resto (compras, parcelas do mês, estornos) é somado.
// É uma estimativa: transações PENDING ainda podem mudar ou sumir.

import type { Bill, Transaction } from "./pluggy.ts";
import { billPaymentMatcher } from "./pagamentos.ts";

export interface OpenBill {
  total: number;
  pendingTotal: number;
  transactions: Transaction[];
}

export function estimateOpenBill(cardTransactions: Transaction[], closedBills: Bill[]): OpenBill {
  const isBillPayment = billPaymentMatcher(closedBills);
  const transactions = cardTransactions.filter((t) => !t.creditCardMetadata?.billId && !isBillPayment(t));

  const sum = (list: Transaction[]) => list.reduce((acc, t) => acc + t.amount, 0);
  return {
    total: sum(transactions),
    pendingTotal: sum(transactions.filter((t) => t.status === "PENDING")),
    transactions,
  };
}

// Data (AAAA-MM-DD) a partir da qual buscar transações da fatura aberta.
// Volta 15 dias antes do último fechamento para pegar compras lançadas com atraso.
export function openBillSearchStart(lastClosedBill: Bill | undefined, today = new Date()): string {
  const base = lastClosedBill?.billClosingDate ? new Date(lastClosedBill.billClosingDate) : today;
  const start = new Date(base);
  start.setUTCDate(start.getUTCDate() - (lastClosedBill ? 15 : 45));
  return start.toISOString().slice(0, 10);
}
