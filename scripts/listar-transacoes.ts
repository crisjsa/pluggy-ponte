// Script de teste: lista as transações dos últimos N dias de cada conta.
// Uso: npm run transacoes          (últimos 30 dias)
//      npm run transacoes -- 7     (últimos 7 dias)

import { PluggyClient, loadConfig, type Account, type Transaction } from "../src/pluggy.ts";

process.loadEnvFile(".env");

const days = Number(process.argv[2] ?? 30);
if (!Number.isInteger(days) || days <= 0) {
  throw new Error(`Número de dias inválido: "${process.argv[2]}". Exemplo: npm run transacoes -- 7`);
}

const { clientId, clientSecret, itemIds } = loadConfig();
const pluggy = new PluggyClient(clientId, clientSecret);

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const sum = (list: Transaction[]) => list.reduce((acc, t) => acc + t.amount, 0);

const to = new Date();
const from = new Date(to);
from.setDate(from.getDate() - days);

function printTransaction(t: Transaction) {
  const m = t.creditCardMetadata;
  const installment = m?.totalInstallments ? ` (${m.installmentNumber}/${m.totalInstallments})` : "";
  const pending = t.status === "PENDING" ? " ⏳" : "";
  const desc = (t.description.trim() + installment).padEnd(40).slice(0, 40);
  console.log(`  ${brDate(t.date)}  ${desc} ${brl.format(t.amount).padStart(14)}${pending}`);
}

const accounts: Account[] = [];
for (const itemId of itemIds) {
  accounts.push(...(await pluggy.listAccounts(itemId)));
}

console.log(`Período: ${brDate(isoDate(from))} a ${brDate(isoDate(to))} (${days} dias)   ⏳ = pendente`);

for (const acc of accounts) {
  const transactions = (await pluggy.listTransactions(acc.id, isoDate(from), isoDate(to)))
    .toSorted((a, b) => b.date.localeCompare(a.date));
  const name = (acc.marketingName ?? acc.name).trim();

  console.log(`\n${acc.type === "CREDIT" ? "💳" : "💰"} ${name} — ${transactions.length} transações`);
  transactions.forEach(printTransaction);

  // Lembre: o sinal é invertido entre conta e cartão (ver src/pluggy.ts).
  if (acc.type === "BANK") {
    const entradas = sum(transactions.filter((t) => t.amount > 0));
    const saidas = sum(transactions.filter((t) => t.amount < 0));
    console.log(`  Entradas: ${brl.format(entradas)} | Saídas: ${brl.format(saidas)} | Resultado: ${brl.format(entradas + saidas)}`);
  } else {
    const compras = sum(transactions.filter((t) => t.amount > 0));
    const creditos = sum(transactions.filter((t) => t.amount < 0));
    console.log(`  Compras: ${brl.format(compras)} | Pagamentos e estornos: ${brl.format(creditos)}`);
  }
}
