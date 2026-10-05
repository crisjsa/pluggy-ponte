// Testa o servidor MCP como o app web faria. Rode o servidor antes (npm start).
// Uso: npm run testar-mcp

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

process.loadEnvFile(".env");

const url = new URL(`http://127.0.0.1:${process.env.MCP_PORT ?? 3333}/mcp`);
const token = process.env.MCP_AUTH_TOKEN ?? "";
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

let falhas = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "✅" : "❌"} ${msg}`);
  if (!ok) falhas++;
};

// 1) Segurança: sem token e com token errado devem ser recusados; x-api-key correto deve passar.
const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
const casos: [string, Record<string, string>, number][] = [
  ["sem token", {}, 401],
  ["Bearer errado", { Authorization: "Bearer errado" }, 401],
  ["x-api-key errado", { "x-api-key": "errado" }, 401],
  ["x-api-key correto", { "x-api-key": token }, 200],
];
for (const [nome, headers, esperado] of casos) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(ping),
  });
  check(res.status === esperado, `${nome} → HTTP ${res.status} (esperado ${esperado})`);
}

// 2) Conexão autenticada, como o backend do app web faria.
const client = new Client({ name: "teste-app-web", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
);

const { tools } = await client.listTools();
check(tools.length === 4, `ferramentas: ${tools.map((t) => t.name).join(", ")}`);
check(tools.every((t) => t.annotations?.readOnlyHint === true), "todas marcadas como somente leitura");

type Resultado = { structuredContent?: any; isError?: boolean; content?: any };
const chamar = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<Resultado>;

const contas = await chamar("listar_contas");
for (const c of contas.structuredContent.contas) {
  console.log(`   ${c.cartao ? "💳" : "💰"} ${c.nome}: ${brl.format(c.saldo)}`);
}

const tx = await chamar("listar_transacoes", { dataInicio: "2026-09-20" });
const lista: any[] = tx.structuredContent.transacoes;
const { inicio, fim } = tx.structuredContent.periodo;
check(!tx.isError && lista.length > 0, `listar_transacoes ${inicio} a ${fim}: ${lista.length} transações`);
check(lista.every((t) => t.valor >= 0), "todos os valores são positivos");
check(lista.every((t) => ["entrada", "saida"].includes(t.tipo) && ["pendente", "confirmada"].includes(t.status)), "tipo e status válidos");
check(new Set(lista.map((t) => t.id)).size === lista.length, "nenhum id repetido");
check(lista.every((t) => !/\s{2}/.test(t.descricao)), "nenhuma descrição com espaços repetidos");
check(lista.every((t) => "categoriaPluggy" in t && "categoriaPluggyId" in t), "categoriaPluggy e categoriaPluggyId presentes");
const categorias = new Map(lista.filter((t) => t.categoriaPluggy).map((t) => [t.categoriaPluggy, t.categoriaPluggyId]));
console.log(`   ${categorias.size} categorias distintas, ex.: ${[...categorias].slice(0, 3).map(([n, id]) => `${n} (${id})`).join(", ")}`);

const pagamentos = lista.filter((t) => t.pagamentoFatura);
console.log("   pagamentos de fatura marcados:");
for (const p of pagamentos) console.log(`     ${p.data} ${p.contaNome.padEnd(10)} ${p.tipo.padEnd(7)} ${brl.format(p.valor)}  ${p.descricao}`);
check(
  pagamentos.some((p) => !p.cartao && p.tipo === "saida") && pagamentos.some((p) => p.cartao && p.tipo === "entrada"),
  "pagamento marcado nos dois lados (saída na conta e entrada no cartão)",
);
check(pagamentos.every((p) => p.valor === pagamentos[0].valor), "nada além do pagamento foi marcado");
console.log("   exemplos:");
for (const t of [lista.find((t) => !t.cartao && t.tipo === "entrada"), lista.find((t) => !t.cartao && t.tipo === "saida"), lista.find((t) => t.cartao)]) {
  if (t) console.log("  ", JSON.stringify({ ...t, id: `${t.id.slice(0, 8)}…`, contaId: `${t.contaId.slice(0, 8)}…` }));
}

const invalido = await chamar("listar_transacoes", { dataInicio: "ontem" });
check(invalido.isError === true, `data inválida recusada: ${invalido.content?.[0]?.text?.slice(0, 70)}…`);

const faturas = await chamar("listar_faturas_abertas");
for (const f of faturas.structuredContent.faturas) {
  console.log(`   💳 ${f.contaNome}: fatura aberta ${brl.format(f.valorEstimado)} (${f.quantidadeLancamentos} lançamentos), sincronizado em ${new Date(f.ultimaSincronizacao).toLocaleString("pt-BR")}`);
}
check(faturas.structuredContent.faturas.length > 0, "listar_faturas_abertas respondeu");

// listar_faturas: histórico por mês (mês de referência = mês do vencimento).
const todas: any[] = (await chamar("listar_faturas")).structuredContent.faturas;
const abertas = todas.filter((f) => f.situacao === "aberta");
check(abertas.length >= 1 && todas.length > abertas.length, `listar_faturas: ${abertas.length} aberta(s) + ${todas.length - abertas.length} fechadas`);
for (const f of todas.slice(0, 4)) {
  console.log(`   ${f.mesReferencia}  vence ${f.vencimento}  fecha ${f.fechamento ?? "—"}  ${brl.format(f.valor).padStart(12)}  ${f.situacao}${f.estimativa ? " (estimativa)" : ""}${f.paga ? " · paga" : ""}`);
}
const porMes = async (mes: string) => (await chamar("listar_faturas", { mes })).structuredContent.faturas as any[];
const [out, nov] = [await porMes("2026-10"), await porMes("2026-11")];
check(out.length === 1 && out[0].situacao === "fechada" && out[0].paga, `mes 2026-10 → ${out.map((f) => `${brl.format(f.valor)} ${f.situacao}`).join(", ")}`);
const valorAberta = faturas.structuredContent.faturas[0]?.valorEstimado;
check(nov.length === 1 && nov[0].situacao === "aberta" && nov[0].valor === valorAberta, `mes 2026-11 → ${nov.map((f) => `${brl.format(f.valor)} ${f.situacao}`).join(", ")} (igual a listar_faturas_abertas)`);
check(new Set(todas.filter((f) => f.contaId === todas[0].contaId).map((f) => f.valor)).size > 1, "meses diferentes têm valores diferentes");
const mesInvalido = await chamar("listar_faturas", { mes: "outubro" });
check(mesInvalido.isError === true, "mês em formato inválido é recusado");

await client.close();
console.log(falhas === 0 ? "\nTudo certo." : `\n${falhas} verificação(ões) falharam.`);
process.exitCode = falhas === 0 ? 0 : 1;
