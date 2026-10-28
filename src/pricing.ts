// API prices in US dollars per million tokens, taken from the providers' pages on 26 Oct 2026:
//   https://api-docs.deepseek.com/quick_start/pricing/   https://opencode.ai/docs/go/
// Add or override entries in ~/.perch/config.json under "prices".
// Local models cost nothing. Unknown models show token counts but no cost.

import type { Usage } from "./provider.js";

export interface Price {
  input: number; // cache miss
  cached: number; // cache hit
  output: number;
  peakInput?: number; // DeepSeek charges double at peak times
  peakCached?: number;
  peakOutput?: number;
}

const deepseekFlash: Price = { input: 0.15, cached: 0.003, output: 0.6, peakInput: 0.3, peakCached: 0.006, peakOutput: 1.2 };
const deepseekPro: Price = { input: 0.66, cached: 0.022, output: 1.98, peakInput: 1.32, peakCached: 0.044, peakOutput: 3.96 };

export const PRICES: Record<string, Price> = {
  "deepseek/deepseek-flash": deepseekFlash,
  "deepseek/deepseek-v4-flash": deepseekFlash,
  "deepseek/deepseek-v4-pro": deepseekPro,
  "opencode-go/deepseek-v4.1-flash": deepseekFlash,
  "opencode-go/deepseek-v4-pro": deepseekPro,
  "opencode-go/glm-5.3-flash": { input: 0.15, cached: 0.03, output: 0.5 },
  "opencode-go/glm-5.3": { input: 1.4, cached: 0.26, output: 4.4 },
  "opencode-go/glm-5.2": { input: 1.4, cached: 0.26, output: 4.4 },
  "opencode-go/kimi-k3.1-pro": { input: 2, cached: 0.2, output: 10 },
  "opencode-go/kimi-k3": { input: 3, cached: 0.3, output: 15 },
  "opencode-go/kimi-k2.7-code": { input: 0.95, cached: 0.19, output: 4 },
  "opencode-go/longcat-2.0": { input: 0.3, cached: 0.006, output: 1.2 },
  "opencode-go/step-5-preview": { input: 1, cached: 0.1, output: 2.7 },
  "opencode-go/mimo-v2.6-flash": { input: 0.14, cached: 0.0028, output: 0.28 },
  "opencode-go/mimo-v2.6-pro": { input: 0.435, cached: 0.003625, output: 0.87 },
  "opencode-go/minimax-m3.1-flash": { input: 0.15, cached: 0.015, output: 0.6 },
  "opencode-go/hy4-preview": { input: 0.834, cached: 0.042, output: 2.501 },
  // Anthropic, 6 Oct 2026. Cache writes (1.25x input) are counted at the input price, and
  // Haiku's higher rate above 100K prompt tokens isn't modelled, so long Claude sessions read
  // slightly low.
  "anthropic/claude-opus-5-5": { input: 4, cached: 0.2, output: 20 },
  "anthropic/claude-sonnet-5-5": { input: 2, cached: 0.2, output: 10 },
  "anthropic/claude-haiku-5-5": { input: 0.1, cached: 0.01, output: 0.5 },
  "anthropic/claude-fable-5-1": { input: 10, cached: 0.25, output: 50 },
};

// DeepSeek peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday.
// (Chinese public holidays are off-peak too; they are not modelled here.)
export function isDeepSeekPeak(d = new Date()): boolean {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function priceFor(ref: string, extra?: Record<string, Price>, local = false): Price | undefined {
  if (local) return { input: 0, cached: 0, output: 0 };
  return extra?.[ref] ?? PRICES[ref];
}

// Cost in dollars of one request.
export function costOf(u: Usage, price: Price | undefined, when = new Date()): number | undefined {
  if (!price) return undefined;
  const peak = price.peakInput !== undefined && isDeepSeekPeak(when);
  const input = peak ? price.peakInput! : price.input;
  const cached = peak ? (price.peakCached ?? price.cached) : price.cached;
  const output = peak ? (price.peakOutput ?? price.output) : price.output;
  const miss = Math.max(0, u.input - u.cacheHit);
  return (miss * input + u.cacheHit * cached + u.output * output) / 1_000_000;
}
