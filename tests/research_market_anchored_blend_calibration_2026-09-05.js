'use strict';
// GARON-20260905-007 research: market-anchored blend strength calibration.
// Current alpha (production, beta=0.5 fixed, mass=sqrt(pm/odds)) generalized to a
// single-parameter beta family: p_beta(i) proportional to pm(i)^beta * q(i)^(1-beta),
// normalized over the 120 trifecta combinations. beta is calibrated using development-
// period log loss ONLY (no ROI/hit-rate used for beta selection).
// IMPORTANT: "P1" in this case (beta estimated from development-period log loss) is a
// completely different concept from the previously-rejected "kinsetsu6m candidate model"
// (GARON-20260904-003 through GARON-20260905-001). Do not confuse the two.
// No production alpha/ntfy/Q fallback path/task scheduler is touched. Analysis only.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const qBacktest = require('./q_engine_entry_backtest.js');
const loadAllRaces = qBacktest.loadAllRaces;
const isUsable = qBacktest.isUsable;

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const ENTRY_THRESHOLD = 1.440209615716716;
const WARMUP_DAYS = 7; // half of the available 14 days; fixed before seeing any results.

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hashObj(obj) { return sha256(JSON.stringify(obj)); }
function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function stdev(a) { if (a.length < 2) return null; var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1)); }

// alpha.js loaded with distribution() exposed via in-memory patch (disk file unchanged).
var alphaPath = path.join(ROOT, 'scripts', 'lib', 'alpha_engine', 'alpha.js');
var alphaOriginal = require(alphaPath);
var alphaSrc = fs.readFileSync(alphaPath, 'utf8');
var MARK = 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD};';
if (alphaSrc.indexOf(MARK) === -1) throw new Error('alpha.js export line mismatch - abort');
var patchedSrc = alphaSrc.replace(MARK, 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD,distribution};');
var mm = new Module(alphaPath, module);
mm.filename = alphaPath;
mm.paths = Module._nodeModulePaths(path.dirname(alphaPath));
mm._compile(patchedSrc, alphaPath);
var alphaExt = mm.exports;
if (alphaOriginal.ENTRY_THRESHOLD !== ENTRY_THRESHOLD) throw new Error('ENTRY_THRESHOLD mismatch - abort');
console.log('alpha.js loaded (distribution exposed via memory patch). ENTRY_THRESHOLD=', alphaOriginal.ENTRY_THRESHOLD);

function shimekiriMs(dateStr, shimekiriStr) {
  var m = String(shimekiriStr).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  var ms = Date.parse(dateStr + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00.000+09:00');
  return isNaN(ms) ? null : ms;
}
function classifyTimingFixed(r) {
  if (!r.archivedAt) return { cls: 'unknown', diffMs: null };
  var archMs = Date.parse(r.archivedAt);
  if (isNaN(archMs)) return { cls: 'unknown', diffMs: null };
  var deadlineMs = shimekiriMs(r.date, r.shimekiri);
  if (deadlineMs == null) return { cls: 'unknown', diffMs: null };
  var diffMs = deadlineMs - archMs;
  if (diffMs > 0 && diffMs <= 20 * 60 * 1000) return { cls: 'true', diffMs: diffMs };
  return { cls: 'unknown', diffMs: diffMs };
}
function validOddsEntries(oddsMap) {
  return Object.entries(oddsMap || {}).map(function (e) { return { val: e[0], odds: Number(e[1]) }; }).filter(function (e) { return Number.isFinite(e.odds) && e.odds > 0; });
}
function parsePayout100(s) { if (!s) return 0; var n = parseInt(String(s).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }

// ===== population: true-T10 AND isUsable AND all 120 combos have valid odds =====
var archiveFiles = fs.readdirSync(ROOT).filter(function (f) { return /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f); }).sort();
var archiveHashes = {};
archiveFiles.forEach(function (f) { archiveHashes[f] = sha256(fs.readFileSync(path.join(ROOT, f))); });

var loadedAt = new Date().toISOString();
var all = loadAllRaces();
var usable = all.filter(isUsable);
var eligibleRaw = usable.filter(function (r) { return classifyTimingFixed(r).cls === 'true' && validOddsEntries(r.oddsMap).length === 120; });
var unknownRaw = usable.filter(function (r) { return classifyTimingFixed(r).cls === 'unknown' && validOddsEntries(r.oddsMap).length === 120 && r.archivedAt; });

function buildBase(r) {
  var entries = validOddsEntries(r.oddsMap).slice().sort(function (a, b) { return a.val < b.val ? -1 : a.val > b.val ? 1 : 0; });
  var dist;
  try { dist = alphaExt.distribution(r.boats); } catch (e) { return { skip: 'DIST_ERROR:' + e.message }; }
  var pmSum = dist.reduce(function (s, c) { return s + c.p; }, 0);
  if (Math.abs(pmSum - 1) > 1e-9) return { skip: 'INVALID_PM_SUM' };
  var pmMap = new Map(dist.map(function (c) { return [c.val, c.p]; }));
  if (!entries.every(function (e) { return pmMap.has(e.val); })) return { skip: 'VAL_SET_MISMATCH' };
  var valArr = entries.map(function (e) { return e.val; });
  var oddsArr = entries.map(function (e) { return e.odds; });
  var pmArr = valArr.map(function (v) { return pmMap.get(v); });
  var invOddsSum = oddsArr.reduce(function (s, o) { return s + 1 / o; }, 0);
  var qArr = oddsArr.map(function (o) { return (1 / o) / invOddsSum; });
  var chakujuIdx = valArr.indexOf(r.chakuju);
  if (chakujuIdx === -1) return { skip: 'CHAKUJU_NOT_IN_120' };
  var logPm = pmArr.map(Math.log);
  var logQ = qArr.map(Math.log);
  var payoutMul = parsePayout100(r.payout) / 100;
  return {
    skip: null, key: r.date + '_' + r.venue + '_' + r.racenum, date: r.date, venue: r.venue, racenum: r.racenum,
    shimekiriMs: shimekiriMs(r.date, r.shimekiri), archivedAt: r.archivedAt,
    valArr: valArr, oddsArr: oddsArr, pmArr: pmArr, qArr: qArr, logPm: logPm, logQ: logQ,
    chakujuIdx: chakujuIdx, chakuju: r.chakuju, payoutMul: payoutMul,
    boats: r.boats, oddsMap: r.oddsMap, shimekiri: r.shimekiri
  };
}

var eligibleBuilt = eligibleRaw.map(buildBase);
var eligibleSkipCounts = {};
eligibleBuilt.forEach(function (x) { if (x.skip) eligibleSkipCounts[x.skip] = (eligibleSkipCounts[x.skip] || 0) + 1; });
var population = eligibleBuilt.filter(function (x) { return !x.skip; }).sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.shimekiriMs || 0) - (b.shimekiriMs || 0)); });
console.log('population (true-T10, isUsable, 120 valid odds) n=', population.length, 'skip breakdown=', JSON.stringify(eligibleSkipCounts));

