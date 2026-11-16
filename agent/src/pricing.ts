// A live cost estimate while a phase runs. The SDK reports the exact cost only when a phase ends
// (total_cost_usd); until then each assistant message's token usage is priced here. The estimate
// is replaced by the exact figure as soon as the phase reports it, so a stale price only skews
// the running number, never the total. With a Claude subscription nothing is billed per run;
// the figure is what the same usage would cost on the API.

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// USD per million tokens. cacheRead defaults to 10% of input, cache writes to 125%.
interface Price {
  input: number;
  output: number;
  cacheRead?: number;
}

// Longest prefix wins, so "claude-opus-5-5" matches before "claude-opus-5".
const PRICES: [string, Price][] = [
  ["claude-fable-5-2", { input: 8, output: 40, cacheRead: 0.2 }],
  ["claude-mythos-5-2", { input: 8, output: 40, cacheRead: 0.2 }],
  ["claude-fable-5-1", { input: 10, output: 50 }],
  ["claude-fable-5", { input: 10, output: 50 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25 }],
  ["claude-opus-4", { input: 5, output: 25 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1 }],
  ["claude-sonnet-5", { input: 2, output: 10 }],
  ["claude-sonnet-4", { input: 3, output: 15 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5 }],
  ["claude-haiku-4", { input: 1, output: 5 }],
];

export function priceFor(model: string): Price | undefined {
  let best: [string, Price] | undefined;
  for (const entry of PRICES) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(t: Tokens, u: Usage): Tokens {
  return {
    input: t.input + (u.input_tokens ?? 0),
    output: t.output + (u.output_tokens ?? 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens ?? 0),
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens ?? 0),
  };
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

// undefined when the model isn't in the table: show tokens only.
export function estimateCost(model: string, t: Tokens): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  return (t.input * p.input + t.output * p.output + t.cacheRead * cacheRead + t.cacheWrite * p.input * 1.25) / 1e6;
}
