import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TaskManager, buildArgs, CHILD_MARKER, parseResult } from '../lib/tasks.mjs';
import { configSchema, resolveCommand, workspacePath } from '../lib/config.mjs';

const fixture = fileURLToPath(new URL('fixtures/cli.mjs', import.meta.url));
const entry = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url));
const config = Object.fromEntries(['codex', 'claude'].map(provider => [provider, { command: [process.execPath, fixture, provider] }]));

async function setup(t, options = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'cc-bridge-test-'));
  const root = await realpath(await mkdir(path.join(scratch, 'workspace'), { recursive: true }));
  const manager = new TaskManager({ root, config, tempRoot: scratch, ...options });
  t.after(async () => {
    await manager.close();
    assert.equal(path.dirname(scratch), os.tmpdir());
    assert.ok(path.basename(scratch).startsWith('cc-bridge-test-'));
    await rm(scratch, { recursive: true, force: true });
  });
  return { manager, root, scratch };
}
async function finished(manager, task) {
  for (let i = 0; i < 30; i++) {
    const current = await manager.get(task.id, 1000);
    if (current.state !== 'running') return current;
  }
  throw new Error('Fixture did not finish.');
}
const base = { prompt: 'Return the task result.', cwd: '.', mode: 'consult', timeout_seconds: 10 };

for (const provider of ['codex', 'claude']) {
  test(`${provider}: CLI subprocess receives stdin, directory, marker, and bounded permissions`, async t => {
    const { manager, root } = await setup(t);
    const prompt = 'Literal "quotes"; $(bad) & | < > `bad`\nUnicode: café 🌉';
    const result = await finished(manager, await manager.start(provider, { ...base, prompt, model: 'test-model' }));
    assert.equal(result.state, 'succeeded', result.error);
    const record = JSON.parse(result.result.text);
    assert.ok(record.prompt.endsWith(prompt));
    assert.equal(record.cwd, root);
    assert.equal(record.child_marker, '1');
    assert.ok(record.args.includes('test-model'));
    assert.ok(!record.args.some(arg => arg.includes('bypass') || arg.includes('dangerously')));
    assert.ok(!record.args.includes(prompt));
    if (provider === 'codex') assert.ok(record.args.includes('read-only'));
    else { assert.ok(record.args.includes('Read,Glob,Grep')); assert.ok(record.args.includes('--strict-mcp-config')); }
    await assert.rejects(access(manager.lockPath));
  });
  for (const directive of ['invalid', 'missing', 'error', 'exit', 'oversize', 'large-result']) {
    test(`${provider}: ${directive} does not become a successful result`, async t => {
      const { manager } = await setup(t);
      const result = await finished(manager, await manager.start(provider, { ...base, prompt: `FIXTURE:${directive}` }));
      assert.equal(result.state, 'failed');
      assert.ok(result.error);
      await assert.rejects(access(manager.lockPath));
    });
  }
}

