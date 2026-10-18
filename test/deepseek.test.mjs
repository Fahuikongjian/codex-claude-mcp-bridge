import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../lib/server.mjs';
import { TaskManager, CHILD_MARKER } from '../lib/tasks.mjs';
import { configSchema } from '../lib/config.mjs';
import { deepseekSettings, DEEPSEEK_ENDPOINT } from '../lib/deepseek.mjs';

const FAKE_KEY = 'fixture-only-not-a-real-api-key-8a51';
const env = { DEEPSEEK_API_KEY: FAKE_KEY, DEEPSEEK_MODEL: 'fixture-deepseek' };
const entry = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url));
const base = { prompt: 'Compute 17 + 25.', timeout_seconds: 5 };

async function fixture(t, options = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'cc-bridge-api-test-'));
  await mkdir(path.join(scratch, 'workspace'));
  const root = await realpath(path.join(scratch, 'workspace'));
  const requests = [];
  const httpServer = createHttpServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      const prompt = data.messages[1].content;
      requests.push({ headers: req.headers, data });
      if (prompt === 'hang-headers') return;
      if (prompt === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end(); return; }
      if (prompt === 'unauthorized') { res.writeHead(401); res.end(FAKE_KEY); return; }
      if (prompt === 'rate-limit') { res.writeHead(429); res.end(FAKE_KEY); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (prompt === 'hang-body') { res.write(' '); return; }
      if (prompt === 'oversize') { res.end(' '.repeat(1024 * 1024 + 1)); return; }
      if (prompt === 'invalid') { res.end(FAKE_KEY); return; }
      const choice = { finish_reason: prompt === 'truncated' ? 'length' : 'stop',
        message: { content: prompt === 'empty' ? '' : prompt === 'large-result' ? 'a'.repeat(65537) : prompt === 'echo-key' ? FAKE_KEY : 'BRIDGE_OK 42 — café 🌉' } };
      if (prompt === 'unexpected-tools') choice.message.tool_calls = [{ id: 'fixture-tool' }];
      res.end('\n  ' + JSON.stringify({ model: 'fixture-deepseek', choices: [choice], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }, reasoning_content: 'must not be returned' }));
    } catch { res.destroy(); }
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const fetchImpl = (url, init) => {
    assert.equal(url, DEEPSEEK_ENDPOINT);
    return fetch(`http://127.0.0.1:${httpServer.address().port}/chat/completions`, init);
  };
  const settings = { root, host: 'codex', peer: 'deepseek', env, tempRoot: scratch, fetchImpl, ...options };
  const manager = new TaskManager(settings);
  t.after(async () => {
    await manager.close();
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
    assert.equal(path.dirname(scratch), os.tmpdir());
    assert.ok(path.basename(scratch).startsWith('cc-bridge-api-test-'));
    await rm(scratch, { recursive: true, force: true });
  });
  return { manager, root, scratch, requests, settings };
}

async function finish(manager, task) {
  for (let i = 0; i < 15; i++) {
    const result = await manager.get(task.id, 1000);
    if (result.state !== 'running') return result;
  }
  throw new Error('API fixture did not finish.');
}

