// Testes de segurança contra o servidor publicado. Rode deste computador (IP fora do Claude):
// tudo em /mcp deve ser recusado com 403, mesmo com o token certo e com IP falso nos cabeçalhos.
// Uso: npm run testar-publico
//      MCP_PUBLIC_URL=https://outro-endereco npm run testar-publico

process.loadEnvFile(".env");
const token = process.env.MCP_AUTH_TOKEN ?? "";
const base = process.env.MCP_PUBLIC_URL ?? "https://pluggy-ponte-production.up.railway.app";
const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const ipDoClaude = "160.79.104.10";

const casos: [string, "GET" | "POST", string, Record<string, string>, number][] = [
  ["GET /health", "GET", "/health", {}, 200],
  ["/mcp sem token", "POST", "/mcp", {}, 403],
  ["/mcp com token certo", "POST", "/mcp", { Authorization: `Bearer ${token}` }, 403],
  ["/mcp com token + X-Real-IP falso (Claude)", "POST", "/mcp", { Authorization: `Bearer ${token}`, "X-Real-IP": ipDoClaude }, 403],
  ["/mcp com token + X-Forwarded-For falso", "POST", "/mcp", { Authorization: `Bearer ${token}`, "X-Forwarded-For": ipDoClaude }, 403],
  ["/mcp com token + os dois falsos", "POST", "/mcp", { "x-api-key": token, "X-Real-IP": ipDoClaude, "X-Forwarded-For": ipDoClaude }, 403],
  ["caminho inexistente", "GET", "/qualquer", {}, 403],
];

let falhas = 0;
for (const [nome, method, path, headers, esperado] of casos) {
  const res = await fetch(base + path, { method, headers: { ...h, ...headers }, body: method === "POST" ? ping : undefined });
  await res.body?.cancel();
  const ok = res.status === esperado;
  if (!ok) falhas++;
  console.log(`${ok ? "✅" : "❌"} ${nome.padEnd(45)} → ${res.status} (esperado ${esperado})`);
}
console.log(falhas ? `\n${falhas} teste(s) com resultado inesperado.` : "\nTodos os testes de segurança passaram.");
process.exitCode = falhas ? 1 : 0;
