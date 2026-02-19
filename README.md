# prompt-doctor

`prompt-doctor` is an MCP server that rewrites user prompts so downstream coding agents receive clearer, execution-ready instructions.

It runs on stdio and exposes one tool: `enhance_prompt`.

## Core responsibilities

- Rewrites the current user request while preserving intent and constraints.
- Enriches rewriting with repository context from the current working directory.
- **Mandates active-file context** from the client for file-targeted requests.
- Clearly separates active file (primary target) from reference context (patterns only).
- Prevents hallucination by distinguishing between facts and reference material.
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
- **Intelligently chunks code** by aligning with function/class boundaries for semantic coherence.
- **Adds metadata tags** to chunks (Function: name, Class: name) for better context understanding.
- Combines lexical ranking and embedding reranking.
- Returns prompt-ranked context excerpts.
- **Clearly distinguishes active file from reference context**:
  - **Active file section** (marked as PRIMARY TARGET):
    - File path
    - Summary
    - Code excerpts from the active file (up to 2 chunks)
  - **Reference context section** (marked as REFERENCE ONLY):
    - Repository-wide relevant chunks (top 6) for understanding patterns
    - Explicitly labeled as reference, not execution targets

## RAG Advantage

RAG is the strongest differentiator in this service because prompt rewriting quality depends on repository-grounded specificity, not generic rewriting rules.

### Why it materially improves output quality

- Converts vague user intent into repository-aware instructions (real files, symbols, and structure).
- **Prevents hallucination** by clearly separating active file (facts) from reference context (patterns).
- Improves rewrite precision by combining current request text with current repo evidence.
- Preserves local coding conventions by retrieving exact in-repo patterns.
- **Provides code-aware chunking** that aligns with function/class boundaries for better semantic coherence.
- **Enriches chunks with metadata** (function names, class names) for improved context understanding.

### Retrieval pipeline (implementation-level)

**Background Indexing:**
- Indexing starts in the background on first query to ensure tool responses within 60s
- Cached index (if available) is loaded immediately for instant results
- Full re-indexing happens asynchronously without blocking queries
- Embeddings computed on-demand at query time (only for top lexical candidates)

**Pipeline Steps:**
1. Discover candidate files from `process.cwd()` with extension and directory filters.
2. Exclude sensitive/noise paths using `.rag/indexing-exclude.txt` patterns.
3. **Chunk files intelligently**:
   - Identify code structure boundaries (function, class, interface definitions)
   - Align chunks with these boundaries when possible (48 lines max, 8-line overlap)
   - Extract and prepend metadata tags to chunks: `[Function: name]`, `[Class: name]`, etc.
4. Build lexical term sets per chunk for fast first-pass recall.
5. Rank candidate chunks lexically from the current prompt.
6. **On-demand embedding**: Embed only the query and top lexical candidates (not the entire index).
7. Blend lexical/vector scores (`0.2 / 0.8`) and select top chunks.
8. **Format context with clear section separation**:
   - Active file section (if `activeFile` provided): marked as PRIMARY TARGET with path, summary, and excerpts
   - Reference context section: marked as REFERENCE ONLY with top 6 repository chunks
9. Deliver formatted context to LLM with explicit instructions about section purposes.

### Indexing model and scoring profile

- Embedding model: `Xenova/all-MiniLM-L6-v2` (computed on-demand at query time)
- Top chunks: `6`
- Max files considered: `1000`
- Lexical candidate expansion: `topK * 12`
- Final score blend: lexical `0.2` + vector `0.8`

**Performance Optimizations:**
- Embeddings computed only for query and top lexical candidates (not stored in index)
- Reduces index file size by ~95% and indexing time by ~80%
- Background indexing allows tool responses within 60 seconds
- Cached index loaded synchronously for immediate availability

### Persistence and reuse

