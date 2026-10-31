import { type Client, ContractExecuteTransaction } from "@hiero-ledger/sdk";

/**
 * Calls a contract from the client's own Hedera account (msg.sender is that account's EVM
 * address) and waits for consensus. Throws if it reverted. Returns the transaction id.
 */
export async function executeContract(
  client: Client,
  c: { contractId: string; data: `0x${string}`; gas: number },
): Promise<string> {
  const res = await new ContractExecuteTransaction()
    .setContractId(c.contractId)
    .setGas(c.gas)
    .setFunctionParameters(Buffer.from(c.data.slice(2), "hex"))
    .execute(client);
  await res.getReceipt(client); // throws on CONTRACT_REVERT_EXECUTED and the like
  return res.transactionId.toString();
}
