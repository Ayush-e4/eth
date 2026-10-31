import type { Card, ChatMode } from "@eth/shared";

/** Shapes the API returns (see apps/api). Amounts in USDC base units travel as strings. */
export interface Me {
  id: string;
  address: string | null;
  displayName: string | null;
  homeCity: string | null;
  isDemo: boolean; // pays from the shared demo wallet (passkey and demo accounts)
  passkey?: boolean; // signs in with a passkey (sent by GET /me)
  wallet?: { address: string; status: "creating" | "ready" | "failed" } | null; // Face ID wallet
  defaultMode: ChatMode;
  defaultLimitUnits: string;
  onboarded: boolean;
  roles: ("user" | "builder" | "admin")[];
}

export interface ChatSummary {
  id: string;
  title: string;
  agent: { address: string; name: string; skill: string } | null; // a chat with one agent
  mode: ChatMode;
  limitUnits: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Same-origin call to the API (forwarded by Next to the Hono server). */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `request failed (${res.status})`);
  return data as T;
}

export const usdc = (units: string | bigint) => (Number(units) / 1e6).toFixed(2);

/** "0x7a3f…91c2" */
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export interface Task {
  id: string;
  chatId: string;
  chatTitle: string;
  skill: string;
  agent: string;
  title: string;
  feeUnits: string;
  mandateId: string;
  hederaTx: string;
  jobKey: string;
  result: unknown;
  logSeq: number | null;
  createdAt: string;
}

export interface Limit {
  id: string;
  mandateId: string;
  registry: string;
  /** On an older MandateRegistry: no new hires use it, but it can still be cancelled. */
  retired: boolean;
  chatId: string;
  chatTitle: string;
  demo: boolean;
  via: "demo" | "wallet" | "face-id"; // who cancels it: the server, MetaMask, or Face ID
  budgetUnits: string;
  spentUnits: string | null;
  payees: string[];
  expiresAt: string;
  status: "active" | "expired" | "revoked";
  logSeq: number | null;
}

export interface WalletInfo {
  account: string | null;
  address: string | null;
  shared: boolean;
  /** Their own Face ID wallet (passkey users), with the free test USDC it got, if any. */
  faceId: { status: "creating" | "ready" | "failed"; giftUnits: string | null } | null;
  balances: { usdcUnits: string; hbarTinybars: string } | null;
  spentUnits: string;
  limits: Limit[];
  payments: {
    id: string;
    chatTitle: string;
    to: string;
    skill: string;
    feeUnits: string;
    hederaTx: string;
    logSeq: number | null;
    createdAt: string;
  }[];
  logTopic: string | null;
}

/** One entry on the public spend log (an HCS topic): written by the facilitator or the app. */
export interface LogEntry {
  seq: number;
  at: string;
  kind: string;
  [field: string]: unknown;
}

export const hashscanTx = (tx: string) => `https://hashscan.io/testnet/transaction/${tx}`;
/** HashScan has no page per message; the topic page lists every entry by number. */
export const hashscanSchedule = (id: string) => `https://hashscan.io/testnet/schedule/${id}`;
export const hashscanTopic = (topic: string) => `https://hashscan.io/testnet/topic/${topic}`;
export const arkivEntity = (key: string) => `https://rabdi.explorer.arkiv.network/entity/${key}`;
export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
