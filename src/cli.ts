#!/usr/bin/env node
/**
 * weixin-agent-cli — CLI tool for WeChat messaging via openclaw-weixin protocol.
 * All commands output JSON to stdout for agent consumption. Errors go to stderr.
 */

import { Command } from "commander";
import {
  listAccountIds,
  registerAccountId,
  unregisterAccountId,
  resolveAccount,
  resolveDefaultAccountId,
  saveAccount,
  clearAccount,
  loadSyncBuf,
  saveSyncBuf,
  restoreContextTokens,
  setContextToken,
  getContextToken,
} from "./store.js";
import { getUpdates, sendTyping as apiSendTyping, getConfig } from "./api.js";
import { sendTextMessage, sendMediaFile } from "./media.js";
import { startLogin, waitForLogin } from "./login.js";
import { MessageItemType, TypingStatus } from "./types.js";
import type { WeixinMessage } from "./types.js";

function jsonOut(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function die(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function getAccountId(opts: { account?: string }): string {
  if (opts.account) return opts.account;
  const envAccount = process.env.WEIXIN_AGENT_CLI_ACCOUNT?.trim();
  if (envAccount) return envAccount;
  try {
    return resolveDefaultAccountId();
  } catch (err) {
    die((err as Error).message);
  }
}

function getRecipientId(opts: { to?: string }): string {
  if (opts.to) return opts.to;
  const envTo = process.env.WEIXIN_AGENT_CLI_TO?.trim();
  if (envTo) return envTo;
  die("Recipient is required. Use --to <userId> or set WEIXIN_AGENT_CLI_TO.");
}

function ensureConfigured(accountId: string) {
  const acct = resolveAccount(accountId);
  if (!acct.configured) {
    die(`Account '${accountId}' is not configured (no token). Run 'weixin-agent-cli login' first.`);
  }
  return acct;
}

// ---------------------------------------------------------------------------
// Message simplification for JSON output
// ---------------------------------------------------------------------------

function simplifyMessage(msg: WeixinMessage) {
  const items = msg.item_list ?? [];
  const textItem = items.find((i) => i.type === MessageItemType.TEXT);
  const imageItem = items.find((i) => i.type === MessageItemType.IMAGE);
  const voiceItem = items.find((i) => i.type === MessageItemType.VOICE);
  const fileItem = items.find((i) => i.type === MessageItemType.FILE);
  const videoItem = items.find((i) => i.type === MessageItemType.VIDEO);

  const simplified: Record<string, unknown> = {
    from: msg.from_user_id,
    to: msg.to_user_id,
    message_id: msg.message_id,
    message_type: msg.message_type === 1 ? "user" : msg.message_type === 2 ? "bot" : msg.message_type,
    message_state: msg.message_state === 0 ? "new" : msg.message_state === 1 ? "generating" : msg.message_state === 2 ? "finish" : msg.message_state,
    timestamp: msg.create_time_ms,
  };

  if (textItem?.text_item?.text) {
    simplified.text = textItem.text_item.text;
  }
  if (imageItem) {
    simplified.image = { has_media: Boolean(imageItem.image_item?.media) };
  }
  if (voiceItem) {
    simplified.voice = {
      text: voiceItem.voice_item?.text,
      playtime_ms: voiceItem.voice_item?.playtime,
    };
  }
  if (fileItem) {
    simplified.file = {
      name: fileItem.file_item?.file_name,
      size: fileItem.file_item?.len,
    };
  }
  if (videoItem) {
    simplified.video = { play_length: videoItem.video_item?.play_length };
  }

  // Include ref_msg summary if present
  for (const item of items) {
    if (item.ref_msg) {
      simplified.ref_msg = {
        title: item.ref_msg.title,
        type: item.ref_msg.message_item?.type,
      };
      break;
    }
  }

  return simplified;
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("weixin-agent-cli")
  .description("CLI tool for WeChat messaging — designed for AI agent automation.\nAll commands output JSON to stdout. Errors go to stderr with exit code 1.")
  .version("0.1.0")
  .addHelpText(
    "after",
    `
Key Concepts:
  Account ID   Each logged-in WeChat bot has an account ID (e.g. abc123@im.bot).
               If only one account exists, it is used automatically.
  User ID      WeChat users are identified by IDs ending in @im.wechat.
  Context      Before you can send a message to a user, you must have received
               at least one message from them via "poll". This caches a required
               context token locally.

Typical Workflow:
  1. weixin-agent-cli login           # scan QR code to authenticate
  2. weixin-agent-cli poll            # receive messages (caches context tokens)
  3. weixin-agent-cli send --to <id> --text "Hi"  # reply

Environment:
  WEIXIN_AGENT_CLI_HOME   Override storage directory (default: ~/.weixin-agent-cli)
`,
  );

// ---- login ----
program
  .command("login")
  .description(
    "Login via QR code scan.\n" +
    "Displays a QR code in the terminal. Scan it with WeChat to authenticate.\n" +
    "On success, outputs JSON with accountId and userId. Credentials are saved locally."
  )
  .addHelpText(
    "after",
    `
Example:
  $ weixin-agent-cli login
  # A QR code is printed to stderr. After scanning, JSON result goes to stdout:
  # { "success": true, "accountId": "abc@im.bot", "userId": "...", "message": "..." }

Notes:
  - This command is interactive (requires a human to scan the QR code).
  - The QR code expires after ~60s and refreshes up to 3 times automatically.
  - Credentials are stored in ~/.weixin-agent-cli/accounts/.
`,
  )
  .action(async () => {
    const startResult = await startLogin();
    if (!startResult.qrcodeUrl) {
      die(startResult.message);
    }

    // Print QR code to terminal
    process.stderr.write("使用微信扫描以下二维码以完成连接：\n\n");
    try {
      const qrterm = await import("qrcode-terminal");
      qrterm.default.generate(startResult.qrcodeUrl, { small: true }, (qr: string) => {
        process.stderr.write(qr + "\n");
      });
    } catch {
      // fallback: just print URL
    }
    process.stderr.write(`\n二维码链接: ${startResult.qrcodeUrl}\n`);
    process.stderr.write("等待扫码...\n");

    const result = await waitForLogin({
      sessionKey: startResult.sessionKey,
      onScanned: () => {
        process.stderr.write("\n👀 已扫码，在微信继续操作...\n");
      },
      onQrRefresh: (url) => {
        process.stderr.write(`\n🔄 二维码已刷新: ${url}\n`);
        try {
          import("qrcode-terminal").then((qrterm) => {
            qrterm.default.generate(url, { small: true }, (qr: string) => {
              process.stderr.write(qr + "\n");
            });
          });
        } catch { /* ignore */ }
      },
    });

    if (result.connected && result.accountId) {
      // Save account credentials
      saveAccount(result.accountId, {
        token: result.botToken,
        baseUrl: result.baseUrl,
        userId: result.userId,
      });
      registerAccountId(result.accountId);

      jsonOut({
        success: true,
        accountId: result.accountId,
        userId: result.userId,
        message: result.message,
      });
    } else {
      jsonOut({
        success: false,
        message: result.message,
      });
      process.exit(1);
    }
  });

// ---- logout ----
program
  .command("logout")
  .description(
    "Remove account credentials and all cached state (sync buffer, context tokens)."
  )
  .option("-a, --account <id>", "Account ID to remove (auto-detected if only one account exists)")
  .addHelpText(
    "after",
    `
Example:
  $ weixin-agent-cli logout
  $ weixin-agent-cli logout --account abc@im.bot
`,
  )
  .action((opts: { account?: string }) => {
    const accountId = getAccountId(opts);
    clearAccount(accountId);
    unregisterAccountId(accountId);
    jsonOut({ success: true, accountId, message: "Account removed." });
  });

// ---- accounts ----
program
  .command("accounts")
  .description(
    "List all registered accounts as a JSON array.\n" +
    "Each entry includes accountId, configured status, baseUrl, and userId."
  )
  .addHelpText(
    "after",
    `
Example:
  $ weixin-agent-cli accounts
  # [ { "accountId": "abc@im.bot", "configured": true, "baseUrl": "...", "userId": "..." } ]

Notes:
  - "configured": true means the account has a valid token.
  - An empty array [] means no accounts — run 'login' first.
`,
  )
  .action(() => {
    const ids = listAccountIds();
    const accounts = ids.map((id) => {
      const acct = resolveAccount(id);
      return {
        accountId: id,
        configured: acct.configured,
        baseUrl: acct.baseUrl,
        userId: acct.userId,
      };
    });
    jsonOut(accounts);
  });

// ---- account-info ----
program
  .command("account-info")
  .description("Show detailed information for a single account.")
  .option("-a, --account <id>", "Account ID (auto-detected if only one account exists)")
  .addHelpText(
    "after",
    `
Example:
  $ weixin-agent-cli account-info
  $ weixin-agent-cli account-info --account abc@im.bot
`,
  )
  .action((opts: { account?: string }) => {
    const accountId = getAccountId(opts);
    const acct = resolveAccount(accountId);
    jsonOut({
      accountId: acct.accountId,
      configured: acct.configured,
      baseUrl: acct.baseUrl,
      cdnBaseUrl: acct.cdnBaseUrl,
      userId: acct.userId,
    });
  });

// ---- poll ----
program
  .command("poll")
  .description(
    "Poll for new messages (single long-poll request).\n" +
    "Returns a JSON object with all received messages. Only completed user messages\n" +
    "(message_type=\"user\", message_state=\"finish\") are included in the output.\n" +
    "Bot echoes and generating states are filtered out.\n" +
    "IMPORTANT: Polling also caches context tokens, which are required before you\n" +
    "can send messages to a user. Always poll before sending.\n" +
    "Use --watch for continuous polling (NDJSON output, one JSON object per line)."
  )
  .option("-a, --account <id>", "Account ID (auto-detected if only one account exists)")
  .option("-t, --timeout <ms>", "Long-poll timeout in milliseconds (server holds connection until messages arrive or timeout)", "30000")
  .option("-w, --watch", "Continuously poll and stream messages as NDJSON (one JSON per line). Runs until interrupted (Ctrl+C).", false)
  .addHelpText(
    "after",
    `
Example:
  # Single poll:
  $ weixin-agent-cli poll
  $ weixin-agent-cli poll --timeout 15000

  # Watch mode (continuous, outputs NDJSON):
  $ weixin-agent-cli poll --watch
  $ weixin-agent-cli poll --watch --timeout 10000

Output format (single poll):
  {
    "accountId": "abc@im.bot",
    "total": 3,
    "messages": [ { "from": "user@im.wechat", "text": "Hello!", ... } ]
  }

Output format (--watch, NDJSON — one JSON object per line):
  {"accountId":"abc@im.bot","total":1,"messages":[{"from":"user@im.wechat","text":"Hi"}]}
  {"accountId":"abc@im.bot","total":1,"messages":[{"from":"user@im.wechat","text":"Second msg"}]}

Notes:
  - If no messages arrive within the timeout, returns { messages: [] } (or an empty line in watch mode is skipped).
  - Sync state is persisted between calls so you won't receive duplicate messages.
  - Each message may have: text, image, voice, file, video, ref_msg fields.
  - In --watch mode, empty polls (no user messages) are not printed.
  - Stop watch mode with Ctrl+C (SIGINT).
`,
  )
  .action(async (opts: { account?: string; timeout: string; watch: boolean }) => {
    const accountId = getAccountId(opts);
    const acct = ensureConfigured(accountId);
    const timeoutMs = parseInt(opts.timeout, 10) || 30000;

    // Restore context tokens from disk
    restoreContextTokens(accountId);

    if (!opts.watch) {
      // --- Single poll mode ---
      const syncBuf = loadSyncBuf(accountId) ?? "";
      const resp = await getUpdates({
        baseUrl: acct.baseUrl,
        token: acct.token,
        get_updates_buf: syncBuf,
        timeoutMs,
      });

      if (resp.get_updates_buf) {
        saveSyncBuf(accountId, resp.get_updates_buf);
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        if (msg.from_user_id && msg.context_token) {
          setContextToken(accountId, msg.from_user_id, msg.context_token);
        }
      }

      const userMessages = msgs.filter(
        (m) => m.message_type === 1 && m.message_state === 2
      );

      jsonOut({
        accountId,
        total: msgs.length,
        messages: userMessages.map(simplifyMessage),
      });
      return;
    }

    // --- Watch mode: continuous long-poll loop, NDJSON output ---
    process.stderr.write(`Watching for messages (timeout=${timeoutMs}ms, Ctrl+C to stop)...\n`);

    let running = true;
    const onSignal = () => { running = false; };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    while (running) {
      try {
        const syncBuf = loadSyncBuf(accountId) ?? "";
        const resp = await getUpdates({
          baseUrl: acct.baseUrl,
          token: acct.token,
          get_updates_buf: syncBuf,
          timeoutMs,
        });

        if (resp.get_updates_buf) {
          saveSyncBuf(accountId, resp.get_updates_buf);
        }

        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          if (msg.from_user_id && msg.context_token) {
            setContextToken(accountId, msg.from_user_id, msg.context_token);
          }
        }

        const userMessages = msgs.filter(
          (m) => m.message_type === 1 && m.message_state === 2
        );

        // Only print lines with actual user messages
        if (userMessages.length > 0) {
          process.stdout.write(
            JSON.stringify({
              accountId,
              total: msgs.length,
              messages: userMessages.map(simplifyMessage),
            }) + "\n",
          );
        }
      } catch (err) {
        // Log errors to stderr but keep looping
        process.stderr.write(`Poll error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    process.stderr.write("Watch stopped.\n");
  });

// ---- send ----
program
  .command("send")
  .description(
    "Send a text message to a WeChat user.\n" +
    "Requires a context token for the recipient, which is cached automatically\n" +
    "when you receive a message from that user via 'poll'."
  )
  .option("--to <userId>", "Recipient user ID (falls back to WEIXIN_AGENT_CLI_TO env var)")
  .requiredOption("--text <message>", "Message text to send")
  .option("-a, --account <id>", "Account ID (auto-detected if only one account exists)")
  .addHelpText(
    "after",
    `
Example:
  $ weixin-agent-cli send --to "user456@im.wechat" --text "Hello!"
  # { "success": true, "accountId": "abc@im.bot", "to": "user456@im.wechat", "messageId": 789 }

Notes:
  - You MUST poll at least once to cache the context token before sending.
  - If no context token is found, the command will still attempt to send but may fail.
`,
  )
  .action(async (opts: { to?: string; text: string; account?: string }) => {
    const to = getRecipientId(opts);
    const accountId = getAccountId(opts);
    const acct = ensureConfigured(accountId);

    restoreContextTokens(accountId);
    const contextToken = getContextToken(accountId, to);

    const result = await sendTextMessage({
      to,
      text: opts.text,
      opts: {
        baseUrl: acct.baseUrl,
        token: acct.token,
        contextToken,
      },
    });

    jsonOut({
      success: true,
      accountId,
      to,
      messageId: result.messageId,
    });
  });

// ---- send-media ----
program
  .command("send-media")
  .description(
    "Send a media file (image, video, or document) to a WeChat user.\n" +
    "File type is auto-detected from extension. Supported types:\n" +
    "  Images: png, jpg, jpeg, gif, webp, bmp\n" +
    "  Video:  mp4, mov, webm, mkv, avi\n" +
    "  Files:  pdf, doc/docx, xls/xlsx, ppt/pptx, txt, csv, zip, tar, gz\n" +
    "Requires a cached context token (run 'poll' first)."
  )
  .option("--to <userId>", "Recipient user ID (falls back to WEIXIN_AGENT_CLI_TO env var)")
  .requiredOption("--file <path>", "Absolute or relative path to the file to send")
  .option("--text <caption>", "Optional text caption sent alongside the file", "")
  .option("-a, --account <id>", "Account ID (auto-detected if only one account exists)")
  .addHelpText(
    "after",
    `
Example:
  $ weixin-agent-cli send-media --to "user@im.wechat" --file ./photo.png
  $ weixin-agent-cli send-media --to "user@im.wechat" --file ./video.mp4 --text "Check this"
  $ weixin-agent-cli send-media --to "user@im.wechat" --file ./report.pdf
`,
  )
  .action(async (opts: { to?: string; file: string; text: string; account?: string }) => {
    const to = getRecipientId(opts);
    const accountId = getAccountId(opts);
    const acct = ensureConfigured(accountId);

    restoreContextTokens(accountId);
    const contextToken = getContextToken(accountId, to);

    const result = await sendMediaFile({
      filePath: opts.file,
      to,
      text: opts.text,
      opts: {
        baseUrl: acct.baseUrl,
        token: acct.token,
        contextToken,
      },
      cdnBaseUrl: acct.cdnBaseUrl,
    });

    jsonOut({
      success: true,
      accountId,
      to,
      messageId: result.messageId,
    });
  });

// ---- typing ----
program
  .command("typing")
  .description(
    "Send a typing indicator to show the bot is composing a response.\n" +
    "Use --cancel to stop the typing indicator. Requires a cached context token."
  )
  .option("--to <userId>", "Recipient user ID (falls back to WEIXIN_AGENT_CLI_TO env var)")
  .option("--cancel", "Cancel the typing indicator instead of starting it", false)
  .option("-a, --account <id>", "Account ID (auto-detected if only one account exists)")
  .addHelpText(
    "after",
    `
Example:
  $ weixin-agent-cli typing --to "user@im.wechat"         # start typing
  $ weixin-agent-cli typing --to "user@im.wechat" --cancel # stop typing
`,
  )
  .action(async (opts: { to?: string; cancel: boolean; account?: string }) => {
    const to = getRecipientId(opts);
    const accountId = getAccountId(opts);
    const acct = ensureConfigured(accountId);

    restoreContextTokens(accountId);
    const contextToken = getContextToken(accountId, to);

    // Get typing ticket
    const config = await getConfig({
      baseUrl: acct.baseUrl,
      token: acct.token,
      ilinkUserId: to,
      contextToken,
    });

    if (!config.typing_ticket) {
      die("Failed to get typing ticket from server.");
    }

    await apiSendTyping({
      baseUrl: acct.baseUrl,
      token: acct.token,
      body: {
        ilink_user_id: to,
        typing_ticket: config.typing_ticket,
        status: opts.cancel ? TypingStatus.CANCEL : TypingStatus.TYPING,
      },
    });

    jsonOut({
      success: true,
      accountId,
      to,
      status: opts.cancel ? "cancelled" : "typing",
    });
  });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`Error: ${String(err)}\n`);
  process.exit(1);
});