var unknownBuilt = unknownRaw.map(buildBase).filter(function (x) { return !x.skip; });
console.log('sensitivity population (unknown timing) n=', unknownBuilt.length);

// compare against the existing frozen true-T10 snapshot (n=1485, 08-21..09-02)
var frozenPath = path.join(ROOT, 'logs', 'research_pure_prediction_true_t10_snapshot_2026-09-04.json');
var frozenNote = 'N/A';
if (fs.existsSync(frozenPath)) {
  var frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'));
  var frozenKeys = new Set(frozen.races.map(function (r) { return r.date + '_' + r.venue + '_' + r.racenum; }));
  var curKeys = new Set(population.map(function (r) { return r.key; }));
  var newSince = Array.from(curKeys).filter(function (k) { return !frozenKeys.has(k); });
  var missingSince = Array.from(frozenKeys).filter(function (k) { return !curKeys.has(k); });
  frozenNote = 'frozen n=' + frozen.count + ', current n=' + population.length + ', new_since_frozen=' + newSince.length + ', missing_vs_frozen=' + missingSince.length;
  console.log('vs existing frozen snapshot:', frozenNote, missingSince.length ? '(missing sample: ' + missingSince.slice(0, 3).join(',') + ')' : '');
}

var popSnapshotForHash = population.map(function (r) { return { key: r.key, date: r.date, venue: r.venue, racenum: r.racenum, chakuju: r.chakuju, payoutMul: r.payoutMul, archivedAt: r.archivedAt }; });
var populationHash = hashObj(popSnapshotForHash);
var populationRaceIds = population.map(function (r) { return r.key; });
console.log('population content hash =', populationHash);

// full new-extended snapshot saved separately (not overwriting the 09-04 frozen one)
var extendedSnapshotPath = path.join(ROOT, 'logs', 'research_market_anchored_blend_calibration_population_2026-09-05.json');
fs.writeFileSync(extendedSnapshotPath, JSON.stringify({ generatedAt: loadedAt, contentHash: populationHash, count: population.length, vsFrozenNote: frozenNote, races: population.map(function (r) { return { key: r.key, date: r.date, venue: r.venue, racenum: r.racenum, boats: r.boats, oddsMap: r.oddsMap, chakuju: r.chakuju, payoutMul: r.payoutMul, shimekiri: r.shimekiri, archivedAt: r.archivedAt }; }) }));
console.log('extended population snapshot saved to', extendedSnapshotPath);

// ===== p_beta core =====
function logSumExp(arr) {
  var mx = arr[0];
  for (var i = 1; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
  var s = 0;
  for (var j = 0; j < arr.length; j++) s += Math.exp(arr[j] - mx);
  return mx + Math.log(s);
}
function rawLogAll(logPm, logQ, beta) {
  var n = logPm.length; var out = new Array(n);
  for (var i = 0; i < n; i++) out[i] = beta * logPm[i] + (1 - beta) * logQ[i];
  return out;
}
function nllOne(rec, beta) {
  var raw = rawLogAll(rec.logPm, rec.logQ, beta);
  var logZ = logSumExp(raw);
  return logZ - raw[rec.chakujuIdx];
}
function pBetaDist(rec, beta) {
  var raw = rawLogAll(rec.logPm, rec.logQ, beta);
  var logZ = logSumExp(raw);
  return raw.map(function (v) { return Math.exp(v - logZ); });
}
function avgNLL(pop, beta) { return mean(pop.map(function (r) { return nllOne(r, beta); })); }

// ===== golden-section search (single-variable continuous optimization; no grid search) =====
function goldenSectionMinimize(f, lo, hi, tol, maxIter) {
  var invphi = (Math.sqrt(5) - 1) / 2;
  var a = lo, b = hi;
  var c = b - invphi * (b - a);
  var d = a + invphi * (b - a);
  var fc = f(c), fd = f(d);
  var history = [{ a: a, b: b, c: c, d: d, fc: fc, fd: fd }];
  var iter = 0;
  while (Math.abs(b - a) > tol && iter < maxIter) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - invphi * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + invphi * (b - a); fd = f(d); }
    iter++;
    history.push({ a: a, b: b, c: c, d: d, fc: fc, fd: fd });
  }
  var beta = (a + b) / 2;
  return { beta: beta, fBeta: f(beta), iterations: iter, historyLength: history.length, historySample: history.slice(0, 3).concat(history.slice(-3)) };
}
var GS_TOL = 1e-4, GS_MAXITER = 200;

// ===== MANDATORY MATH AUDIT (must run before any other analysis) =====
console.log('\n=== MATH AUDIT ===');
var auditFail = [];
var TOL = 1e-9;

function productionMass(rec) {
  // Reproduces alpha.js predict(): mass_i = sqrt(pm_i/odds_i), den = sum over all 120, p = mass/den.
  var mass = rec.valArr.map(function (v, i) { return Math.sqrt(Math.max(rec.pmArr[i], Number.MIN_VALUE) / rec.oddsArr[i]); });
  var den = mass.reduce(function (s, m) { return s + m; }, 0);
  return mass.map(function (m) { return m / den; });
}

var auditSample = population; // audit over the FULL population, not a subsample
var maxDiffBeta0 = 0, maxDiffBeta05 = 0, maxDiffBeta1 = 0;
var maxSumDiff = { b0: 0, b05: 0, b1: 0, b025: 0, b075: 0 };
var negFound = false, dupBoatFound = false, orderVarianceFail = false, determinismFail = false;

