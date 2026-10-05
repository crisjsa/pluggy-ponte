# pluggy-ponte

Servidor **MCP remoto e somente leitura** que busca contas, transações e faturas de cartão na
[API da Pluggy](https://docs.pluggy.ai) (via Meu Pluggy) e entrega tudo num formato pronto para o
app web de finanças, que roda como artifact no Claude e acessa o servidor pelo conector.

Nada aqui escreve, paga ou move dinheiro: todas as ferramentas só leem.

---

## Ferramentas

| Ferramenta | Entrada | O que devolve |
|---|---|---|
| `listar_contas` | — | Contas e cartões com saldo (no cartão, o saldo é o limite usado, incluindo parcelas futuras) |
| `listar_transacoes` | `dataInicio`, `dataFim` (AAAA-MM-DD, padrão últimos 30 dias, máx. 366), `contaId` (opcional) | Lista de transações (formato abaixo) |
| `listar_faturas_abertas` | `incluirLancamentos` (opcional) | Fatura aberta **estimada** de cada cartão, última fatura fechada e data da última sincronização |
| `listar_faturas` | `mes` (AAAA-MM, opcional), `contaId` (opcional) | Faturas de cada cartão por mês: as fechadas (~12 meses) e a aberta (estimativa). `mesReferencia` = mês do **vencimento** |

Formato de cada transação:

```json
{
  "id": "0d633bc7-…",
  "data": "2026-10-03",
  "descricao": "ACAI FRUTO DO PARA BELO HORIZONT BRA",
  "valor": 104.8,
  "tipo": "saida",
  "contaId": "4e29b77b-…",
  "contaNome": "BANDEIRADO",
  "cartao": true,
  "status": "pendente",
  "categoriaPluggy": "Shopping",
  "categoriaPluggyId": "08000000",
  "pagamentoFatura": false
}
```

- `id`: id da Pluggy. O app atualiza pelo id e apaga as pendentes que deixarem de vir.
- `valor`: sempre positivo; o sentido está em `tipo` (`entrada` / `saida`).
- `pagamentoFatura`: `true` nos **dois lados** do pagamento de fatura (débito na conta e entrada no cartão). Some só um deles para não contar em dobro.
- A fatura aberta é uma estimativa: pode ficar abaixo do app do banco se algum lançamento ainda não sincronizou (veja `ultimaSincronizacao`).

---

## Adicionar um banco novo

Cada banco conectado na Pluggy vira um **item**, com um ID próprio. O servidor só enxerga os itens
listados em `PLUGGY_ITEM_IDS`.

1. **Conecte o banco no Meu Pluggy** ([meu.pluggy.ai](https://meu.pluggy.ai)) e conclua o login do banco.
2. **No Dashboard da Pluggy** ([dashboard.pluggy.ai](https://dashboard.pluggy.ai)), conecte o **MeuPluggy de novo**,
   para que a sua aplicação passe a ter acesso também ao banco novo.
3. **Copie o item ID** do banco novo. Ele tem o formato `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
4. **Acrescente o ID em `PLUGGY_ITEM_IDS`**, separado por vírgula, sem apagar os que já existem:
   ```
   PLUGGY_ITEM_IDS=<id-do-banco-1>,<id-do-banco-novo>
   ```
   - **No seu computador:** no arquivo `.env`.
   - **No Railway:** no serviço → aba **Variables** → edite `PLUGGY_ITEM_IDS` → aplique a mudança
     (o Railway mostra um aviso para fazer o deploy das alterações).
5. **Confira:**
   ```bash
   npm run contas
   ```
   As contas do banco novo devem aparecer. No Claude, peça para listar as contas.

> Se um banco parar de atualizar (senha trocada, consentimento expirado), reconecte-o no Meu Pluggy.
> O `npm run diagnostico-fatura` mostra a data da última sincronização de cada item.

---

## Rodar no seu computador

Requer **Node.js 24** ou mais novo.

```bash
npm install
cp .env.example .env    # preencha os valores
npm start               # http://127.0.0.1:3333/mcp
npm run testar-mcp      # em outro terminal: testa o servidor como o app faria
```

Outros scripts:

| Comando | O que faz |
|---|---|
| `npm run contas` | Saldo das contas, fatura aberta e última fatura fechada |
| `npm run transacoes -- 7` | Transações dos últimos 7 dias (padrão: 30) |
| `npm run diagnostico-fatura` | Detalha a conta da fatura aberta e a última sincronização com o banco |
| `npm run conferir-pendentes` | Verifica se o id das transações pendentes se mantém quando são confirmadas |
| `npm run typecheck` | Confere os tipos do TypeScript |

---

## Variáveis de ambiente

| Variável | Obrigatória | Para que serve |
|---|---|---|
| `PLUGGY_CLIENT_ID` | sim | Credencial da aplicação no Dashboard da Pluggy |
| `PLUGGY_CLIENT_SECRET` | sim | Idem |
| `PLUGGY_ITEM_IDS` | sim | IDs dos bancos conectados, separados por vírgula |
| `MCP_AUTH_TOKEN` | sim | Token que o conector do Claude envia (mínimo 32 caracteres) |
| `MCP_PORT` | não | Porta local (padrão 3333). No Railway é ignorada: ele usa `PORT` |
| `MCP_ALLOWED_IPS` | não | Faixas de IP aceitas no modo público (padrão: a do Claude, `160.79.104.0/21`) |
| `MCP_PUBLIC_HOST` | não | Domínio público, se não for o domínio gerado pelo Railway |

O `.env` **nunca** vai para o Git. No Railway, as variáveis ficam na aba **Variables** do serviço.

---

## Publicação (Railway)

O servidor detecta que está no Railway pela variável `PORT` e entra em **modo público**:

- escuta no endereço e porta que o Railway define;
- só aceita requisições endereçadas ao domínio do Railway (`RAILWAY_PUBLIC_DOMAIN`);
- só aceita IPs da Anthropic (`160.79.104.0/21`), lidos do cabeçalho `X-Real-IP`;
- exige o token em toda chamada a `/mcp`.

A cada `git push` para o GitHub, o Railway publica a versão nova sozinho.

### Conector no Claude

Em **Personalização → Conectores → Adicionar conector personalizado**:

1. **URL:** `https://<seu-domínio>.up.railway.app/mcp`
2. Clique em **Continuar**.
3. **Autenticação:** **Sem login**.
4. **Cabeçalhos de requisição → Adicionar cabeçalho:**
   - nome `authorization`, valor `Bearer <MCP_AUTH_TOKEN>`; **ou**
   - nome `x-api-key`, valor `<MCP_AUTH_TOKEN>` (sem "Bearer").

O Claude não deixa editar a autenticação depois. Para trocar o token, remova o conector e adicione de novo.

### Trocar o token

1. Gere um novo:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
2. Atualize `MCP_AUTH_TOKEN` no `.env` e no Railway.
3. Remova o conector no Claude e adicione de novo com o token novo.

---

## Segurança

- Somente leitura: nenhuma ferramenta altera dados na Pluggy ou no banco.
- Os logs registram só método, caminho, status e IP, nunca o conteúdo.
- O token é comparado em tempo constante e nunca vai no endereço (URL).
- Segredos ficam no `.env` (fora do Git) e nas variáveis do Railway.
