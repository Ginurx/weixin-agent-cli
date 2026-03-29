/**
 * CDN media upload — AES-128-ECB encryption + upload to Weixin CDN.
 * Compatible with openclaw-weixin's cdn/ module.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv } from "node:crypto";

import { getUploadUrl, type ApiOptions } from "./api.js";
import { UploadMediaType, MessageItemType, MessageType, MessageState } from "./types.js";
import type { MessageItem, SendMessageReq } from "./types.js";
import { sendMessage } from "./api.js";

// ---------------------------------------------------------------------------
// AES-128-ECB
// ---------------------------------------------------------------------------

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ---------------------------------------------------------------------------
// CDN URL construction
// ---------------------------------------------------------------------------

function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

// ---------------------------------------------------------------------------
// MIME detection
// ---------------------------------------------------------------------------

const EXTENSION_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Upload pipeline
// ---------------------------------------------------------------------------

type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

const UPLOAD_MAX_RETRIES = 3;

async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);

  let cdnUrl: string;
  if (uploadFullUrl?.trim()) {
    cdnUrl = uploadFullUrl.trim();
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error("CDN upload URL missing (need upload_full_url or upload_param)");
  }

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN upload server error: status ${res.status}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt >= UPLOAD_MAX_RETRIES) break;
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}

async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: ApiOptions;
  cdnBaseUrl: string;
  mediaType: number;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, opts, cdnBaseUrl, mediaType } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadUrlResp.upload_full_url?.trim() || undefined,
    uploadParam: uploadUrlResp.upload_param ?? undefined,
    filekey,
    cdnBaseUrl,
    aeskey,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

// ---------------------------------------------------------------------------
// Message sending helpers
// ---------------------------------------------------------------------------

function generateClientId(): string {
  return `weixin-cli:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function buildTextSendReq(params: {
  to: string;
  text: string;
  contextToken?: string;
}): SendMessageReq {
  const items: MessageItem[] = params.text
    ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: generateClientId(),
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: items.length ? items : undefined,
      context_token: params.contextToken ?? undefined,
    },
  };
}

export async function sendTextMessage(params: {
  to: string;
  text: string;
  opts: ApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  const req = buildTextSendReq({ to, text, contextToken: opts.contextToken });
  const messageId = req.msg!.client_id!;
  await sendMessage({ baseUrl: opts.baseUrl, token: opts.token, timeoutMs: opts.timeoutMs, body: req });
  return { messageId };
}

async function sendMediaItemMessage(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: ApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts } = params;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
      },
    };
    await sendMessage({ baseUrl: opts.baseUrl, token: opts.token, timeoutMs: opts.timeoutMs, body: req });
  }

  return { messageId: lastClientId };
}

// ---------------------------------------------------------------------------
// Public: send media file (routes by MIME type)
// ---------------------------------------------------------------------------

export async function sendMediaFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: ApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const mime = getMimeFromFilename(filePath);
  const uploadOpts: ApiOptions = { baseUrl: opts.baseUrl, token: opts.token };

  if (mime.startsWith("video/")) {
    const uploaded = await uploadMediaToCdn({
      filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl, mediaType: UploadMediaType.VIDEO,
    });
    const videoItem: MessageItem = {
      type: MessageItemType.VIDEO,
      video_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
          encrypt_type: 1,
        },
        video_size: uploaded.fileSizeCiphertext,
      },
    };
    return sendMediaItemMessage({ to, text, mediaItem: videoItem, opts });
  }

  if (mime.startsWith("image/")) {
    const uploaded = await uploadMediaToCdn({
      filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl, mediaType: UploadMediaType.IMAGE,
    });
    const imageItem: MessageItem = {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
          encrypt_type: 1,
        },
        mid_size: uploaded.fileSizeCiphertext,
      },
    };
    return sendMediaItemMessage({ to, text, mediaItem: imageItem, opts });
  }

  // File attachment
  const fileName = path.basename(filePath);
  const uploaded = await uploadMediaToCdn({
    filePath, toUserId: to, opts: uploadOpts, cdnBaseUrl, mediaType: UploadMediaType.FILE,
  });
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
  return sendMediaItemMessage({ to, text, mediaItem: fileItem, opts });
}
