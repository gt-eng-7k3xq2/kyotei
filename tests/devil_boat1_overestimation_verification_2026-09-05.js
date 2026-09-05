'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const { alphaP0 } = require('./lib/p1_kinsetsu_candidate_predictor_2026-09-05.js');
const { loadAllRaces } = require('./q_engine_entry_backtest.js');

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMs(dateStr, shimekiriStr) {
  const m = String(shimekiriStr).match(/([0-9]{1,2}):([0-9]{2})/);
  if (!m) return null;
  const ms = Date.parse(dateStr + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00.000+09:00');
  return isNaN(ms) ? null : ms;
}
function validOddsEntries(oddsMap) {
  return Object.entries(oddsMap || {}).map(function (e) { return { val: e[0], odds: Number(e[1]) }; })
    .filter(function (e) { return Number.isFinite(e.odds) && e.odds > 0; });
}
function classifyTimingFixed(r) {
  if (!r.archivedAt) return { cls: 'unknown' };
  const archMs = Date.parse(r.archivedAt);
  if (isNaN(archMs)) return { cls: 'unknown' };
  const deadlineMs2 = shimekiriMs(r.date, r.shimekiri);
  if (deadlineMs2 == null) return { cls: 'unknown' };
  const diffMs = deadlineMs2 - archMs;
  if (diffMs > 0 && diffMs <= 20 * 60 * 1000) return { cls: 'true', diffMs: diffMs };
  return { cls: 'unknown' };
}
function isUsableForLayer1(r) {
  return !!(r.resulted && r.boats && r.boats.length === 6 && r.boats.every(function (b) { return !b.isJogai; }) && r.chakuju);
}
function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function wilson(k, n) {
  if (n === 0) return { lo: null, hi: null };
  const z = 1.959963985;
  const p = k / n;
  const denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { lo: (center - margin) / denom, hi: (center + margin) / denom };
}
function period(date) {
  if (date >= '2026-08-21' && date <= '2026-08-27') return 'EvalA';
  if (date >= '2026-08-28' && date <= '2026-09-02') return 'EvalB';
  if (date >= '2026-09-03') return 'Beyond0902';
  return 'PreLearningBoundary';
}

console.log('GARON-20260905-003 boat1 overestimation verification');
const allRaces = loadAllRaces();
console.log('loadAllRaces total =', allRaces.length);

function alphaTryBoats(boats) {
  return Array.isArray(boats) && boats.length === 6 && boats.every(function (b) { return b && !b.isJogai; }) &&
    boats.map(function (b) { return b.no; }).slice().sort().join() === '1,2,3,4,5,6';
}

function buildRecord(r) {
  if (!alphaTryBoats(r.boats)) return { skip: 'BOATS_INVALID' };
  let dist;
  try { dist = alphaP0.distribution(r.boats); } catch (e) { return { skip: 'DIST_ERROR:' + e.message }; }
  const sum = dist.reduce(function (s, c) { return s + c.p; }, 0);
  if (Math.abs(sum - 1) > 1e-9) return { skip: 'INVALID_DIST' };
  const p1boat1 = dist.filter(function (c) { return c.val.split('-')[0] === '1'; }).reduce(function (s, c) { return s + c.p; }, 0);
  const p1 = {}; for (let c = 1; c <= 6; c++) p1[c] = 0;
  for (const e of dist) { const f = Number(e.val.split('-')[0]); p1[f] += e.p; }
  const argmax1 = Number(Object.keys(p1).reduce(function (a, b) { return p1[b] > p1[a] ? b : a; }));
  const actual1 = r.chakuju ? Number(r.chakuju.split('-')[0]) : null;
  const actualIsBoat1 = actual1 === 1;
  const payoutMul = parsePayout100(r.payout) / 100;
  const confirmedInBand = !!(r.resulted && payoutMul >= 50 && payoutMul <= 150);

  const entries = validOddsEntries(r.oddsMap);
  const hasFullOdds = entries.length === 120;
  let marketP1 = null, marketP1Mixed = null;
  if (hasFullOdds) {
    const invSum = entries.reduce(function (s, e) { return s + 1 / e.odds; }, 0);
    marketP1 = entries.filter(function (e) { return e.val.split('-')[0] === '1'; }).reduce(function (s, e) { return s + (1 / e.odds) / invSum; }, 0);
    const pmMap = new Map(dist.map(function (c) { return [c.val, c.p]; }));
    const massAll = entries.map(function (e) { return { val: e.val, mass: Math.sqrt(Math.max(pmMap.get(e.val) || Number.MIN_VALUE, Number.MIN_VALUE) / e.odds) }; });
    const massSum = massAll.reduce(function (s, e) { return s + e.mass; }, 0);
    marketP1Mixed = massAll.filter(function (e) { return e.val.split('-')[0] === '1'; }).reduce(function (s, e) { return s + e.mass / massSum; }, 0);
  }
  const bandCount = entries.filter(function (e) { return e.odds >= 50 && e.odds <= 150; }).length;

  const deadlineMs = shimekiriMs(r.date, r.shimekiri);
  let entered = null, prodError = null;
  if (hasFullOdds && deadlineMs != null && r.archivedAt) {
    const input = { boats: r.boats, oddsMap: r.oddsMap, oddsCapturedAt: r.archivedAt, deadlineAt: new Date(deadlineMs).toISOString() };
    const nowMs = Date.parse(r.archivedAt);
    try {
      const prod = alphaP0.predict(input, nowMs);
      entered = !!prod.entered;
      prodError = (prod.entered === false && prod.points && prod.points.length === 0) ? prod.reason : null;
    } catch (e) { prodError = 'PREDICT_ERROR:' + e.message; }
  }

  return {
    skip: null,
    rec: {
      key: r.date + '_' + r.venue + '_' + r.racenum, date: r.date, venue: r.venue, racenum: r.racenum,
      period: period(r.date),
      p1boat1: p1boat1, argmax1: argmax1, actualIsBoat1: actualIsBoat1,
      payoutMul: payoutMul, confirmedInBand: confirmedInBand,
      hasFullOdds: hasFullOdds, marketP1: marketP1, marketP1Mixed: marketP1Mixed,
      bandCount: bandCount, bandEligible: bandCount >= 8,
      trueT10: classifyTimingFixed(r).cls === 'true',
      entered: entered, prodError: prodError,
    }
  };
}

const dateFloor = '2026-08-21';
const layer1Pop = allRaces.filter(function (r) { return isUsableForLayer1(r) && r.date >= dateFloor; });
console.log('population1 candidate n =', layer1Pop.length);
const built1 = layer1Pop.map(buildRecord);
const skipCounts1 = {};
built1.forEach(function (x) { if (x.skip) skipCounts1[x.skip] = (skipCounts1[x.skip] || 0) + 1; });
const pop1 = built1.filter(function (x) { return !x.skip; }).map(function (x) { return x.rec; });
console.log('population1 valid n =', pop1.length, 'skips=', JSON.stringify(skipCounts1));

const pop2 = pop1.filter(function (r) { return r.trueT10; });
console.log('population2 (true-T10) n =', pop2.length);
const pop3 = pop2.filter(function (r) { return r.bandEligible; });
console.log('population3 (pop2 && bandCount>=8) n =', pop3.length);
const pop4 = pop3.filter(function (r) { return r.entered === true; });
console.log('population4 (pop3 && entered=true) n =', pop4.length);
const pop5 = pop3.filter(function (r) { return r.entered === false; });
console.log('population5 (pop3 && entered=false) n =', pop5.length);
const pop6 = pop2.filter(function (r) { return r.confirmedInBand; });
console.log('population6 (pop2 && confirmed payout 50-150x) n =', pop6.length);

function calibMetrics(pop) {
  const n = pop.length;
  if (n === 0) return null;
  const argmaxRate = pop.filter(function (r) { return r.argmax1 === 1; }).length / n * 100;
  const meanPred = mean(pop.map(function (r) { return r.p1boat1; }));
  const actualK = pop.filter(function (r) { return r.actualIsBoat1; }).length;
  const actualRate = actualK / n * 100;
  const w = wilson(actualK, n);
  const brier = mean(pop.map(function (r) { return Math.pow(r.p1boat1 - (r.actualIsBoat1 ? 1 : 0), 2); }));
  const EPS = 1e-9;
  const logloss = mean(pop.map(function (r) {
    const p = Math.min(1 - EPS, Math.max(EPS, r.p1boat1));
    return -(r.actualIsBoat1 ? Math.log(p) : Math.log(1 - p));
  }));
  return {
    n: n, argmaxBoat1RatePct: argmaxRate, meanPredictedP1: meanPred, actualBoat1RatePct: actualRate,
    calibErrorPct: meanPred * 100 - actualRate, wilson95: { lo: w.lo * 100, hi: w.hi * 100 },
    brier: brier, logloss: logloss,
  };
}
function decileCalibration(pop) {
  const n = pop.length;
  const nBins = n >= 100 ? 10 : (n >= 30 ? 5 : (n > 0 ? Math.max(1, Math.min(3, Math.floor(n / 10))) : 0));
  if (nBins === 0) return [];
  const sorted = pop.slice().sort(function (a, b) { return a.p1boat1 - b.p1boat1; });
  const binSize = Math.ceil(n / nBins);
  const bins = [];
  for (let i = 0; i < nBins; i++) {
    const slice = sorted.slice(i * binSize, (i + 1) * binSize);
    if (!slice.length) continue;
    const k = slice.filter(function (r) { return r.actualIsBoat1; }).length;
    bins.push({ binIndex: i, n: slice.length, predMin: slice[0].p1boat1, predMax: slice[slice.length - 1].p1boat1, meanPredPct: mean(slice.map(function (r) { return r.p1boat1; })) * 100, actualRatePct: k / slice.length * 100 });
  }
  return bins;
}
function groupBy(pop, keyFn) {
  const g = {};
  for (const r of pop) { const k = keyFn(r); (g[k] = g[k] || []).push(r); }
  const out = {};
  for (const k of Object.keys(g)) out[k] = calibMetrics(g[k]);
  return out;
}

const section1 = {};
const popsForSection1 = { pop1: pop1, pop2: pop2, pop3: pop3, pop4: pop4, pop5: pop5, pop6: pop6 };
for (const name of Object.keys(popsForSection1)) {
  const pop = popsForSection1[name];
  section1[name] = {
    overall: calibMetrics(pop),
    decile: decileCalibration(pop),
    byMonth: groupBy(pop, function (r) { return r.date.slice(0, 7); }),
    byPeriod: groupBy(pop, function (r) { return r.period; }),
    byVenue: groupBy(pop, function (r) { return r.venue; }),
  };
  console.log('section1 ' + name + ' (n=' + pop.length + ') overall=' + JSON.stringify(section1[name].overall));
  console.log('  byPeriod=' + JSON.stringify(section1[name].byPeriod));
}

function marketCalib(pop, field) {
  const withMarket = pop.filter(function (r) { return r[field] != null; });
  const n = withMarket.length;
  if (n === 0) return null;
  const meanPred = mean(withMarket.map(function (r) { return r[field]; }));
  const actualK = withMarket.filter(function (r) { return r.actualIsBoat1; }).length;
  const actualRate = actualK / n * 100;
  const brier = mean(withMarket.map(function (r) { return Math.pow(r[field] - (r.actualIsBoat1 ? 1 : 0), 2); }));
  return { n: n, meanPredicted: meanPred, actualRatePct: actualRate, calibErrorPct: meanPred * 100 - actualRate, brier: brier };
}
const section2 = {};
for (const name of ['pop2', 'pop3', 'pop4', 'pop5']) {
  const pop = popsForSection1[name];
  section2[name] = {
    p0pure: calibMetrics(pop),
    marketRaw: marketCalib(pop, 'marketP1'),
    marketMixed: marketCalib(pop, 'marketP1Mixed'),
  };
  console.log('section2 ' + name + '=' + JSON.stringify(section2[name]));
}

function counterfactual(pop) {
  let TP = 0, FP = 0, FN = 0, TN = 0;
  const fpByPayout = { lt50: 0, band50_150: 0, gt150: 0, unresulted: 0 };
  const tpByPayout = { lt50: 0, band50_150: 0, gt150: 0, unresulted: 0 };
  function bandOf(r) {
    if (!r.payoutMul || r.payoutMul <= 0) return 'unresulted';
    if (r.payoutMul < 50) return 'lt50';
    if (r.payoutMul <= 150) return 'band50_150';
    return 'gt150';
  }
  for (const r of pop) {
    const modelBoat1 = r.argmax1 === 1;
    if (modelBoat1 && r.actualIsBoat1) { TP++; tpByPayout[bandOf(r)]++; }
    else if (modelBoat1 && !r.actualIsBoat1) { FP++; fpByPayout[bandOf(r)]++; }
    else if (!modelBoat1 && r.actualIsBoat1) FN++;
    else TN++;
  }
  return { n: pop.length, TP: TP, FP: FP, FN: FN, TN: TN, fpByPayout: fpByPayout, tpByPayout: tpByPayout };
}
const section3 = { pop1: counterfactual(pop1), pop2: counterfactual(pop2), pop3: counterfactual(pop3) };
console.log('section3=' + JSON.stringify(section3));

const out = {
  generatedAt: new Date().toISOString(),
  caseId: 'GARON-20260905-003',
  scopeNote: 'Diagnosis only, no production changes, no re-training.',
  populationCounts: { pop1: pop1.length, pop2: pop2.length, pop3: pop3.length, pop4: pop4.length, pop5: pop5.length, pop6: pop6.length },
  skipCounts1: skipCounts1,
  section1: section1,
  section2: section2,
  section3: section3,
};
fs.writeFileSync(path.join(ROOT, 'logs', 'devil_boat1_overestimation_verification_2026-09-05.json'), JSON.stringify(out, null, 2));
console.log('Saved logs/devil_boat1_overestimation_verification_2026-09-05.json');
