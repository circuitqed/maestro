/**
 * Token prices, in one place, with their provenance.
 *
 * Every dollar figure Maestro shows is DERIVED: no transcript carries a cost field
 * (checked -- Claude Code writes `message.usage` and nothing else, Codex writes
 * `total_token_usage`), so cost is always tokens x a table, and the table is the
 * only thing that can make it wrong. Hence: one table, a date on it, a source URL,
 * and an override path that does not need a deploy.
 *
 * Three rules that matter more than the numbers:
 *
 *   1. An unknown model costs `null`, never an estimate. A made-up price is worse
 *      than a blank, because it looks like an answer. While writing this file
 *      Opus 5.5's $4/$0.20 got used for Opus 5, whose real rates are $5/$0.50 --
 *      2.5x on cache reads, the largest line item in a long session.
 *   2. Some models price by prompt size (gpt-6-astra, Haiku 5.5). Session token
 *      totals cannot say which tier each request hit, so those report a RANGE:
 *      `usd` at the cheap tier, `usdMax` at the dear one. A bracket is honest; a
 *      point estimate picked from a coin flip is not.
 *   3. On a subscription, these prices are NOT a bill. Max plans are flat-rate; the
 *      dollars are what the same traffic would have cost on the API. Useful for
 *      comparing agents and spotting waste, meaningless as an invoice. Callers get
 *      `basis: 'api-equivalent'` so they can say so out loud.
 *
 * Prices are USD per million tokens, verified against the vendors' published tables.
 */
import { getSetting } from './db.js';

export const PRICING_VERIFIED_ON = '2026-10-24';
export const PRICING_SOURCES = {
  anthropic: 'https://platform.claude.com/docs/en/docs/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
};

// in = base input, out = output, cw5 = 5-minute cache write, cw1h = 1-hour cache
// write, read = cache hit/refresh. Each column is explicit rather than a ratio off
// `in`, because the ratios are not constant across the range.
// `long` holds the dear tier for models priced by prompt size (see rule 2).
const ANTHROPIC = {
  'claude-fable-5-1':  { in: 10,   out: 50,   cw5: 12.5,  cw1h: 20,   read: 0.25 },
  'claude-mythos-5-1': { in: 10,   out: 50,   cw5: 12.5,  cw1h: 20,   read: 0.25 },
  'claude-fable-5':    { in: 10,   out: 50,   cw5: 12.5,  cw1h: 20,   read: 1 },
  'claude-mythos-5':   { in: 10,   out: 50,   cw5: 12.5,  cw1h: 20,   read: 1 },
  'claude-opus-5-5':   { in: 4,    out: 20,   cw5: 5,     cw1h: 8,    read: 0.20 },
  'claude-opus-5':     { in: 5,    out: 25,   cw5: 6.25,  cw1h: 10,   read: 0.50 },
  'claude-opus-4-8':   { in: 5,    out: 25,   cw5: 6.25,  cw1h: 10,   read: 0.50 },
  'claude-opus-4-7':   { in: 5,    out: 25,   cw5: 6.25,  cw1h: 10,   read: 0.50 },
  'claude-opus-4-6':   { in: 5,    out: 25,   cw5: 6.25,  cw1h: 10,   read: 0.50 },
  'claude-opus-4-5':   { in: 5,    out: 25,   cw5: 6.25,  cw1h: 10,   read: 0.50 },
  'claude-opus-4-1':   { in: 15,   out: 75,   cw5: 18.75, cw1h: 30,   read: 1.50 },
  'claude-opus-4':     { in: 15,   out: 75,   cw5: 18.75, cw1h: 30,   read: 1.50 },
  'claude-sonnet-5-5': { in: 2,    out: 10,   cw5: 2.5,   cw1h: 4,    read: 0.10 },
  'claude-sonnet-5':   { in: 2,    out: 10,   cw5: 2.5,   cw1h: 4,    read: 0.20 },
  'claude-sonnet-4-6': { in: 3,    out: 15,   cw5: 3.75,  cw1h: 6,    read: 0.30 },
  'claude-sonnet-4-5': { in: 3,    out: 15,   cw5: 3.75,  cw1h: 6,    read: 0.30 },
  'claude-sonnet-4':   { in: 3,    out: 15,   cw5: 3.75,  cw1h: 6,    read: 0.30 },
  'claude-haiku-4-5':  { in: 1,    out: 5,    cw5: 1.25,  cw1h: 2,    read: 0.10 },
  'claude-haiku-3-5':  { in: 0.80, out: 4,    cw5: 1,     cw1h: 1.60, read: 0.08 },
  // Priced by prompt size: <=100k tokens vs over.
  'claude-haiku-5-5':  { in: 0.10, out: 0.50, cw5: 0.125, cw1h: 0.20, read: 0.01,
    long:              { in: 0.50, out: 2.50, cw5: 0.625, cw1h: 1,    read: 0.05 } },
};

