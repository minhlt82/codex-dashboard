# Codex Dashboard

A local web dashboard to visualize [OpenAI Codex CLI](https://github.com/openai/codex) session logs — token usage, context window breakdown, tool calls, and turn-by-turn analysis.

![screenshot](https://img.shields.io/badge/status-beta-blue)

## Features

- **Session browser** — Lists all Codex sessions sorted by recency with live indicators
- **Token usage tracking** — Input, output, cached, and reasoning tokens per session
- **Context window progress** — Visual bar showing how much of the model's context is consumed
- **Context category breakdown** — System prompt, memory/context, skills, and message token distribution
- **Per-API-call inspection** — Drill into each turn to see individual API calls, messages, tool invocations
- **Tool call analysis** — Categorized tool usage (read, write, search, list) with execution times
- **Files accessed** — Quick view of all files the agent touched
- **Rate limit monitoring** — 5-hour and weekly usage with color-coded warnings
- **Accurate tokenization** — Uses [js-tiktoken](https://www.npmjs.com/package/js-tiktoken) (o200k_base) for system prompt tokenization, and real API-reported token counts for tool outputs

## Quick Start

```bash
# Clone and run
git clone https://github.com/minhlt82/codex-dashboard.git
cd codex-dashboard
npm install
npm start
```

Then open **http://localhost:3456** in your browser.

## Requirements

- **Node.js** ≥ 18
- **Codex CLI** installed and used at least once (creates session logs in `~/.codex/sessions/`)

## How It Works

The dashboard reads Codex CLI JSONL session logs from `~/.codex/sessions/` and parses them into a structured timeline. No data is sent anywhere — everything runs locally on your machine.

### Data Sources

| Data | Source | Accuracy |
|------|--------|----------|
| Token counts (per-call) | `token_count` events in JSONL | ✅ Exact (from API) |
| Tool output tokens | `Original token count: N` in function outputs | ✅ Exact (from API) |
| System prompt tokens | `js-tiktoken` o200k_base encoder | ⚠️ Approximate (Claude uses a proprietary tokenizer) |
| Rate limits | `rate_limits` in token_count events | ✅ Exact (from API) |

### Context Breakdown Categories

- **System Prompt** — Base instructions, personality, rules (developer_instructions)
- **Memory & Context** — XML-tagged blocks (`<artifacts>`, `<knowledge_item>`, `<persistent_context>`, etc.) + tool output text injected into context
- **Skills** — XML-tagged configuration (`<skills>`, `<identity>`, `<guidelines>`, etc.)
- **Messages** — Conversation history (derived: total input − system − memory − skills)

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3456` | HTTP server port |

## Project Structure

```
codex-dashboard/
├── server.js      # Node.js HTTP server + JSONL parser
├── index.html     # Single-file frontend (HTML + CSS + JS)
├── package.json
└── .gitignore
```

Zero build step. No framework. Just `node server.js`.

## License

MIT
