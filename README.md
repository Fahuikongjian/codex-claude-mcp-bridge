# Codex ↔ Claude Code / DeepSeek MCP Bridge

A local MCP server with two integration paths: **Codex ↔ Claude Code**, or **Claude Desktop → Codex and Codex → the official DeepSeek API**. CLI tasks launch fresh, non-interactive sessions. DeepSeek tasks create independent API consultations with no local tools.

This connects the agents through CLI and model API interfaces. It does not remote-control their windows, attach to an existing GUI chat, share hidden conversation history, or combine subscriptions. It is an independent community project.

```text
Codex       → MCP bridge (--host codex)  → claude --print
Claude Code → MCP bridge (--host claude) → codex exec
Claude Desktop → MCP bridge (--host desktop) → codex exec
Codex → MCP bridge (--host codex --peer deepseek) → api.deepseek.com
```

Tasks return an ID immediately. Poll for a final result, or cancel the CLI process tree. Both installations can coexist. A shared workspace lock serializes bridge tasks, and an inherited child marker blocks recursive bridge delegation.

## Claude Desktop and the official DeepSeek API

Claude Desktop and Claude Code are different hosts. Installing Desktop does not supply a `claude --print` executable or its authentication. For a Desktop + DeepSeek setup, Claude Code CLI and a separate gateway application are not required.

Desktop can connect to the Codex-facing MCP server using `--host desktop` (`--host claude` remains compatible). A [Desktop configuration example](examples/claude-desktop.json) and [complete setup guide](docs/claude-desktop-and-gateways.md) are included. The actual Desktop UI has not been exercised here.

For the reverse direction, select `--peer deepseek` in Codex and provide the bridge's API key environment variable and an explicit DeepSeek model ID. This calls only `https://api.deepseek.com/chat/completions`. It does not control Desktop or access its current conversation. Prompts/code context must be supplied explicitly; files are not uploaded automatically. No official DeepSeek model call has been completed without a locally available key. See [v1.1 validation](docs/test-report-v1.1.md).

## Install

