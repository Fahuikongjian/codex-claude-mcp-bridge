export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;

export function deepseekSettings(config = {}, input = {}, env = process.env) {
  const keyEnv = config.api_key_env ?? 'DEEPSEEK_API_KEY';
  const secret = env[keyEnv]?.trim();
  if (!secret) throw new Error(`Set ${keyEnv} in the bridge server environment to call DeepSeek. Do not send the key in a tool argument.`);
  if (/\s/.test(secret)) throw new Error('DeepSeek API key must not contain whitespace.');
  const model = input.model ?? config.model ?? env.DEEPSEEK_MODEL;
  if (!model || !MODEL_ID.test(model)) throw new Error('Set DEEPSEEK_MODEL, deepseek.model in --config, or the task model to your official DeepSeek model ID.');
  const maxTokens = input.max_output_tokens ?? 2048;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error('max_output_tokens must be an integer between 1 and 8192.');
  return { secret, model, maxTokens };
}

export function redactSecret(text, secret) {
  return String(text).split(secret).join('[REDACTED]');
}

export async function requestDeepseek(settings, prompt, signal, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(DEEPSEEK_ENDPOINT, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.secret}` },
      body: JSON.stringify({ model: settings.model, stream: false, thinking: { type: 'disabled' },
        max_tokens: settings.maxTokens,
        messages: [
          { role: 'system', content: 'You are a delegated consultant. Answer only the supplied task. You have no access to local files, tools, or desktop conversations. Return your answer and any uncertainty to the caller.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch { throw new Error('DeepSeek request failed or was aborted. Check network access and task status.'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    // Error bodies can echo credentials or prompts; never publish them in MCP results.
    throw new Error(`DeepSeek HTTP ${response.status}. Check the API key, model access, balance, and rate limits. No automatic retry was attempted.`);
  }
  const chunks = [];
  let bytes = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('DeepSeek response exceeded the 1 MiB limit.');
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (error) {
    if (bytes > MAX_RESPONSE_BYTES) throw error;
    throw new Error('DeepSeek response was interrupted or aborted. Check task status.');
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('DeepSeek returned invalid JSON.'); }
  const choice = data.choices?.[0];
  if (choice?.finish_reason !== 'stop') throw new Error('DeepSeek did not finish normally (output limit, filtering, or unexpected tool request). The answer is not treated as complete.');
  if (choice.message?.tool_calls?.length) throw new Error('DeepSeek returned unexpected tool calls. No tools were executed.');
  const content = choice.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek returned no final text answer.');
  if (Buffer.byteLength(content, 'utf8') > MAX_RESULT_BYTES) throw new Error('DeepSeek final result exceeded the 64 KiB limit.');
  const result = { text: redactSecret(content, settings.secret), endpoint: DEEPSEEK_ENDPOINT,
    model: redactSecret(typeof data.model === 'string' ? data.model.slice(0, 200) : settings.model, settings.secret) };
  const usage = {};
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(data.usage?.[field]) && data.usage[field] >= 0) usage[field] = data.usage[field];
  }
  if (Object.keys(usage).length) result.usage = usage;
  return result;
}
