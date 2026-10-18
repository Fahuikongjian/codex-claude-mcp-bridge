# Validation report

Date: 2026-10-18. Environment: Windows, Node.js 24.14.0, npm 11.9.0.

## Results and scope

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| JavaScript syntax | Passed | `npm run check` |
| Automated suite | 37 passed, 0 failed | [Full output](automated-tests.txt); deterministic CLI fixtures with real subprocesses and MCP clients |
| Real MCP → Codex CLI → model | Passed | Codex `0.163.0-alpha.10.2`, authenticated with ChatGPT; [recorded response](live-codex-smoke.json) |
| Real MCP → Claude Code CLI | Authentication failure correctly returned | Claude Code `2.1.100`; [recorded failure](live-claude-smoke.json) |
| Claude Code native plugin manifest | Passed | `claude plugin validate` on `2.1.100`; [CLI validation output](plugin-validation.txt) |
| Dependency audit | Passed | No vulnerabilities reported by npm on the locked dependency set |
| Windows / macOS / Linux, Node 22 and 24 | Passed on GitHub Actions | All six jobs succeeded; [run #1](https://github.com/Fahuikongjian/codex-claude-mcp-bridge/actions/runs/39116451707), [job evidence](ci-results.json) |

GitHub Actions tested source commit `2ab574dc42f7623141e09989b0ee56f877d0f5dc`. Every matrix job completed dependency installation, syntax validation, and the automated suite. This evidence was added afterward in a documentation-only commit.

The model-backed Codex task used a real MCP stdio client, discovered `start_codex_task`, launched the actual installed Codex executable, and polled `get_task`. Its request was: compute 17 + 25 without using tools or reading files and return `BRIDGE_OK 42`. The exact response matched.

The Claude Code direction completed MCP discovery and launched a real CLI. The CLI reported `Not logged in`, and the bridge returned a terminal `failed` task with exit code 1. No Claude model reply or fully authenticated two-host round trip is claimed. An isolated compatible CLI installation was used; the machine did not have an existing `claude` command on PATH. An attempt to stage the then-current native npm package (`2.1.302`) did not complete, so that release was not executed. Its executable layout is supported by the resolver, but remains unverified with the real binary here.

To complete model-backed coverage after authenticating Claude Code, run:

```sh
node scripts/smoke.mjs --provider claude --workspace /absolute/path/your-project
```

This report does not claim successful live UI-host tool selection, shared existing chat sessions, or live editing of a user project. The MCP client in the smoke test replaces the calling host; the destination CLI and Codex model are real.

## Automated coverage

- Both direction profiles and the combined profile: real MCP stdio initialization, discovery, calls, schema rejection, polling, and structured results.
- Actual fixture subprocesses for both CLI adapters: arguments, stdin-only prompt delivery, Unicode and shell metacharacters, working directory, and inherited recursion marker.
- One-hop delegation guard, explicit edit opt-in, bounded Codex sandbox and Claude tool configuration, and absence of dangerous bypass flags.
- Parent traversal, absolute path escape, symlink/junction escape, and valid subdirectories.
- Concurrent starts within one server and file locking between independent managers using the same workspace; lock reuse after cancellation.
- Timeouts, explicit cancellation, descendant process termination, shutdown, missing executables, and unknown task IDs.
- Nonzero CLI exit, invalid JSON, missing final messages, reported agent failures, permission-denial propagation, 1 MiB output limit, and 64 KiB final-result limit.
- Correct ordering of terminal status after lock cleanup, so a completed task can be followed immediately by another.
- Strict command configuration, rejection of Windows batch launchers, and configuration generation without writing host settings.

An implementation review found a race where terminal status could appear before the workspace lock had been removed. It was corrected before publication and covered by a regression test. Actual Claude authentication failure also exposed confusing `subtype: success` plus `is_error: true` output; error reporting now treats this as an error and extracts the message instead of returning the full CLI usage JSON.

## Reproduction

```sh
npm ci --ignore-scripts
npm run check
npm test
node scripts/smoke.mjs --provider codex --workspace /absolute/path/your-project
node scripts/smoke.mjs --provider claude --workspace /absolute/path/your-project
```

The automated suite needs no credentials. Live smoke tests require destination CLI authentication and can consume account usage. They launch fresh consult tasks. The repository includes source, locked dependencies, fixtures, scripts, and recorded local results; installed CLI binaries and account credentials are excluded.
