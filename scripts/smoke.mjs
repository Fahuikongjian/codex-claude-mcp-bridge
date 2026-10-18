// Optional live test. Invokes the authenticated local CLI and can consume account usage.
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: {
  provider: { type: 'string' }, workspace: { type: 'string' }, config: { type: 'string' },
} });
if (!['codex', 'claude'].includes(values.provider) || !values.workspace || !path.isAbsolute(values.workspace)) {
  throw new Error('Usage: node scripts/smoke.mjs --provider codex|claude --workspace ABSOLUTE_PATH [--config FILE]');
}
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url)), 'serve', '--host', values.provider === 'codex' ? 'claude' : 'codex',
    '--workspace', values.workspace, ...(values.config ? ['--config', values.config] : [])], stderr: 'pipe' });
let serverErrors = '';
transport.stderr?.on('data', chunk => { serverErrors += chunk; });
const client = new Client({ name: 'bridge-live-smoke', version: '1.0.0' });
const report = { provider: values.provider, started_at: new Date().toISOString(), protocol: 'MCP stdio', checks: {} };
try {
  await client.connect(transport);
  const list = await client.listTools();
  report.checks.tool_discovery = list.tools.some(tool => tool.name === `start_${values.provider}_task`);
  const start = await client.callTool({ name: `start_${values.provider}_task`, arguments: {
    prompt: 'Do not use any tools or access files. Compute 17 + 25. Respond with exactly BRIDGE_OK 42.', timeout_seconds: 90,
  } });
  if (start.isError) throw new Error(start.content[0].text);
  let result;
  for (let i = 0; i < 120; i++) {
    const response = await client.callTool({ name: 'get_task', arguments: { task_id: start.structuredContent.id, wait_ms: 1000 } });
    if (response.isError) throw new Error(response.content[0].text);
    result = response.structuredContent;
    if (result.state !== 'running') break;
  }
  report.task = result;
  report.checks.model_reply = result.state === 'succeeded' && result.result.text.trim() === 'BRIDGE_OK 42';
  if (!report.checks.model_reply) process.exitCode = 1;
} catch (error) { report.error = error.message; if (serverErrors) report.server_errors = serverErrors; process.exitCode = 1; }
finally {
  await client.close();
  report.finished_at = new Date().toISOString();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
