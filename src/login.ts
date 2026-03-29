/**
 * QR code login flow — compatible with openclaw-weixin's login-qr.ts
 */

import { randomUUID } from "node:crypto";
import { apiGet, DEFAULT_BASE_URL } from "./api.js";

const DEFAULT_BOT_TYPE = "3";
const GET_QRCODE_TIMEOUT_MS = 5_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  currentApiBaseUrl: string;
};

export type LoginStartResult = {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
};

export type LoginWaitResult = {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
};

const activeLogins = new Map<string, ActiveLogin>();

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

async function fetchQRCode(baseUrl: string, botType: string): Promise<QRCodeResponse> {
  return apiGet<QRCodeResponse>({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: GET_QRCODE_TIMEOUT_MS,
  });
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<StatusResponse> {
  try {
    return await apiGet<StatusResponse>({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    return { status: "wait" };
  }
}

export async function startLogin(opts?: {
  accountId?: string;
  botType?: string;
}): Promise<LoginStartResult> {
  const sessionKey = opts?.accountId || randomUUID();
  const botType = opts?.botType || DEFAULT_BOT_TYPE;

  try {
    const qr = await fetchQRCode(DEFAULT_BASE_URL, botType);
    const login: ActiveLogin = {
      sessionKey,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      currentApiBaseUrl: DEFAULT_BASE_URL,
    };
    activeLogins.set(sessionKey, login);
    return {
      qrcodeUrl: qr.qrcode_img_content,
      message: "使用微信扫描二维码以完成连接。",
      sessionKey,
    };
  } catch (err) {
    return {
      message: `Failed to start login: ${String(err)}`,
      sessionKey,
    };
  }
}

export async function waitForLogin(opts: {
  sessionKey: string;
  timeoutMs?: number;
  botType?: string;
  onScanned?: () => void;
  onQrRefresh?: (qrcodeUrl: string) => void;
}): Promise<LoginWaitResult> {
  const login = activeLogins.get(opts.sessionKey);
  if (!login) {
    return { connected: false, message: "当前没有进行中的登录，请先发起登录。" };
  }
  if (!isLoginFresh(login)) {
    activeLogins.delete(opts.sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }

  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedNotified = false;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    const baseUrl = login.currentApiBaseUrl;
    const status = await pollQRStatus(baseUrl, login.qrcode);

    switch (status.status) {
      case "wait":
        break;

      case "scaned":
        if (!scannedNotified) {
          opts.onScanned?.();
          scannedNotified = true;
        }
        break;

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          activeLogins.delete(opts.sessionKey);
          return { connected: false, message: "登录超时：二维码多次过期，请重新开始登录流程。" };
        }
        try {
          const botType = opts.botType || DEFAULT_BOT_TYPE;
          const qr = await fetchQRCode(DEFAULT_BASE_URL, botType);
          login.qrcode = qr.qrcode;
          login.qrcodeUrl = qr.qrcode_img_content;
          login.startedAt = Date.now();
          scannedNotified = false;
          opts.onQrRefresh?.(qr.qrcode_img_content);
        } catch (refreshErr) {
          activeLogins.delete(opts.sessionKey);
          return { connected: false, message: `刷新二维码失败: ${String(refreshErr)}` };
        }
        break;
      }

      case "scaned_but_redirect": {
        if (status.redirect_host) {
          login.currentApiBaseUrl = `https://${status.redirect_host}`;
        }
        break;
      }

      case "confirmed": {
        activeLogins.delete(opts.sessionKey);
        if (!status.ilink_bot_id) {
          return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
        }
        return {
          connected: true,
          botToken: status.bot_token,
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl,
          userId: status.ilink_user_id,
          message: "✅ 与微信连接成功！",
        };
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  activeLogins.delete(opts.sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}
