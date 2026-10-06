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

const contas: any[] = (await chamar("listar_contas")).structuredContent.contas;
const iniciais = (nome: string | null) => (nome ? nome.split(/\s+/).map((p) => p[0]).join("") : "—");
for (const c of contas) {
  const quando = c.ultimaAtualizacao ? new Date(c.ultimaAtualizacao).toLocaleString("pt-BR") : "—";
  console.log(
    `   ${c.cartao ? "💳" : "💰"} ${c.nome.slice(0, 28).padEnd(28)} ${brl.format(c.saldo).padStart(13)} | ${String(c.banco).padEnd(16)} | titular ${iniciais(c.titular).padEnd(5)} | item ${c.itemId.slice(0, 8)}… | ${quando}`,
  );
}
check(
  contas.every((c) => typeof c.id === "string" && typeof c.nome === "string" && typeof c.cartao === "boolean" && typeof c.saldo === "number"),
  "campos antigos (id, nome, cartao, saldo) mantidos",
);
check(contas.every((c) => "itemId" in c && "banco" in c && "titular" in c && "ultimaAtualizacao" in c), "campos novos presentes em todas as contas");
check(contas.every((c) => c.banco), `banco preenchido em ${contas.filter((c) => c.banco).length}/${contas.length} contas`);
check(contas.every((c) => c.titular), `titular preenchido em ${contas.filter((c) => c.titular).length}/${contas.length} contas`);
check(contas.every((c) => c.ultimaAtualizacao), `ultimaAtualizacao preenchida em ${contas.filter((c) => c.ultimaAtualizacao).length}/${contas.length} contas`);

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
// Cada pagamento marcado deve ter o "par" do outro lado: saída numa conta ↔ entrada num cartão, mesmo valor.
const temPar = (p: any) => pagamentos.some((q) => q !== p && q.cartao !== p.cartao && Math.abs(q.valor - p.valor) < 0.01);
const semPar = pagamentos.filter((p) => !temPar(p));
check(
  pagamentos.some((p) => !p.cartao && p.tipo === "saida") && pagamentos.some((p) => p.cartao && p.tipo === "entrada"),
  "pagamento marcado nos dois lados (saída na conta e entrada no cartão)",
);
check(pagamentos.every((p) => (p.cartao ? p.tipo === "entrada" : p.tipo === "saida")), "pagamentos: saída na conta, entrada no cartão");
// Na conta corrente, só marca com par num cartão conectado. No cartão, sem par pode acontecer:
// a fatura pode ter sido paga por uma conta que não está conectada.
check(semPar.every((p) => p.cartao), `nenhum débito em conta marcado sem par num cartão conectado`);
for (const p of semPar) console.log(`   ⚠️  cartão sem par no período: ${p.data} ${p.contaNome} ${p.tipo} ${brl.format(p.valor)}`);
check(
  !lista.some((t) => !t.cartao && Math.abs(t.valor - 49.07) < 0.01 && t.pagamentoFatura),
  "pagamento de cartão não conectado (R$ 49,07, Nubank) NÃO é marcado",
);
check(lista.every((t) => t.data >= inicio && t.data <= fim), "nenhuma transação fora do período pedido");

// Filtrando só a conta corrente do C6, o par no cartão ainda precisa ser encontrado.
const contaC6 = contas.find((c) => !c.cartao && c.banco === "C6 Bank");
if (contaC6) {
  const soC6: any[] = (await chamar("listar_transacoes", { dataInicio: "2026-09-20", contaId: contaC6.id })).structuredContent.transacoes;
  const pg = soC6.find((t) => Math.abs(t.valor - 9648.41) < 0.01);
  check(soC6.every((t) => t.contaId === contaC6.id), `filtro por conta: ${soC6.length} transações, todas do C6 BANK`);
  check(pg?.pagamentoFatura === true, "com filtro só na conta C6, o pagamento de R$ 9.648,41 continua marcado");
}
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
const cartoes = contas.filter((c) => c.cartao);
const abertasPorCartao = cartoes.map((c) => todas.filter((f) => f.contaId === c.id && f.situacao === "aberta"));
check(abertasPorCartao.every((a) => a.length === 1), `listar_faturas: 1 fatura aberta por cartão (${cartoes.length} cartões, ${todas.length} faturas no total)`);
for (const c of cartoes) {
  const doCartao = todas.filter((f) => f.contaId === c.id);
  const aberta = doCartao.find((f) => f.situacao === "aberta");
  const daOutra = faturas.structuredContent.faturas.find((f: any) => f.contaId === c.id);
  console.log(`   💳 ${c.nome.slice(0, 24).padEnd(24)} ${doCartao.length - 1} fechadas | aberta ${aberta?.mesReferencia ?? "—"} ${brl.format(aberta?.valor ?? 0)}`);
  check(aberta?.valor === daOutra?.valorEstimado, `   aberta de ${c.nome.slice(0, 24)} igual a listar_faturas_abertas`);
}

// Valores conhecidos do cartão do C6 (BANDEIRADO).
const c6 = cartoes.find((c) => c.nome === "BANDEIRADO");
if (c6) {
  const porMes = async (mes: string) =>
    ((await chamar("listar_faturas", { mes, contaId: c6.id })).structuredContent.faturas as any[]);
  const [out, nov] = [await porMes("2026-10"), await porMes("2026-11")];
  check(out.length === 1 && out[0].valor === 9648.41 && out[0].paga, `C6 2026-10 → ${out.map((f) => `${brl.format(f.valor)} ${f.situacao}`).join(", ")}`);
  check(nov.length === 1 && nov[0].situacao === "aberta", `C6 2026-11 → ${nov.map((f) => `${brl.format(f.valor)} ${f.situacao}`).join(", ")}`);
  check(new Set(todas.filter((f) => f.contaId === c6.id).map((f) => f.valor)).size > 1, "meses diferentes têm valores diferentes");
}
const mesInvalido = await chamar("listar_faturas", { mes: "outubro" });
check(mesInvalido.isError === true, "mês em formato inválido é recusado");

await client.close();
console.log(falhas === 0 ? "\nTudo certo." : `\n${falhas} verificação(ões) falharam.`);
process.exitCode = falhas === 0 ? 0 : 1;
