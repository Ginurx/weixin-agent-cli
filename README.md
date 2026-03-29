# weixin-agent-cli

[中文文档](README.zh.md)

CLI tool for WeChat (微信) messaging, built on top of the [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) protocol. Designed for AI agent automation — all commands output JSON to stdout.

## Installation

```bash
npm install -g weixin-agent-cli
# or use locally
npx weixin-agent-cli
```

Requires Node.js >= 22.

## Quick Start

```bash
# 1. Login with QR code
weixin-agent-cli login

# 2. Poll for messages
weixin-agent-cli poll

# 3. Send a reply
weixin-agent-cli send --to "user123@im.wechat" --text "Hello!"
```

## Commands

### `weixin-agent-cli login`

Initiate QR code login. Displays QR in terminal; scan with WeChat to connect.

### `weixin-agent-cli logout [-a <accountId>]`

Remove account credentials.

### `weixin-agent-cli accounts`

List all registered accounts as JSON array.

### `weixin-agent-cli account-info [-a <accountId>]`

Show details of an account.

### `weixin-agent-cli poll [-a <accountId>] [-t <timeoutMs>] [--watch]`

Long-poll for new messages. Returns JSON with received messages. Default timeout: 30 seconds.

Use `--watch` (`-w`) for continuous polling — outputs NDJSON (one JSON object per line) and runs until interrupted with Ctrl+C. Empty polls are skipped.

### `weixin-agent-cli send --to <userId> --text <message> [-a <accountId>]`

Send a text message. You must have received at least one message from the recipient via `poll` before you can send to them.

### `weixin-agent-cli send-media --to <userId> --file <path> [--text <caption>] [-a <accountId>]`

Send a media file (image, video, or file attachment). Routes by file extension/MIME type.

### `weixin-agent-cli typing --to <userId> [--cancel] [-a <accountId>]`

Send or cancel a typing indicator.

## Multi-Account

If only one account is registered, it's used automatically. With multiple accounts, specify `--account <id>` (or `-a <id>`).

## Data Storage

Account credentials and state are stored in `~/.weixin-agent-cli/`. Override with the `WEIXIN_AGENT_CLI_HOME` environment variable.

## License

MIT
