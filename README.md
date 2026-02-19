# prompt-doctor

`prompt-doctor` is an MCP server that rewrites user prompts so downstream coding agents receive clearer, execution-ready instructions.

It runs on stdio and exposes one tool: `enhance_prompt`.

## Core responsibilities

- Rewrites the current user request while preserving intent and constraints.
- Enriches rewriting with repository context from the current working directory.
- Accepts active-file context from the client.
- Blocks LLM forwarding when secret leakage is detected.

## Runtime architecture

### 1) MCP server layer (`src/server.ts`)

- Registers `enhance_prompt` with Zod input validation.
- Coordinates three subsystems:
  - `CodebaseContextRetriever`
  - `GitleaksGuard`
  - `LiteLLMClient`

### 2) Context retrieval layer (`src/context-retriever.ts`)

- Indexes repository files into chunked searchable units.
- Combines lexical ranking and embedding reranking.
- Returns prompt-ranked context excerpts.
- Adds a dedicated active-file section when `activeFile` is provided:
  - `Active file: <path>`
  - short file summary
  - active-file excerpts

## RAG Advantage

RAG is the strongest differentiator in this service because prompt rewriting quality depends on repository-grounded specificity, not generic rewriting rules.

### Why it materially improves output quality

- Converts vague user intent into repository-aware instructions (real files, symbols, and structure).
- Reduces hallucinated assumptions by constraining the rewrite to indexed project content.
- Improves rewrite precision by combining current request text with current repo evidence.
- Preserves local coding conventions by retrieving exact in-repo patterns.

### Retrieval pipeline (implementation-level)

1. Discover candidate files from `process.cwd()` with extension and directory filters.
2. Exclude sensitive/noise paths using `.rag/indexing-exclude.txt` patterns.
3. Chunk files into overlapping windows (48 lines, 8-line overlap).
4. Build lexical term sets per chunk for fast first-pass recall.
5. Rank candidate chunks lexically from the current prompt.
6. If embeddings are available, rerank with MiniLM vector similarity.
7. Blend lexical/vector scores (`0.2 / 0.8`) and select top chunks.
8. Add active-file context section and active-file excerpts when `activeFile` is present.
9. Format final context for LLM as bounded, source-tagged excerpts.

### Indexing model and scoring profile

- Embedding model: `Xenova/all-MiniLM-L6-v2`
- Top chunks: `6`
- Max files considered: `1000`
- Embedding batch size: `24`
- Lexical candidate expansion: `topK * 12`
- Final score blend: lexical `0.2` + vector `0.8`

### Persistence and reuse

- Fingerprint-based index reuse avoids unnecessary re-indexing when files are unchanged.
- Persisted index path: `.rag/code-index-v1.json`
- Exclusion config path: `.rag/indexing-exclude.txt`
- If exclusion file is missing, it is recreated with the default protective pattern set.

### Active file augmentation

Active file context is appended as a separate section, not mixed into prompt ranking:

- `Active file: <path>`
- concise file summary
- up to 2 active-file excerpts

This keeps prompt retrieval objective while still giving the rewriter high-value local context from the editor focus.

### 3) Secret scanning layer (`src/gitleaks-guard.ts`, `src/install.ts`)

- Scans:
  - user prompt
  - retrieved repo context
- Uses `gitleaks detect --no-git` over temporary files.
- If `gitleaks` is missing, attempts package-manager installation across macOS, Linux, and Windows.

### 4) LLM transport layer (`src/litellm.ts`)

- Sends chat-completions requests to `LLM_BASE_URL`.
- Loads rewrite system instructions from `src/prompt.txt`.
- Uses message/payload cache hints for repeated system-prompt use.

## Tool contract

Tool name: `enhance_prompt`

Input payload:

```json
{
  "prompt": "string",
  "activeFile": "string"
}
```

Field behavior:

- `prompt`: required request text.
- `activeFile`: exact current editor-focused file path provided by the client for that turn. Do not infer or substitute it from repo docs, instructions, or retrieval results. It should not be a reference file such as `AGENTS.md` or `SKILL.md` unless that is truly the file being actively edited.

## Rewriter output semantics

The rewriter returns a structured prompt artifact for the downstream agent. It may include:

- `Open Questions`
- `Required`
- `Reason`

Interpretation rules:

- `Required` is advisory and should only appear when clarification could improve execution.
- `Reason` explains why the clarification may matter.
- If `Reason` is present, downstream agents should evaluate relevance and decide whether to ask now or continue.
- If clarification is not useful, output should use `Required: None.` and `Reason: None.`

## Request lifecycle

1. Validate tool input.
2. Scan prompt with gitleaks.
3. Build repository context from index + active-file section.
4. Scan retrieved context with gitleaks.
5. Rewrite prompt through LiteLLM using `src/prompt.txt` output rules.
6. Return rewritten text.

Failure behavior:

- Secret detection: request is blocked and not sent to LLM.
- Scanner failure: request is blocked and not sent to LLM.
- LLM failure: original prompt is returned.

## Configuration

### Required environment variables (LLM)

```bash
LLM_BASE_URL=https://your-litellm-host/v1/chat/completions
LLM_MODEL=your-model
LLM_API_KEY=your-api-key
```

### Scanner environment variables

```bash
GITLEAKS_BIN=gitleaks
GITLEAKS_CONFIG=/absolute/path/to/gitleaks.toml
```

If `GITLEAKS_BIN` is not set, the guard resolves common binary locations and `PATH` entries.

## Defaults and tuning profile

The service runs with a fixed rewrite profile to keep behavior stable across clients:

- temperature: `0.2`
- max_tokens: `1000`
- system prompt source: `src/prompt.txt`
- cache hints enabled in request payload and system message

RAG profile is also fixed in code for MiniLM-based retrieval:

- model: `Xenova/all-MiniLM-L6-v2`
- top K chunks: `6`
- chunk size: `48` lines
- overlap: `8` lines
- lexical/vector blend: `0.2 / 0.8`

## Repository indexing details

RAG works against `process.cwd()` (the repo where MCP is launched).

Generated files:

- `.rag/code-index-v1.json`
- `.rag/indexing-exclude.txt`

If `.rag/indexing-exclude.txt` is missing, it is recreated with the built-in default exclusion patterns.

## Local development

Install and build:

```bash
npm install
npm run build
```

Run:

```bash
node build/server.js
```

Expected startup log:

```text
prompt doctor server running on stdio
```

## MCP client configuration

### Using global install

```bash
npm install -g prompt-doctor
```

```json
{
  "mcpServers": {
    "prompt-doctor": {
      "command": "prompt-doctor",
      "args": [],
      "env": {
        "LLM_BASE_URL": "https://your-litellm-host/v1/chat/completions",
        "LLM_MODEL": "your-model",
        "LLM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Using local build directly

```json
{
  "mcpServers": {
    "prompt-doctor": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/build/server.js"],
      "env": {
        "LLM_BASE_URL": "https://your-litellm-host/v1/chat/completions",
        "LLM_MODEL": "your-model",
        "LLM_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Prompt behavior customization

Edit `src/prompt.txt`, then rebuild:

```bash
npm run build
```

## License

MIT
