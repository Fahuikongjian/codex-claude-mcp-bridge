# Claude Desktop and model gateways

## Compatibility boundary

| Path | Status in this release |
| --- | --- |
| Claude Code to Codex CLI | Implemented; automated protocol tests and a real MCP-client-to-Codex model smoke test are recorded |
| Codex to Claude Code CLI | Implemented; automated fixtures passed; the staged real CLI returned an authentication failure |
| Claude Desktop to Codex CLI | Uses the existing local stdio MCP server; configuration example supplied; actual Desktop execution is unverified |
| Codex to a DeepSeek model behind a custom Desktop gateway | No adapter implemented; gateway details are required |
| Codex to an existing Desktop window or chat | Not implemented |

The earlier `Not logged in` result came from a separately staged **Claude Code CLI**. It does not describe the login or model connection inside Claude Desktop. A Desktop gateway connection cannot be assumed to authenticate that CLI.

## Desktop to Codex

This uses the [local MCP client configuration documented by the MCP project](https://modelcontextprotocol.io/docs/develop/connect-local-servers). [Anthropic's Desktop guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) also describes local server connections and desktop extensions.

1. Install this repository's dependencies with `npm ci --ignore-scripts` and keep them available. Install and authenticate Codex CLI separately. Claude Code CLI is not needed for this direction.
2. Open Claude Desktop's Developer settings and use **Edit Config** to select the configuration the application actually uses. The standard Windows location is `%APPDATA%\Claude\claude_desktop_config.json`; macOS uses `~/Library/Application Support/Claude/claude_desktop_config.json`. Custom distributions can differ.
3. Merge the `codex_bridge` entry from [the example](../examples/claude-desktop.json) into the existing `mcpServers` map. Replace all paths with actual absolute paths; keep existing settings and other servers. On macOS/Linux, use the actual Node executable path instead of the Windows example.
4. The `--host claude` value selects the **Codex-facing direction**. It does not require the caller to be Claude Code and does not start Claude Code. If Desktop does not inherit Codex's PATH, supply the repository's `--config` option with an explicit Codex command array as described in the README.
5. Fully quit and reopen Desktop when ready, inspect the local server connection, then ask it to call `bridge_status`. Next, ask it to run `start_codex_task` in consult mode and poll `get_task`.

The existing configuration generator also prints the required `mcpServers` structure:

```sh
node bin/bridge.mjs config --host claude --workspace /absolute/path/your-project
```

It prints JSON only and does not modify Desktop settings. The repository's `.claude-plugin/` wrapper is a Claude Code plugin; it is not a Claude Desktop `.mcpb` extension.

## DeepSeek behind a gateway

The MCP server runs independently of the model provider. Successful use from a customized Desktop host still requires the host and gateway to preserve tool definitions, tool calls, and returned tool results. An ordinary text reply from DeepSeek does not establish that those operations work.

Before implementing a reverse adapter, identify the gateway software/project and its documented interface. The relevant details are its API format, base URL without embedded credentials, and model identifier. Do not publish API keys or copy account secrets into issues, reports, or example files.

Possible implementations depend on that interface:

- A model API adapter can send a new request from Codex to the configured DeepSeek gateway. The response comes from the model endpoint, not an existing Desktop chat; Desktop's local MCP tools and chat state do not automatically accompany it.
- A gateway exposing an agent/session API may support more, but its documented operations and authentication must be verified first.
- A Desktop host that offers only outbound MCP client connections does not thereby expose an inbound chat-control API. Adding an MCP server to Desktop alone does not establish two-way control of the application.

No gateway credentials were read, no Desktop settings were edited, and no DeepSeek requests were sent while preparing this compatibility note. Full two-way compatibility with a Desktop/gateway deployment remains unverified.
