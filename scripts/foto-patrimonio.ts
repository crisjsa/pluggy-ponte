// Tira a foto do patrimônio agora (origem 'manual') e mostra os totais.
// Uso: npm run foto-patrimonio -- [AAAA-MM] [--sem-salvar]
//   --sem-salvar: só calcula e mostra, sem gravar (não precisa de DATABASE_URL).
// Para gravar no Postgres do Railway pelo computador, use no .env a DATABASE_PUBLIC_URL do Railway como DATABASE_URL.

import { PluggyClient, loadConfig } from "../src/pluggy.ts";
import { fotosDoAmbiente } from "../src/fotos.ts";
import { calcularTotais, coletarDados, mesAtual } from "../src/patrimonio.ts";

process.loadEnvFile(".env");

const args = process.argv.slice(2);
const mes = args.find((a) => /^\d{4}-\d{2}$/.test(a)) ?? mesAtual();
const semSalvar = args.includes("--sem-salvar");

const { clientId, clientSecret, itemIds } = loadConfig();
const dados = await coletarDados(new PluggyClient(clientId, clientSecret), itemIds);

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const mostrar = (totais: Record<string, number>) => {
  for (const [nome, valor] of Object.entries(totais)) console.log(`  ${nome.padEnd(22)} ${brl.format(valor).padStart(16)}`);
};

console.log("Conexões:");
for (const c of dados.conexoes) console.log(`  ${c.bancos.join(", ") || c.itemId}: ${c.status}, sincronizada em ${c.ultimaSincronizacao ?? "—"}`);
console.log(`Contas: ${dados.contas.length}  Investimentos ativos: ${dados.investimentos.length}  Cartões: ${dados.cartoes.length}`);
for (const c of dados.cartoes) {
  console.log(
    `  ${c.nome} (${c.banco ?? "?"}): aberta ${brl.format(c.faturaAbertaEstimada)}, fechadas não pagas ${c.faturasFechadasNaoPagas.length}, ` +
      `usado ${brl.format(c.saldoUsado)}, parcelas futuras ${brl.format(c.parcelasFuturas)}`,
  );
}

if (semSalvar) {
  console.log(`\nTotais (não gravado):`);
  mostrar(calcularTotais(dados, []));
} else {
  const fotos = fotosDoAmbiente();
  if (!fotos) throw new Error("DATABASE_URL não definida no .env (ou use --sem-salvar).");
  try {
    const { foto, motivo } = await fotos.salvar(mes, dados, "manual");
    if (!foto) throw new Error(motivo);
    console.log(`\nFoto ${foto.mes} gravada (${foto.origem}, ${foto.status}, ${foto.itensManuais.length} itens manuais):`);
    mostrar(foto.totais);
  } finally {
    await fotos.fechar();
  }
}
