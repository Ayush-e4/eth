import {
  type AddEthereumChainParameter,
  createWalletClient,
  custom,
  type EIP1193Provider,
  getAddress,
} from "viem";
import { createSiweMessage } from "viem/siwe";
import { api, type Me } from "./api";

/** Hedera testnet as MetaMask sees it (chain 296, gas paid in HBAR). */
const HEDERA_PARAMS: AddEthereumChainParameter = {
  chainId: "0x128",
  chainName: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: ["https://testnet.hashio.io/api"],
  blockExplorerUrls: ["https://hashscan.io/testnet"],
};

export const HEDERA_TESTNET = { chainId: 296, hex: "0x128", params: HEDERA_PARAMS } as const;

export type WalletStep = "connect" | "no-wallet" | "network" | "sign";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;

function provider(): EIP1193Provider {
  if (!window.ethereum) throw new WalletError("no-wallet", "MetaMask isn't installed");
  return window.ethereum;
}

export class WalletError extends Error {
  constructor(
    readonly step: WalletStep,
    message: string,
  ) {
    super(message);
  }
}

/** Asks MetaMask for an account. */
export async function connect(): Promise<`0x${string}`> {
  const [address] = await provider().request({ method: "eth_requestAccounts" });
  if (!address) throw new WalletError("connect", "No account was shared");
  return getAddress(address);
}

export async function onHederaTestnet(): Promise<boolean> {
  const id = await provider().request({ method: "eth_chainId" });
  return Number(id) === HEDERA_TESTNET.chainId;
}

/** Switches MetaMask to Hedera testnet, adding the network first if MetaMask doesn't know it. */
export async function switchToHedera(): Promise<void> {
  const eth = provider();
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: HEDERA_TESTNET.hex }],
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    await eth.request({ method: "wallet_addEthereumChain", params: [HEDERA_TESTNET.params] });
  }
}

/** The exact message MetaMask will show; built from a one-time code the server issued. */
export function signInMessage(address: `0x${string}`, nonce: string) {
  return createSiweMessage({
    address,
    chainId: HEDERA_TESTNET.chainId,
    domain: window.location.host,
    nonce,
    uri: window.location.origin,
    version: "1",
    statement: "Sign in to AgentNet. This will not send a transaction or cost any fees.",
    issuedAt: new Date(),
  });
}

/** Sign-In with Ethereum: get a code, have MetaMask sign the message, and start a session. */
export async function signIn(address: `0x${string}`): Promise<Me> {
  const { nonce } = await api<{ nonce: string }>("/auth/nonce");
  const message = signInMessage(address, nonce);
  const wallet = createWalletClient({ transport: custom(provider()) });
  const signature = await wallet.signMessage({ account: address, message });
  return (await api<{ user: Me }>("/auth/verify", { method: "POST", body: { message, signature } }))
    .user;
}