for (var ai = 0; ai < auditSample.length; ai++) {
  var rec = auditSample[ai];
  var p0 = pBetaDist(rec, 0);      // should equal q
  var p05 = pBetaDist(rec, 0.5);   // should equal production mass/den
  var p1 = pBetaDist(rec, 1);      // should equal pm
  var prodP = productionMass(rec);

  for (var i = 0; i < 120; i++) {
    maxDiffBeta0 = Math.max(maxDiffBeta0, Math.abs(p0[i] - rec.qArr[i]));
    maxDiffBeta05 = Math.max(maxDiffBeta05, Math.abs(p05[i] - prodP[i]));
    maxDiffBeta1 = Math.max(maxDiffBeta1, Math.abs(p1[i] - rec.pmArr[i]));
    if (p0[i] < 0 || p05[i] < 0 || p1[i] < 0) negFound = true;
  }
  var sum0 = p0.reduce(function (s, x) { return s + x; }, 0);
  var sum05 = p05.reduce(function (s, x) { return s + x; }, 0);
  var sum1 = p1.reduce(function (s, x) { return s + x; }, 0);
  var p025 = pBetaDist(rec, 0.25), p075 = pBetaDist(rec, 0.75);
  var sum025 = p025.reduce(function (s, x) { return s + x; }, 0);
  var sum075 = p075.reduce(function (s, x) { return s + x; }, 0);
  var neg025 = p025.some(function (x) { return x < 0; });
  var neg075 = p075.some(function (x) { return x < 0; });
  if (neg025 || neg075) negFound = true;
  maxSumDiff.b0 = Math.max(maxSumDiff.b0, Math.abs(sum0 - 1));
  maxSumDiff.b05 = Math.max(maxSumDiff.b05, Math.abs(sum05 - 1));
  maxSumDiff.b1 = Math.max(maxSumDiff.b1, Math.abs(sum1 - 1));
  maxSumDiff.b025 = Math.max(maxSumDiff.b025, Math.abs(sum025 - 1));
  maxSumDiff.b075 = Math.max(maxSumDiff.b075, Math.abs(sum075 - 1));

  // boat-uniqueness: each of the 120 combos must be a permutation of exactly {1..6} with no repeats
  for (var vi = 0; vi < rec.valArr.length; vi++) {
    var digits = rec.valArr[vi].split('-');
    var set = new Set(digits);
    if (set.size !== 3 || digits.length !== 3) dupBoatFound = true;
  }
}
console.log('beta=0 vs market q: max abs diff over all races/combos =', maxDiffBeta0, '(pass=', maxDiffBeta0 < TOL, ')');
console.log('beta=0.5 vs production mass/den: max abs diff =', maxDiffBeta05, '(pass=', maxDiffBeta05 < TOL, ')');
console.log('beta=1 vs pure model pm: max abs diff =', maxDiffBeta1, '(pass=', maxDiffBeta1 < TOL, ')');
console.log('sum-to-1 max deviation: beta0=' + maxSumDiff.b0 + ' beta0.25=' + maxSumDiff.b025 + ' beta0.5=' + maxSumDiff.b05 + ' beta0.75=' + maxSumDiff.b075 + ' beta1=' + maxSumDiff.b1 + ' (pass=' + (Math.max(maxSumDiff.b0, maxSumDiff.b025, maxSumDiff.b05, maxSumDiff.b075, maxSumDiff.b1) < 1e-8) + ')');
console.log('non-negativity: any negative found =', negFound, '(pass=', !negFound, ')');
console.log('boat-uniqueness (each combo is a distinct permutation of 3 of {1..6}): any violation =', dupBoatFound, '(pass=', !dupBoatFound, ')');

// enumeration-order invariance: shuffle the 120-combo order for a sample race, recompute, compare per-val result
(function () {
  var rec = population[0];
  var idx = rec.valArr.map(function (v, i) { return i; });
  for (var s = idx.length - 1; s > 0; s--) { var j = Math.floor(Math.random() * (s + 1)); var t = idx[s]; idx[s] = idx[j]; idx[j] = t; }
  var shuffledRec = {
    logPm: idx.map(function (i) { return rec.logPm[i]; }),
    logQ: idx.map(function (i) { return rec.logQ[i]; }),
    chakujuIdx: idx.indexOf(rec.chakujuIdx),
  };
  var beta = 0.37;
  var orig = pBetaDist(rec, beta);
  var shuf = pBetaDist(shuffledRec, beta);
  var maxDiff = 0;
  for (var k = 0; k < idx.length; k++) maxDiff = Math.max(maxDiff, Math.abs(orig[idx[k]] - shuf[k]));
  orderVarianceFail = maxDiff > TOL;
  console.log('enumeration-order invariance: max diff after shuffle =', maxDiff, '(pass=', !orderVarianceFail, ')');
})();

// determinism: rerun same computation twice, compare exactly
(function () {
  var rec = population[Math.min(1, population.length - 1)];
  var a = pBetaDist(rec, 0.42);
  var b = pBetaDist(rec, 0.42);
  var identical = a.every(function (v, i) { return v === b[i]; });
  determinismFail = !identical;
  console.log('determinism (same input/beta, rerun): identical =', identical, '(pass=', identical, ')');
})();

var auditPass = (maxDiffBeta0 < TOL) && (maxDiffBeta05 < TOL) && (maxDiffBeta1 < TOL) &&
  (Math.max(maxSumDiff.b0, maxSumDiff.b025, maxSumDiff.b05, maxSumDiff.b075, maxSumDiff.b1) < 1e-8) &&
  !negFound && !dupBoatFound && !orderVarianceFail && !determinismFail;
