// Fotos mensais do patrimônio, guardadas no Postgres (DATABASE_URL).
// A Pluggy só informa os valores do dia; estas fotos formam o histórico.

import pg from "pg";
import { calcularTotais, type DadosFoto, type ItemManual, type Totais } from "./patrimonio.ts";

export type Origem = "automatica" | "manual";
export type Status = "parcial" | "fechada";

export interface Foto {
  mes: string;
  tiradaEm: string;
  origem: Origem;
  status: Status;
  dados: DadosFoto;
  itensManuais: ItemManual[];
  totais: Totais;
  atualizadaEm: string;
}

const CRIAR_TABELA = `
  CREATE TABLE IF NOT EXISTS fotos_patrimonio (
    mes           text PRIMARY KEY CHECK (mes ~ '^\\d{4}-(0[1-9]|1[0-2])$'),
    tirada_em     timestamptz NOT NULL,
    origem        text NOT NULL CHECK (origem IN ('automatica', 'manual')),
    status        text NOT NULL DEFAULT 'parcial' CHECK (status IN ('parcial', 'fechada')),
    dados         jsonb NOT NULL,
    itens_manuais jsonb NOT NULL DEFAULT '[]',
    totais        jsonb NOT NULL,
    atualizada_em timestamptz NOT NULL DEFAULT now()
  )`;

const paraFoto = (r: Record<string, unknown>): Foto => ({
  mes: r.mes as string,
  tiradaEm: (r.tirada_em as Date).toISOString(),
  origem: r.origem as Origem,
  status: r.status as Status,
  dados: r.dados as DadosFoto,
  itensManuais: r.itens_manuais as ItemManual[],
  totais: r.totais as Totais,
  atualizadaEm: (r.atualizada_em as Date).toISOString(),
});

export class FotosPatrimonio {
  private readonly pool: pg.Pool;
  private pronto: Promise<void> | null = null;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 3 });
    // Erro numa conexão ociosa (ex.: o Postgres reiniciou) não pode derrubar o servidor.
    this.pool.on("error", (e) => console.error("Postgres:", e.message));
  }

  // Cria a tabela na primeira vez que for usada.
  private preparar(): Promise<void> {
    this.pronto ??= this.pool.query(CRIAR_TABELA).then(
      () => undefined,
      (e) => {
        this.pronto = null;
        throw e;
      },
    );
    return this.pronto;
  }

  async listar(de?: string, ate?: string): Promise<Foto[]> {
    await this.preparar();
    const { rows } = await this.pool.query(
      `SELECT * FROM fotos_patrimonio
        WHERE ($1::text IS NULL OR mes >= $1) AND ($2::text IS NULL OR mes <= $2)
        ORDER BY mes`,
      [de ?? null, ate ?? null],
    );
    return rows.map(paraFoto);
  }

  // Grava os dados do dia. Foto 'fechada' nunca é sobrescrita: é preciso reabrir antes.
  // Em foto existente, mantém os itens manuais e recalcula os totais.
  async salvar(mes: string, dados: DadosFoto, origem: Origem): Promise<{ foto: Foto | null; motivo?: string }> {
    return this.transacao(async (c) => {
      const atual = (await c.query("SELECT * FROM fotos_patrimonio WHERE mes = $1 FOR UPDATE", [mes])).rows[0];
      if (atual?.status === "fechada") {
        return { foto: null, motivo: `A foto de ${mes} está fechada. Use reabrir_foto_patrimonio antes de tirar de novo.` };
      }
      const itens: ItemManual[] = atual?.itens_manuais ?? [];
      const { rows } = await c.query(
        `INSERT INTO fotos_patrimonio (mes, tirada_em, origem, dados, itens_manuais, totais)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (mes) DO UPDATE SET
           tirada_em = EXCLUDED.tirada_em, origem = EXCLUDED.origem, dados = EXCLUDED.dados,
           totais = EXCLUDED.totais, atualizada_em = now()
         RETURNING *`,
        [mes, dados.tiradaEm, origem, JSON.stringify(dados), JSON.stringify(itens), JSON.stringify(calcularTotais(dados, itens))],
      );
      return { foto: paraFoto(rows[0]) };
    });
  }

  // Troca a lista de itens manuais (dólar, imóvel...) e recalcula os totais. fechar=true fecha a foto.
  async completar(mes: string, itens: ItemManual[], fechar: boolean): Promise<{ foto: Foto | null; motivo?: string }> {
    return this.transacao(async (c) => {
      const atual = (await c.query("SELECT * FROM fotos_patrimonio WHERE mes = $1 FOR UPDATE", [mes])).rows[0];
      if (!atual) return { foto: null, motivo: `Não há foto de ${mes}. Use tirar_foto_patrimonio primeiro.` };
      if (atual.status === "fechada") return { foto: null, motivo: `A foto de ${mes} está fechada. Use reabrir_foto_patrimonio antes.` };
      const { rows } = await c.query(
        `UPDATE fotos_patrimonio SET itens_manuais = $2, totais = $3, status = $4, atualizada_em = now()
          WHERE mes = $1 RETURNING *`,
        [mes, JSON.stringify(itens), JSON.stringify(calcularTotais(atual.dados, itens)), fechar ? "fechada" : "parcial"],
      );
      return { foto: paraFoto(rows[0]) };
    });
  }

  async reabrir(mes: string): Promise<Foto | null> {
    await this.preparar();
    const { rows } = await this.pool.query(
      "UPDATE fotos_patrimonio SET status = 'parcial', atualizada_em = now() WHERE mes = $1 RETURNING *",
      [mes],
    );
    return rows[0] ? paraFoto(rows[0]) : null;
  }

  async fechar(): Promise<void> {
    await this.pool.end();
  }

  private async transacao<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    await this.preparar();
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
}

// null quando DATABASE_URL não está definida (as ferramentas de foto respondem com erro).
export function fotosDoAmbiente(): FotosPatrimonio | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? new FotosPatrimonio(url) : null;
}