// OpenAI/Codex. The shape differs: one cached-input price and no separate write
// tier, so a cache write is billed as ordinary input. Codex's own
// `cache_write_input_tokens` is therefore folded into `in` by the caller.
const OPENAI = {
  'gpt-5':          { in: 1.25, out: 10,   read: 0.125 },
  'gpt-5-3-codex':  { in: 1.75, out: 14,   read: 0.175 },
  'gpt-6-luna':     { in: 0.10, out: 0.50, read: 0.01,  long: { in: 0.20, out: 0.75, read: 0.02 } },
  'gpt-6-sol':      { in: 2,    out: 10,   read: 0.20,  long: { in: 4,    out: 15,   read: 0.40 } },
  'gpt-6-1-sol':    { in: 2,    out: 10,   read: 0.10,  long: { in: 4,    out: 15,   read: 0.20 } },
  'gpt-6-astra':    { in: 10,   out: 50,   read: 1,     long: { in: 20,   out: 75,   read: 2 } },
};

/**
 * Transcripts carry ids like `claude-opus-4-8`, `gpt-6-astra`, and sometimes a dated
 * suffix (`claude-haiku-4-5-20251001`) or a dotted form (`gpt-5.3-codex`).
 * Normalise to the tables' keys: lowercase, dots to dashes, no release date.
 */
export function normaliseModel(model) {
  let m = String(model || '').trim().toLowerCase();
  if (!m) return '';
  m = m.replace(/^(anthropic|openai)\//, ''); // some gateways prefix the vendor
  m = m.replace(/\[\d+[km]\]$/i, '');         // context marker, e.g. opus-5[1m]
  m = m.replace(/-\d{8}$/, '');               // release date
  m = m.replace(/\./g, '-');                  // gpt-5.3-codex -> gpt-5-3-codex
  return m;
}

/** Operator overrides, as JSON in the `pricing_overrides` setting. */
function overrides() {
  try {
    const raw = getSetting('pricing_overrides');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {}; // a malformed override must not take pricing down with it
  }
}

/**
 * @returns {object|null} per-MTok rates, or null when the model is not priced.
 *   Null is a real answer here: see rule 1 at the top of this file.
 */
export function ratesFor(model) {
  const key = normaliseModel(model);
  if (!key || key === '<synthetic>') return null;
  return overrides()[key] || ANTHROPIC[key] || OPENAI[key] || null;
}

const apply = (r, t) =>
  ((t.in || 0) * (r.in || 0) +
   (t.out || 0) * (r.out || 0) +
   (t.cw5 || 0) * (r.cw5 ?? r.in ?? 0) +
   (t.cw1h || 0) * (r.cw1h ?? r.cw5 ?? r.in ?? 0) +
   (t.read || 0) * (r.read || 0)) / 1e6;

const round = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Cost of one token bundle.
 *
 * `{usd: null, priced: false}` when the model has no rates, so a caller can report
 * the tokens and stay silent about the money. For a size-tiered model `usdMax`
 * exceeds `usd` and `tiered` is true: the true figure is somewhere in that bracket
 * and nothing in the session totals narrows it further.
 *
 * `cw5`/`cw1h` come from usage.cache_creation. When only the combined
 * `cache_creation_input_tokens` is available, pass it as `cw5` -- the cheaper write
 * tier -- so the result is a floor rather than a guess in the dear direction.
 */
export function costOf(model, { in: inTok = 0, out = 0, cw5 = 0, cw1h = 0, read = 0 } = {}) {
  const r = ratesFor(model);
  const key = normaliseModel(model);
  if (!r) return { usd: null, usdMax: null, priced: false, tiered: false, model: key };
  const t = { in: inTok, out, cw5, cw1h, read };
  const usd = round(apply(r, t));
  const usdMax = r.long ? round(apply(r.long, t)) : usd;
  return { usd, usdMax, priced: true, tiered: Boolean(r.long), model: key };
}

/** Which models this build can price — so a CLI can show what it does and doesn't know. */
export function pricedModels() {
  return [...Object.keys(ANTHROPIC), ...Object.keys(OPENAI), ...Object.keys(overrides())].sort();
}
