// Foto do patrimônio da casa: o que a Pluggy informa hoje (contas, investimentos, cartões)
// mais itens lançados à mão (dólar, imóvel...). Também o agendamento da foto de fim de mês.

import * as z from "zod/v4";
import type { Account, PluggyClient } from "./pluggy.ts";
import type { FotosPatrimonio } from "./fotos.ts";
import { estimateOpenBill, openBillSearchStart } from "./fatura.ts";
import { bancoDosInvestimentos, bancosPorConta } from "./bancos.ts";
import { toInvestimento } from "./investimentos.ts";
import { accountName } from "./formato.ts";

const FUSO = "America/Sao_Paulo";
const arred = (n: number) => Math.round(n * 100) / 100;
const somar = (valores: (number | null)[]) => arred(valores.reduce<number>((s, v) => s + (v ?? 0), 0));

// "Hoje" e o mês atual no fuso da casa.
export const hojeNaCasa = (agora = new Date()) => agora.toLocaleDateString("sv-SE", { timeZone: FUSO });
export const mesAtual = (agora = new Date()) => hojeNaCasa(agora).slice(0, 7);

export const ItemManualSchema = z.object({
  nome: z.string().min(1),
  tipo: z.enum(["dolar", "renda_fixa", "imovel", "outro"]),
  valorBRL: z.number().describe("Valor em reais"),
  observacao: z.string().optional(),
});
export type ItemManual = z.infer<typeof ItemManualSchema>;

export const TotaisSchema = z.object({
  investimentos: z.number().describe("Soma do valor bruto (valorAtual) dos investimentos ativos"),
  contas: z.number(),
  faturas_a_descontar: z.number().describe("Faturas abertas estimadas + faturas fechadas não pagas"),
  parcelas_futuras_info: z.number().describe("Só informativo: limite usado nos cartões além das faturas a descontar"),
  manuais: z.number(),
  patrimonio_liquido: z.number().describe("investimentos + contas + manuais − faturas_a_descontar"),
});
export type Totais = z.infer<typeof TotaisSchema>;

export interface DadosFoto {
  tiradaEm: string;
  contas: { id: string; banco: string | null; titular: string | null; nome: string; saldo: number }[];
  investimentos: {
    id: string;
    banco: string | null;
    titular: string | null;
    tipo: string;
    subtipo: string | null;
    nome: string;
    codigo: string | null;
    quantidade: number | null;
    precoAtual: number | null;
    valorAtual: number | null;
    valorLiquido: number | null;
    dataAtualizacao: string | null;
  }[];
  cartoes: {
    id: string;
    banco: string | null;
    titular: string | null;
    nome: string;
    faturaAbertaEstimada: number;
    faturasFechadasNaoPagas: { vencimento: string; valor: number; valorPago: number; aPagar: number }[];
    saldoUsado: number; // limite usado no cartão, incluindo parcelas futuras
    parcelasFuturas: number; // saldoUsado − fatura aberta − fechadas não pagas (mínimo 0)
  }[];
  conexoes: { itemId: string; bancos: string[]; status: string; ultimaSincronizacao: string | null }[];
}

// Faturas fechadas consideradas para "não paga": vencidas há no máximo 40 dias ou ainda por vencer.
// Faturas mais antigas sem pagamento registrado costumam ser só falta de dado da Pluggy.
const DIAS_FATURA_FECHADA = 40;

