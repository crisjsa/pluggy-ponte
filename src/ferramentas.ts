// Ferramentas MCP (somente leitura) expostas ao app web.

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Account, PluggyClient } from "./pluggy.ts";
import { estimateOpenBill, openBillDates, openBillSearchStart } from "./fatura.ts";
import { billPaymentMatcher } from "./pagamentos.ts";
import { ContaSchema, TransacaoSchema, accountName, toConta, toTransacao } from "./formato.ts";

const MAX_DIAS = 366;
const DATA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD");
const SOMENTE_LEITURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// "Hoje" no fuso de Brasília, para o padrão de datas não pular de dia à noite.
const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const somarDias = (data: string, dias: number) => {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const diasEntre = (inicio: string, fim: string) =>
  (Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000;

// Resposta de sucesso: JSON legível em `content` + objeto tipado em `structuredContent`.
const ok = <T extends Record<string, unknown>>(dados: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(dados) }],
  structuredContent: dados,
});
const erro = (mensagem: string) => ({ content: [{ type: "text" as const, text: mensagem }], isError: true });

async function listarTodasAsContas(pluggy: PluggyClient, itemIds: string[]): Promise<Account[]> {
  const porItem = await Promise.all(itemIds.map((id) => pluggy.listAccounts(id)));
  return porItem.flat();
}

