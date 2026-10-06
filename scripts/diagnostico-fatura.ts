// Diagnóstico da fatura aberta: ajuda a comparar o cálculo com o app do banco.
// Uso: npm run diagnostico-fatura

import { PluggyClient, amountBRL, loadConfig, type Transaction } from "../src/pluggy.ts";
import { estimateOpenBill, openBillSearchStart } from "../src/fatura.ts";

process.loadEnvFile(".env");

const { clientId, clientSecret, itemIds } = loadConfig();
const pluggy = new PluggyClient(clientId, clientSecret);

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const today = new Date().toISOString().slice(0, 10);

const threeDaysAgo = new Date();
threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
const since3 = threeDaysAgo.toISOString().slice(0, 10);

const isFeeOrCredit = (t: Transaction) =>
  amountBRL(t) < 0 || /IOF|ESTORNO|CR[EÉ]DITO|ANUIDADE|TARIFA|JUROS/i.test(t.description) || t.operationType === "ESTORNO";

for (const itemId of itemIds) {
  const item = await pluggy.getItem(itemId);
  const updated = item.lastUpdatedAt ? new Date(item.lastUpdatedAt).toLocaleString("pt-BR") : "—";
  console.log(`Conexão ${itemId}: status ${item.status} (${item.executionStatus ?? "—"}), última sincronização ${updated}`);

  for (const acc of await pluggy.listAccounts(itemId)) {
    if (acc.type !== "CREDIT") continue;

    const bills = await pluggy.listBills(acc.id);
    const all = await pluggy.listTransactions(acc.id, openBillSearchStart(bills[0]), today);
    const open = estimateOpenBill(all, bills);
    const included = new Set(open.transactions.map((t) => t.id));

    const why = (t: Transaction) =>
      included.has(t.id) ? "na fatura aberta" : t.creditCardMetadata?.billId ? "EXCLUÍDO: já em fatura fechada" : "EXCLUÍDO: pagamento de fatura";

    const line = (t: Transaction) => {
      const m = t.creditCardMetadata;
      const inst = m?.totalInstallments ? ` (${m.installmentNumber}/${m.totalInstallments})` : "";
      const desc = (t.description.trim() + inst).padEnd(42).slice(0, 42);
      console.log(`  ${brDate(t.date)}  ${desc} ${brl.format(amountBRL(t)).padStart(13)}  ${t.status.padEnd(7)}  ${why(t)}`);
    };
    const byDate = (list: Transaction[]) => list.toSorted((a, b) => b.date.localeCompare(a.date));

    console.log(`\n💳 ${(acc.marketingName ?? acc.name).trim()} — fatura aberta calculada: ${brl.format(open.total)}`);

    const recent = byDate(all.filter((t) => t.date.slice(0, 10) >= since3));
    console.log(`\n1) Lançamentos desde ${brDate(since3)} (${recent.length})`);
    recent.forEach(line);

    const fees = byDate(all.filter(isFeeOrCredit));
    console.log(`\n2) IOF, estornos, tarifas e créditos desde ${brDate(openBillSearchStart(bills[0]))} (${fees.length})`);
    fees.forEach(line);

    const excluded = byDate(all.filter((t) => !included.has(t.id)));
    console.log(`\n3) Tudo que ficou FORA da fatura aberta (${excluded.length})`);
    excluded.forEach(line);
  }
}
