'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'C:/garon';
const { loadAllRaces } = require(path.join(ROOT, 'tests/q_engine_entry_backtest.js'));
const Module = require('module');
function loadAlphaWithDistribution() {
  const alphaDir = path.join(ROOT, 'scripts/lib/alpha_engine');
  const src = fs.readFileSync(path.join(alphaDir, 'alpha.js'), 'utf8');
  const patched = src.replace('module.exports={predict,MODEL_ID,ENTRY_THRESHOLD};', 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD,distribution};');
  const m = new Module(path.join(alphaDir, 'alpha.js'), module);
  m.filename = path.join(alphaDir, 'alpha.js');
  m.paths = Module._nodeModulePaths(alphaDir);
  m._compile(patched, m.filename);
  return m.exports;
}
const alphaP0 = loadAlphaWithDistribution();
console.log('ENTRY_THRESHOLD=', alphaP0.ENTRY_THRESHOLD);
function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMs(dateStr, shimekiriStr) {
  const m = String(shimekiriStr).match(/([0-9]{1,2}):([0-9]{2})/);
  if (!m) return null;
  const ms = Date.parse(dateStr + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00.000+09:00');
  return isNaN(ms) ? null : ms;
}
function classifyTimingFixed(r) {
  if (!r.archivedAt) return { cls: 'unknown' };
  const archMs = Date.parse(r.archivedAt);
  if (isNaN(archMs)) return { cls: 'unknown' };
  const deadlineMs2 = shimekiriMs(r.date, r.shimekiri);
  if (deadlineMs2 == null) return { cls: 'unknown' };
  const diffMs = deadlineMs2 - archMs;
  if (diffMs > 0 && diffMs <= 20 * 60 * 1000) return { cls: 'true', diffMs };
  return { cls: 'unknown' };
}
function isUsableForLayer1(r) {
  return !!(r.resulted && r.boats && r.boats.length === 6 && r.boats.every(b => !b.isJogai) && r.chakuju);
}
function alphaTryBoats(boats) {
  return Array.isArray(boats) && boats.length === 6 && boats.every(b => b && !b.isJogai) &&
    boats.map(b => b.no).slice().sort().join() === '1,2,3,4,5,6';
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function stdev(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }
function tstat(sampleMean, sampleSd, n, nullVal) { if (!sampleSd || n < 2) return null; return (sampleMean - nullVal) / (sampleSd / Math.sqrt(n)); }
function period(date) {
  if (date >= '2026-08-21' && date <= '2026-08-27') return 'EvalA';
  if (date >= '2026-08-28' && date <= '2026-09-02') return 'EvalB';
  if (date >= '2026-09-03') return 'Beyond0902';
  return 'PreLearningBoundary';
}
const KIMARITE_MISSING_START = '2026-08-21', KIMARITE_MISSING_END = '2026-08-26';
function kimariteMissing(date) { return date >= KIMARITE_MISSING_START && date <= KIMARITE_MISSING_END; }
console.log('loaded helpers OK');
console.log('loading all races...');
const allRaces = loadAllRaces();
console.log('total races =', allRaces.length);
function computeScale(boats, oddsMap) {
  const dist = alphaP0.distribution(boats);
  const sum = dist.reduce((s, c) => s + c.p, 0);
  if (Math.abs(sum - 1) > 1e-9) return null;
  const pm = new Map(dist.map(c => [c.val, c.p]));
  const entriesRaw = Object.entries(oddsMap || {}).map(([val, v]) => ({ val, odds: Number(v) })).filter(e => Number.isFinite(e.odds) && e.odds > 0);
  if (entriesRaw.length !== 120) return null;
  const invSum = entriesRaw.reduce((s, e) => s + 1 / e.odds, 0);
  const entries = entriesRaw.map(e => {
    const p = pm.get(e.val) || 0;
    return { val: e.val, odds: e.odds, pm: p, marketRaw: (1 / e.odds) / invSum, mass: Math.sqrt(Math.max(p, Number.MIN_VALUE) / e.odds) };
  });
  const den = entries.reduce((s, e) => s + e.mass, 0);
  entries.forEach(e => { e.mixed = e.mass / den; });
  const boat1 = leg => e => e.val.split('-')[leg] === '1';
  const p0_p1 = entries.filter(boat1(0)).reduce((s, e) => s + e.pm, 0);
  const market_p1_raw = entries.filter(boat1(0)).reduce((s, e) => s + e.marketRaw, 0);
  const market_p1_mixed = entries.filter(boat1(0)).reduce((s, e) => s + e.mixed, 0);
  const entropy = -dist.reduce((s, c) => s + (c.p > 0 ? c.p * Math.log(c.p) : 0), 0);
  const maxP = Math.max.apply(null, dist.map(c => c.p));
  const bandCount = entries.filter(e => e.odds >= 50 && e.odds <= 150).length;
  const sortedAll = entries.slice().sort((a, b) => a.val.localeCompare(b.val));
  const bandEntries = sortedAll.filter(e => e.odds >= 50 && e.odds <= 150);
  const selected8 = bandEntries.slice().sort((a, b) => b.mixed - a.mixed || a.val.localeCompare(b.val)).slice(0, 8);
  let estimate = null, entered = null;
  if (selected8.length === 8) {
    estimate = selected8.reduce((s, c) => s + c.mixed * c.odds, 0) / 8;
    entered = estimate >= alphaP0.ENTRY_THRESHOLD;
  }
  const boat1LegFrac = selected8.length ? selected8.filter(c => c.val.split('-').indexOf('1') !== -1).length / selected8.length : null;
  return { p0_p1, market_p1_raw, market_p1_mixed, entropy, maxP, bandCount, selected8, estimate, entered };
}
console.log('computeScale defined OK');
function buildRecord(r) {
  if (!alphaTryBoats(r.boats)) return { skip: 'BOATS_INVALID' };
  let sc;
  try { sc = computeScale(r.boats, r.oddsMap); } catch (e) { return { skip: 'CALC_ERROR:' + e.message }; }
  if (!sc) return { skip: 'NO_SCALE' };
  const actual1 = r.chakuju ? Number(r.chakuju.split('-')[0]) : null;
  const actualIsBoat1 = actual1 === 1;
  const payoutMul = parsePayout100(r.payout) / 100;
  const hit = sc.selected8.some(function (c) { return c.val === r.chakuju; });
  const stake = 800;
  const winPayoutYen = hit ? parsePayout100(r.payout) : 0;
  const profit = winPayoutYen - stake;
  return {
    skip: null,
    rec: {
      key: r.date + '_' + r.venue + '_' + r.racenum, date: r.date, venue: r.venue, racenum: r.racenum,
      period: period(r.date), kimariteMissingFlag: kimariteMissing(r.date),
      p0_p1: sc.p0_p1, market_p1_raw: sc.market_p1_raw, market_p1_mixed: sc.market_p1_mixed,
      diffRaw: sc.p0_p1 - sc.market_p1_raw, diffMixed: sc.p0_p1 - sc.market_p1_mixed,
      ratioRaw: sc.market_p1_raw > 0 ? sc.p0_p1 / sc.market_p1_raw : null,
      entropy: sc.entropy, maxP: sc.maxP, bandCount: sc.bandCount,
      boat1LegFrac: sc.boat1LegFrac,
      estimate: sc.estimate, entered: sc.entered,
      chakuju: r.chakuju, actualIsBoat1: actualIsBoat1, payoutMul: payoutMul, hit: hit, winPayoutYen: winPayoutYen, profit: profit, stake: stake,
      trueT10: classifyTimingFixed(r).cls === 'true',
      bandEligible: sc.bandCount >= 8,
      selected8: sc.selected8.map(function (c) { return { val: c.val, odds: c.odds, pm: c.pm, marketRaw: c.marketRaw, mixed: c.mixed }; }),
    }
  };
}
console.log('buildRecord defined OK');
var dateFloor = '2026-08-21';
var cand = allRaces.filter(function (r) { return isUsableForLayer1(r) && r.date >= dateFloor; });
console.log('population1 candidate n =', cand.length);
var built = cand.map(buildRecord);
var skipCounts = {};
built.forEach(function (x) { if (x.skip) skipCounts[x.skip] = (skipCounts[x.skip] || 0) + 1; });
console.log('skipCounts=', JSON.stringify(skipCounts));
var pop1 = built.filter(function (x) { return !x.skip; }).map(function (x) { return x.rec; });
console.log('population1 valid n =', pop1.length);
var pop2 = pop1.filter(function (r) { return r.trueT10; });
console.log('population2 (trueT10) n =', pop2.length);
var pop3 = pop2.filter(function (r) { return r.bandEligible; });
console.log('population3 (bandEligible) n =', pop3.length);
var pop4 = pop3.filter(function (r) { return r.entered === true; });
console.log('population4 (entered=true) n =', pop4.length);
var pop5 = pop3.filter(function (r) { return r.entered === false; });
console.log('population5 (entered=false) n =', pop5.length);
var OUT_DIR = path.dirname(__filename);
var crypto = require('crypto');
var pop3Json = JSON.stringify(pop3);
fs.writeFileSync(path.join(OUT_DIR, 'pop3_race_level.json'), pop3Json);
console.log('pop3 sha256=', crypto.createHash('sha256').update(pop3Json).digest('hex'));
console.log('saved pop3 race-level json to scratchpad, bytes=', pop3Json.length);
console.log('DONE_STAGE2_LOAD');
