// Verifica se o id de uma transação PENDENTE continua o mesmo quando ela é confirmada.
// Uso: npm run conferir-pendentes
//   1ª vez: salva uma foto das pendentes em .snapshots/ (fora do Git).
//   Depois: compara a foto mais antiga com a situação atual.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { PluggyClient, loadConfig, type Transaction } from "../src/pluggy.ts";

process.loadEnvFile(".env");

const PASTA = ".snapshots";
const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

interface Foto {
  data: string;
  pendentes: { id: string; accountId: string; date: string; description: string; amount: number }[];
}

const { clientId, clientSecret, itemIds } = loadConfig();
const pluggy = new PluggyClient(clientId, clientSecret);
const contas = (await Promise.all(itemIds.map((id) => pluggy.listAccounts(id)))).flat();

async function transacoesDesde(inicio: string): Promise<Transaction[]> {
  return (await Promise.all(contas.map((c) => pluggy.listTransactions(c.id, inicio, hoje)))).flat();
}

if (!existsSync(PASTA)) mkdirSync(PASTA);
const fotos = readdirSync(PASTA).filter((f) => f.startsWith("pendentes-")).sort();
const maisAntiga = fotos[0];

if (!maisAntiga || maisAntiga === `pendentes-${hoje}.json`) {
  const inicio = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const pendentes = (await transacoesDesde(inicio))
    .filter((t) => t.status === "PENDING")
    .map(({ id, accountId, date, description, amount }) => ({ id, accountId, date, description, amount }));
  const arquivo = `${PASTA}/pendentes-${hoje}.json`;
  writeFileSync(arquivo, JSON.stringify({ data: hoje, pendentes } satisfies Foto, null, 2));
  console.log(`Foto salva: ${arquivo} (${pendentes.length} pendentes). Rode de novo daqui a alguns dias.`);
} else {
  const foto: Foto = JSON.parse(readFileSync(`${PASTA}/${maisAntiga}`, "utf8"));
  const inicio = foto.pendentes.map((p) => p.date.slice(0, 10)).sort()[0] ?? foto.data;
  const agora = await transacoesDesde(inicio);
  const porId = new Map(agora.map((t) => [t.id, t]));

  const resultado = { confirmadaMesmoId: 0, aindaPendente: 0, idMudou: 0, sumiu: 0 };
  for (const p of foto.pendentes) {
    const atual = porId.get(p.id);
    if (atual?.status === "POSTED") resultado.confirmadaMesmoId++;
    else if (atual) resultado.aindaPendente++;
    else {
      const parecida = agora.find(
        (t) => t.accountId === p.accountId && Math.abs(t.amount - p.amount) < 0.01 && t.description.trim() === p.description.trim(),
      );
      if (parecida) resultado.idMudou++;
      else resultado.sumiu++;
      console.log(`  ${parecida ? "ID MUDOU" : "SUMIU   "}  ${p.date.slice(0, 10)}  ${p.description.trim().slice(0, 35)}  ${p.amount}`);
    }
  }

  console.log(`\nFoto de ${foto.data} → hoje (${hoje}), ${foto.pendentes.length} pendentes na foto:`);
  console.log(`  ✅ confirmadas com o MESMO id: ${resultado.confirmadaMesmoId}`);
  console.log(`  ⏳ ainda pendentes:            ${resultado.aindaPendente}`);
  console.log(`  ⚠️  confirmadas com id NOVO:    ${resultado.idMudou}`);
  console.log(`  ❌ sumiram:                    ${resultado.sumiu}`);
}
