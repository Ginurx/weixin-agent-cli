# Skill: WeChat Messaging via weixin-agent-cli

Use the `weixin-agent-cli` command-line tool to send and receive WeChat (微信) messages. All commands output JSON to stdout.

## Prerequisites

- The `weixin-agent-cli` tool must be installed and available in PATH
- An account must be logged in (run `weixin-agent-cli login` in an interactive terminal first)

## Key Concepts

- **Account ID**: Each logged-in WeChat bot has an account ID (e.g. `abc123@im.bot`). If only one account exists, it's used automatically.
- **User ID**: WeChat users are identified by IDs ending in `@im.wechat` (e.g. `user456@im.wechat`).
- **Context Token**: Required for sending messages. Automatically cached when you receive a message from a user via `poll`. You must poll at least once before you can send to a user.

## Workflow

### 1. Check Accounts

```bash
weixin-agent-cli accounts
```

Returns a JSON array of registered accounts with their status.

### 2. Poll for Messages

```bash
weixin-agent-cli poll
# With timeout (ms):
weixin-agent-cli poll --timeout 15000
# Specific account:
weixin-agent-cli poll --account "abc123@im.bot"
```

**Output format:**

```json
{
  "accountId": "abc123@im.bot",
  "total": 3,
  "messages": [
    {
      "from": "user456@im.wechat",
      "to": "abc123@im.bot",
      "message_id": 12345,
      "message_type": "user",
      "message_state": "finish",
      "timestamp": 1711700000000,
      "text": "Hello, bot!"
    }
  ]
}
```

The `messages` array only contains completed user messages (bot echoes and generating states are filtered out).

#### Watch Mode (continuous polling)

```bash
weixin-agent-cli poll --watch
weixin-agent-cli poll --watch --timeout 10000
```

Outputs NDJSON (one JSON object per line). Empty polls (no user messages) are skipped. Runs until interrupted with Ctrl+C.

```jsonl
{"accountId":"abc123@im.bot","total":1,"messages":[{"from":"user456@im.wechat","text":"Hi"}]}
{"accountId":"abc123@im.bot","total":1,"messages":[{"from":"user456@im.wechat","text":"Second msg"}]}
```

### 3. Send a Text Message

```bash
weixin-agent-cli send --to "user456@im.wechat" --text "Hello from the bot!"
```

**Important:** You must have received at least one message from the target user (via `poll`) before sending, so the context token is available.

### 4. Send a Media File

```bash
# Image
weixin-agent-cli send-media --to "user456@im.wechat" --file "/path/to/image.png"

# Video with caption
weixin-agent-cli send-media --to "user456@im.wechat" --file "/path/to/video.mp4" --text "Check this out"

# Document
weixin-agent-cli send-media --to "user456@im.wechat" --file "/path/to/report.pdf"
```

File type is detected from the extension. Supported categories:

- **Images**: png, jpg, jpeg, gif, webp, bmp
- **Video**: mp4, mov, webm, mkv, avi
- **Files**: pdf, doc/docx, xls/xlsx, ppt/pptx, txt, csv, zip, tar, gz

### 5. Send Typing Indicator

```bash
# Start typing
weixin-agent-cli typing --to "user456@im.wechat"

# Cancel typing
weixin-agent-cli typing --to "user456@im.wechat" --cancel
```

## Error Handling

All errors are written to stderr and the process exits with code 1. Check the JSON output `success` field or the exit code to detect failures.

## Typical Agent Loop

**Single-poll approach:**

```bash
# Poll for new messages
RESULT=$(weixin-agent-cli poll --timeout 15000)

# Parse messages from JSON output, process each one
# Then reply:
weixin-agent-cli send --to "$FROM_USER" --text "$REPLY_TEXT"
```

**Watch mode approach (continuous):**

```bash
# Stream messages continuously, process each NDJSON line as it arrives:
weixin-agent-cli poll --watch | while IFS= read -r line; do
  echo "$line" | process_message_and_reply
done
```

## Multi-Account

With multiple accounts, always pass `--account <id>` (or `-a <id>`):

```bash
weixin-agent-cli poll --account "bot1@im.bot"
weixin-agent-cli send --to "user@im.wechat" --text "Hi" --account "bot1@im.bot"
```
