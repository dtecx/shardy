// Self-check for the shared model (card math, ETA, strings). Run: node tests/shared.test.js
const fs = require('fs'); const vm = require('vm'); const assert = require('assert'); const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'extension', 'shared.js');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8') + ';this.X={compareVersions,tDated,titleSummary,titleState,etaSeconds,titlePlan,cyclesLeft,paceOf,t,formatDuration,DEFAULTS,STR,CH_OVERHEAD_SEC,COOLDOWN_SEC};', ctx);
const { compareVersions, tDated, titleSummary, titleState, etaSeconds, titlePlan, cyclesLeft, t, formatDuration, DEFAULTS, STR, CH_OVERHEAD_SEC, COOLDOWN_SEC } = ctx.X;
const plain = o => JSON.parse(JSON.stringify(o));
// Real API shape for Необъятный океан (0 of 13 cards).
const data = { balance: { amount: 7 }, exchange_options: [
  { rank: 'E', cost: 100, missing_cards_count: 5, total_cards_count: 5 },
  { rank: 'D', cost: 300, missing_cards_count: 3, total_cards_count: 3 },
  { rank: 'C', cost: 700, missing_cards_count: 2, total_cards_count: 2 },
  { rank: 'B', cost: 1800, missing_cards_count: 3, total_cards_count: 3 },
  { rank: 'A', cost: 4500, missing_cards_count: 0, total_cards_count: 0 } ] };
const all = ['E','D','C','B','A'];
assert.deepStrictEqual(plain(titleSummary(data, all)), { noCards: false, need: 8200, balance: 7, total: 13, collected: 0 });
assert.strictEqual(titleSummary(data, ['E']).need, 500);
// Half collected: only the missing half is farmed.
const half = { balance: { amount: 50 }, exchange_options: [{ rank: 'E', cost: 100, missing_cards_count: 2, total_cards_count: 5 }] };
assert.deepStrictEqual(plain(titleSummary(half, all)), { noCards: false, need: 200, balance: 50, total: 5, collected: 3 });
assert.strictEqual(titleState(titleSummary(half, all)), 'farm');
assert.strictEqual(titleState({ need: 0, balance: 3, total: 5, collected: 5 }), 'complete');
assert.strictEqual(titleState({ need: 200, balance: 250, total: 5, collected: 3 }), 'enough');
assert.strictEqual(titleState(titleSummary({ exchange_options: [] }, all)), 'noCards');
// ETA follows each title's own chapter length (no weekly pressure: 20 shards fits this week).
const s = { ...DEFAULTS, stats: { secPerPage: 5, shardsPerCh: 1 }, dailyMax: 0, breakMin: 0, breakMax: 0, weekly: { remaining: 700, limit: 750, resetAt: Date.now() + 3 * 864e5 } };
const long = { need: 10, balance: 0, pagesPerCh: 50, chapters: 100 }, short = { need: 10, balance: 0, pagesPerCh: 13, chapters: 100 };
assert.strictEqual(etaSeconds(s, long), 10 * (50 * 5 + CH_OVERHEAD_SEC));
assert.strictEqual(etaSeconds(s, short), 10 * (13 * 5 + CH_OVERHEAD_SEC));
assert.strictEqual(etaSeconds(s, [long, short]), etaSeconds(s, long) + etaSeconds(s, short));
// Live progress: half way to the 90% credit point counts as part of a chapter.
const live = { ...s, running: true, live: { slug: 'a', page: 45, total: 100 } };
assert.strictEqual(titlePlan(live, { ...long, slug: 'a' }).chapters, 9.5);
// Daily cap stretches the ETA.
assert.strictEqual(etaSeconds({ ...s, dailyMax: 5 }, short), 2 * 86400);
// Weekly limit: 900 shards with 100 left this week → reset (3 days) + 800/750 weeks.
const big = { need: 900, balance: 0, pagesPerCh: 1, chapters: 5000 };
const wk = { ...s, stats: { secPerPage: 0.001, shardsPerCh: 1 }, weekly: { remaining: 100, limit: 750, resetAt: Date.now() + 3 * 864e5 } };
const e = etaSeconds(wk, big);
assert.ok(Math.abs(e - (3 * 86400 + (800 / 750) * 7 * 86400)) < 5, e);
// Cooldown cycles: 8200 shards from 143 chapters at 1.2/chapter needs 6834 chapter reads → 47 more cycles of 30 days.
const gb = { need: 8200, balance: 0, pagesPerCh: 47, chapters: 143, eligible: 143 };
const gs = { ...DEFAULTS, stats: { shardsPerCh: 1.2 } };
assert.strictEqual(titlePlan(gs, gb).cycles, Math.ceil((Math.ceil(8200 / 1.2) - 143) / 143));
assert.ok(etaSeconds(gs, gb) >= 47 * COOLDOWN_SEC);
assert.strictEqual(cyclesLeft(gs, [gb, short]), titlePlan(gs, gb).cycles);
// A small album fits in one pass: no cycles.
assert.strictEqual(titlePlan(gs, { need: 79, balance: 21, chapters: 120, eligible: 110 }).cycles, 0);
assert.strictEqual(etaSeconds(s, { need: null }), null);
assert.strictEqual(etaSeconds(s, { need: 0, balance: 0, total: 5, collected: 5 }), 0);
assert.strictEqual(titleState({ need: 100, balance: 0, cooldownUntil: Date.now() + 1000 }), 'cooldown');
assert.strictEqual(t('uk', 'cards', { c: 1, t: 2 }), 'Карти 1/2');
assert.deepStrictEqual(Object.keys(STR.ru).sort(), Object.keys(STR.uk).sort());
// Update check: newer release only when the version is really higher.
assert.strictEqual(compareVersions('v0.6.0', '0.5.0'), 1);
assert.strictEqual(compareVersions('0.5.0', 'v0.5.0'), 0);
assert.strictEqual(compareVersions('0.5.10', '0.5.9'), 1);
assert.strictEqual(compareVersions('0.4.9', '0.5'), -1);
// Notification text formats timestamps in the chosen language.
assert.ok(/понедельник/.test(tDated('ru', 'n_weekly', { date: Date.parse('2026-11-16T06:00:00Z') })));
assert.ok(/понеділок/.test(tDated('uk', 'n_weekly', { date: Date.parse('2026-11-16T06:00:00Z') })));
assert.strictEqual(tDated('ru', 'n_card', { rank: 'E', name: 'Тиса' }), 'Новая карта E: Тиса');
console.log('shared.js self-check ok');