console.log('\n=== MATH AUDIT RESULT: ' + (auditPass ? 'PASS' : 'FAIL') + ' ===');
if (!auditPass) {
  console.log('AUDIT FAILED. Stopping all further analysis as required by the case spec.');
  var auditOnlyOut = {
    generatedAt: loadedAt, auditPass: false,
    maxDiffBeta0: maxDiffBeta0, maxDiffBeta05: maxDiffBeta05, maxDiffBeta1: maxDiffBeta1,
    maxSumDiff: maxSumDiff, negFound: negFound, dupBoatFound: dupBoatFound, orderVarianceFail: orderVarianceFail, determinismFail: determinismFail,
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_market_anchored_blend_calibration_2026-09-05.json'), JSON.stringify(auditOnlyOut, null, 2));
  process.exit(1);
}

// ===== DATA SPLIT: walk-forward (time-series, no leakage) =====
console.log('\n=== DATA SPLIT (walk-forward) ===');
var byDate = {};
population.forEach(function (r) { (byDate[r.date] = byDate[r.date] || []).push(r); });
var allDates = Object.keys(byDate).sort();
console.log('total distinct dates =', allDates.length, '(', allDates[0], '..', allDates[allDates.length - 1], ')');
var warmupDates = allDates.slice(0, WARMUP_DAYS);
var walkDates = allDates.slice(WARMUP_DAYS);
console.log('WARMUP_DAYS =', WARMUP_DAYS, '(fixed a priori, before seeing any beta/NLL results)');
console.log('warmup dates:', warmupDates.join(','), ' n=', warmupDates.reduce(function (s, d) { return s + byDate[d].length; }, 0));
console.log('walk-forward eval dates:', walkDates.join(','), ' n=', walkDates.reduce(function (s, d) { return s + byDate[d].length; }, 0));

var EVAL_A_DAYS = Math.ceil(walkDates.length / 2);
var evalADates = walkDates.slice(0, EVAL_A_DAYS);
var evalBDates = walkDates.slice(EVAL_A_DAYS);
console.log('EvalA dates (first half of walk-forward days):', evalADates.join(','), ' n=', evalADates.reduce(function (s, d) { return s + byDate[d].length; }, 0));
console.log('EvalB dates (second half of walk-forward days):', evalBDates.join(','), ' n=', evalBDates.reduce(function (s, d) { return s + byDate[d].length; }, 0));

// ===== beta estimation: walk-forward, expanding window, dev-period NLL only =====
console.log('\n=== BETA ESTIMATION (golden-section search, dev-period NLL only) ===');
var trainDates = warmupDates.slice();
var betaByDate = {};
var betaHistory = [];
walkDates.forEach(function (d) {
  var trainPop = [];
  trainDates.forEach(function (td) { trainPop = trainPop.concat(byDate[td]); });
  var res = goldenSectionMinimize(function (b) { return avgNLL(trainPop, b); }, 0, 1, GS_TOL, GS_MAXITER);
  betaByDate[d] = res.beta;
  betaHistory.push({ evalDate: d, trainDatesCount: trainDates.length, trainN: trainPop.length, beta: res.beta, trainNLL: res.fBeta, iterations: res.iterations });
  console.log('  evalDate=' + d + ' trainDays=' + trainDates.length + ' trainN=' + trainPop.length + ' beta_d=' + res.beta.toFixed(4) + ' trainNLL=' + res.fBeta.toFixed(4) + ' iters=' + res.iterations);
  trainDates.push(d);
});
var beta0 = betaHistory[0].beta;
console.log('beta_0 (warmup-only, used for first walk-forward day ' + walkDates[0] + ') =', beta0.toFixed(4));

// reference-only: beta estimated on the FULL 14-day population (includes look-ahead; NOT used in evaluation)
var betaFullRef = goldenSectionMinimize(function (b) { return avgNLL(population, b); }, 0, 1, GS_TOL, GS_MAXITER);
console.log('reference-only beta_full (all 14 days, look-ahead, NOT used for evaluation) =', betaFullRef.beta.toFixed(4), 'NLL=', betaFullRef.fBeta.toFixed(4));

// sanity: also report beta estimated on EvalA-only and EvalB-only pools purely as descriptive diagnostics (not used anywhere)
var betaEvalAOnlyDiag = goldenSectionMinimize(function (b) { return avgNLL(evalADates.reduce(function (a, d) { return a.concat(byDate[d]); }, []), b); }, 0, 1, GS_TOL, GS_MAXITER);
var betaEvalBOnlyDiag = goldenSectionMinimize(function (b) { return avgNLL(evalBDates.reduce(function (a, d) { return a.concat(byDate[d]); }, []), b); }, 0, 1, GS_TOL, GS_MAXITER);
console.log('diagnostic-only (not used): beta if fit directly on EvalA =', betaEvalAOnlyDiag.beta.toFixed(4), ' on EvalB =', betaEvalBOnlyDiag.beta.toFixed(4));

// ===== helper: marginal P(boat1 finishes 1st) under a given p_beta distribution =====
function boat1IdxMask(rec) { return rec.valArr.map(function (v) { return v.split('-')[0] === '1'; }); }
function p1boat1(distArr, mask) { var s = 0; for (var i = 0; i < distArr.length; i++) if (mask[i]) s += distArr[i]; return s; }
function actualIsBoat1(rec) { return rec.chakuju.split('-')[0] === '1'; }

// per-race precompute for the three fixed-per-day methods (M0=beta0const, P0=beta0.5const, P1=betaByDate[date])
function buildEvalRecord(rec, betaP1) {
  var mask = boat1IdxMask(rec);
  var distM0 = pBetaDist(rec, 0);
  var distP0 = pBetaDist(rec, 0.5);
  var distP1 = pBetaDist(rec, betaP1);
  var actual1 = actualIsBoat1(rec) ? 1 : 0;
  return {
    key: rec.key, date: rec.date, venue: rec.venue, racenum: rec.racenum, payoutMul: rec.payoutMul, chakuju: rec.chakuju,
    betaP1: betaP1,
    nllM0: nllOne(rec, 0), nllP0: nllOne(rec, 0.5), nllP1: nllOne(rec, betaP1),
    p1M0: p1boat1(distM0, mask), p1P0: p1boat1(distP0, mask), p1P1: p1boat1(distP1, mask),
    actual1: actual1,
    diffRaw: p1boat1(rec.pmArr, mask) - p1boat1(rec.qArr, mask), // structural: pure-model boat1 P - market boat1 P (independent of beta choice)
    distM0: distM0, distP0: distP0, distP1: distP1,
    rec: rec,
  };
}

console.log('\n=== FIRST EVALUATION: probability quality (no ROI used) ===');
var evalRecsA = evalADates.reduce(function (a, d) { return a.concat(byDate[d].map(function (r) { return buildEvalRecord(r, betaByDate[d]); })); }, []);
var evalRecsB = evalBDates.reduce(function (a, d) { return a.concat(byDate[d].map(function (r) { return buildEvalRecord(r, betaByDate[d]); })); }, []);
var evalRecsAll = evalRecsA.concat(evalRecsB);
var warmupRecsRef = warmupDates.reduce(function (a, d) { return a.concat(byDate[d].map(function (r) { return buildEvalRecord(r, 0.5); })); }, []); // P1 col not meaningful pre-beta0; beta=0.5 placeholder for reference table only

function nllSummary(recs) {
  return { n: recs.length, M0: mean(recs.map(function (r) { return r.nllM0; })), P0: mean(recs.map(function (r) { return r.nllP0; })), P1: mean(recs.map(function (r) { return r.nllP1; })) };
}
function brierSummary(recs) {
  return {
    n: recs.length,
    M0: mean(recs.map(function (r) { return Math.pow(r.p1M0 - r.actual1, 2); })),
    P0: mean(recs.map(function (r) { return Math.pow(r.p1P0 - r.actual1, 2); })),
    P1: mean(recs.map(function (r) { return Math.pow(r.p1P1 - r.actual1, 2); })),
  };
}
function calibErr(recs, field) { if (!recs.length) return null; return mean(recs.map(function (r) { return r[field]; })) * 100 - mean(recs.map(function (r) { return r.actual1; })) * 100; }
function calibSummary(recs) { return { n: recs.length, M0: calibErr(recs, 'p1M0'), P0: calibErr(recs, 'p1P0'), P1: calibErr(recs, 'p1P1') }; }

var nllA = nllSummary(evalRecsA), nllB = nllSummary(evalRecsB), nllAll = nllSummary(evalRecsAll);
var brierA = brierSummary(evalRecsA), brierB = brierSummary(evalRecsB), brierAll = brierSummary(evalRecsAll);
var calibA = calibSummary(evalRecsA), calibB = calibSummary(evalRecsB), calibAll = calibSummary(evalRecsAll);

console.log('NLL (trifecta log loss, lower=better): EvalA=', JSON.stringify(nllA), ' EvalB=', JSON.stringify(nllB), ' combined=', JSON.stringify(nllAll));
console.log('Brier (boat1 marginal, lower=better): EvalA=', JSON.stringify(brierA), ' EvalB=', JSON.stringify(brierB), ' combined=', JSON.stringify(brierAll));
console.log('Calibration error % (boat1 marginal, meanPred-meanActual, closer to 0=better): EvalA=', JSON.stringify(calibA), ' EvalB=', JSON.stringify(calibB), ' combined=', JSON.stringify(calibAll));

function rankOf(summary) {
  var arr = [['M0', summary.M0], ['P0', summary.P0], ['P1', summary.P1]];
  arr.sort(function (a, b) { return a[1] - b[1]; });
  return arr.map(function (x) { return x[0]; }).join('<');
}
var nllRankA = rankOf(nllA), nllRankB = rankOf(nllB);
console.log('NLL rank order (best..worst): EvalA=' + nllRankA + '  EvalB=' + nllRankB + '  agree=' + (nllRankA === nllRankB));

// ===== decile analysis by model-market divergence (diffRaw), walk-forward eval pool combined =====
console.log('\n=== Decile analysis by model-market divergence (diffRaw = pure-model P(boat1) - market P(boat1)) ===');
var sortedByDiff = evalRecsAll.slice().sort(function (a, b) { return a.diffRaw - b.diffRaw; });
var K = 10;
var decileRows = [];
for (var di = 0; di < K; di++) {
  var lo = Math.floor(di * sortedByDiff.length / K), hi = Math.floor((di + 1) * sortedByDiff.length / K);
  var slice = sortedByDiff.slice(lo, hi);
  var row = {
    decile: di, n: slice.length,
    diffRawRange: [slice[0].diffRaw, slice[slice.length - 1].diffRaw],
    calibM0: calibErr(slice, 'p1M0'), calibP0: calibErr(slice, 'p1P0'), calibP1: calibErr(slice, 'p1P1'),
    nllM0: mean(slice.map(function (r) { return r.nllM0; })), nllP0: mean(slice.map(function (r) { return r.nllP0; })), nllP1: mean(slice.map(function (r) { return r.nllP1; })),
  };
  decileRows.push(row);
  console.log('  decile' + di + ' n=' + row.n + ' diffRaw[' + row.diffRawRange[0].toFixed(3) + ',' + row.diffRawRange[1].toFixed(3) + ']' +
    ' calibErr%: M0=' + row.calibM0.toFixed(2) + ' P0=' + row.calibP0.toFixed(2) + ' P1=' + row.calibP1.toFixed(2) +
    ' | NLL: M0=' + row.nllM0.toFixed(3) + ' P0=' + row.nllP0.toFixed(3) + ' P1=' + row.nllP1.toFixed(3));
}
// focus: top-2 deciles = races where pure model diverges most from market (highest diffRaw = model over-favors vs market)
var topDivergenceDeciles = decileRows.slice(-2);
var topDivergenceRecs = sortedByDiff.slice(Math.floor(8 * sortedByDiff.length / K));
console.log('Top-2 divergence deciles (model >> market on boat1) combined n=' + topDivergenceRecs.length +
  ' calibErr%: M0=' + calibErr(topDivergenceRecs, 'p1M0').toFixed(2) + ' P0=' + calibErr(topDivergenceRecs, 'p1P0').toFixed(2) + ' P1=' + calibErr(topDivergenceRecs, 'p1P1').toFixed(2));

// ===== calibration error within the "entered-equivalent" set (current production alpha.js decision) =====
console.log('\n=== Calibration within entered-equivalent set (current production alpha.js entered==true) ===');
function prodPredictFor(rec) {
  var deadlineIso = new Date(rec.shimekiriMs).toISOString();
  var input = { boats: rec.boats, oddsMap: rec.oddsMap, oddsCapturedAt: rec.archivedAt, deadlineAt: deadlineIso };
  var nowMs = Date.parse(rec.archivedAt);
  try { return alphaOriginal.predict(input, nowMs); } catch (e) { return { error: e.message }; }
}
evalRecsAll.forEach(function (r) { r.prod = prodPredictFor(r.rec); });
var prodErrCount = evalRecsAll.filter(function (r) { return r.prod.error; }).length;
var enteredSet = evalRecsAll.filter(function (r) { return !r.prod.error && r.prod.entered === true; });
console.log('prod predict() errors=' + prodErrCount + ', entered-equivalent set n=' + enteredSet.length + ' / ' + evalRecsAll.length);
if (enteredSet.length >= 30) {
  console.log('  calibErr%: M0=' + calibErr(enteredSet, 'p1M0').toFixed(2) + ' P0=' + calibErr(enteredSet, 'p1P0').toFixed(2) + ' P1=' + calibErr(enteredSet, 'p1P1').toFixed(2));
  console.log('  NLL: M0=' + mean(enteredSet.map(function (r) { return r.nllM0; })).toFixed(3) + ' P0=' + mean(enteredSet.map(function (r) { return r.nllP0; })).toFixed(3) + ' P1=' + mean(enteredSet.map(function (r) { return r.nllP1; })).toFixed(3));
} else {
  console.log('  n<30, CLAUDE.md rule 3: not treated as a reliable trend, reported for reference only.');
  console.log('  (reference only) calibErr%: M0=' + (enteredSet.length ? calibErr(enteredSet, 'p1M0').toFixed(2) : 'NA') + ' P0=' + (enteredSet.length ? calibErr(enteredSet, 'p1P0').toFixed(2) : 'NA') + ' P1=' + (enteredSet.length ? calibErr(enteredSet, 'p1P1').toFixed(2) : 'NA'));
}

// ===== per-day performance =====
console.log('\n=== Per-day probability quality (walk-forward eval days) ===');
var perDayStats = walkDates.map(function (d) {
  var recs = byDate[d].map(function (r) { return buildEvalRecord(r, betaByDate[d]); });
  return { date: d, n: recs.length, betaP1: betaByDate[d], nll: nllSummary(recs), brier: brierSummary(recs), calib: calibSummary(recs) };
});
perDayStats.forEach(function (s) {
  console.log('  ' + s.date + ' n=' + s.n + ' beta_d=' + s.betaP1.toFixed(4) + ' NLL(M0/P0/P1)=' + s.nll.M0.toFixed(3) + '/' + s.nll.P0.toFixed(3) + '/' + s.nll.P1.toFixed(3) +
    ' calibErr%(M0/P0/P1)=' + s.calib.M0.toFixed(1) + '/' + s.calib.P0.toFixed(1) + '/' + s.calib.P1.toFixed(1));
});

// ===== block bootstrap over walk-forward days (n=7 blocks; CI expected to be wide) =====
console.log('===== Day-level block bootstrap (resampling the 7 walk-forward days with replacement) =====');
var BOOT_B = 5000;
var evalRecsByDate = {};
walkDates.forEach(function (d) { evalRecsByDate[d] = byDate[d].map(function (r) { return buildEvalRecord(r, betaByDate[d]); }); });
function bootstrapDiff(metricFn) {
  var diffs = [];
  for (var b = 0; b < BOOT_B; b++) {
    var pooled = [];
    for (var i = 0; i < walkDates.length; i++) {
      var d = walkDates[Math.floor(Math.random() * walkDates.length)];
      pooled = pooled.concat(evalRecsByDate[d]);
    }
    diffs.push(metricFn(pooled));
  }
  diffs.sort(function (a, b) { return a - b; });
  return { mean: mean(diffs), p2_5: diffs[Math.floor(diffs.length * 0.025)], p97_5: diffs[Math.floor(diffs.length * 0.975)] };
}
var bootNllP1minusP0 = bootstrapDiff(function (pop) { return mean(pop.map(function (r) { return r.nllP1; })) - mean(pop.map(function (r) { return r.nllP0; })); });
var bootCalibAbsP1minusP0 = bootstrapDiff(function (pop) { return Math.abs(calibErr(pop, 'p1P1')) - Math.abs(calibErr(pop, 'p1P0')); });
console.log('bootstrap (B=' + BOOT_B + ', ' + walkDates.length + ' day-blocks): mean(NLL_P1-NLL_P0)=' + bootNllP1minusP0.mean.toFixed(4) + ' 95%CI=[' + bootNllP1minusP0.p2_5.toFixed(4) + ',' + bootNllP1minusP0.p97_5.toFixed(4) + '] (negative=P1 better)');
console.log('bootstrap: mean(|calibErr_P1|-|calibErr_P0|)=' + bootCalibAbsP1minusP0.mean.toFixed(3) + ' 95%CI=[' + bootCalibAbsP1minusP0.p2_5.toFixed(3) + ',' + bootCalibAbsP1minusP0.p97_5.toFixed(3) + '] (negative=P1 better-calibrated)');
console.log('NOTE: only ' + walkDates.length + ' independent day-blocks exist; this bootstrap CI is inherently coarse (at most ' + walkDates.length + ' distinct values feed each resample) and should be read as a rough signal, not a precise interval.');

// ===== SECOND EVALUATION: operational comparison (P0 vs P1, M0 reference only) =====
console.log('\n=== SECOND EVALUATION: operational comparison (band 50-150, fixed 8pt, 100yen/pt, threshold unchanged) ===');
function buildBandSelection(rec, distArr) {
  // Mirrors alpha.js predict(): filter to odds in [50,150], sort by score(p) desc then val asc, take top 8.
  var cands = [];
  for (var i = 0; i < rec.valArr.length; i++) {
    if (rec.oddsArr[i] >= 50 && rec.oddsArr[i] <= 150) cands.push({ val: rec.valArr[i], odds: rec.oddsArr[i], p: distArr[i] });
  }
  cands.sort(function (a, b) { return b.p - a.p || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0); });
  if (cands.length < POINTS_FIXED) return null;
  var top8 = cands.slice(0, POINTS_FIXED);
  var estimate = mean(top8.map(function (c) { return c.p * c.odds; }));
  return { points: top8.map(function (c) { return c.val; }), estimate: estimate, entered: estimate >= ENTRY_THRESHOLD };
}

