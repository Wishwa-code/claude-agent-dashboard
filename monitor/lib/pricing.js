// API list prices in US dollars per million tokens, for an API-equivalent cost of each transcript turn. On a Pro/Max
// plan this is not what the user pays; the page says so next to every total.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-29. Opus 5.5 and Sonnet 5.5 cache
// reads are 0.05x input (that page's footnote 2). Haiku 5.5 is priced per request by prompt size (input + cache read
// + cache write): over 100,000 tokens the whole request pays the higher row.
'use strict';

const SOURCE = { url: 'https://platform.claude.com/docs/en/about-claude/pricing', read: '2026-10-29' };

// Keyed by model-id prefix; the longest matching prefix wins (claude-sonnet-5-5 before claude-sonnet-5).
const PRICES = {
  'claude-opus-5-5': { inp: 4, out: 20, cw5: 5, cw1h: 8, cr: 0.20 },
  'claude-opus-5': { inp: 5, out: 25, cw5: 6.25, cw1h: 10, cr: 0.50 },
  'claude-sonnet-5-5': { inp: 2, out: 10, cw5: 2.50, cw1h: 4, cr: 0.10 },
  'claude-sonnet-5': { inp: 2, out: 10, cw5: 2.50, cw1h: 4, cr: 0.20 },
  'claude-haiku-5-5': { tiers: [
    { upTo: 100000, inp: 0.10, out: 0.50, cw5: 0.125, cw1h: 0.20, cr: 0.01 },
    { upTo: Infinity, inp: 0.50, out: 2.50, cw5: 0.625, cw1h: 1, cr: 0.05 },
  ] },
  'claude-fable-5-1': { inp: 10, out: 50, cw5: 12.50, cw1h: 20, cr: 0.25 },
};
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

function priceFor(model) {
  const k = KEYS.find(p => String(model || '').startsWith(p));
  return k ? PRICES[k] : null;
}

// One turn: {inp, cw5, cw1h, cr, out} tokens -> US dollars, or null for a model with no price.
function turnCost(model, t) {
  let p = priceFor(model);
  if (!p) return null;
  if (p.tiers) {
    const prompt = t.inp + t.cr + t.cw5 + t.cw1h;
    p = p.tiers.find(x => prompt <= x.upTo);
  }
  return (t.inp * p.inp + t.cw5 * p.cw5 + t.cw1h * p.cw1h + t.cr * p.cr + t.out * p.out) / 1e6;
}

module.exports = { SOURCE, PRICES, priceFor, turnCost };
