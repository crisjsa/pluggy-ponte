// Script de teste: lista as contas de todas as conexões (items) do .env,
// separando dinheiro em conta de cartões de crédito.
// Uso: npm run contas

import { PluggyClient, loadConfig, type Account, type Bill } from "../src/pluggy.ts";
import { estimateOpenBill, openBillSearchStart } from "../src/fatura.ts";

// Recurso nativo do Node (>= 21.7): carrega o .env para process.env.
process.loadEnvFile(".env");

const { clientId, clientSecret, itemIds } = loadConfig();
const pluggy = new PluggyClient(clientId, clientSecret);

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const money = (value: number | null | undefined) => (value == null ? "—" : brl.format(value));
const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—");
const label = (acc: Account) => `${(acc.marketingName ?? acc.name).trim()} (final ${acc.number.slice(-4)})`;

// Compara o total pago com o valor da fatura para dizer se ela foi quitada.
function billStatus(bill: Bill): string {
  const paid = (bill.payments ?? []).reduce((sum, p) => sum + p.amount, 0);
  if (paid >= bill.totalAmount - 0.01) return `✅ paga (${money(paid)})`;
  if (paid > 0) return `⚠️ paga parcialmente (${money(paid)} de ${money(bill.totalAmount)})`;
  return new Date(bill.dueDate) < new Date() ? "❌ vencida sem pagamento registrado" : "⏳ a vencer";
}

// Busca as contas de todas as conexões e junta numa lista só.
const accounts: Account[] = [];
for (const itemId of itemIds) {
  accounts.push(...(await pluggy.listAccounts(itemId)));
}

const bank = accounts.filter((acc) => acc.type === "BANK");
const credit = accounts.filter((acc) => acc.type === "CREDIT");

console.log("\n💰 DINHEIRO EM CONTA");
for (const acc of bank) {
  console.log(`  ${label(acc)}: ${money(acc.balance)}`);
}
const totalBank = bank.reduce((sum, acc) => sum + acc.balance, 0);
console.log(`  Total: ${money(totalBank)}`);

console.log("\n💳 CARTÕES DE CRÉDITO");
for (const acc of credit) {
  const c = acc.creditData;
  const bills = await pluggy.listBills(acc.id);
  const [lastBill] = bills;

  const today = new Date().toISOString().slice(0, 10);
  const cardTransactions = await pluggy.listTransactions(acc.id, openBillSearchStart(lastBill), today);
  const openBill = estimateOpenBill(cardTransactions, bills);

  console.log(`  ${label(acc)}`);
  console.log(`    Fatura aberta (estimativa): ${money(openBill.total)}`);
  console.log(`      ${openBill.transactions.length} lançamentos, ${money(openBill.pendingTotal)} ainda pendentes`);
  if (lastBill) {
    console.log(`    Última fatura fechada: ${money(lastBill.totalAmount)}`);
    console.log(`      fechou ${date(lastBill.billClosingDate)} · vence ${date(lastBill.dueDate)} · ${billStatus(lastBill)}`);
  } else {
    console.log("    Nenhuma fatura fechada encontrada");
  }
  console.log(`    Limite usado (inclui parcelas futuras): ${money(acc.balance)}`);
  console.log(`    Limite disponível: ${money(c?.availableCreditLimit)} de ${money(c?.creditLimit)}`);
}
const totalCredit = credit.reduce((sum, acc) => sum + acc.balance, 0);
console.log(`  Total de limite usado nos cartões: ${money(totalCredit)}`);
