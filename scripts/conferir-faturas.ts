// Confere, para cada cartão e cada mês de fatura, se a soma das compras (mesFatura)
// bate com o valor da fatura em listar_faturas. Rode o servidor antes (npm start).
// Uso: npm run conferir-faturas

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

process.loadEnvFile(".env");

const client = new Client({ name: "conferir-faturas", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${process.env.MCP_PORT ?? 3333}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } },
  }),
);
const chamar = async (name: string, args: Record<string, unknown> = {}) =>
  ((await client.callTool({ name, arguments: args })) as { structuredContent: any }).structuredContent;

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dia = (iso: string, delta: number) => new Date(Date.parse(iso) + delta * 86_400_000).toISOString().slice(0, 10);
const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

// Duas janelas de até 366 dias cobrem ~2 anos (a Pluggy costuma ter ~12 meses).
const janelas = [
  { dataInicio: dia(hoje, -731), dataFim: dia(hoje, -366) },
  { dataInicio: dia(hoje, -365), dataFim: hoje },
];
const porId = new Map<string, any>();
for (const j of janelas) for (const t of (await chamar("listar_transacoes", j)).transacoes) porId.set(t.id, t);
const transacoes = [...porId.values()];

const { contas } = await chamar("listar_contas");
const { faturas } = await chamar("listar_faturas");

let divergencias = 0;
for (const cartao of contas.filter((c: any) => c.cartao)) {
  const doCartao = transacoes.filter((t) => t.contaId === cartao.id);
  const maisAntiga = doCartao.map((t) => t.data).sort()[0];
  const semMes = doCartao.filter((t) => !t.mesFatura);
  console.log(`\n💳 ${cartao.nome} (${cartao.banco}) — ${doCartao.length} transações desde ${maisAntiga ?? "—"}`);
  if (semMes.length) console.log(`   ⚠️  ${semMes.length} transações sem mesFatura (billId de fatura que a Pluggy não devolve)`);

  const faturasDoCartao = faturas.filter((f: any) => f.contaId === cartao.id && f.mesReferencia);
  const meses = [...new Set([...faturasDoCartao.map((f: any) => f.mesReferencia), ...doCartao.map((t) => t.mesFatura).filter(Boolean)])].sort().reverse();

  for (const mes of meses) {
    const fatura = faturasDoCartao.find((f: any) => f.mesReferencia === mes);
    const compras = doCartao.filter((t) => t.mesFatura === mes && !t.pagamentoFatura);
    const soma = Math.round(compras.reduce((s, t) => s + (t.tipo === "saida" ? t.valor : -t.valor), 0) * 100) / 100;
    const diff = fatura ? Math.round((fatura.valor - soma) * 100) / 100 : null;
    // Até R$ 0,01 é arredondamento: a Pluggy às vezes manda o total com 4 casas (ex.: 472.5455).
    const ok = diff !== null && Math.abs(diff) < 0.015;
    // Compras de uma fatura acontecem até ~40 dias antes do fechamento.
    const incompleta = !ok && fatura?.fechamento && maisAntiga ? maisAntiga > dia(fatura.fechamento, -40) : false;
    // A Pluggy só traz parcelas de compras feitas dentro do histórico (~12 meses). Faturas do
    // primeiro ano podem ter parcelas de compras mais antigas que não vêm: fatura > compras.
    const parcelasAntigas =
      !ok && !incompleta && diff !== null && diff > 0 && fatura?.fechamento && maisAntiga
        ? fatura.fechamento < dia(maisAntiga, 365)
        : false;
    // Pagamento antecipado: pago dentro do próprio ciclo, o banco abate do total da fatura.
    // O servidor marca como pagamentoFatura (certo para o app), então as compras somam a mais.
    const antecipado =
      !ok && diff !== null && diff < 0
        ? doCartao.find((t) => t.mesFatura === mes && t.pagamentoFatura && Math.abs(t.valor + diff) < 0.015)
        : undefined;
    if (!ok && !incompleta && !parcelasAntigas && !antecipado) divergencias++;
    const icone = ok ? "✅" : incompleta ? "⏳" : parcelasAntigas || antecipado ? "⚠️ " : "❌";
    const nota = incompleta
      ? "  — transações anteriores ao período da Pluggy"
      : parcelasAntigas
        ? `  — podem faltar parcelas de compras anteriores a ${maisAntiga}`
        : antecipado
          ? `  — pagamento antecipado de ${brl.format(antecipado.valor)} em ${antecipado.data}, abatido na própria fatura`
          : "";
    console.log(
      `   ${icone} ${mes}  fatura ${fatura ? brl.format(fatura.valor).padStart(13) : "      (nenhuma)"}` +
        `${fatura?.estimativa ? " (aberta)" : "         "}  compras ${brl.format(soma).padStart(13)} (${String(compras.length).padStart(3)})` +
        `${diff !== null && !ok ? `  diferença ${brl.format(diff)}` : ""}${nota}`,
    );
  }
}

await client.close();
console.log(
  `\n✅ bate  ❌ não bate  ⏳ dados insuficientes (as transações da Pluggy começam depois das compras dessa fatura)` +
    `\n⚠️  diferença explicada: parcela de compra anterior ao histórico da Pluggy, ou pagamento antecipado` +
    `\n${divergencias ? `${divergencias} mês(es) com diferença.` : "Nenhuma diferença nos meses com dados completos."}`,
);
