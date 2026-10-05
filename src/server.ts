// Servidor MCP remoto (Streamable HTTP), somente leitura.
//
// Local:   npm start  →  http://127.0.0.1:3333/mcp
// Railway: o Railway define PORT e RAILWAY_PUBLIC_DOMAIN; o servidor entra em modo público.
//
// Toda chamada a /mcp precisa do token em "Authorization: Bearer <MCP_AUTH_TOKEN>"
// ou em "x-api-key: <MCP_AUTH_TOKEN>".

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { BlockList, isIPv4 } from "node:net";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { PluggyClient, loadConfig } from "./pluggy.ts";
import { criarServidor } from "./ferramentas.ts";

// Em desenvolvimento lê o .env; em produção as variáveis vêm do painel da hospedagem.
try {
  process.loadEnvFile(".env");
} catch {}

const { clientId, clientSecret, itemIds } = loadConfig();
const token = process.env.MCP_AUTH_TOKEN?.trim() ?? "";
if (token.length < 32) {
  throw new Error("MCP_AUTH_TOKEN ausente ou curto demais (mínimo 32 caracteres). Veja o .env.example.");
}

// ---------- Modo local x público ----------

const publico = process.env.PORT !== undefined;
const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? 3333);
const host = publico ? "::" : "127.0.0.1"; // "::" aceita IPv4 e IPv6

const dominioPublico = process.env.MCP_PUBLIC_HOST ?? process.env.RAILWAY_PUBLIC_DOMAIN;
if (publico && !dominioPublico) {
  throw new Error("Modo público sem domínio: gere um domínio no Railway (Settings > Networking) ou defina MCP_PUBLIC_HOST.");
}

// Proteção contra DNS rebinding: só aceita requisições endereçadas ao nosso domínio.
// No modo público a checagem de Origin fica desligada: as chamadas vêm dos servidores
// da Anthropic (sem Origin), e quem protege é o token + a lista de IPs.
const validateHost = publico ? hostHeaderValidation([dominioPublico!]) : localhostHostValidation();
const validateOrigin = publico ? () => true : localhostOriginValidation();

// ---------- Lista de IPs permitidos (só no modo público) ----------

// Faixa de saída da Anthropic: https://claude.com/docs/connectors/building/authentication
const IPS_PADRAO = "160.79.104.0/21";
const permitidos = new BlockList();
for (const cidr of (process.env.MCP_ALLOWED_IPS ?? IPS_PADRAO).split(",").map((s) => s.trim()).filter(Boolean)) {
  const [rede, bits] = cidr.split("/");
  if (!rede || !isIPv4(rede)) throw new Error(`MCP_ALLOWED_IPS inválido: "${cidr}" (use IPv4, ex.: 160.79.104.0/21)`);
  permitidos.addSubnet(rede, Number(bits ?? 32), "ipv4");
}

// Atrás do proxy do Railway, o IP de quem chamou vem no cabeçalho X-Real-IP.
function ipDoCliente(req: IncomingMessage): string {
  const real = req.headers["x-real-ip"];
  const ip = (typeof real === "string" ? real : req.socket.remoteAddress) ?? "";
  return ip.replace(/^::ffff:/, ""); // IPv4 escrito no formato IPv6
}
const ipPermitido = (ip: string) => isIPv4(ip) && permitidos.check(ip, "ipv4");

// ---------- Token ----------

// Compara hashes de mesmo tamanho em tempo constante, para não vazar o token por tempo de resposta.
const sha256 = (s: string) => createHash("sha256").update(s).digest();
function tokenRecebido(req: IncomingMessage): string | undefined {
  const [esquema, bearer] = (req.headers.authorization ?? "").split(" ");
  if (esquema === "Bearer" && bearer) return bearer;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && apiKey ? apiKey : undefined;
}
function autorizado(req: IncomingMessage): boolean {
  const recebido = tokenRecebido(req);
  return recebido !== undefined && timingSafeEqual(sha256(recebido), sha256(token));
}

// ---------- Servidor ----------

// Um único cliente Pluggy para todas as requisições: reaproveita a apiKey (~2h).
const pluggy = new PluggyClient(clientId, clientSecret);

// Stateless: o SDK chama a fábrica e cria um McpServer novo a cada requisição.
const handler = createMcpHandler(() => criarServidor(pluggy, itemIds));
const mcp = toNodeHandler(handler, { onerror: (e) => console.error("Erro no MCP:", e.message) });

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const ip = ipDoCliente(req);
  // Loga só método, caminho, status e IP: nunca o conteúdo (são dados financeiros).
  res.on("finish", () => console.log(`${req.method} ${path} → ${res.statusCode} (${ip})`));

  // Sem dados: responde antes das checagens para a hospedagem saber que o servidor está de pé.
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    return;
  }

  if (!validateHost(req, res) || !validateOrigin(req, res)) return;

  if (publico && !ipPermitido(ip)) {
    res.writeHead(403).end();
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (!autorizado(req)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
    return;
  }
  void mcp(req, res);
});

server.listen(port, host, () => {
  const endereco = publico ? `https://${dominioPublico}/mcp` : `http://${host}:${port}/mcp`;
  console.log(`MCP pluggy-ponte (${publico ? "público" : "local"}) em ${endereco}`);
});

const encerrar = async () => {
  await handler.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar); // o Railway envia SIGTERM ao reiniciar ou atualizar
