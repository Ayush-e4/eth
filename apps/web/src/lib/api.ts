import type { Card, ChatMode } from "@eth/shared";

/** Shapes the API returns (see apps/api). Amounts in USDC base units travel as strings. */
export interface Me {
  id: string;
  address: string | null;
  displayName: string | null;
  homeCity: string | null;
  isDemo: boolean;
  defaultMode: ChatMode;
  defaultLimitUnits: string;
  onboarded: boolean;
  roles: ("user" | "builder" | "admin")[];
}

export interface ChatSummary {
  id: string;
  title: string;
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
  createdAt: string;
}

export interface Limit {
  mandateId: string;
  chatId: string;
  chatTitle: string;
  demo: boolean;
  budgetUnits: string;
  spentUnits: string | null;
  payees: string[];
  expiresAt: string;
  status: "active" | "expired" | "revoked";
}

export interface WalletInfo {
  account: string | null;
  address: string | null;
  shared: boolean;
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
    createdAt: string;
  }[];
}

export const hashscanTx = (tx: string) => `https://hashscan.io/testnet/transaction/${tx}`;
export const arkivEntity = (key: string) => `https://tiramisu.explorer.arkiv.network/entity/${key}`;
export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
