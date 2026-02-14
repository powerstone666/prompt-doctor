# prompt-doctor

An MCP (Model Context Protocol) server that improves user prompts for clarity and completeness while preserving intent. It acts as a middleware tool so downstream AI agents receive a clean, actionable request.

## Features

- Exposes a single MCP tool: `enhance_prompt`
- Rewrites prompts using a system prompt in `src/prompt.txt`
- Works over stdio (standard MCP server transport)
- Returns the original prompt if the LLM call fails

## Requirements

- Node.js 18+ (for built-in `fetch`)
- npm

## Install and Build

```bash
npm install
npm run build
```

Build output is written to `build/`, and `src/prompt.txt` is copied to `build/prompt.txt`.

## Configuration

The server requires these environment variables:

- `LLM_BASE_URL` (LiteLLM-compatible endpoint)
- `LLM_MODEL` (model name)
- `LLM_API_KEY` (API key)

Optional:

- `LLM_TEMPERATURE` (default: `0.2`)
- `LLM_MAX_TOKENS` (omit to use the model maximum)

You can plug in any model compatible with LiteLLM.

## Run Locally

```bash
npm run build
node build/server.js
```

You should see:

```
prompt doctor server running on stdio
```

## Codex Setup (MCP)

This project is tested with OpenAI Codex. It should also work with any MCP-compatible client.

1. Build the project:

```bash
npm run build
```

2. Add a new MCP server in your Codex configuration. The exact file location depends on your Codex setup. Choose one of the following options:

Option A: Run the built file directly with Node (no global install required):

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

Option B: Use the `prompt-doctor` CLI (requires the package to be installed and on your PATH). For local development, you can build and link it:

```bash
npm run build
npm link
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

3. Restart Codex to pick up the new MCP server.

## Usage

Once configured, Codex (or any MCP client) will call `enhance_prompt` for each user request. The tool returns a rewritten prompt following the rules in `src/prompt.txt`.

## Customizing the Prompt

Edit `src/prompt.txt` to change how prompts are rewritten, then rebuild:

```bash
npm run build
```

## Compatibility / Testing

Tested with OpenAI Codex on macOS. It should work with other MCP-compatible clients and platforms that support Node.js 18+.

## Contributing

Issues and pull requests are welcome. Please keep changes focused and include a clear description.

## License

ISC