test('DeepSeek uses the official endpoint, bearer authentication, chosen model, and supplied prompt only', async t => {
  const { manager, requests } = await fixture(t);
  const result = await finish(manager, await manager.start('deepseek', { ...base, max_output_tokens: 123, model: 'custom-model' }));
  assert.equal(result.state, 'succeeded', result.error);
  assert.equal(result.result.text, 'BRIDGE_OK 42 — café 🌉');
  assert.deepEqual(result.result.usage, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
  const [{ headers, data }] = requests;
  assert.equal(headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(data.model, 'custom-model');
  assert.equal(data.messages[1].content, base.prompt);
  assert.equal(data.max_tokens, 123);
  assert.equal(data.stream, false);
  assert.deepEqual(data.thinking, { type: 'disabled' });
  assert.equal(data.tools, undefined);
  assert.equal(data.messages.length, 2);
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
  await assert.rejects(access(manager.lockPath));
});

for (const prompt of ['unauthorized', 'rate-limit', 'invalid', 'truncated', 'empty', 'large-result', 'oversize', 'unexpected-tools', 'redirect']) {
  test(`DeepSeek ${prompt} is a failure with no credential disclosure or retry`, async t => {
    const { manager, requests } = await fixture(t);
    const result = await finish(manager, await manager.start('deepseek', { ...base, prompt }));
    assert.equal(result.state, 'failed');
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
    assert.equal(requests.length, 1);
    await assert.rejects(access(manager.lockPath));
  });
}

test('DeepSeek output cannot echo the active API credential', async t => {
  const { manager } = await fixture(t);
  const result = await finish(manager, await manager.start('deepseek', { ...base, prompt: 'echo-key' }));
  assert.equal(result.state, 'succeeded');
  assert.equal(result.result.text, '[REDACTED]');
});

for (const prompt of ['hang-headers', 'hang-body']) {
  test(`DeepSeek timeout aborts ${prompt} and releases workspace`, async t => {
    const { manager } = await fixture(t);
    const result = await finish(manager, await manager.start('deepseek', { ...base, prompt, timeout_seconds: 1 }));
    assert.equal(result.state, 'timed_out');
    await assert.rejects(access(manager.lockPath));
  });
}

test('DeepSeek cancellation and shutdown abort HTTP work before returning', async t => {
  const { manager } = await fixture(t);
  const task = await manager.start('deepseek', { ...base, prompt: 'hang-body' });
  assert.equal((await manager.cancel(task.id)).state, 'cancelled');
  const second = await manager.start('deepseek', { ...base, prompt: 'hang-headers' });
  await manager.close();
  assert.equal((await manager.get(second.id)).state, 'cancelled');
  await assert.rejects(access(manager.lockPath));
});

test('DeepSeek consult tasks obey the shared lock and reject edit mode', async t => {
  const { manager, settings } = await fixture(t, { allowEdits: true });
  await assert.rejects(manager.start('deepseek', { ...base, mode: 'edit' }), /consultation only/);
  const second = new TaskManager(settings);
  t.after(() => second.close());
  const task = await manager.start('deepseek', { ...base, prompt: 'hang-headers' });
  await assert.rejects(second.start('deepseek', base), /busy|stale/);
  await manager.cancel(task.id);
  assert.equal((await finish(second, await second.start('deepseek', base))).state, 'succeeded');
});

test('DeepSeek requires environment credentials and explicit model before sending anything', async t => {
  const { manager, requests } = await fixture(t, { env: {} });
  await assert.rejects(manager.start('deepseek', base), /DEEPSEEK_API_KEY/);
  await assert.rejects(access(manager.lockPath));
  assert.equal(requests.length, 0);
  assert.throws(() => deepseekSettings({}, {}, { DEEPSEEK_API_KEY: FAKE_KEY }), /DEEPSEEK_MODEL/);
  assert.throws(() => deepseekSettings({}, { max_output_tokens: 0 }, env), /max_output_tokens/);
  assert.throws(() => deepseekSettings({}, { model: 'bad\nmodel' }, env), /model ID/);
  assert.equal(deepseekSettings({ api_key_env: 'CUSTOM_KEY', model: 'config-model' }, {}, { CUSTOM_KEY: FAKE_KEY }).model, 'config-model');
  assert.throws(() => configSchema.parse({ deepseek: { api_key: FAKE_KEY } }));
  assert.throws(() => configSchema.parse({ deepseek: { base_url: 'https://example.invalid' } }));
});

test('DeepSeek cannot delegate recursively from a bridge child', async t => {
  const { manager } = await fixture(t, { env: { ...env, [CHILD_MARKER]: '1' } });
  await assert.rejects(manager.start('deepseek', base), /Nested bridge/);
});

test('late cancellation preserves an already completed API answer while cleanup finishes', async t => {
  const { manager } = await fixture(t);
  const task = await manager.start('deepseek', base);
  const internal = manager.tasks.get(task.id);
  const release = internal.release;
  let entered;
  const inCleanup = new Promise(resolve => { entered = resolve; });
  let proceed;
  const gate = new Promise(resolve => { proceed = resolve; });
  internal.release = async () => { entered(); await gate; await release(); };
  await inCleanup;
  const cancel = manager.cancel(task.id);
  proceed();
  const result = await cancel;
  assert.equal(result.state, 'succeeded');
  assert.equal(result.error, undefined);
});

test('DeepSeek MCP discovery, validation, request, result and cancellation use the shared task API', async t => {
  const { settings } = await fixture(t);
  const { server, tasks } = createServer(settings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'deepseek-mcp-test', version: '1.0.0' });
  t.after(async () => { await tasks.close(); await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'start_deepseek_task'));
  assert.ok(!tools.some(tool => tool.name === 'start_claude_task'));
  assert.ok(!tools.find(tool => tool.name === 'start_deepseek_task').inputSchema.properties.api_key);
  const invalid = await client.callTool({ name: 'start_deepseek_task', arguments: { prompt: 'x', max_output_tokens: 0 } });
  assert.equal(invalid.isError, true);
  const start = await client.callTool({ name: 'start_deepseek_task', arguments: base });
  const result = await tasks.get(start.structuredContent.id, 1000);
  assert.equal(result.state, 'succeeded', result.error);
  const hanging = await client.callTool({ name: 'start_deepseek_task', arguments: { ...base, prompt: 'hang-body' } });
  const cancelled = await client.callTool({ name: 'cancel_task', arguments: { task_id: hanging.structuredContent.id } });
  assert.equal(cancelled.structuredContent.state, 'cancelled');
});

test('DeepSeek stdio discovery works before API credentials are configured', async t => {
  const { root } = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [entry, 'serve', '--host', 'codex', '--peer', 'deepseek', '--workspace', root],
    env: { ...process.env, DEEPSEEK_API_KEY: '', DEEPSEEK_MODEL: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'deepseek-stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'start_deepseek_task'));
  const result = await client.callTool({ name: 'start_deepseek_task', arguments: base });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DEEPSEEK_API_KEY/);
});

test('Desktop profile exposes only Codex and generated configs preserve the selected peer', async t => {
  const { root } = await fixture(t);
  const desktop = new TaskManager({ root, host: 'desktop' });
  assert.deepEqual(desktop.providers(), ['codex']);
  const generated = spawnSync(process.execPath, [entry, 'config', '--host', 'desktop', '--workspace', root], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  assert.ok(JSON.parse(generated.stdout).mcpServers.codex_bridge.args.includes('desktop'));
  const codex = spawnSync(process.execPath, [entry, 'config', '--host', 'codex', '--peer', 'deepseek', '--workspace', root], { encoding: 'utf8' });
  assert.equal(codex.status, 0, codex.stderr);
  assert.ok(codex.stdout.startsWith('[mcp_servers.deepseek_bridge]'));
  assert.ok(codex.stdout.includes('"--peer","deepseek"'));
});
