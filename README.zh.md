# weixin-agent-cli

基于 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 协议的微信消息命令行工具，专为 AI Agent 自动化设计——所有命令的结果均以 JSON 格式输出到 stdout。

## 安装

> **注意：** 本包尚未发布到 npm，请直接从仓库安装：

```bash
git clone https://github.com/Ginurx/weixin-agent-cli.git
cd weixin-agent-cli
npm install
npm run build
npm install -g .
```

需要 Node.js >= 22。

## 快速开始

```bash
# 1. 扫码登录
weixin-agent-cli login

# 2. 拉取消息
weixin-agent-cli poll

# 3. 回复消息
weixin-agent-cli send --to "user123@im.wechat" --text "你好！"
```

## 命令说明

### `weixin-agent-cli login`

扫码登录。在终端显示二维码，用微信扫码完成连接。**此命令需要人工操作。**

### `weixin-agent-cli logout [-a <accountId>]`

移除账号凭证及所有本地缓存状态（同步缓冲、context token）。

### `weixin-agent-cli accounts`

列出所有已登录账号，返回 JSON 数组。

### `weixin-agent-cli account-info [-a <accountId>]`

查看指定账号的详细信息。

### `weixin-agent-cli poll [-a <accountId>] [-t <timeoutMs>] [--watch]`

拉取新消息（单次 long-poll 请求），返回 JSON。默认超时 30 秒。

使用 `--watch`（`-w`）开启持续监听模式——以 NDJSON 格式（每行一个 JSON 对象）持续输出消息，直到 Ctrl+C 中断。空轮次（无用户消息）不输出。

**输出格式：**

```json
{
  "accountId": "abc123@im.bot",
  "total": 1,
  "messages": [
    {
      "from": "user456@im.wechat",
      "to": "abc123@im.bot",
      "message_id": 12345,
      "message_type": "user",
      "message_state": "finish",
      "timestamp": 1711700000000,
      "text": "你好"
    }
  ]
}
```

> **重要：** poll 会自动缓存 context token。在向某个用户发送消息之前，必须先通过 `poll` 收到过该用户发来的消息。

### `weixin-agent-cli send --to <userId> --text <message> [-a <accountId>]`

发送文本消息。必须先通过 `poll` 收到过该用户的消息，才能向其发送。

### `weixin-agent-cli send-media --to <userId> --file <path> [--text <caption>] [-a <accountId>]`

发送媒体文件（图片、视频或文件附件），根据文件扩展名自动识别类型。

支持的类型：

- **图片**：png、jpg、jpeg、gif、webp、bmp
- **视频**：mp4、mov、webm、mkv、avi
- **文件**：pdf、doc/docx、xls/xlsx、ppt/pptx、txt、csv、zip、tar、gz

### `weixin-agent-cli typing --to <userId> [--cancel] [-a <accountId>]`

发送或取消"正在输入"指示。

```bash
weixin-agent-cli typing --to "user456@im.wechat"          # 开始输入
weixin-agent-cli typing --to "user456@im.wechat" --cancel  # 取消输入
```

## 多账号

只有一个已登录账号时自动使用。存在多个账号时，通过 `--account <id>`（或 `-a <id>`）指定：

```bash
weixin-agent-cli poll --account "bot1@im.bot"
weixin-agent-cli send --to "user@im.wechat" --text "你好" --account "bot1@im.bot"
```

## 典型 Agent 循环

**单次轮询：**

```bash
RESULT=$(weixin-agent-cli poll --timeout 15000)
# 解析 JSON，处理每条消息后回复：
weixin-agent-cli send --to "$FROM_USER" --text "$REPLY_TEXT"
```

**持续监听（Watch 模式）：**

```bash
weixin-agent-cli poll --watch | while IFS= read -r line; do
  echo "$line" | 你的消息处理脚本
done
```

## 数据存储

账号凭证和状态存储在 `~/.weixin-agent-cli/` 目录下。可通过环境变量 `WEIXIN_AGENT_CLI_HOME` 自定义路径。

## License

MIT
