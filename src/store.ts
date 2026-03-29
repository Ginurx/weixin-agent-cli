/**
 * Account storage for weixin-agent-cli.
 *
 * Storage layout under ~/.weixin-agent-cli/:
 *   accounts.json                          — array of registered account IDs
 *   accounts/{accountId}.json              — credentials { token, baseUrl, userId, savedAt }
 *   accounts/{accountId}.sync.json         — { get_updates_buf }
 *   accounts/{accountId}.context-tokens.json — { userId: contextToken }
 *
 * Override the base directory with WEIXIN_AGENT_CLI_HOME env var.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BASE_URL, CDN_BASE_URL } from "./api.js";

// ---------------------------------------------------------------------------
// State directory
// ---------------------------------------------------------------------------

function resolveBaseDir(): string {
  return (
    process.env.WEIXIN_AGENT_CLI_HOME?.trim() ||
    path.join(os.homedir(), ".weixin-agent-cli")
  );
}

function resolveAccountsDir(): string {
  return path.join(resolveBaseDir(), "accounts");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveBaseDir(), "accounts.json");
}

// ---------------------------------------------------------------------------
// Account data types
// ---------------------------------------------------------------------------

export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  userId?: string;
};

export type ResolvedAccount = {
  accountId: string;
  token?: string;
  baseUrl: string;
  cdnBaseUrl: string;
  userId?: string;
  configured: boolean;
};

// ---------------------------------------------------------------------------
// Account index
// ---------------------------------------------------------------------------

export function listAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

export function registerAccountId(accountId: string): void {
  const dir = resolveBaseDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = listAccountIds();
  if (existing.includes(accountId)) return;
  const updated = [...existing, accountId];
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

export function unregisterAccountId(accountId: string): void {
  const existing = listAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

export function loadAccount(accountId: string): WeixinAccountData | null {
  try {
    const filePath = resolveAccountPath(accountId);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch { /* ignore */ }
  return null;
}

export function saveAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadAccount(accountId) ?? {};
  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch { /* best-effort */ }
}

export function clearAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  const files = [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
  ];
  for (const file of files) {
    try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
  }
}

export function resolveAccount(accountId: string): ResolvedAccount {
  const data = loadAccount(accountId);
  return {
    accountId,
    token: data?.token,
    baseUrl: data?.baseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    userId: data?.userId,
    configured: Boolean(data?.token),
  };
}

/**
 * Resolve the default account ID. If only one account is registered, use it.
 * If multiple, throw an error asking the user to specify.
 */
export function resolveDefaultAccountId(): string {
  const ids = listAccountIds();
  if (ids.length === 0) {
    throw new Error("No accounts found. Run 'weixin-agent-cli login' first.");
  }
  if (ids.length === 1) {
    return ids[0];
  }
  throw new Error(
    `Multiple accounts found: ${ids.join(", ")}. Use --account <id> to specify one.`,
  );
}

// ---------------------------------------------------------------------------
// Sync buffer (get_updates_buf persistence)
// ---------------------------------------------------------------------------

function syncBufPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}

export function loadSyncBuf(accountId: string): string | undefined {
  try {
    const raw = fs.readFileSync(syncBufPath(accountId), "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    return typeof data.get_updates_buf === "string" ? data.get_updates_buf : undefined;
  } catch {
    return undefined;
  }
}

export function saveSyncBuf(accountId: string, getUpdatesBuf: string): void {
  const filePath = syncBufPath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}

// ---------------------------------------------------------------------------
// Context tokens (required for sending messages)
// ---------------------------------------------------------------------------

const contextTokenCache = new Map<string, string>();

function ctKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function contextTokenFilePath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.context-tokens.json`);
}

function persistContextTokens(accountId: string): void {
  const prefix = `${accountId}:`;
  const tokens: Record<string, string> = {};
  for (const [k, v] of contextTokenCache) {
    if (k.startsWith(prefix)) {
      tokens[k.slice(prefix.length)] = v;
    }
  }
  const filePath = contextTokenFilePath(accountId);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 0), "utf-8");
  } catch { /* ignore */ }
}

export function restoreContextTokens(accountId: string): void {
  const filePath = contextTokenFilePath(accountId);
  try {
    if (!fs.existsSync(filePath)) return;
    const tokens = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, string>;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token) {
        contextTokenCache.set(ctKey(accountId, userId), token);
      }
    }
  } catch { /* ignore */ }
}

export function setContextToken(accountId: string, userId: string, token: string): void {
  contextTokenCache.set(ctKey(accountId, userId), token);
  persistContextTokens(accountId);
}

export function getContextToken(accountId: string, userId: string): string | undefined {
  return contextTokenCache.get(ctKey(accountId, userId));
}
