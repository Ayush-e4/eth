import { z } from "zod";

/**
 * Hedera ↔ EVM address resolution via the mirror node.
 * Accounts with an ECDSA alias have an `evm_address`; everything else (contracts, tokens,
 * plain accounts) is addressable by its "long-zero" form: 0x + entity number in hex.
 */

export function longZero(id: string): `0x${string}` {
  const num = Number(id.split(".")[2]);
  if (!/^0\.0\.\d+$/.test(id) || !Number.isSafeInteger(num))
    throw new Error(`Bad Hedera id: ${id}`);
  return `0x${num.toString(16).padStart(40, "0")}`;
}

/** Asset id → EVM address used in executeTransfer ("0.0.0" = HBAR = address(0)). */
export function assetToEvm(asset: string): `0x${string}` {
  return asset === "0.0.0" ? "0x0000000000000000000000000000000000000000" : longZero(asset);
}

const AccountSchema = z.object({
  account: z.string(),
  evm_address: z.string().nullable().optional(),
});

const TokenSchema = z.object({
  custom_fees: z
    .object({
      fixed_fees: z.array(z.unknown()).optional(),
      fractional_fees: z.array(z.unknown()).optional(),
      royalty_fees: z.array(z.unknown()).optional(),
    })
    .optional(),
});

export class MirrorResolver {
  constructor(
    private readonly mirrorUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.mirrorUrl}/api/v1${path}`);
    if (!res.ok) throw new Error(`mirror ${path} → HTTP ${res.status}`);
    return res.json();
  }

  /** Hedera account id → the EVM address the chain uses for it. */
  async accountToEvm(accountId: string): Promise<`0x${string}`> {
    const a = AccountSchema.parse(await this.get(`/accounts/${accountId}`));
    return (a.evm_address as `0x${string}` | null | undefined) ?? longZero(a.account);
  }

  /** True if the token charges custom fees (then `exact` amounts can't hold). */
  async hasCustomFees(tokenId: string): Promise<boolean> {
    if (tokenId === "0.0.0") return false;
    const t = TokenSchema.parse(await this.get(`/tokens/${tokenId}`));
    const f = t.custom_fees;
    return Boolean(f?.fixed_fees?.length || f?.fractional_fees?.length || f?.royalty_fees?.length);
  }
}
