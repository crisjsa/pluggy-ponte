// Cliente mínimo (somente leitura) da API da Pluggy.
// Documentação: https://docs.pluggy.ai

const BASE_URL = "https://api.pluggy.ai";

// Só os campos que usamos. A API devolve mais coisas, mas tipar só o
// necessário deixa o código mais simples.
export interface Account {
  id: string;
  itemId: string;
  type: "BANK" | "CREDIT";
  subtype: string;
  name: string;
  marketingName: string | null;
  number: string;
  balance: number;
  currencyCode: string;
  owner?: string | null;
  // Só vem preenchido em contas do tipo BANK. transferNumber = "banco/agência/conta".
  bankData?: { transferNumber?: string | null } | null;
  // Só vem preenchido em contas do tipo CREDIT (cartões).
  creditData?: {
    creditLimit: number | null;
    availableCreditLimit: number | null;
    balanceCloseDate: string | null;
    balanceDueDate: string | null;
    minimumPayment: number | null;
  } | null;
}

// Fatura de cartão. A Pluggy só devolve faturas JÁ FECHADAS;
// a fatura aberta (corrente) não aparece aqui.
export interface Bill {
  id: string;
  dueDate: string;
  billClosingDate: string | null;
  totalAmount: number;
  minimumPaymentAmount: number | null;
  payments: { amount: number; paymentDate: string }[] | null;
}

// Sinal do amount:
//   conta (BANK):    negativo = saída, positivo = entrada
//   cartão (CREDIT): positivo = compra (aumenta a dívida), negativo = pagamento/estorno
export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amount: number; // na moeda da compra (currencyCode): numa compra em dólar, vem em dólar
  amountInAccountCurrency?: number | null; // o mesmo valor convertido para a moeda da conta (reais)
  currencyCode?: string | null;
  type: "DEBIT" | "CREDIT";
  status: "PENDING" | "POSTED";
  category: string | null;
  categoryId: string | null;
  operationType?: string | null;
  creditCardMetadata?: {
    billId?: string | null;
    installmentNumber?: number | null;
    totalInstallments?: number | null;
  } | null;
}

// Valor em reais. Use sempre este em contas: `amount` vem na moeda da compra
// (ex.: assinatura de US$ 21,18 que custou R$ 114,52 na fatura).
export const amountBRL = (t: Transaction): number => t.amountInAccountCurrency ?? t.amount;

export interface Item {
  id: string;
  status: string;
  executionStatus: string | null;
  lastUpdatedAt: string | null;
}

// Investimento. Nos dados reais (Meu Pluggy): owner e institution nunca vêm,
// amountProfit e as taxas de rentabilidade (lastMonthRate etc.) também não.
export interface Investment {
  id: string;
  itemId: string;
  type: string; // FIXED_INCOME, EQUITY, MUTUAL_FUND, SECURITY, ETF, COE, OTHER
  subtype: string | null; // CDB, LCA, STOCK, REAL_ESTATE_FUND, BDR, FIXED_INCOME_FUND, TREASURY...
  name: string;
  code: string | null; // ticker em ações/FIIs; CNPJ em fundos; código do título em renda fixa
  isin: string | null;
  quantity: number | null;
  value: number | null; // preço unitário atual
  amount: number | null; // valor bruto atual
  balance: number | null; // valor líquido (descontados impostos)
  amountOriginal: number | null; // valor investido (só renda fixa, nos dados reais)
  amountProfit: number | null;
  currencyCode: string | null;
  date: string | null; // data da posição
  dueDate: string | null;
  rate: number | null;
  rateType: string | null;
  fixedAnnualRate: number | null;
  status: string | null; // ACTIVE, TOTAL_WITHDRAWAL...
}

export interface InvestmentTransaction {
  id: string;
  type: string; // BUY, SELL (dados reais); a API prevê outros (dividendos, juros, impostos...)
  movementType: string | null;
  description: string | null;
  date: string;
  tradeDate: string | null;
  quantity: number | null;
  value: number | null; // preço unitário
  amount: number | null; // valor bruto
  netAmount: number | null; // valor líquido
}

interface Page<T> {
  total: number;
  totalPages: number;
  page: number;
  results: T[];
}

