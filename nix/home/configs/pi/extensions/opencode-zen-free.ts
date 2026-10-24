// One free OpenCode Zen model as provider `opencode-zen-free`, trimmed from
// @ravshansbox/pi-opencode-zen 0.4.3 to a static model with no catalog fetch.
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createHash, randomBytes } from 'node:crypto';

const IDENTIFIER_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// The Zen gateway serves free models only to requests carrying an OpenCode
// session id (`ses_` + a descending identifier); pi's own UUID is rejected.
function sessionId(timestamp = Date.now(), random: Uint8Array = randomBytes(14)): string {
  const value = ~(BigInt(timestamp) * 0x1000n + 1n);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0'),
  ).join('');
  return `ses_${time}${Array.from(random, (byte) => IDENTIFIER_CHARS[byte % 62]).join('')}`;
}

const OPENCODE_SESSION = sessionId();

function opencodeHeaders(directory = process.cwd()): Record<string, string> {
  return {
    'User-Agent': 'opencode/latest/2.0.30/cli',
    'x-opencode-project': createHash('sha256').update(`directory:${directory}`).digest('hex'),
    'x-opencode-session': OPENCODE_SESSION,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider('opencode-zen-free', {
    name: 'OpenCode Zen (free)',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    apiKey: 'public',
    api: 'openai-completions',
    streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
      openAICompletionsApi().streamSimple(model, context, {
        ...options,
        apiKey: 'public',
        headers: { ...options?.headers, ...opencodeHeaders() },
      }),
    models: [
      {
        id: 'deepseek-v4.1-flash-free',
        name: 'DeepSeek V4.1 Flash Free',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
        // Catalog effort values are low/high/max, plus an on/off toggle.
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
      },
    ],
  });
}
