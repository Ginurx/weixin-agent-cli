/**
 * Weixin HTTP API layer — self-contained, compatible with openclaw-weixin protocol.
 *
 * Endpoints (all POST JSON to ilinkai.weixin.qq.com):
 *   /ilink/bot/getupdates    — long-poll for messages
 *   /ilink/bot/sendmessage   — send a message
 *   /ilink/bot/getuploadurl  — get CDN upload pre-signed URL
 *   /ilink/bot/getconfig     — get bot config (typing ticket)
 *   /ilink/bot/sendtyping    — typing indicator
 */

import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesReq,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export type ApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Package info & headers (mirrors openclaw-weixin's api.ts)
// ---------------------------------------------------------------------------

const ILINK_APP_ID = "bot";
const ILINK_APP_VERSION = "0.1.0";

const CHANNEL_VERSION = "2.1.3";

function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(buildClientVersion(ILINK_APP_VERSION)),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

function buildGetHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(buildClientVersion(ILINK_APP_VERSION)),
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

async function apiPost<T>(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<T> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`API ${params.endpoint} ${res.status}: ${rawText}`);
    }
    return JSON.parse(rawText) as T;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

export async function apiGet<T>(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
}): Promise<T> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildGetHeaders();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: hdrs,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`API GET ${params.endpoint} ${res.status}: ${rawText}`);
    }
    return JSON.parse(rawText) as T;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

export async function getUpdates(
  params: GetUpdatesReq & { baseUrl: string; token?: string; timeoutMs?: number },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    return await apiPost<GetUpdatesResp>({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

export async function sendMessage(
  params: ApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiPost<unknown>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  });
}

export async function getUploadUrl(
  params: GetUploadUrlReq & ApiOptions,
): Promise<GetUploadUrlResp> {
  return apiPost<GetUploadUrlResp>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  });
}

export async function getConfig(
  params: ApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  return apiPost<GetConfigResp>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}

export async function sendTyping(
  params: ApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPost<unknown>({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}
