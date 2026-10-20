import { z } from "zod";

/**
 * Read-only queries via the Mirror Node REST API.
 * (AccountBalanceQuery on consensus nodes is deprecated since v0.77 — use this instead.)
 */

const AccountSchema = z.object({
  account: z.string(),
  evm_address: z.string().nullable().optional(),
  balance: z.object({
    balance: z.number(),
    tokens: z.array(z.object({ token_id: z.string(), balance: z.number() })),
  }),
});

export interface AccountBalances {
  accountId: string;
  evmAddress?: string;
  tinybars: bigint;
  tokens: Record<string, bigint>;
}

export function parseAccount(json: unknown): AccountBalances {
  const a = AccountSchema.parse(json);
  return {
    accountId: a.account,
    evmAddress: a.evm_address ?? undefined,
    tinybars: BigInt(a.balance.balance),
    tokens: Object.fromEntries(a.balance.tokens.map((t) => [t.token_id, BigInt(t.balance)])),
  };
}

const MessagesSchema = z.object({
  messages: z.array(
    z.object({
      sequence_number: z.number(),
      consensus_timestamp: z.string(),
      message: z.string(),
    }),
  ),
});

export interface TopicMessage {
  sequence: number;
  timestamp: string;
  text: string;
}

export function parseMessages(json: unknown): TopicMessage[] {
  return MessagesSchema.parse(json).messages.map((m) => ({
    sequence: m.sequence_number,
    timestamp: m.consensus_timestamp,
    text: Buffer.from(m.message, "base64").toString("utf8"),
  }));
}

type Fetch = typeof fetch;

export class Mirror {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`);
    if (!res.ok) throw new Error(`Mirror ${path} → HTTP ${res.status}`);
    return res.json();
  }

  async balances(accountIdOrEvm: string): Promise<AccountBalances> {
    return parseAccount(await this.get(`/accounts/${accountIdOrEvm}`));
  }

  async topicMessages(topicId: string, limit = 10): Promise<TopicMessage[]> {
    return parseMessages(await this.get(`/topics/${topicId}/messages?order=desc&limit=${limit}`));
  }
}
