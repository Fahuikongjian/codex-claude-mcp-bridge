import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TaskManager } from './tasks.mjs';

const taskInput = {
  prompt: z.string().trim().min(1).max(32000).describe('A bounded task with acceptance criteria. Passed through stdin, never through a shell.'),
  cwd: z.string().min(1).max(4096).default('.').describe('Directory inside the configured workspace; symlinks are resolved.'),
  mode: z.enum(['consult', 'edit']).default('consult'),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/).optional(),
  timeout_seconds: z.number().int().min(1).max(600).default(120),
  max_turns: z.number().int().min(1).max(30).default(8).describe('Claude Code turn limit; ignored by Codex.'),
};

export function createServer(options) {
  const tasks = new TaskManager(options);
  const server = new McpServer({ name: 'codex-claude-mcp-bridge', version: '1.0.0' }, {
    instructions: 'Start a task on the other CLI, then poll get_task with wait_ms=1000 until terminal. Keep file ownership with the caller. Do not recursively delegate. Tools use the separately authenticated local CLIs.',
  });
  const handler = fn => async args => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  for (const provider of tasks.providers()) {
    server.registerTool(`start_${provider}_task`, {
      description: `Start a fresh ${provider === 'codex' ? 'Codex' : 'Claude Code'} CLI task and return its ID immediately. Consult is the default. Poll get_task for results; use cancel_task to stop. No existing GUI conversation is reused.`,
      inputSchema: taskInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, handler(args => tasks.start(provider, args)));
  }
  server.registerTool('get_task', {
    description: 'Poll one task. Terminal states: succeeded, failed, timed_out, cancelled. Results expire when the bridge stops or after 32 newer tasks.',
    inputSchema: { task_id: z.string().uuid(), wait_ms: z.number().int().min(0).max(1000).default(0) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, handler(args => tasks.get(args.task_id, args.wait_ms)));
  server.registerTool('cancel_task', {
    description: 'Terminate a running CLI process tree and wait for cleanup. Edits already made are retained.',
    inputSchema: { task_id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, handler(args => tasks.cancel(args.task_id)));
  server.registerTool('bridge_status', {
    description: 'Show bridge direction, workspace, edit policy, task IDs, and workspace lock path. Does not call either model.',
    inputSchema: {}, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, handler(() => tasks.status()));
  return { server, tasks };
}

export async function serve(options) {
  const { server, tasks } = createServer(options);
  const transport = new StdioServerTransport();
  let closing;
  const close = () => closing ??= tasks.close().then(() => server.close());
  server.server.onclose = () => { void close(); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await server.connect(transport);
  return { server, tasks, close };
}
