# Claude Desktop and the official DeepSeek API

## Compatibility boundary

| Path | Status in this release |
| --- | --- |
| Claude Code to Codex CLI | Implemented; automated protocol tests and a real MCP-client-to-Codex model smoke test are recorded |
| Codex to Claude Code CLI | Implemented; automated fixtures passed; the staged real CLI returned an authentication failure |
| Claude Desktop to Codex CLI | Local stdio MCP server using `--host desktop`; protocol tested; actual Desktop UI execution is unverified |
| Codex to the official DeepSeek API | Implemented in v1.1 using `--host codex --peer deepseek`; local HTTP/MCP fixtures tested; real API call requires a local credential |
| Codex to a third-party gateway | No arbitrary endpoint adapter; this release uses the official DeepSeek endpoint only |
| Codex to an existing Desktop window or chat | Not implemented |

The earlier `Not logged in` result came from a separately staged **Claude Code CLI**. It does not describe the login or model connection inside Claude Desktop. For the direct DeepSeek API setup below, no Claude Code installation or extra gateway application is needed.

## Desktop to Codex

This uses the [local MCP client configuration documented by the MCP project](https://modelcontextprotocol.io/docs/develop/connect-local-servers). [Anthropic's Desktop guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) also describes local server connections and desktop extensions.

1. Install this repository's dependencies with `npm ci --ignore-scripts` and keep them available. Install and authenticate Codex CLI separately. Claude Code CLI is not needed for this direction.
2. Open Claude Desktop's Developer settings and use **Edit Config** to select the configuration the application actually uses. The standard Windows location is `%APPDATA%\Claude\claude_desktop_config.json`; macOS uses `~/Library/Application Support/Claude/claude_desktop_config.json`. Custom distributions can differ.
3. Merge the `codex_bridge` entry from [the example](../examples/claude-desktop.json) into the existing `mcpServers` map. Replace all paths with actual absolute paths; keep existing settings and other servers. On macOS/Linux, use the actual Node executable path instead of the Windows example.
4. The `--host desktop` value selects the **Codex-facing direction**. The older `--host claude` value still selects the same tools. Neither starts Claude Code. If Desktop does not inherit Codex's PATH, supply the repository's `--config` option with an explicit Codex command array as described in the README.
5. Fully quit and reopen Desktop when ready, inspect the local server connection, then ask it to call `bridge_status`. Next, ask it to run `start_codex_task` in consult mode and poll `get_task`.

The existing configuration generator also prints the required `mcpServers` structure:

```sh
node bin/bridge.mjs config --host desktop --workspace /absolute/path/your-project
```

It prints JSON only and does not modify Desktop settings. The repository's `.claude-plugin/` wrapper is a Claude Code plugin; it is not a Claude Desktop `.mcpb` extension.

## Codex to DeepSeek directly

The adapter sends one text consultation to `https://api.deepseek.com/chat/completions`, following the [official DeepSeek API documentation](https://api-docs.deepseek.com/). It uses bearer authentication, non-streaming chat completions, disabled thinking, and a bounded output token allowance. No gateway product or OpenAI SDK is needed. Production endpoints cannot be supplied by tool arguments or config; redirects are rejected.

1. Make `DEEPSEEK_API_KEY` available in the environment inherited by the MCP server. The bridge does not extract it from Desktop. Set `DEEPSEEK_MODEL` to the actual model ID you use, or select the model through the owner config or task argument. No model is silently chosen.
2. Register the new direction in Codex:

```sh
codex mcp add deepseek_bridge -- node /absolute/path/codex-claude-mcp-bridge/bin/bridge.mjs serve --host codex --peer deepseek --workspace /absolute/path/your-project
```

3. Ask Codex to call `start_deepseek_task`, then poll `get_task`:

```json
{
  "prompt": "Review the following code for edge cases: ...",
  "timeout_seconds": 120,
  "max_output_tokens": 2048
}
```

The model can also be supplied through a `model` argument. The owner config [example](../examples/deepseek-config.json) contains an example model ID and the name of the key environment variable; it contains no credential. Pass it with `--config /absolute/path/deepseek-config.json` when using that configuration method. Replace the example model with your chosen model.

### Supply credentials locally

For a new Codex CLI session launched from PowerShell, these prompts keep the key out of command history and chat:

```powershell
$deepseekKeyInput = Read-Host 'DeepSeek API key' -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $deepseekKeyInput).Password
$env:DEEPSEEK_MODEL = Read-Host 'DeepSeek model ID'
codex
```

These variables apply to that shell and processes launched from it. Setting them in a terminal does not update an already-running Codex Desktop app or MCP server. A GUI host must be fully restarted from an environment that includes them, or use your normal local secret-injection mechanism. Do not paste a real key into the README, an issue, a tool prompt, or a committed configuration file. This project does not change user or machine environment settings automatically.

### What the two directions share

The caller explicitly passes task context. The DeepSeek API request receives only the supplied prompt and a consultant instruction; no local files, Desktop history, MCP tool definitions, or credentials other than the DeepSeek authorization header are added. It does not execute tools or edit files. Use Codex to inspect and validate any proposed changes.

Both directions use the same task result API and workspace lock. Register the same canonical workspace root on each side. Cancellation aborts the local API request; the provider can already have begun processing or billing it. Failed API requests are not retried automatically.

Desktop's MCP client must preserve tool calls and returned results for the Desktop-to-Codex path to work in your particular setup. A Desktop tool backed by DeepSeek is distinct from replacing Desktop's primary chat model; this project does not inspect or change Desktop's model selection.

## Validation status

The [v1.1 validation report](test-report-v1.1.md) records local HTTP fixture and MCP tests. No Desktop settings or stored credentials were read or changed. No real DeepSeek request was sent because `DEEPSEEK_API_KEY` was unavailable to this process. Full Desktop UI plus real DeepSeek API operation remains to be verified after local configuration. The [earlier CLI report](test-report.md) is historical evidence for v1.0.