Requirements: Node.js 22+, Git, and authenticated [Codex CLI](https://developers.openai.com/codex/cli/). The CLI-to-CLI path additionally needs authenticated [Claude Code](https://code.claude.com/docs/en/setup); the DeepSeek path needs an official API key and a selected model. Use a trusted local workspace. Calls consume the destination account's usage.

```sh
git clone https://github.com/Fahuikongjian/codex-claude-mcp-bridge.git
cd codex-claude-mcp-bridge
npm ci --ignore-scripts
node bin/bridge.mjs --help
```

Use absolute paths below. On Windows, forward slashes in the example paths work too. Use the absolute Node executable path if your app does not inherit your terminal's PATH. No npm registry publication is required.

### Let Codex call the official DeepSeek API

Make `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` available in the environment inherited by the bridge server. Select your actual model ID; no model is silently chosen. An example server-owner model configuration is included in [examples/deepseek-config.json](examples/deepseek-config.json). Keep the key in the environment, not the config file or tool arguments.

```sh
codex mcp add deepseek_bridge -- node /absolute/path/codex-claude-mcp-bridge/bin/bridge.mjs serve --host codex --peer deepseek --workspace /absolute/path/your-project
```

Or print a Codex config snippet:

```sh
node bin/bridge.mjs config --host codex --peer deepseek --workspace /absolute/path/your-project
```

Call `start_deepseek_task` with a prompt, then poll `get_task`. The default output allowance is 2,048 tokens, adjustable from 1 to 8,192 through `max_output_tokens`. Thinking is disabled for bounded consultations. Only a normally completed text answer is a success; truncated answers, API errors, unexpected tool calls, and output overflow fail the task. The adapter does not execute tools or retry requests automatically.

The fixed endpoint and bearer authentication follow the [official DeepSeek API guide](https://api-docs.deepseek.com/). This provides a second opinion from DeepSeek; the Desktop application remains an independent MCP client.

### Let Codex call Claude Code

```sh
codex mcp add claude_bridge -- node /absolute/path/codex-claude-mcp-bridge/bin/bridge.mjs serve --host codex --workspace /absolute/path/your-project
```

Alternatively, generate a snippet for your Codex `config.toml`:

```sh
node bin/bridge.mjs config --host codex --workspace /absolute/path/your-project
```

The generator prints configuration; it never changes host files. Merge its output into the appropriate Codex configuration. Restart the host or reload its MCP connections, then check `codex mcp list`. The [official Codex MCP guide](https://developers.openai.com/codex/mcp) describes configuration scopes and tool policy.

### Let Claude Code call Codex

```sh
claude mcp add --transport stdio codex_bridge -- node /absolute/path/codex-claude-mcp-bridge/bin/bridge.mjs serve --host claude --workspace /absolute/path/your-project
```

Or generate JSON and merge its `mcpServers` entry into your chosen Claude Code MCP configuration:

```sh
node bin/bridge.mjs config --host claude --workspace /absolute/path/your-project
```

Check `claude mcp list` or `/mcp`. Choose one registration method to avoid duplicate servers. See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp) for project, local, and user scopes.

### Optional Claude Code plugin wrapper

The repository includes `.claude-plugin/plugin.json` and `.mcp.json`. After running `npm ci` in the clone, load it locally:

```sh
claude --plugin-dir /absolute/path/codex-claude-mcp-bridge
```

This wrapper exposes the Codex direction and binds it to `${CLAUDE_PROJECT_DIR}`. It requires Node and Codex on the host's PATH. Keep the installed clone's dependencies available. The plain MCP registration works with both hosts and supports custom executable paths; do not register the wrapper and plain Codex direction together.

## Use

In Codex, ask:

> Use start_claude_task to review src/parser.js for edge cases. Consult mode only. Do not change files. Poll get_task and summarize the findings with evidence.

In Claude Code, ask:

> Use start_codex_task to independently check the test failure in this workspace. Do not change files. Poll get_task and report the cause and a proposed fix.

| Tool | Purpose |
| --- | --- |
| `start_claude_task` | Available in `--host codex` and `--host both` with the default `--peer claude` |
| `start_codex_task` | Available in `--host claude`, `--host desktop`, and `--host both` |
| `start_deepseek_task` | Available in `--host codex --peer deepseek` and `--host both --peer deepseek`; consultation only |
| `get_task` | Fetch status/result; optional `wait_ms` from 0 to 1000 |
| `cancel_task` | Stop a task, wait for process cleanup, retain existing edits |
| `bridge_status` | Show direction, workspace, edit policy, running tasks, and lock path |

CLI task arguments:

```json
{
  "prompt": "Review src/parser.js. Report reproducible issues and their file locations.",
  "cwd": ".",
  "mode": "consult",
  "timeout_seconds": 120,
  "max_turns": 8
}
```

`model` is optional and defaults to the destination CLI's configuration. `cwd` must resolve to a directory within the configured workspace, including after symlink resolution. Timeout is 1–600 seconds. Claude's turn limit is 1–30; Codex ignores `max_turns` and uses the wall-clock timeout. Prompt length is capped at 32,000 characters.

Use the returned `id` as `get_task.task_id`. Poll with `wait_ms: 1000`, with a brief pause between calls for long tasks. Terminal states are `succeeded`, `failed`, `timed_out`, and `cancelled`. A successful task returns `result.text`; Claude results also expose `permission_denials`, which the caller should inspect. CLI failure is a **failed task**, not an MCP protocol failure. Validation, policy, and unknown-ID errors use MCP `isError`.

DeepSeek tasks accept `prompt`, optional `model`, `timeout_seconds`, and `max_output_tokens`. Model selection uses the task argument, then `deepseek.model` in the owner config, then `DEEPSEEK_MODEL`. The key comes from `DEEPSEEK_API_KEY` by default, or the environment variable named by `deepseek.api_key_env`. There is no key or endpoint tool argument. API task results include the final text, model, endpoint, and numeric token usage when provided.

### Edits

Default `consult` uses the Codex read-only sandbox, or Claude's plan mode with only `Read,Glob,Grep`. To permit delegated edits, the server owner must add `--allow-edits` to the launch command, and the caller must explicitly request `mode: "edit"`.

Edit mode selects Codex's `workspace-write` sandbox, or Claude's `acceptEdits` mode with `Read,Glob,Grep,Edit,Write`. Claude's shell tools are deliberately absent; the calling agent can run validation after inspecting changes. The bridge does not pass either CLI's dangerous permission-bypass flags. Codex runs with `approval_policy="never"` so an unattended task cannot wait for interactive escalation; commands outside its sandbox are denied.

The [Codex CLI reference](https://developers.openai.com/codex/cli/reference) and [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) document the flags used by these adapters. Host approval of an MCP tool does not automatically approve operations inside the destination CLI.

## Executable configuration

Native `codex`/`claude` executables on PATH are discovered automatically. Windows npm installations of the known CLI packages are resolved directly, including Claude's native `bin/claude.exe` and older `cli.js` layouts. Arbitrary `.cmd`/`.bat` launchers are rejected instead of being passed through a shell.

For other installations, supply a server-owner JSON file using `--config /absolute/path/bridge.json`:

```json
{
  "codex": { "command": ["C:/tools/codex.exe"] },
  "claude": { "command": ["C:/tools/claude.exe"] }
}
```

For an older JavaScript CLI, use `{"command":["C:/tools/node.exe","C:/path/to/cli.js"]}`. Command arrays are administrator-controlled launch configuration, never tool arguments. Do not point them at untrusted scripts. Prompts are sent over stdin and child processes use `shell: false`.

## Coordination and lifecycle

- The caller owns the acceptance criteria and the final decision. Give the worker a bounded task and owned files; review its evidence before accepting changes.
- Each child inherits `CODEX_CLAUDE_BRIDGE_CHILD=1`. Another copy of this bridge in that child refuses to launch further tasks. Claude children additionally use an empty, strict MCP configuration. This is a cooperative recursion guard, not a security boundary against a process deliberately clearing its environment.
- One task at a time is allowed for each canonical configured workspace across bridge processes, including both directions and consult tasks. Both registrations must use the **same workspace root**. Different roots and external editors/agents are not coordinated by this lock.
- A lock file is created atomically under the OS temp directory in `codex-claude-mcp-bridge/`. Normal completion, failure, cancellation, and connection shutdown release it. The lock remains if the server is forcibly killed. Find its path with `bridge_status`; inspect its PID and confirm that the previous server **and its CLI children** have stopped before manually removing that one stale file. No automatic stale-lock takeover is attempted.
- Tasks and results are held only in memory, limited to the latest 32 tasks. Codex uses ephemeral sessions; Claude disables session persistence. The bridge writes no prompt/result log. Destination CLIs can still maintain their own authentication, diagnostics, caches, hooks, and settings.
- Timeouts, cancellation, and normal MCP disconnection terminate the active process tree (`taskkill /T /F` on Windows; a process group on Unix). Forced server termination and commands that deliberately detach themselves require external process supervision. Cancellation does not roll back edits.
- CLI output is bounded to 1 MiB total; the final answer is bounded to 64 KiB. Exceeding either is a failed task. No result is silently truncated into success.
- DeepSeek tasks use the same workspace lock and task lifecycle. Cancellation aborts the local HTTP request; it cannot guarantee that the provider stops processing or billing. HTTP redirects are rejected. Responses are capped at 1 MiB and final text at 64 KiB. API error bodies are excluded, and the active credential is redacted from returned text. The adapter does not read Desktop settings or credentials.

The workspace check confines the **launch directory**, not every file the downstream CLI can read. Claude permissions are not an OS filesystem sandbox, and Codex may load local settings and hooks. The server inherits the account environment to preserve CLI authentication. Use a workspace, configuration, and executable you trust; the bridge adds no HTTP listener or credential store.

## Verify

```sh
npm run check
npm test
```

The suite uses deterministic CLI fixtures and real MCP stdio clients. It requires no model credentials. A GitHub Actions matrix is configured for Windows, macOS, and Linux with Node 22/24; inspect the actual run before claiming platform coverage.

Optional model-backed smoke tests, after authenticating each destination CLI:

```sh
node scripts/smoke.mjs --provider codex --workspace /absolute/path/your-project
node scripts/smoke.mjs --provider claude --workspace /absolute/path/your-project
node scripts/smoke.mjs --provider deepseek --workspace /absolute/path/your-project
```

The smoke script accepts `--config` too. Current results and limits are recorded in [the v1.1 test report](docs/test-report-v1.1.md). The [v1.0 report](docs/test-report.md) is retained as historical evidence.

MIT licensed. Not affiliated with OpenAI or Anthropic.
