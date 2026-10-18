import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const [provider, ...args] = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes('FIXTURE:hang')) {
  setInterval(() => {}, 1000);
} else if (prompt.includes('FIXTURE:tree')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(path.join(process.cwd(), 'child-pid.txt'), String(child.pid));
  setInterval(() => {}, 1000);
} else if (prompt.includes('FIXTURE:oversize')) {
  process.stdout.write('x'.repeat(1024 * 1024 + 10));
} else if (prompt.includes('FIXTURE:exit')) {
  process.stderr.write('fixture authentication failed');
  process.exitCode = 7;
} else if (prompt.includes('FIXTURE:invalid')) {
  process.stdout.write('invalid JSON');
} else if (prompt.includes('FIXTURE:missing')) {
  process.stdout.write(provider === 'codex' ? '{"type":"turn.completed"}\n' : '{}');
} else if (prompt.includes('FIXTURE:error')) {
  process.stdout.write(provider === 'codex' ? '{"type":"turn.failed","error":{"message":"fixture turn failure"}}\n' : '{"is_error":true,"subtype":"error_max_turns","result":"fixture turn failure"}');
} else {
  const text = prompt.includes('FIXTURE:large-result') ? 'a'.repeat(65537)
    : JSON.stringify({ provider, args, prompt, cwd: process.cwd(), child_marker: process.env.CODEX_CLAUDE_BRIDGE_CHILD });
  if (provider === 'codex') process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
  else process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, permission_denials: [] }));
}
