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
  amount: number;
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

export interface Item {
  id: string;
  status: string;
  executionStatus: string | null;
  lastUpdatedAt: string | null;
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

  // Faz um GET autenticado. Se a apiKey expirou (401), renova uma vez e tenta de novo.
  private async get<T>(path: string, retry = true): Promise<T> {
    this.apiKey ??= await this.authenticate();

    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "X-API-KEY": this.apiKey },
    });

    if (res.status === 401 && retry) {
      this.apiKey = undefined;
      return this.get<T>(path, false);
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
