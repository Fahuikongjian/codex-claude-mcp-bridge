import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, workspacePath } from './config.mjs';
import { deepseekSettings, requestDeepseek } from './deepseek.mjs';

export const CHILD_MARKER = 'CODEX_CLAUDE_BRIDGE_CHILD';
const MAX_OUTPUT = 1024 * 1024;
const MAX_RESULT = 64 * 1024;

export function buildArgs(provider, input) {
  if (provider === 'codex') {
    return ['exec', '--json', '--ephemeral', '--color', 'never', '--skip-git-repo-check',
      '--sandbox', input.mode === 'edit' ? 'workspace-write' : 'read-only',
      '-c', 'approval_policy="never"', ...(input.model ? ['--model', input.model] : []), '-'];
  }
  return ['--print', '--output-format', 'json', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', input.mode === 'edit' ? 'acceptEdits' : 'plan',
    '--tools', input.mode === 'edit' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
    '--max-turns', String(input.max_turns ?? 8), ...(input.model ? ['--model', input.model] : [])];
}

export function parseResult(provider, stdout) {
  if (provider === 'claude') {
    const data = JSON.parse(stdout);
    if (data.is_error || (data.subtype && data.subtype !== 'success')) {
      const reason = data.subtype && data.subtype !== 'success' ? data.subtype : 'an error';
      throw new Error(`Claude Code reported ${reason}: ${data.result ?? (data.errors ?? []).join('; ')}`);
    }
    if (typeof data.result !== 'string' || !data.result.trim()) throw new Error('Claude Code returned no final result.');
    return { text: data.result, permission_denials: data.permission_denials ?? [] };
  }
  let text;
  let failure;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === 'turn.failed') failure = event.error?.message ?? 'Codex turn failed.';
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
  }
  if (failure) throw new Error(failure);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Codex returned no final agent message.');
  return { text };
}

export function lockPathFor(root, tempRoot = os.tmpdir()) {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  return path.join(tempRoot, 'codex-claude-mcp-bridge', `${createHash('sha256').update(key).digest('hex')}.lock`);
}