export function criarServidor(pluggy: PluggyClient, itemIds: string[]): McpServer {
  const server = new McpServer({ name: "pluggy-ponte", version: "0.1.0" });

  server.registerTool(
    "listar_contas",
    {
      title: "Listar contas",
      description: "Lista as contas bancárias e cartões de crédito conectados, com saldo.",
      outputSchema: z.object({ contas: z.array(ContaSchema) }),
      annotations: SOMENTE_LEITURA,
    },
    async () => {
      const contas = (await listarTodasAsContas(pluggy, itemIds)).map(toConta);
      return ok({ contas });
    },
  );

  server.registerTool(
    "listar_transacoes",
    {
      title: "Listar transações",
      description:
        "Lista transações de contas e cartões num período (padrão: últimos 30 dias, máximo 366). " +
        "Cada transação tem um `id` estável da Pluggy para evitar duplicadas, `valor` sempre positivo " +
        "e `tipo` entrada/saída. `pagamentoFatura` marca os dois lados do pagamento de fatura de cartão " +
        "(débito na conta e entrada no cartão). Transações pendentes podem mudar ou sumir em sincronizações futuras.",
      inputSchema: z.object({
        dataInicio: DATA.optional().describe("Início do período (AAAA-MM-DD). Padrão: 30 dias antes de dataFim."),
        dataFim: DATA.optional().describe("Fim do período, inclusivo (AAAA-MM-DD). Padrão: hoje."),
        contaId: z.string().optional().describe("Filtra por uma conta (id de listar_contas)."),
      }),
      outputSchema: z.object({
        periodo: z.object({ inicio: z.string(), fim: z.string() }),
        total: z.number(),
        transacoes: z.array(TransacaoSchema),
      }),
      annotations: SOMENTE_LEITURA,
    },
    async ({ dataInicio, dataFim, contaId }) => {
      const fim = dataFim ?? hoje();
      const inicio = dataInicio ?? somarDias(fim, -30);
      if (inicio > fim) return erro(`dataInicio (${inicio}) é depois de dataFim (${fim}).`);
      if (diasEntre(inicio, fim) > MAX_DIAS) return erro(`Período maior que ${MAX_DIAS} dias. Divida em partes menores.`);

      let contas = await listarTodasAsContas(pluggy, itemIds);
      if (contaId) {
        contas = contas.filter((c) => c.id === contaId);
        if (contas.length === 0) return erro(`Conta ${contaId} não encontrada. Use listar_contas para ver os ids.`);
      }

      // As faturas de TODOS os cartões são necessárias mesmo filtrando uma conta corrente:
      // é nelas que estão os pagamentos que marcam pagamentoFatura no débito da conta.
      const todosOsCartoes = (contaId ? await listarTodasAsContas(pluggy, itemIds) : contas).filter((c) => c.type === "CREDIT");
      const faturas = (await Promise.all(todosOsCartoes.map((c) => pluggy.listBills(c.id)))).flat();
      const ehPagamentoFatura = billPaymentMatcher(faturas);

      const porConta = await Promise.all(
        contas.map(async (acc) =>
          (await pluggy.listTransactions(acc.id, inicio, fim)).map((t) => toTransacao(t, acc, ehPagamentoFatura(t))),
        ),
      );
      const transacoes = porConta.flat().toSorted((a, b) => b.data.localeCompare(a.data));

      return ok({ periodo: { inicio, fim }, total: transacoes.length, transacoes });
    },
  );

  server.registerTool(
    "listar_faturas_abertas",
    {
      title: "Listar faturas abertas",
      description:
        "Retorna, para cada cartão de crédito, a fatura aberta (corrente) ESTIMADA: soma dos lançamentos " +
        "ainda não incluídos em fatura fechada, sem os pagamentos de faturas anteriores. Pode ficar abaixo " +
        "do valor do app do banco se algum lançamento ainda não foi sincronizado (veja ultimaSincronizacao).",
      inputSchema: z.object({
        incluirLancamentos: z.boolean().optional().describe("Se true, inclui os lançamentos de cada fatura. Padrão: false."),
      }),
      outputSchema: z.object({
        faturas: z.array(
          z.object({
            contaId: z.string(),
            contaNome: z.string(),
            valorEstimado: z.number(),
            valorPendente: z.number().describe("Parte do valor que ainda está pendente no banco"),
            quantidadeLancamentos: z.number(),
            ultimaSincronizacao: z.string().nullable().describe("Quando a Pluggy atualizou os dados do banco (ISO 8601)"),
            ultimaFaturaFechada: z
              .object({ fechamento: z.string().nullable(), vencimento: z.string(), valor: z.number(), paga: z.boolean() })
              .nullable(),
            lancamentos: z.array(TransacaoSchema).optional(),
          }),
        ),
      }),
      annotations: SOMENTE_LEITURA,
    },
    async ({ incluirLancamentos }) => {
      const cartoes = (await listarTodasAsContas(pluggy, itemIds)).filter((c) => c.type === "CREDIT");
      const items = new Map(
        await Promise.all([...new Set(cartoes.map((c) => c.itemId))].map(async (id) => [id, await pluggy.getItem(id)] as const)),
      );

      const faturas = await Promise.all(
        cartoes.map(async (acc) => {
          const bills = await pluggy.listBills(acc.id);
          const ultima = bills[0];
          const transacoes = await pluggy.listTransactions(acc.id, openBillSearchStart(ultima), hoje());
          const aberta = estimateOpenBill(transacoes, bills);
          const pago = (ultima?.payments ?? []).reduce((s, p) => s + p.amount, 0);
          const arred = (n: number) => Math.round(n * 100) / 100;

          return {
            contaId: acc.id,
            contaNome: accountName(acc),
            valorEstimado: arred(aberta.total),
            valorPendente: arred(aberta.pendingTotal),
            quantidadeLancamentos: aberta.transactions.length,
            ultimaSincronizacao: items.get(acc.itemId)?.lastUpdatedAt ?? null,
            ultimaFaturaFechada: ultima
              ? {
                  fechamento: ultima.billClosingDate?.slice(0, 10) ?? null,
                  vencimento: ultima.dueDate.slice(0, 10),
                  valor: ultima.totalAmount,
                  paga: pago >= ultima.totalAmount - 0.01,
                }
              : null,
            // Pagamentos já foram excluídos da fatura aberta, então nenhum lançamento aqui é pagamento.
            ...(incluirLancamentos && { lancamentos: aberta.transactions.map((t) => toTransacao(t, acc, false)) }),
          };
        }),
      );

      return ok({ faturas });
    },
  );

  server.registerTool(
    "listar_faturas",
    {
      title: "Listar faturas",
      description:
        "Lista as faturas de cada cartão: as fechadas (últimos ~12 meses, valores do banco) e a aberta " +
        "(valor ESTIMADO, com vencimento previsto). `mesReferencia` (AAAA-MM) é o mês do VENCIMENTO, como " +
        "o banco nomeia a fatura. Use `mes` para filtrar um mês.",
      inputSchema: z.object({
        mes: z
          .string()
          .regex(/^\d{4}-\d{2}$/, "Use o formato AAAA-MM")
          .optional()
          .describe("Filtra pelo mês de referência (vencimento), ex.: 2026-10"),
        contaId: z.string().optional().describe("Filtra por um cartão (id de listar_contas)."),
      }),
      outputSchema: z.object({
        faturas: z.array(
          z.object({
            contaId: z.string(),
            contaNome: z.string(),
            mesReferencia: z.string().nullable().describe("Mês do vencimento (AAAA-MM)"),
            vencimento: z.string().nullable(),
            fechamento: z.string().nullable(),
            valor: z.number(),
            situacao: z.enum(["fechada", "aberta"]),
            estimativa: z.boolean().describe("true na fatura aberta: valor e datas são previsões"),
            paga: z.boolean(),
            valorPago: z.number(),
          }),
        ),
      }),
      annotations: SOMENTE_LEITURA,
    },
    async ({ mes, contaId }) => {
      let cartoes = (await listarTodasAsContas(pluggy, itemIds)).filter((c) => c.type === "CREDIT");
      if (contaId) {
        cartoes = cartoes.filter((c) => c.id === contaId);
        if (cartoes.length === 0) return erro(`Cartão ${contaId} não encontrado. Use listar_contas para ver os ids.`);
      }
      const arred = (n: number) => Math.round(n * 100) / 100;

      const porCartao = await Promise.all(
        cartoes.map(async (acc) => {
          const bills = await pluggy.listBills(acc.id);
          const ultima = bills[0];
          const transacoes = await pluggy.listTransactions(acc.id, openBillSearchStart(ultima), hoje());
          const aberta = estimateOpenBill(transacoes, bills);
          const previstas = openBillDates(ultima);
          const base = { contaId: acc.id, contaNome: accountName(acc) };

          const fechadas = bills.map((b) => {
            const pago = arred((b.payments ?? []).reduce((s, p) => s + p.amount, 0));
            return {
              ...base,
              mesReferencia: b.dueDate.slice(0, 7),
              vencimento: b.dueDate.slice(0, 10),
              fechamento: b.billClosingDate?.slice(0, 10) ?? null,
              valor: b.totalAmount,
              situacao: "fechada" as const,
              estimativa: false,
              paga: pago >= b.totalAmount - 0.01,
              valorPago: pago,
            };
          });

          const faturaAberta = {
            ...base,
            mesReferencia: previstas.dueDate?.slice(0, 7) ?? null,
            vencimento: previstas.dueDate,
            fechamento: previstas.closingDate,
            valor: arred(aberta.total),
            situacao: "aberta" as const,
            estimativa: true,
            paga: false,
            valorPago: 0,
          };

          return [faturaAberta, ...fechadas];
        }),
      );

      const faturas = porCartao
        .flat()
        .filter((f) => !mes || f.mesReferencia === mes)
        .toSorted((a, b) => (b.vencimento ?? "9999").localeCompare(a.vencimento ?? "9999"));

      return ok({ faturas });
    },
  );

  return server;
}