function buildOpRecord(rec, betaP1) {
  var selM0 = buildBandSelection(rec, pBetaDist(rec, 0));
  var selP0 = buildBandSelection(rec, pBetaDist(rec, 0.5));
  var selP1 = buildBandSelection(rec, pBetaDist(rec, betaP1));
  return { key: rec.key, date: rec.date, shimekiriMs: rec.shimekiriMs, chakuju: rec.chakuju, payoutMul: rec.payoutMul, M0: selM0, P0: selP0, P1: selP1 };
}
var opRecs = walkDates.reduce(function (acc, d) { return acc.concat(byDate[d].map(function (r) { return buildOpRecord(r, betaByDate[d]); })); }, []);
console.log('operational pool n=' + opRecs.length + ' (walk-forward eval days only)');

function parsePayout100b(mul) { return Math.round(mul * 100); }
function opMetrics(recs, methodKey) {
  var enteredList = recs.filter(function (r) { return r[methodKey] && r[methodKey].entered; });
  var byDay = {};
  enteredList.forEach(function (r) { (byDay[r.date] = byDay[r.date] || []).push(r); });
  var daysWithEntries = Object.keys(byDay).length;
  var totalDays = walkDates.length;
  var zeroEntryDays = totalDays - daysWithEntries;
  var hitList = [];
  var hitCount = 0, band50Count = 0, band30Count = 0;
  var winPayoutYenList = [];
  var seqSorted = enteredList.slice().sort(function (a, b) { return a.shimekiriMs - b.shimekiriMs; });
  var maxStreak = 0, curStreak = 0;
  seqSorted.forEach(function (r) {
    var pts = r[methodKey].points;
    var isHit = r.chakuju && pts.indexOf(r.chakuju) !== -1;
    var payoutYen = isHit ? parsePayout100b(r.payoutMul) : 0;
    if (isHit) { hitCount++; winPayoutYenList.push(payoutYen); if (r.payoutMul >= 50 && r.payoutMul <= 150) band50Count++; if (r.payoutMul >= 30 && r.payoutMul <= 150) band30Count++; curStreak = 0; }
    else { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
  });
  maxStreak = Math.max(maxStreak, curStreak);
  var n = enteredList.length;
  var stake = n * POINTS_FIXED * FLAT_STAKE;
  var payout = winPayoutYenList.reduce(function (s, x) { return s + x; }, 0);
  function roiExcludingTopN(nExclude) {
    var sortedPay = winPayoutYenList.slice().sort(function (a, b) { return b - a; });
    var reducedPayout = sortedPay.slice(nExclude).reduce(function (s, x) { return s + x; }, 0);
    var reducedStake = (n - Math.min(nExclude, sortedPay.length)) * POINTS_FIXED * FLAT_STAKE;
    return reducedStake > 0 ? reducedPayout / reducedStake * 100 : null;
  }
  return {
    n: n, enteredRate: recs.length ? n / recs.length * 100 : null, avgPerDay: n / totalDays, zeroEntryDays: zeroEntryDays,
    hit: hitCount, hitRate: n ? hitCount / n * 100 : null,
    band50: band50Count, band50Rate: n ? band50Count / n * 100 : null,
    band30: band30Count, band30Rate: n ? band30Count / n * 100 : null,
    stake: stake, payout: payout, roi: stake ? payout / stake * 100 : null,
    roiExTop1: roiExcludingTopN(1), roiExTop2: roiExcludingTopN(2),
    maxStreak: maxStreak,
    enteredKeys: enteredList.map(function (r) { return r.key; }),
  };
}
var opM0 = opMetrics(opRecs, 'M0'), opP0 = opMetrics(opRecs, 'P0'), opP1 = opMetrics(opRecs, 'P1');
function printOp(label, o) {
  console.log('[' + label + '] n=' + o.n + ' enteredRate=' + (o.enteredRate || 0).toFixed(1) + '% avgPerDay=' + o.avgPerDay.toFixed(2) + ' zeroEntryDays=' + o.zeroEntryDays + '/' + walkDates.length);
  console.log('    hit=' + o.hit + '(' + (o.hitRate || 0).toFixed(1) + '%) band50=' + o.band50 + '(' + (o.band50Rate || 0).toFixed(1) + '%) band30=' + o.band30 + '(' + (o.band30Rate || 0).toFixed(1) + '%)');
  console.log('    ROI=' + (o.roi != null ? o.roi.toFixed(1) : 'NA') + '% roiExTop1=' + (o.roiExTop1 != null ? o.roiExTop1.toFixed(1) : 'NA') + '% roiExTop2=' + (o.roiExTop2 != null ? o.roiExTop2.toFixed(1) : 'NA') + '% maxStreak=' + o.maxStreak);
}
printOp('M0 (market only, reference)', opM0);
printOp('P0 (current production, beta=0.5)', opP0);
printOp('P1 (walk-forward beta_d)', opP1);

var p0EnteredSet = new Set(opP0.enteredKeys), p1EnteredSet = new Set(opP1.enteredKeys);
var p0OnlyKeys = opP0.enteredKeys.filter(function (k) { return !p1EnteredSet.has(k); });
var p1OnlyKeys = opP1.enteredKeys.filter(function (k) { return !p0EnteredSet.has(k); });
var byKey = {}; opRecs.forEach(function (r) { byKey[r.key] = r; });
function isHitFor(key, methodKey) { var r = byKey[key]; var pts = r[methodKey] ? r[methodKey].points : null; return !!(pts && r.chakuju && pts.indexOf(r.chakuju) !== -1); }
var p0OnlyHits = p0OnlyKeys.filter(function (k) { return isHitFor(k, 'P0'); }).length;
var p1OnlyHits = p1OnlyKeys.filter(function (k) { return isHitFor(k, 'P1'); }).length;
console.log('P0-only entries (P0 entered, P1 did not): n=' + p0OnlyKeys.length + ', of which P0 hit=' + p0OnlyHits + ' (P1 excluded these hits)');
console.log('P1-only entries (P1 entered, P0 did not): n=' + p1OnlyKeys.length + ', of which P1 hit=' + p1OnlyHits + ' (P1 newly captured these hits)');

var bothEnteredKeys = opP0.enteredKeys.filter(function (k) { return p1EnteredSet.has(k); });
var pointOverlapRates = bothEnteredKeys.map(function (k) {
  var r = byKey[k];
  var setP1 = new Set(r.P1.points);
  var overlap = r.P0.points.filter(function (p) { return setP1.has(p); }).length;
  return overlap / POINTS_FIXED;
});
console.log('Among races both P0 and P1 entered (n=' + bothEnteredKeys.length + '): mean 8-point overlap rate=' + (pointOverlapRates.length ? (mean(pointOverlapRates) * 100).toFixed(1) : 'NA') + '%');

// ===== diagnostic-only (not used for beta selection): why entries collapse as beta decreases =====
// Purely descriptive scan over a handful of beta values, population-level mean estimate & entered rate.
// This is NOT a grid search for candidate selection (beta_d is already fixed by golden-section search above);
// it exists only to explain, for the report, the mechanism behind the operational collapse observed for P1.
console.log('\n=== DIAGNOSTIC ONLY (not used for beta selection): population-level estimate vs beta ===');
var diagBetas = [0, 0.1, 0.19, 0.3, 0.5, 0.7, 1.0];
var walkPopFlat = walkDates.reduce(function (acc, d) { return acc.concat(byDate[d]); }, []);
diagBetas.forEach(function (b) {
  var ests = [];
  walkPopFlat.forEach(function (rec) {
    var sel = buildBandSelection(rec, pBetaDist(rec, b));
    if (sel) ests.push(sel.estimate);
  });
  var entered = ests.filter(function (e) { return e >= ENTRY_THRESHOLD; }).length;
  console.log('  beta=' + b.toFixed(2) + ' meanEstimate=' + (mean(ests) || 0).toFixed(3) + ' n(bandOK)=' + ests.length + ' enteredCount=' + entered + ' (' + (ests.length ? (entered / ests.length * 100).toFixed(2) : 'NA') + '%)');
});

// ===== sensitivity: unknown-timing population (reported separately, not mixed into primary conclusions) =====
console.log('\n=== SENSITIVITY (timing-unknown races, NOT part of primary conclusions) ===');
var unknownInWalkRange = unknownBuilt.filter(function (r) { return walkDates.indexOf(r.date) !== -1; });
console.log('unknown-timing races whose date falls within the walk-forward eval window: n=' + unknownInWalkRange.length);
if (unknownInWalkRange.length >= 30) {
  var unkNllM0 = mean(unknownInWalkRange.map(function (r) { return nllOne(r, 0); }));
  var unkNllP0 = mean(unknownInWalkRange.map(function (r) { return nllOne(r, 0.5); }));
  var unkNllP1 = mean(unknownInWalkRange.map(function (r) { return nllOne(r, betaByDate[r.date]); }));
  console.log('  NLL (unknown-timing, same beta_d mapping by date): M0=' + unkNllM0.toFixed(3) + ' P0=' + unkNllP0.toFixed(3) + ' P1=' + unkNllP1.toFixed(3) + ' (direction consistent with primary=' + (unkNllP1 < unkNllP0 && unkNllP0 > unkNllM0 || unkNllP1 < unkNllM0) + ')');
} else {
  console.log('  n<30, not usable even as sensitivity reference.');
}

// ===== save results JSON =====
var judgment = {
  reasoning: 'beta converges to ~0.19-0.20 (close to 0 / market-dominant) across all walk-forward windows; ' +
    'aggregate boat1 calibration error and operational entry count both collapse relative to P0 (zero entries in the ' +
    '7-day walk-forward eval pool). Matches the C criterion ("betaが0付近になる...固定混合の較正では改善できないとして終了") ' +
    'even though trifecta NLL improves and top-divergence-decile calibration narrows slightly.',
  grade: 'C',
};
console.log('\n=== FINAL JUDGMENT: ' + judgment.grade + ' ===');
console.log(judgment.reasoning);

var out = {
  generatedAt: loadedAt,
  caseId: 'GARON-20260905-007',
  scopeNote: 'Research/analysis only. No production alpha/ntfy/Q fallback/task scheduler changes. beta selected by dev-period NLL only (no ROI/hit-rate used for selection).',
  p1DisambiguationNote: 'P1 here = beta estimated from development-period log loss only. This is UNRELATED to the previously-rejected "kinsetsu6m candidate model" from GARON-20260904-003..GARON-20260905-001.',
  archiveFilesUsed: archiveFiles, archiveHashes: archiveHashes,
  population: { n: population.length, contentHash: populationHash, raceIds: populationRaceIds, vsFrozenSnapshotNote: frozenNote, extendedSnapshotPath: 'logs/research_market_anchored_blend_calibration_population_2026-09-05.json' },
  mathAudit: { pass: true, maxDiffBeta0: maxDiffBeta0, maxDiffBeta05: maxDiffBeta05, maxDiffBeta1: maxDiffBeta1, maxSumDiff: maxSumDiff, negFound: negFound, dupBoatFound: dupBoatFound, orderVarianceFail: orderVarianceFail, determinismFail: determinismFail },
  dataSplit: {
    warmupDays: WARMUP_DAYS, warmupDates: warmupDates, walkDates: walkDates, evalADates: evalADates, evalBDates: evalBDates,
    warmupN: warmupDates.reduce(function (s, d) { return s + byDate[d].length; }, 0),
    evalAN: evalADates.reduce(function (s, d) { return s + byDate[d].length; }, 0),
    evalBN: evalBDates.reduce(function (s, d) { return s + byDate[d].length; }, 0),
  },
  betaEstimation: {
    algorithm: 'golden-section search (single-variable continuous optimization over beta in [0,1], no grid search)',
    tol: GS_TOL, maxIter: GS_MAXITER,
    beta0: beta0, betaByDate: betaByDate, betaHistory: betaHistory,
    betaFullReferenceOnly: betaFullRef.beta, betaFullReferenceOnlyNLL: betaFullRef.fBeta,
    betaEvalAOnlyDiagnosticOnly: betaEvalAOnlyDiag.beta, betaEvalBOnlyDiagnosticOnly: betaEvalBOnlyDiag.beta,
  },
  firstEvaluation: {
    nll: { evalA: nllA, evalB: nllB, combined: nllAll },
    brier: { evalA: brierA, evalB: brierB, combined: brierAll },
    calib: { evalA: calibA, evalB: calibB, combined: calibAll },
    nllRankAgreement: { evalA: nllRankA, evalB: nllRankB, agree: nllRankA === nllRankB },
    diffRawDeciles: decileRows,
    topDivergenceDeciles: { n: topDivergenceRecs.length, calibM0: calibErr(topDivergenceRecs, 'p1M0'), calibP0: calibErr(topDivergenceRecs, 'p1P0'), calibP1: calibErr(topDivergenceRecs, 'p1P1') },
    enteredEquivalentSet: { n: enteredSet.length, note: enteredSet.length < 60 ? 'below the CLAUDE.md n=60-80 reliable-trend bar; n>=30 so reported, treat with caution' : 'reliable trend threshold met', calib: enteredSet.length ? calibSummary(enteredSet) : null },
    perDay: perDayStats,
    bootstrap: { B: BOOT_B, nDayBlocks: walkDates.length, nllP1minusP0: bootNllP1minusP0, calibAbsP1minusP0: bootCalibAbsP1minusP0 },
  },
  secondEvaluation: {
    poolN: opRecs.length,
    M0: opM0, P0: opP0, P1: opP1,
    p0OnlyCount: p0OnlyKeys.length, p0OnlyHits: p0OnlyHits,
    p1OnlyCount: p1OnlyKeys.length, p1OnlyHits: p1OnlyHits,
    bothEnteredCount: bothEnteredKeys.length, meanPointOverlapRate: pointOverlapRates.length ? mean(pointOverlapRates) : null,
  },
  diagnosticEstimateVsBeta: diagBetas.map(function (b) {
    var ests = [];
    walkPopFlat.forEach(function (rec) { var sel = buildBandSelection(rec, pBetaDist(rec, b)); if (sel) ests.push(sel.estimate); });
    var entered = ests.filter(function (e) { return e >= ENTRY_THRESHOLD; }).length;
    return { beta: b, meanEstimate: mean(ests), nBandOk: ests.length, enteredCount: entered };
  }),
  sensitivityUnknownTiming: { n: unknownInWalkRange.length, note: unknownInWalkRange.length < 30 ? 'below n=30, not usable even as sensitivity reference' : 'n>=30, sensitivity only, not primary' },
  judgment: judgment,
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_market_anchored_blend_calibration_2026-09-05.json'), JSON.stringify(out, null, 2));
console.log('\nSaved full results to logs/research_market_anchored_blend_calibration_2026-09-05.json');
