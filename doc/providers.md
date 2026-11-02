# AI Provider

AISE 不綁定任何一家模型廠商：給一把 API key 就能用。

## 支援的 Provider

| id | Provider | Key 前綴 | 環境變數 | 預設模型 |
|----|----------|----------|----------|----------|
| `anthropic` | Anthropic Claude | `sk-ant-` | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |
| `nvidia` | NVIDIA NIM | `nvapi-` | `NVIDIA_API_KEY` | `nvidia/nemotron-3-super-120b-a12b` |
| `openrouter` | OpenRouter | `sk-or-` | `OPENROUTER_API_KEY` | `openrouter/auto` |
| `groq` | Groq | `gsk_` | `GROQ_API_KEY` | `openai/gpt-oss-120b` |
| `gemini` | Google Gemini | `AIza` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `deepseek` | DeepSeek | （需指定 `--provider`） | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `openai` | OpenAI | `sk-` | `OPENAI_API_KEY` | `gpt-5` |
| `ollama` | Ollama（本機） | 不需要 key | — | `llama3.1` |
| `custom` | 任何 OpenAI 相容服務（vLLM、自架 NIM…） | — | — | 需指定 |
| `mock` | 離線測試用 | 不需要 key | — | — |

各家模型清單變動很快，預設模型不一定是最新的。用 `aise models` 查詢可用模型，再用 `aise use <id> --model <model>` 換掉。工具呼叫（tool calling）需要模型支援；NVIDIA 上請挑標示支援 function calling 的模型。

## 使用方式

```bash
aise login nvapi-xxxxxxxx
```

```bash
aise login sk-ant-xxxxxxxx
```

```bash
aise login mykey --provider deepseek
```

```bash
aise login mykey --provider custom --base-url http://my-gpu:8000/v1 --model qwen3-coder
```

最後一次 `login` 的 provider 會成為預設；`aise use <id>` 切換。

## 選擇順序

1. 指令或 API 明確指定的 provider
2. 環境變數 `AISE_PROVIDER`
3. `aise login` / `aise use` 設定的預設值
4. 環境中第一個有設定 API key 的 provider

模型可用 `AISE_MODEL` 臨時覆寫。

## 架構

```mermaid
flowchart LR
    CORE[core<br/>Agent 迴圈] -->|中立格式<br/>Message / Part / ToolDef| P{Provider}
    P --> A[AnthropicProvider<br/>@anthropic-ai/sdk]
    P --> O[OpenAICompatProvider<br/>openai SDK + baseURL]
    P --> M[MockProvider]
    O --> NV[NVIDIA NIM]
    O --> OR[OpenRouter / Groq / Gemini / DeepSeek / OpenAI]
    O --> OL[Ollama / vLLM]
```

- **中立格式**（[types.ts](../packages/llm/src/types.ts)）：`text`、`tool_call`、`tool_result`，以及 `opaque`——供應商專屬的區塊（例如 Claude 的 thinking），只會原封不動回傳給同一家 provider。
- **Anthropic**：串流、adaptive thinking、refusal 時由伺服器端自動 fallback。
- **OpenAI 相容**：串流並重組分段送來的 tool call；`tool_result` 轉成 `role: "tool"` 訊息。
- **輸入驗證**：所有 provider 回傳的工具參數都先經過 zod schema 驗證才執行，格式錯誤會以錯誤結果回給模型。

## 安全

- API key 存在 `~/.aise/credentials.json`（目錄 700、檔案 600），不會進 repo，也不會傳給工作區。
- `aise providers` 只顯示遮罩後的 key。
- 雲端部署時，key 只放在伺服器上；手機與 CLI 只持有伺服器 token。
