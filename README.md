# prompt-doctor

An MCP (Model Context Protocol) server that improves user prompts for clarity and completeness while preserving intent. It acts as a middleware tool so downstream AI agents receive a clean, actionable request.

## Features

- Exposes a single MCP tool: `enhance_prompt`
- Rewrites prompts using a system prompt in `src/prompt.txt`
- Works over stdio (standard MCP server transport)
- Returns the original prompt if the LLM call fails

## Requirements

- Node.js 18+ (Node.js 20+ recommended)
- npm

## Environment Setup

Create a `.env` file (or set env vars in your shell/MCP client config):

```bash
LLM_BASE_URL=https://your-litellm-host/v1/chat/completions
LLM_MODEL=your-model
LLM_API_KEY=your-api-key

# Optional
LLM_TEMPERATURE=0.2
LLM_MAX_TOKENS=1000
```

The server also accepts `LITELLM_*` variants:

- `LITELLM_BASE_URL`
- `LITELLM_MODEL`
- `LITELLM_API_KEY`
- `LITELLM_TEMPERATURE`
- `LITELLM_MAX_TOKENS`

## Local Development

Install dependencies and build:

```bash
npm install
npm run build
```

Run locally:

```bash
node build/server.js
```

You should see:

```text
prompt doctor server running on stdio
```

## Use as an npm Package

Install globally:

```bash
npm install -g prompt-doctor
```

Then configure your MCP client to run the CLI:

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

Alternative (no global install): use the built file directly.

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

## Codex Setup (MCP)

1. Add one of the MCP server configurations above.
2. Restart Codex to pick up the new MCP server.

## Usage

Once configured, Codex (or any MCP client) will call `enhance_prompt` for each user request. The tool returns a rewritten prompt following the rules in `src/prompt.txt`.

## Customizing the Prompt

Edit `src/prompt.txt` and rebuild:

```bash
npm run build
```

## Compatibility / Testing

Tested with OpenAI Codex on macOS. It should work with other MCP-compatible clients and platforms that support Node.js 18+.

## Contributing

Issues and pull requests are welcome. Please keep changes focused and include a clear description.

## License

MIT
