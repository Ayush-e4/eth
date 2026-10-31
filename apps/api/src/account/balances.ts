/** Balances from Hedera's public mirror node: USDC (6 decimals) and HBAR (tinybars). */
export async function balances(
  mirrorUrl: string,
  account: string,
  usdcTokenId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const res = await fetchImpl(`${mirrorUrl}/api/v1/balances?account.id=${account}`).catch(
    () => null,
  );
  if (!res?.ok) return null;
  const body = (await res.json()) as {
    balances?: { balance: number; tokens: { token_id: string; balance: number }[] }[];
  };
  const b = body.balances?.[0];
  if (!b) return null;
  return {
    hbarTinybars: String(b.balance),
    usdcUnits: String(b.tokens.find((t) => t.token_id === usdcTokenId)?.balance ?? 0),
  };
}