- Fingerprint-based index reuse avoids unnecessary re-indexing when files are unchanged.
- Persisted index path: `.rag/code-index-v1.json`
- Exclusion config path: `.rag/indexing-exclude.txt`
- If exclusion file is missing, it is recreated with the default protective pattern set.
- **Cached index loaded immediately** on first query for instant results.
- **Background re-indexing** updates the cache if files have changed.
- Index files are lightweight (no embeddings stored) for fast I/O.

### Active file augmentation

Active file context is presented as the PRIMARY TARGET section, clearly separated from reference context:

**Active File Section (PRIMARY TARGET):**
- File path (exact editor-focused file)
- Summary (first meaningful content line)
- Up to 2 code excerpts from the active file
- Clear header: `=== ACTIVE FILE (PRIMARY TARGET) ===`

**Reference Context Section (REFERENCE ONLY):**
- Top 6 repository-wide relevant chunks
- Clear header: `=== REFERENCE CONTEXT (for patterns/conventions only) ===`
- Explicitly marked as reference to prevent hallucination

**Critical distinction:**
- Active file = THE file the user is currently editing/viewing (editor focus) - the PRIMARY target
- Active file should NEVER be documentation (README, AGENTS.md, SKILL.md, etc.) unless genuinely being edited
- Reference context = Background patterns ONLY, not execution targets
- The downstream agent ALREADY HAS full repository access - enhanced prompts should be concise
- LLM instructions emphasize: downstream agent has repo context, don't repeat file contents or suggest searches

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
- `activeFile`: **MANDATORY** for file-targeted requests. Must be the EXACT file the user is currently editing/viewing in their editor (the file with editor focus/cursor). This is what the user is working on RIGHT NOW. Active file should NEVER be documentation/instruction files (README.md, AGENTS.md, SKILL.md, .cursorrules, etc.) UNLESS the user is genuinely editing those files. References like "this file", "here", "current page" ALWAYS mean this file. Do not infer, substitute, or default from repo docs, instructions, or retrieval results. Only omit when the request has no file target (e.g., general conceptual questions).

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

**Anti-hallucination guarantees:**

- Rewriter will NOT invent file paths, searches, or navigation steps not requested by the user.
- Rewriter will NOT treat reference context as facts about what exists or where to search.
- Rewriter will NOT propose operations on terms/symbols not visible in the active file excerpts.
- Rewriter will NOT repeat large code snippets from reference context (downstream agent already has repo access).
- If active file is provided, rewriter MUST include it in `Relevant Files` even if user used vague references ("here", "this file").
- Reference context is used ONLY to understand patterns/conventions, never as execution targets.
- Enhanced prompts stay concise since the downstream agent has full repository context.

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

RAG works against the repository specified via the `workingDirectory` parameter in the `enhance_prompt` tool call.

**IMPORTANT:** The client must provide the `workingDirectory` parameter pointing to the target repository. If omitted, the server falls back to `process.cwd()` (where the MCP server was launched), which is typically incorrect.

Generated files in the target repository:

- `.rag/code-index-v1.json` - Persisted index with fingerprints for fast reuse
- `.rag/indexing-exclude.txt` - Exclusion patterns for files to skip during indexing

If `.rag/indexing-exclude.txt` is missing, it is recreated with the built-in default exclusion patterns.

### Tool Parameters

The `enhance_prompt` tool accepts:

- `prompt` (required): The user's prompt to enhance
- `activeFile` (optional): Path to the file the user is actively editing/viewing
- `workingDirectory` (optional): Absolute path to the target repository where `.rag` should be created. **Highly recommended** to always provide this parameter.

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

**Note:** When calling the `enhance_prompt` tool, your MCP client should pass the `workingDirectory` parameter with the absolute path to the target repository. This ensures the `.rag` directory is created in the correct location.

Example tool call:
```json
{
  "name": "enhance_prompt",
  "arguments": {
    "prompt": "add error handling to the API",
    "activeFile": "/path/to/repo/src/api.ts",
    "workingDirectory": "/path/to/repo"
  }
}
```

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
