// Nome da instituição de cada conta.
//
// As conexões feitas pelo Meu Pluggy informam sempre "MeuPluggy" como conector,
// então o banco de verdade vem do código COMPE no início de bankData.transferNumber
// ("336/0001/12345678-9" → 336 = C6). Cartões não têm esse número: herdam o banco
// da conta corrente da mesma conexão (ignorando corretoras, que não emitem cartão).

import type { Account } from "./pluggy.ts";

const BANCOS: Record<string, string> = {
  "001": "Banco do Brasil",
  "033": "Santander",
  "041": "Banrisul",
  "070": "BRB",
  "077": "Inter",
  "102": "XP Investimentos",
  "104": "Caixa Econômica Federal",
  "197": "Stone",
  "208": "BTG Pactual",
  "212": "Banco Original",
  "237": "Bradesco",
  "260": "Nubank",
  "290": "PagBank",
  "323": "Mercado Pago",
  "336": "C6 Bank",
  "341": "Itaú Unibanco",
  "348": "Banco XP S.A.",
  "380": "PicPay",
  "403": "Cora",
  "422": "Safra",
  "748": "Sicredi",
  "756": "Sicoob",
};

// Corretoras: têm conta, mas não emitem cartão de crédito.
const CORRETORAS = new Set(["102"]);

const codigoDoBanco = (acc: Account) => acc.bankData?.transferNumber?.split("/")[0]?.padStart(3, "0");

function bancoDaConta(acc: Account): string | null {
  const codigo = codigoDoBanco(acc);
  if (codigo && BANCOS[codigo]) return BANCOS[codigo];
  // Código fora da tabela: usa o nome que a própria conta informa.
  return acc.type === "BANK" ? (acc.marketingName ?? acc.name).trim() : null;
}

// Instituição onde ficam os investimentos de uma conexão: a corretora, se houver
// (na XP, "XP Investimentos"); senão, o banco da conta corrente.
export function bancoDosInvestimentos(contasDaConexao: Account[]): string | null {
  const correntes = contasDaConexao.filter((c) => c.type === "BANK");
  const custodiante = correntes.find((c) => CORRETORAS.has(codigoDoBanco(c) ?? "")) ?? correntes[0];
  return custodiante ? bancoDaConta(custodiante) : null;
}

// Devolve o nome do banco de cada conta (por id), olhando as outras contas da mesma conexão.
export function bancosPorConta(contas: Account[]): Map<string, string | null> {
  const resultado = new Map<string, string | null>();
  for (const acc of contas) {
    if (acc.type === "BANK") {
      resultado.set(acc.id, bancoDaConta(acc));
      continue;
    }
    const correntesDaConexao = contas.filter((c) => c.itemId === acc.itemId && c.type === "BANK");
    const emissora =
      correntesDaConexao.find((c) => !CORRETORAS.has(codigoDoBanco(c) ?? "")) ?? correntesDaConexao[0];
    resultado.set(acc.id, emissora ? bancoDaConta(emissora) : null);
  }
  return resultado;
}