async function acquireLock(file, taskId) {
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Workspace is busy or has a stale bridge lock: ${file}. See README recovery instructions.`);
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, taskId, startedAt: new Date().toISOString() })); }
  catch (error) { await handle.close(); await unlink(file); throw error; }
  await handle.close();
  return async () => {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.token !== token) throw new Error('Workspace lock ownership changed; refusing to remove it.');
    await unlink(file);
  };
}

async function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export class TaskManager {
  constructor({ root, host = 'both', peer = 'claude', allowEdits = false, config = {}, tempRoot, env = process.env, fetchImpl = globalThis.fetch }) {
    this.root = root;
    this.host = host;
    this.peer = peer;
    this.fetchImpl = fetchImpl;
    this.allowEdits = allowEdits;
    this.config = config;
    this.env = env;
    this.lockPath = lockPathFor(root, tempRoot);
    this.tasks = new Map();
    this.starting = false;
    this.closing = false;
  }

  providers() { return this.host === 'codex' ? [this.peer] : ['claude', 'desktop'].includes(this.host) ? ['codex'] : ['codex', this.peer]; }

  status() {
    return { host: this.host, peer: this.peer, workspace: this.root, providers: this.providers(), allow_edits: this.allowEdits,
      nested_calls_blocked: Boolean(this.env[CHILD_MARKER]), task_count: this.tasks.size,
      running: [...this.tasks.values()].filter(task => task.state === 'running').map(task => task.id), lock_file: this.lockPath };
  }

  view(task) {
    const { child, controller, done, release, stdout, stderr, stopping, stop_state, finishing, ...visible } = task;
    return structuredClone(visible);
  }

  async start(provider, input) {
    if (this.closing) throw new Error('Bridge is shutting down.');
    if (this.env[CHILD_MARKER]) throw new Error('Nested bridge invocation blocked. Return the result to the calling agent.');
    if (!this.providers().includes(provider)) throw new Error('This direction is disabled for the configured host.');
    if (provider === 'deepseek' && input.mode === 'edit') throw new Error('DeepSeek API tasks support consultation only; no local tools or editing are available.');
    if (input.mode === 'edit' && !this.allowEdits) throw new Error('Edit mode requires the server owner to pass --allow-edits.');
    if (this.starting || [...this.tasks.values()].some(task => task.state === 'running')) throw new Error('Workspace is busy with another task.');
    this.starting = true;
    let release;
    try {
      const cwd = await workspacePath(this.root, input.cwd);
      const command = provider === 'deepseek' ? undefined : await resolveCommand(provider, this.config[provider]?.command, this.env);
      const apiSettings = provider === 'deepseek' ? deepseekSettings(this.config.deepseek, input, this.env) : undefined;
      const id = randomUUID();
      release = await acquireLock(this.lockPath, id);
      if (this.closing) throw new Error('Bridge is shutting down.');
      for (const [key, value] of this.tasks) {
        if (this.tasks.size < 32) break;
        if (value.state !== 'running') this.tasks.delete(key);
      }
      const task = { id, provider, cwd, mode: input.mode ?? 'consult', state: 'running',
        started_at: new Date().toISOString(), timeout_seconds: input.timeout_seconds ?? 120,
        stdout: '', stderr: '', release };
      this.tasks.set(id, task);
      task.done = provider === 'deepseek' ? this.runDeepseek(task, apiSettings, input) : this.run(task, command, input);
      return this.view(task);
    } catch (error) { if (release) await release(); throw error; }
    finally { this.starting = false; }
  }

  async runDeepseek(task, settings, input) {
    let finalState = 'failed';
    task.controller = new AbortController();
    const timer = setTimeout(() => this.stop(task, 'timed_out', 'Task exceeded its timeout.'), task.timeout_seconds * 1000);
    try {
      task.result = await requestDeepseek(settings, input.prompt, task.controller.signal, this.fetchImpl);
      finalState = task.stop_state ?? 'succeeded';
    } catch (error) {
      finalState = task.stop_state ?? 'failed';
      if (!task.stop_state) task.error = error.message;
    } finally {
      task.finishing = true;
      clearTimeout(timer);
      try { await task.release(); } catch (error) { finalState = 'failed'; task.error = `Lock cleanup failed: ${error.message}`; }
      delete task.controller; delete task.release; delete task.stopping; delete task.stop_state;
      delete task.stdout; delete task.stderr;
      task.finished_at = new Date().toISOString();
      task.state = finalState;
      delete task.finishing;
    }
  }

  async run(task, command, input) {
    let timer;
    let finalState = 'failed';
    try {
      task.child = spawn(command[0], [...command.slice(1), ...buildArgs(task.provider, input)], {
        cwd: task.cwd, env: { ...this.env, [CHILD_MARKER]: '1' },
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32',
      });
      const child = task.child;
      let size = 0;
      let processError;
      const collect = (key, chunk) => {
        size += Buffer.byteLength(chunk, 'utf8');
        if (size > MAX_OUTPUT) { this.stop(task, 'failed', 'CLI output exceeded the 1 MiB limit.'); return; }
        task[key] += chunk.toString('utf8');
      };
      // Decode multibyte characters across chunk boundaries correctly.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => collect('stdout', chunk));
      child.stderr.on('data', chunk => collect('stderr', chunk));
      child.on('error', error => { processError = error; });
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') processError = error; });
      timer = setTimeout(() => { this.stop(task, 'timed_out', 'Task exceeded its timeout.'); }, task.timeout_seconds * 1000);
      const result = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const context = 'You are a delegated worker. Complete only the following task. Do not delegate back through the Codex-Claude bridge. Return evidence and unresolved issues to the caller.\n\n';
      child.stdin.end(context + input.prompt);
      const { code, signal } = await result;
      if (task.stopping) await task.stopping;
      task.exit_code = code;
      if (!task.stop_state) {
        if (processError) throw processError;
        if (code !== 0) {
          let detail = task.stderr.slice(-4096).trim();
          if (!detail) {
            try { parseResult(task.provider, task.stdout); }
            catch (error) { if (!(error instanceof SyntaxError)) detail = error.message; }
          }
          throw new Error(`CLI exited with code ${code}${signal ? ` (${signal})` : ''}. ${detail || task.stdout.slice(-4096)}`);
        }
        const parsed = parseResult(task.provider, task.stdout);
        if (Buffer.byteLength(parsed.text, 'utf8') > MAX_RESULT) throw new Error('Final result exceeded the 64 KiB limit.');
        task.result = parsed;
        finalState = 'succeeded';
      } else { finalState = task.stop_state; delete task.stop_state; }
    } catch (error) {
      finalState = task.stop_state ?? 'failed'; delete task.stop_state;
      task.error = String(error.message).slice(0, 8192);
    } finally {
      task.finishing = true;
      clearTimeout(timer);
      try { await task.release(); } catch (error) { finalState = 'failed'; task.error = `Lock cleanup failed: ${error.message}`; }
      delete task.stdout; delete task.stderr; delete task.child; delete task.release; delete task.stopping;
      task.finished_at = new Date().toISOString();
      task.state = finalState;
      delete task.finishing;
    }
  }

  stop(task, state, error) {
    if (task.state !== 'running' || task.stopping || task.finishing) return;
    task.stop_state = state;
    task.error = error;
    if (task.controller) {
      task.controller.abort();
      task.stopping = Promise.resolve();
      return;
    }
    task.stopping = killTree(task.child).catch(failure => { task.error += ` Process cleanup failed: ${failure.message}`; task.child?.kill('SIGKILL'); });
  }

  async get(id, waitMs = 0) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task ID. Tasks belong to the server connection and are not persisted.');
    if (waitMs && task.state === 'running') {
      let timer;
      await Promise.race([task.done, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
    }
    return this.view(task);
  }

  async cancel(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown task ID.');
    this.stop(task, 'cancelled', 'Cancelled by the caller.');
    await task.done;
    return this.view(task);
  }

  async close() {
    this.closing = true;
    // A start operation rechecks closing after it acquires its lock.
    for (const task of this.tasks.values()) this.stop(task, 'cancelled', 'Bridge connection closed.');
    await Promise.all([...this.tasks.values()].map(task => task.done));
  }
}