export async function coletarDados(pluggy: PluggyClient, itemIds: string[]): Promise<DadosFoto> {
  const tiradaEm = new Date().toISOString();
  const hoje = hojeNaCasa();
  const limiteVencimento = new Date(Date.parse(`${hoje}T00:00:00Z`) - DIAS_FATURA_FECHADA * 86_400_000).toISOString().slice(0, 10);

  const porConexao = await Promise.all(
    itemIds.map(async (itemId) => {
      const [item, contas, investimentos] = await Promise.all([
        pluggy.getItem(itemId),
        pluggy.listAccounts(itemId),
        pluggy.listInvestments(itemId),
      ]);
      return { item, contas, investimentos };
    }),
  );

  const todasAsContas = porConexao.flatMap((c) => c.contas);
  const bancos = bancosPorConta(todasAsContas);
  const titular = (acc: Account) => acc.owner?.trim() || null;

  const contas = todasAsContas
    .filter((acc) => acc.type !== "CREDIT")
    .map((acc) => ({ id: acc.id, banco: bancos.get(acc.id) ?? null, titular: titular(acc), nome: accountName(acc), saldo: arred(acc.balance) }));

  const investimentos = porConexao.flatMap(({ contas, investimentos }) => {
    const banco = bancoDosInvestimentos(contas);
    const dono = contas.find((c) => c.owner?.trim())?.owner?.trim() ?? null;
    return investimentos
      .filter((inv) => inv.status !== "TOTAL_WITHDRAWAL")
      .map((inv) => {
        const i = toInvestimento(inv, banco, dono);
        return {
          id: i.id,
          banco: i.banco,
          titular: i.titular,
          tipo: i.tipo,
          subtipo: i.subtipo,
          nome: i.nome,
          codigo: i.codigo,
          quantidade: i.quantidade,
          precoAtual: i.precoAtual,
          valorAtual: i.valorAtual,
          valorLiquido: i.valorLiquido,
          dataAtualizacao: i.dataAtualizacao,
        };
      });
  });

  // Mesma conta da fatura aberta de listar_faturas_abertas.
  const cartoes = await Promise.all(
    todasAsContas
      .filter((acc) => acc.type === "CREDIT")
      .map(async (acc) => {
        const bills = await pluggy.listBills(acc.id);
        const transacoes = await pluggy.listTransactions(acc.id, openBillSearchStart(bills[0]), hoje);
        const aberta = arred(estimateOpenBill(transacoes, bills).total);
        const naoPagas = bills
          .filter((b) => b.dueDate.slice(0, 10) >= limiteVencimento)
          .map((b) => {
            const pago = arred((b.payments ?? []).reduce((s, p) => s + p.amount, 0));
            return { vencimento: b.dueDate.slice(0, 10), valor: arred(b.totalAmount), valorPago: pago, aPagar: arred(b.totalAmount - pago) };
          })
          .filter((b) => b.aPagar > 0.01);
        const saldoUsado = arred(acc.balance);
        return {
          id: acc.id,
          banco: bancos.get(acc.id) ?? null,
          titular: titular(acc),
          nome: accountName(acc),
          faturaAbertaEstimada: aberta,
          faturasFechadasNaoPagas: naoPagas,
          saldoUsado,
          parcelasFuturas: Math.max(0, arred(saldoUsado - aberta - somar(naoPagas.map((b) => b.aPagar)))),
        };
      }),
  );

  const conexoes = porConexao.map(({ item, contas }) => ({
    itemId: item.id,
    bancos: [...new Set(contas.map((c) => bancos.get(c.id)).filter((b): b is string => !!b))],
    status: item.status,
    ultimaSincronizacao: item.lastUpdatedAt,
  }));

  return { tiradaEm, contas, investimentos, cartoes, conexoes };
}

export function calcularTotais(dados: DadosFoto, itens: ItemManual[]): Totais {
  const investimentos = somar(dados.investimentos.map((i) => i.valorAtual));
  const contas = somar(dados.contas.map((c) => c.saldo));
  const faturas = somar(dados.cartoes.flatMap((c) => [c.faturaAbertaEstimada, ...c.faturasFechadasNaoPagas.map((b) => b.aPagar)]));
  const manuais = somar(itens.map((i) => i.valorBRL));
  return {
    investimentos,
    contas,
    faturas_a_descontar: faturas,
    parcelas_futuras_info: somar(dados.cartoes.map((c) => c.parcelasFuturas)),
    manuais,
    patrimonio_liquido: arred(investimentos + contas + manuais - faturas),
  };
}

// ---------- Agendamento ----------

// Todo dia às 23:30 (horário da casa) confere se amanhã é dia 1; se for, tira a foto do mês que termina.
// Checa a cada minuto, para funcionar mesmo se o servidor reiniciar depois das 23:30.
// Se a foto falhar, tenta de novo no minuto seguinte, até 5 vezes.
const HORA_FOTO = "23:30";
const MAX_TENTATIVAS = 5;

export function agendarFotoMensal(pluggy: PluggyClient, itemIds: string[], fotos: FotosPatrimonio): () => void {
  let diaFeito: string | null = null;
  let tentativas = 0;
  let rodando = false;

  const conferir = async () => {
    const agora = new Date();
    const hoje = hojeNaCasa(agora);
    const hora = agora.toLocaleTimeString("en-GB", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
    const amanha = hojeNaCasa(new Date(agora.getTime() + 24 * 60 * 60 * 1000));
    if (rodando || diaFeito === hoje || hora < HORA_FOTO || !amanha.endsWith("-01")) return;

    rodando = true;
    const mes = hoje.slice(0, 7);
    try {
      const { foto, motivo } = await fotos.salvar(mes, await coletarDados(pluggy, itemIds), "automatica");
      // Só o resultado, nunca valores (são dados financeiros).
      console.log(foto ? `Foto do patrimônio ${mes}: salva (automática)` : `Foto do patrimônio ${mes}: não alterada. ${motivo}`);
      diaFeito = hoje;
    } catch (e) {
      tentativas++;
      console.error(`Foto do patrimônio ${mes}: erro (tentativa ${tentativas}/${MAX_TENTATIVAS}): ${(e as Error).message}`);
      if (tentativas >= MAX_TENTATIVAS) diaFeito = hoje;
    } finally {
      if (diaFeito === hoje) tentativas = 0;
      rodando = false;
    }
  };

  const timer = setInterval(() => void conferir(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
