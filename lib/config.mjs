import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const command = z.array(z.string().min(1).max(8192)).min(1).max(8);
export const configSchema = z.object({
  codex: z.object({ command }).strict().optional(),
  claude: z.object({ command }).strict().optional(),
  deepseek: z.object({
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/).optional(),
    api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional(),
  }).strict().optional(),
}).strict();

export async function loadConfig(file) {
  return file ? configSchema.parse(JSON.parse(await readFile(file, 'utf8'))) : {};
}

export async function workspacePath(root, requested = '.') {
  const target = await realpath(path.resolve(root, requested));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Working directory must resolve inside the configured workspace.');
  }
  if (!(await stat(target)).isDirectory()) throw new Error('Working directory must be a directory.');
  return target;
}

async function exists(file) {
  try { await access(file, constants.F_OK); return (await stat(file)).isFile(); } catch { return false; }
}

// Never execute a .cmd/.bat shim through a shell. Resolve only the known npm package layouts.
export async function resolveCommand(provider, configured, env = process.env) {
  if (configured) {
    if (/\.(cmd|bat)$/i.test(configured[0])) {
      throw new Error('Batch launchers are unsupported. Use a native executable or [node, absolute-cli.js].');
    }
    return configured;
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  const packageFiles = provider === 'codex' ? ['@openai/codex/bin/codex.js']
    : ['@anthropic-ai/claude-code/bin/claude.exe', '@anthropic-ai/claude-code/cli.js'];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const file = path.join(dir, provider + ext);
      if (await exists(file)) return [file];
    }
    if (process.platform === 'win32') {
      for (const packageFile of packageFiles) {
        const file = path.join(dir, 'node_modules', packageFile);
        if (await exists(file)) return file.endsWith('.exe') ? [file] : [process.execPath, file];
      }
    }
  }
  throw new Error(`${provider} CLI was not found. Install and authenticate it, or set its command array in --config.`);
}