test('direction profiles expose only the opposite provider', async t => {
  const { manager } = await setup(t, { host: 'codex' });
  assert.deepEqual(manager.providers(), ['claude']);
  await assert.rejects(manager.start('codex', base), /direction is disabled/);
});
test('inherited child marker prevents recursive delegation', async t => {
  const { manager } = await setup(t, { env: { ...process.env, [CHILD_MARKER]: '1' } });
  await assert.rejects(manager.start('claude', base), /Nested bridge/);
});
test('edit mode is denied until server owner opts in', async t => {
  const { manager } = await setup(t);
  await assert.rejects(manager.start('codex', { ...base, mode: 'edit' }), /--allow-edits/);
});
test('explicit edit policy uses workspace sandbox / limited edit tools', async t => {
  const { manager } = await setup(t, { allowEdits: true });
  for (const provider of ['codex', 'claude']) {
    const result = await finished(manager, await manager.start(provider, { ...base, mode: 'edit' }));
    assert.equal(result.state, 'succeeded', result.error);
    const record = JSON.parse(result.result.text);
    assert.ok(record.args.includes(provider === 'codex' ? 'workspace-write' : 'Read,Glob,Grep,Edit,Write'));
  }
});
test('parent traversal and external absolute paths are rejected', async t => {
  const { manager, scratch } = await setup(t);
  await assert.rejects(manager.start('codex', { ...base, cwd: '..' }), /inside/);
  await assert.rejects(manager.start('claude', { ...base, cwd: scratch }), /inside/);
});
test('symlink or junction cannot escape workspace', async t => {
  const { manager, root, scratch } = await setup(t);
  const target = await mkdir(path.join(scratch, 'outside'));
  await symlink(target ?? path.join(scratch, 'outside'), path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.start('codex', { ...base, cwd: 'escape' }), /inside/);
});
test('subdirectory inside workspace is accepted', async t => {
  const { manager, root } = await setup(t);
  await mkdir(path.join(root, 'sub'));
  const task = await finished(manager, await manager.start('codex', { ...base, cwd: 'sub' }));
  assert.equal(task.state, 'succeeded');
  assert.equal(task.cwd, path.join(root, 'sub'));
});
test('same-server concurrent starts are rejected without losing first task', async t => {
  const { manager } = await setup(t);
  const first = manager.start('codex', { ...base, prompt: 'FIXTURE:hang' });
  await assert.rejects(manager.start('claude', base), /busy/);
  const task = await first;
  assert.equal((await manager.cancel(task.id)).state, 'cancelled');
});
test('two independent managers cannot run against the same workspace', async t => {
  const { manager, root, scratch } = await setup(t);
  const second = new TaskManager({ root, config, tempRoot: scratch });
  t.after(() => second.close());
  const firstTask = await manager.start('codex', { ...base, prompt: 'FIXTURE:hang' });
  await assert.rejects(second.start('claude', base), /busy|stale/);
  await manager.cancel(firstTask.id);
  assert.equal((await finished(second, await second.start('claude', base))).state, 'succeeded');
});
test('timeout kills the CLI and releases lock', async t => {
  const { manager } = await setup(t);
  const result = await finished(manager, await manager.start('codex', { ...base, prompt: 'FIXTURE:hang', timeout_seconds: 1 }));
  assert.equal(result.state, 'timed_out');
  await assert.rejects(access(manager.lockPath));
});
test('cancel terminates child and descendant processes', async t => {
  const { manager, root } = await setup(t);
  const task = await manager.start('codex', { ...base, prompt: 'FIXTURE:tree' });
  let descendant;
  for (let i = 0; i < 100 && !descendant; i++) {
    try { descendant = Number(await readFile(path.join(root, 'child-pid.txt'), 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(descendant, 'fixture wrote its descendant PID');
  assert.equal((await manager.cancel(task.id)).state, 'cancelled');
  // Unix can briefly retain an exited descendant as a zombie; check the actual process state there.
  if (process.platform === 'win32') assert.throws(() => process.kill(descendant, 0));
  else {
    const status = spawnSync('ps', ['-o', 'stat=', '-p', String(descendant)], { encoding: 'utf8' });
    assert.ok(!status.stdout.trim() || status.stdout.trim().startsWith('Z'), status.stdout);
  }
});
test('shutdown cancels active work and denies new work', async t => {
  const { manager } = await setup(t);
  const task = await manager.start('claude', { ...base, prompt: 'FIXTURE:hang' });
  await manager.close();
  assert.equal((await manager.get(task.id)).state, 'cancelled');
  await assert.rejects(manager.start('claude', base), /shutting down/);
});
test('missing executable becomes a failed task and releases lock', async t => {
  const { manager } = await setup(t, { config: { codex: { command: ['nonexistent-bridge-cli-7613'] } } });
  const result = await finished(manager, await manager.start('codex', base));
  assert.equal(result.state, 'failed');
  await assert.rejects(access(manager.lockPath));
});
test('unknown task IDs fail clearly', async t => {
  const { manager } = await setup(t);
  await assert.rejects(manager.get('unknown'), /Unknown task/);
  await assert.rejects(manager.cancel('unknown'), /Unknown task/);
});
test('strict command configuration rejects unknown keys and shell launchers', async () => {
  assert.throws(() => configSchema.parse({ unknown: true }));
  await assert.rejects(resolveCommand('claude', ['claude.cmd']), /Batch launchers/);
});
test('Codex failure after an earlier message is still a failure', () => {
  const output = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }) + '\n' + JSON.stringify({ type: 'turn.failed', error: { message: 'failed later' } });
  assert.throws(() => parseResult('codex', output), /failed later/);
});
test('Claude permission denials are included for caller inspection', () => {
  const result = parseResult('claude', JSON.stringify({ subtype: 'success', result: 'Partial review', permission_denials: [{ tool_name: 'Read' }] }));
  assert.deepEqual(result.permission_denials, [{ tool_name: 'Read' }]);
});
test('Claude authentication error is not described as a success', () => {
  assert.throws(() => parseResult('claude', JSON.stringify({ subtype: 'success', is_error: true, result: 'Not logged in' })), /reported an error: Not logged in/);
});
test('terminal status is visible only after lock cleanup finishes', async t => {
  const { manager } = await setup(t);
  const task = await manager.start('codex', base);
  const internal = manager.tasks.get(task.id);
  const release = internal.release;
  internal.release = async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await manager.get(task.id)).state, 'running');
    await release();
  };
  const result = await finished(manager, task);
  assert.equal(result.state, 'succeeded');
  assert.ok(result.finished_at);
  await assert.rejects(access(manager.lockPath));
});
test('config generator emits valid JSON and TOML without writing host files', async t => {
  const { root } = await setup(t);
  const result = spawnSync(process.execPath, [entry, 'config', '--host', 'claude', '--workspace', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(result.stdout);
  assert.equal(generated.mcpServers.codex_bridge.command, process.execPath);
  assert.ok(generated.mcpServers.codex_bridge.args.includes(root));
  const codex = spawnSync(process.execPath, [entry, 'config', '--host', 'codex', '--workspace', root], { encoding: 'utf8' });
  assert.equal(codex.status, 0);
  assert.ok(codex.stdout.startsWith('[mcp_servers.claude_bridge]'));
});

for (const host of ['codex', 'claude', 'desktop', 'both']) {
  test(`MCP stdio handshake, discovery, calls and schema validation (${host})`, async t => {
    const { root, scratch } = await setup(t);
    const { writeFile } = await import('node:fs/promises');
    const configPath = path.join(scratch, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [entry, 'serve', '--host', host, '--workspace', root, '--config', configPath], stderr: 'pipe' });
    const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(transport);
    const list = await client.listTools();
    const names = list.tools.map(tool => tool.name);
    assert.ok(names.includes('get_task') && names.includes('cancel_task') && names.includes('bridge_status'));
    assert.equal(names.includes('start_codex_task'), host !== 'codex');
    assert.equal(names.includes('start_claude_task'), !['claude', 'desktop'].includes(host));
    const provider = ['claude', 'desktop'].includes(host) ? 'codex' : 'claude';
    const invalid = await client.callTool({ name: `start_${provider}_task`, arguments: { prompt: 'x', timeout_seconds: 0 } });
    assert.equal(invalid.isError, true);
    const start = await client.callTool({ name: `start_${provider}_task`, arguments: { prompt: 'MCP round-trip' } });
    assert.ok(!start.isError, JSON.stringify(start));
    let result;
    for (let i = 0; i < 20; i++) {
      const call = await client.callTool({ name: 'get_task', arguments: { task_id: start.structuredContent.id, wait_ms: 1000 } });
      result = call.structuredContent;
      if (result.state !== 'running') break;
    }
    assert.equal(result.state, 'succeeded', result.error);
    assert.ok(JSON.parse(result.result.text).prompt.includes('MCP round-trip'));
    const status = await client.callTool({ name: 'bridge_status', arguments: {} });
    assert.equal(status.structuredContent.host, host);
  });
}
