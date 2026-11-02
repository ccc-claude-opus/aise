# aise

AI 軟體工程 IDE —— 以規格驅動、測試把關、全程可追溯的 AI 軟體開發工具。可架在雲端機器上，只用手機也能開發。

- 專案規劃：[doc/plan.md](doc/plan.md)
- 雲端與手機模式：[doc/cloud.md](doc/cloud.md)
- AI Provider：[doc/providers.md](doc/providers.md)

## 快速開始

需要 Node.js 24 以上。

```bash
corepack pnpm install
```

貼上任一家的 API key，會依 key 的前綴自動判斷是哪家 provider：

```bash
corepack pnpm aise login nvapi-xxxxxxxx
```

在要分析的 repo 啟動伺服器：

```bash
corepack pnpm aise serve --root /path/to/repo
```

另開一個終端機發問：

```bash
corepack pnpm aise ask "登入流程在哪裡實作？"
```

任務在伺服器上執行，客戶端斷線也不會中斷；`aise tasks` 列出任務，`aise show <id>` 接續觀看。

## 指令

| 指令 | 說明 |
|------|------|
| `aise login <key> [--provider id] [--model id] [--base-url url]` | 儲存 API key（存在 `~/.aise/credentials.json`，權限 600） |
| `aise providers` | 列出所有 provider 與設定狀態 |
| `aise use <provider> [--model id]` | 切換預設 provider |
| `aise models` | 列出 provider 提供的模型 |
| `aise serve [--root dir] [--host addr] [--port n]` | 啟動伺服器（預設 `127.0.0.1:7420`） |
| `aise connect <url> --token t` | 連到遠端伺服器 |
| `aise ask <question>` | 詢問關於 repo 的問題，即時串流回答 |
| `aise tasks` / `aise show <id>` | 列出任務 / 觀看任務 |

## 開發

```bash
corepack pnpm test
```

```bash
corepack pnpm typecheck
```

TypeScript 原始碼由 Node.js 直接執行（type stripping），不需要編譯步驟。

| 套件 | 職責 |
|------|------|
| [packages/llm](packages/llm) | 中立的訊息格式、各家 provider 轉接、API key 管理 |
| [packages/core](packages/core) | Agent 工具迴圈與唯讀工具（`list_files`、`read_file`、`grep`） |
| [packages/server](packages/server) | HTTP API、SQLite 任務佇列、背景 worker、SSE 事件串流 |
| [packages/cli](packages/cli) | `aise` 指令 |
