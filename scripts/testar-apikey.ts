// Testa a renovação da apiKey da Pluggy contra a API real.
// Uso: npm run testar-apikey
//
// Para simular chave vencida, o teste altera campos internos do cliente (apiKey e
// apiKeyObtidaEm). Conta, espionando o fetch, quantos POST /auth e quantas recusas houve.

import { PluggyClient, loadConfig } from "../src/pluggy.ts";

process.loadEnvFile(".env");
const { clientId, clientSecret, itemIds } = loadConfig();
const itemId = itemIds[0]!;

// Espião do fetch: conta autenticações e respostas de chave recusada.
const contagem = { auth: 0, recusas: 0, codigos: new Set<string>() };
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
  const url = String(entrada);
  if (url.endsWith("/auth")) contagem.auth++;
  const res = await fetchOriginal(entrada, init);
  if (!url.endsWith("/auth") && (res.status === 401 || res.status === 403)) {
    contagem.recusas++;
    const corpo = await res.clone().text();
    contagem.codigos.add(`${res.status} ${corpo.match(/"codeDescription":"([^"]+)"/)?.[1] ?? corpo.slice(0, 60)}`);
  }
  return res;
}) as typeof fetch;

const zerar = () => {
  contagem.auth = 0;
  contagem.recusas = 0;
  contagem.codigos.clear();
};
let falhas = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "✅" : "❌"} ${msg}`);
  if (!ok) falhas++;
};
const emParalelo = async (cliente: PluggyClient, n: number) => {
  const r = await Promise.allSettled(Array.from({ length: n }, () => cliente.getItem(itemId)));
  return r.filter((x) => x.status === "fulfilled").length;
};
const MIN = 60_000;

// A) Início frio: 10 chamadas ao mesmo tempo → uma única autenticação.
const cliente = new PluggyClient(clientId, clientSecret);
const interno = cliente as unknown as { apiKey?: string; apiKeyObtidaEm: number };
zerar();
let ok = await emParalelo(cliente, 10);
check(ok === 10 && contagem.auth === 1, `A) início frio: ${ok}/10 ok, ${contagem.auth} POST /auth (esperado 1)`);

// B) Chave vencida do lado da Pluggy, mas o cliente acha que ainda vale.
interno.apiKey = "chave-vencida-de-teste";
interno.apiKeyObtidaEm = Date.now();
zerar();
ok = await emParalelo(cliente, 10);
check(ok === 10, `B) chave recusada: ${ok}/10 chamadas ok depois de renovar`);
check(contagem.auth === 1, `B) ${contagem.auth} POST /auth para 10 chamadas em paralelo (esperado 1)`);
check(contagem.recusas >= 1, `B) a Pluggy recusou a chave inválida ${contagem.recusas}x: ${[...contagem.codigos].join("; ")}`);
check(interno.apiKey !== "chave-vencida-de-teste", "B) a chave recusada foi descartada");

// C) Chave perto de vencer (obtida há 1h55): renova ANTES, sem nenhuma recusa.
interno.apiKeyObtidaEm = Date.now() - 115 * MIN;
const antes = interno.apiKey;
zerar();
ok = await emParalelo(cliente, 5);
check(ok === 5 && contagem.auth === 1 && contagem.recusas === 0,
  `C) perto de vencer: ${ok}/5 ok, ${contagem.auth} POST /auth, ${contagem.recusas} recusas (esperado 1 e 0)`);
check(interno.apiKey !== antes, "C) a chave foi trocada");

// D) Chave dentro do prazo (obtida há 30 min): nenhuma autenticação.
interno.apiKeyObtidaEm = Date.now() - 30 * MIN;
zerar();
ok = await emParalelo(cliente, 5);
check(ok === 5 && contagem.auth === 0, `D) dentro do prazo: ${ok}/5 ok, ${contagem.auth} POST /auth (esperado 0)`);

globalThis.fetch = fetchOriginal;
console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : "\nTudo certo.");
process.exitCode = falhas ? 1 : 0;
