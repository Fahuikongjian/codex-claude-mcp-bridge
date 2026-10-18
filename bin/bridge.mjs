#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { serve } from '../lib/server.mjs';

try {
  const { values, positionals } = parseArgs({ options: {
    host: { type: 'string', default: 'both' }, workspace: { type: 'string' },
    peer: { type: 'string', default: 'claude' },
    config: { type: 'string' }, 'allow-edits': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  }, allowPositionals: true });
  const action = positionals[0] ?? 'serve';
  if (values.help) {
    process.stdout.write('Usage: codex-claude-bridge <serve|config> --workspace PATH [--host codex|claude|desktop|both] [--peer claude|deepseek] [--config FILE] [--allow-edits]\n\nconfig prints host configuration without changing your files. serve uses MCP stdio.\n');
  } else {
    if (positionals.length > 1 || !['serve', 'config'].includes(action)) throw new Error('Unknown command. Use --help.');
    if (!['codex', 'claude', 'desktop', 'both'].includes(values.host)) throw new Error('--host must be codex, claude, desktop, or both.');
    if (!['claude', 'deepseek'].includes(values.peer)) throw new Error('--peer must be claude or deepseek.');
    if (!values.workspace || !path.isAbsolute(values.workspace)) throw new Error('--workspace must be an absolute directory path.');
    const root = await realpath(values.workspace);
    if (!(await stat(root)).isDirectory()) throw new Error('--workspace must be a directory.');
    const config = await loadConfig(values.config);
    if (action === 'config') {
      if (values.host === 'both') throw new Error('config requires --host codex, claude, or desktop.');
      const args = [fileURLToPath(import.meta.url), 'serve', '--host', values.host, '--peer', values.peer, '--workspace', root,
        ...(values.config ? ['--config', path.resolve(values.config)] : []), ...(values['allow-edits'] ? ['--allow-edits'] : [])];
      if (values.host === 'claude' || values.host === 'desktop') {
        process.stdout.write(JSON.stringify({ mcpServers: { codex_bridge: { command: process.execPath, args } } }, null, 2) + '\n');
      } else {
        process.stdout.write(`[mcp_servers.${values.peer === 'deepseek' ? 'deepseek_bridge' : 'claude_bridge'}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 30\n`);
      }
    } else { await serve({ root, host: values.host, peer: values.peer, config, allowEdits: values['allow-edits'] }); }
  }
} catch (error) { process.stderr.write(`codex-claude-bridge: ${error.message}\n`); process.exitCode = 1; }