export class PluggyClient {
  private apiKey: string | undefined;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  // Troca clientId + clientSecret por uma apiKey temporária (~2h).
  private async authenticate(): Promise<string> {
    const res = await fetch(`${BASE_URL}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
    });
    if (!res.ok) {
      throw new Error(`Falha na autenticação da Pluggy (HTTP ${res.status}). Confira o CLIENT_ID e o CLIENT_SECRET.`);
    }
    const data = (await res.json()) as { apiKey: string };
    return data.apiKey;
  }

  // Faz um GET autenticado.
  // - 401 (apiKey expirou): renova a apiKey uma vez e tenta de novo.
  // - 429 (limite de requisições da Pluggy) ou 503: espera e tenta de novo, até 3 vezes.
  //   Usa o Retry-After que a Pluggy manda; sem ele, 1 s, 2 s, 4 s. Nunca mais de 10 s por espera.
  private async get<T>(path: string, retry = true, tentativa = 0): Promise<T> {
    this.apiKey ??= await this.authenticate();

    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "X-API-KEY": this.apiKey },
    });

    if (res.status === 401 && retry) {
      this.apiKey = undefined;
      return this.get<T>(path, false, tentativa);
    }
    if ((res.status === 429 || res.status === 503) && tentativa < 3) {
      const pedido = Number(res.headers.get("retry-after"));
      const segundos = Math.min(Number.isFinite(pedido) && pedido > 0 ? pedido : 2 ** tentativa, 10);
      await res.body?.cancel();
      console.warn(`Pluggy HTTP ${res.status} em ${path.split("?")[0]}; nova tentativa em ${segundos}s`);
      await new Promise((r) => setTimeout(r, segundos * 1000));
      return this.get<T>(path, retry, tentativa + 1);
    }
    if (res.status === 429) {
      throw new Error("A Pluggy limitou o número de requisições (HTTP 429). Tente de novo em alguns segundos.");
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Erro da Pluggy em GET ${path} (HTTP ${res.status}): ${body}`);
    }
    return (await res.json()) as T;
  }

  // Situação da conexão: quando a Pluggy sincronizou com o banco pela última vez.
  async getItem(itemId: string): Promise<Item> {
    return this.get<Item>(`/items/${encodeURIComponent(itemId)}`);
  }

  async listAccounts(itemId: string): Promise<Account[]> {
    const page = await this.get<Page<Account>>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
    return page.results;
  }

  // Faturas fechadas de um cartão, da mais recente para a mais antiga.
  async listBills(accountId: string): Promise<Bill[]> {
    const page = await this.get<Page<Bill>>(`/bills?accountId=${encodeURIComponent(accountId)}`);
    return page.results.toSorted((a, b) => b.dueDate.localeCompare(a.dueDate));
  }

  // Todas as transações de uma conta no período (datas no formato AAAA-MM-DD).
  // Usa GET /v2/transactions, que pagina por cursor: cada resposta traz em
  // `next` a URL da próxima página (com o cursor no parâmetro `after`),
  // ou null quando acabou.
  async listTransactions(accountId: string, dateFrom: string, dateTo: string): Promise<Transaction[]> {
    const all: Transaction[] = [];
    let after: string | null = null;

    do {
      const params = new URLSearchParams({ accountId, dateFrom, dateTo });
      if (after) params.set("after", after);

      const page: { results: Transaction[]; next: string | null } =
        await this.get(`/v2/transactions?${params}`);
      all.push(...page.results);

      after = page.next ? new URL(page.next, BASE_URL).searchParams.get("after") : null;
    } while (after);

    return all;
  }

  // Percorre uma rota paginada por número de página (page/totalPages).
  private async allPages<T>(path: string): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const res = await this.get<Page<T>>(`${path}${sep}pageSize=500&page=${page}`);
      all.push(...res.results);
      if (page >= (res.totalPages ?? 1)) return all;
    }
  }

  async listInvestments(itemId: string): Promise<Investment[]> {
    return this.allPages<Investment>(`/investments?itemId=${encodeURIComponent(itemId)}`);
  }

  async listInvestmentTransactions(investmentId: string): Promise<InvestmentTransaction[]> {
    return this.allPages<InvestmentTransaction>(`/investments/${encodeURIComponent(investmentId)}/transactions`);
  }
}

// Lê as configurações do ambiente e falha cedo, com uma mensagem clara, se faltar algo.
export function loadConfig() {
  const clientId = process.env.PLUGGY_CLIENT_ID?.trim();
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET?.trim();
  const itemIds = (process.env.PLUGGY_ITEM_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const missing = [
    !clientId && "PLUGGY_CLIENT_ID",
    !clientSecret && "PLUGGY_CLIENT_SECRET",
    itemIds.length === 0 && "PLUGGY_ITEM_IDS",
  ].filter(Boolean);

  if (!clientId || !clientSecret || missing.length > 0) {
    throw new Error(`Variáveis faltando no .env: ${missing.join(", ")}`);
  }
  return { clientId, clientSecret, itemIds };
}
