# v1.1 validation report

Date: 2026-10-18. Local environment: Windows, Node.js 24.14.0, npm 11.9.0.

This release adds a direct official DeepSeek API consultation adapter and an explicit `desktop` host profile. The original Codex/Claude Code CLI adapters remain available with their previous default behavior.

## Local results

| Check | Result | Evidence / scope |
| --- | --- | --- |
| JavaScript syntax | Passed | `npm run check`, including the new API adapter |
| Full automated suite | 59 passed, 0 failed | [Full output](automated-tests-v1.1.txt) |
| DeepSeek HTTP behavior | Passed against local fixtures | Real loopback HTTP server plus the production fetch/request/response code; no official account usage |
| MCP protocol integration | Passed | New tool discovery, schema validation, asynchronous task results, cancellation, and credential setup errors |
| Desktop host profile | Passed with MCP stdio client and CLI fixture | Actual Desktop UI operation has not been tested |
| Official DeepSeek model response | Not executed | `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` were absent from this process; [setup-check output](deepseek-setup-check.json) |
| Cross-platform v1.1 CI | Pending at publication | Check the repository Actions run for this implementation commit; v1.0 CI results are recorded separately |

## New coverage

- Request target fixed to `https://api.deepseek.com/chat/completions`; bearer authentication, explicit model, prompt-only context, non-streaming response, disabled thinking, and bounded output tokens.
- Actual loopback HTTP requests and JSON response parsing, including Unicode and leading keepalive whitespace. A test-only fetch wrapper routes the production request to localhost; the production CLI has no endpoint override.
- Authentication/rate-limit failures, rejected redirects, malformed JSON, truncated output, empty content, unexpected tool calls, 1 MiB response overflow, and 64 KiB result overflow. No automatic retries or tool execution.
- API error bodies excluded from tool results, active key redaction, and no API key field in MCP input schemas. Tests use a visibly synthetic fixture credential, never a real account key.
- Timeout before response headers and during the response body, explicit cancellation, shutdown, workspace locking, and reuse of a released lock.
- Missing credentials/model rejected before sending a request; custom key environment variable name; no raw key or arbitrary endpoint in the owner configuration schema.
- Recursion marker enforcement, consult-only API behavior even when local edit tasks are allowed, and late cancellation during cleanup preserving an already-completed answer.
- Desktop profile discovery and configuration generation, plus regression coverage for the existing CLI adapters.

## Real-environment limits

The user clarified that the installed application is Claude Desktop using the official DeepSeek API, with no separate gateway software. The bridge therefore supports Codex-to-DeepSeek through the official model API, independently of Desktop. It does not claim to control the Desktop window, attach to an existing chat, replace Desktop's primary model, or inherit Desktop's tools and authentication.

Only credential **availability** was checked in the current process; no Desktop configuration or stored API key was inspected. The optional smoke script confirmed MCP discovery and reported the missing local key. It did not send an unauthenticated request to DeepSeek. The original real Codex smoke result remains [historical evidence](live-codex-smoke.json); it is not re-labelled as an end-to-end Desktop/DeepSeek test.

After making the key and chosen model available locally, the optional test is:

```sh
node scripts/smoke.mjs --provider deepseek --workspace /absolute/path/your-project
```

It sends one short prompt with a 64-token output allowance, checks for `BRIDGE_OK 42`, and can consume account usage. The default adapter allowance for ordinary consultations is 2,048 tokens. Cancellation cannot guarantee that provider-side processing or billing stops.
