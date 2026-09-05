'use strict';
// GARON-20260905-008 research: market takeout-rate normalization of the entry scale.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const LEGACY_ENTRY_THRESHOLD = 1.440209615716716;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function quantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  const idx = (sortedArr.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}
function distSummary(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return {
    n: s.length, min: s[0], p50: quantile(s, 0.5), p75: quantile(s, 0.75),
    p90: quantile(s, 0.9), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s[s.length - 1],
  };
}

const alphaPath = path.join(ROOT, 'scripts', 'lib', 'alpha_engine', 'alpha.js');
const alphaOriginal = require(alphaPath);
const alphaSrc = fs.readFileSync(alphaPath, 'utf8');
const MARK = 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD};';
if (alphaSrc.indexOf(MARK) === -1) throw new Error('alpha.js export line mismatch - abort');
const patchedSrc = alphaSrc.replace(MARK, 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD,distribution};');
const mm = new Module(alphaPath, module);
mm.filename = alphaPath;
mm.paths = Module._nodeModulePaths(path.dirname(alphaPath));
mm._compile(patchedSrc, alphaPath);
const alphaExt = mm.exports;
if (alphaOriginal.ENTRY_THRESHOLD !== LEGACY_ENTRY_THRESHOLD) throw new Error('ENTRY_THRESHOLD mismatch - abort');
console.log('alpha.js loaded (distribution exposed via memory patch). ENTRY_THRESHOLD(legacy, reference only)=', alphaOriginal.ENTRY_THRESHOLD);

const popPath = path.join(ROOT, 'logs', 'research_market_anchored_blend_calibration_population_2026-09-05.json');
const calPath = path.join(ROOT, 'logs', 'research_market_anchored_blend_calibration_2026-09-05.json');
const popFile = JSON.parse(fs.readFileSync(popPath, 'utf8'));
const calFile = JSON.parse(fs.readFileSync(calPath, 'utf8'));
const popFileHash = sha256(fs.readFileSync(popPath));
const calFileHash = sha256(fs.readFileSync(calPath));
console.log('reused population file hash=', popFileHash, 'contentHash(inside)=', popFile.contentHash, 'n=', popFile.count);
console.log('reused calibration file hash=', calFileHash);
if (popFile.count !== popFile.races.length) throw new Error('population count mismatch');

const betaByDate = calFile.betaEstimation.betaByDate;
const walkDates = calFile.dataSplit.walkDates;
const warmupDates = calFile.dataSplit.warmupDates;
console.log('walkDates (held-out, out-of-sample for beta_d) =', walkDates.join(','));
console.log('warmupDates (training-only, excluded from diagnosis per spec) =', warmupDates.join(','));

function validOddsEntries(oddsMap) {
  return Object.entries(oddsMap || {}).map(([val, v]) => ({ val, odds: Number(v) })).filter(e => Number.isFinite(e.odds) && e.odds > 0);
}
function parsePayout100(mul) { return Math.round(mul * 100); }

function buildRec(r) {
  const entries = validOddsEntries(r.oddsMap).slice().sort((a, b) => a.val < b.val ? -1 : a.val > b.val ? 1 : 0);
  if (entries.length !== 120) return { skip: 'NOT_120_VALID_ODDS' };
  let dist;
  try { dist = alphaExt.distribution(r.boats); } catch (e) { return { skip: 'DIST_ERROR:' + e.message }; }
  const pmSum = dist.reduce((s, c) => s + c.p, 0);
  if (Math.abs(pmSum - 1) > 1e-9) return { skip: 'INVALID_PM_SUM' };
  const pmMap = new Map(dist.map(c => [c.val, c.p]));
  if (!entries.every(e => pmMap.has(e.val))) return { skip: 'VAL_SET_MISMATCH' };
  const valArr = entries.map(e => e.val);
  const oddsArr = entries.map(e => e.odds);
  const pmArr = valArr.map(v => pmMap.get(v));
  const invOddsSum = oddsArr.reduce((s, o) => s + 1 / o, 0);
  const qArr = oddsArr.map(o => (1 / o) / invOddsSum);
  const S = invOddsSum;
  const marketBaseline = 1 / S;
  const chakujuIdx = valArr.indexOf(r.chakuju);
  if (chakujuIdx === -1) return { skip: 'CHAKUJU_NOT_IN_120' };
  return {
    skip: null, key: r.key, date: r.date, venue: r.venue, racenum: r.racenum,
    shimekiri: r.shimekiri, archivedAt: r.archivedAt,
    valArr, oddsArr, pmArr, qArr, S, marketBaseline,
    chakuju: r.chakuju, chakujuIdx, payoutMul: r.payoutMul,
    boats: r.boats, oddsMap: r.oddsMap,
  };
}

const built = popFile.races.map(buildRec);
const skipCounts = {};
built.forEach(x => { if (x.skip) skipCounts[x.skip] = (skipCounts[x.skip] || 0) + 1; });
const population = built.filter(x => !x.skip);
console.log('population usable for this analysis n=', population.length, ' (of', popFile.count, ') skip breakdown=', JSON.stringify(skipCounts));

const heldOut = population.filter(r => walkDates.indexOf(r.date) !== -1);
console.log('held-out diagnostic set (walk-forward days only, beta_d out-of-sample) n=', heldOut.length);

function logSumExp(arr) { let mx = arr[0]; for (let i = 1; i < arr.length; i++) if (arr[i] > mx) mx = arr[i]; let s = 0; for (let j = 0; j < arr.length; j++) s += Math.exp(arr[j] - mx); return mx + Math.log(s); }
function pBetaDist(rec, beta) {
  const n = rec.pmArr.length;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) raw[i] = beta * Math.log(rec.pmArr[i]) + (1 - beta) * Math.log(rec.qArr[i]);
  const logZ = logSumExp(raw);
  return raw.map(v => Math.exp(v - logZ));
}

function buildBandSelection(rec, distArr) {
  const cands = [];
  for (let i = 0; i < rec.valArr.length; i++) {
    if (rec.oddsArr[i] >= 50 && rec.oddsArr[i] <= 150) cands.push({ val: rec.valArr[i], odds: rec.oddsArr[i], p: distArr[i] });
  }
  cands.sort((a, b) => b.p - a.p || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  if (cands.length < POINTS_FIXED) return null;
  const top8 = cands.slice(0, POINTS_FIXED);
  const rawEstimate = mean(top8.map(c => c.p * c.odds));
  return { points: top8.map(c => c.val), rawEstimate };
}

console.log('\n=== SECTION 3: MATH AUDIT ===');
const TOL = 1e-9;
let auditRows = [];
let auditAllPass = true;
function record(name, pass, detail) { auditRows.push({ name, pass, detail }); if (!pass) auditAllPass = false; console.log('  [' + (pass ? 'PASS' : 'FAIL') + '] ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }

{
  let maxDev = 0, worstKey = null;
  for (const rec of population) {
    const dist0 = pBetaDist(rec, 0);
    const sel = buildBandSelection(rec, dist0);
    if (!sel) continue;
    const normalizedLift = sel.rawEstimate * rec.S;
    const dev = Math.abs(normalizedLift - 1);
    if (dev > maxDev) { maxDev = dev; worstKey = rec.key; }
  }
  record('beta=0: normalizedLift==1 for all races (band-restricted top8)', maxDev < 1e-8, { maxDev, worstKey });
}

{
  const bases = population.map(r => r.marketBaseline);
  const summary = distSummary(bases.slice().sort((a, b) => a - b));
  record('marketBaseline distribution centers near ~0.75 (takeout-rate complement)', summary.p50 > 0.70 && summary.p50 < 0.80, summary);
}

{
  let mismatches = 0, checked = 0;
  for (const rec of heldOut) {
    const betaD = betaByDate[rec.date];
    const selP0 = buildBandSelection(rec, pBetaDist(rec, 0.5));
    const selP1 = buildBandSelection(rec, pBetaDist(rec, betaD));
    for (const sel of [selP0, selP1]) {
      if (!sel) continue;
      checked++;
      const normalizedLift = sel.rawEstimate * rec.S;
      const a = sel.rawEstimate > 1;
      const b = normalizedLift > rec.S;
      if (a !== b) mismatches++;
    }
  }
  record('rawEstimate>1 is exactly equivalent to normalizedLift>S (P0/P1, held-out set)', mismatches === 0, { checked, mismatches });
}

{
  let maxDiff = 0, worstKey = null, compared = 0, prodSkipped = 0;
  for (const rec of population) {
    const dist05 = pBetaDist(rec, 0.5);
    const sel = buildBandSelection(rec, dist05);
    if (!sel) continue;
    const timeMatch = String(rec.shimekiri).match(/(\d{1,2}):(\d{2})/) || ['', '00', '00'];
    const deadlineIso = new Date(Date.parse(rec.date + 'T' + timeMatch[1].padStart(2, '0') + ':' + timeMatch[2] + ':00.000+09:00')).toISOString();
    const nowMs = Date.parse(rec.archivedAt);
    let prod;
    try { prod = alphaOriginal.predict({ boats: rec.boats, oddsMap: rec.oddsMap, oddsCapturedAt: rec.archivedAt, deadlineAt: deadlineIso }, nowMs); } catch (e) { prod = { error: e.message }; }
    if (prod.error || prod.estimatedReturn === undefined) { prodSkipped++; continue; }
    compared++;
    const diff = Math.abs(prod.estimatedReturn - sel.rawEstimate);
    if (diff > maxDiff) { maxDiff = diff; worstKey = rec.key; }
  }
  record('beta=0.5 rawEstimate matches production predict().estimatedReturn', maxDiff < 1e-9, { maxDiff, worstKey, compared, prodSkipped });
}

{
  let maxDev = 0;
  for (const rec of population) {
    for (const b of [0, 0.19, 0.5, 1]) {
      const d = pBetaDist(rec, b);
      const s = d.reduce((a, x) => a + x, 0);
      maxDev = Math.max(maxDev, Math.abs(s - 1));
    }
  }
  record('P0/P1 (and beta=0,1 reference) sum to 1 over 120 combos', maxDev < 1e-8, { maxDev });
}

{
  const rec = population[0];
  const idx = rec.valArr.map((v, i) => i);
  for (let s = idx.length - 1; s > 0; s--) { const j = Math.floor(Math.random() * (s + 1)); const t = idx[s]; idx[s] = idx[j]; idx[j] = t; }
  const shuffledRec = { pmArr: idx.map(i => rec.pmArr[i]), qArr: idx.map(i => rec.qArr[i]) };
  const beta = 0.37;
  const orig = pBetaDist(rec, beta);
  const shuf = pBetaDist(shuffledRec, beta);
  let maxDiff = 0;
  for (let k = 0; k < idx.length; k++) maxDiff = Math.max(maxDiff, Math.abs(orig[idx[k]] - shuf[k]));
  record('enumeration-order invariance (120-combo order shuffled)', maxDiff < TOL, { maxDiff });
}

{
  const rec = population[Math.min(1, population.length - 1)];
  const a = pBetaDist(rec, 0.42);
  const b = pBetaDist(rec, 0.42);
  const identical = a.every((v, i) => v === b[i]);
  record('determinism (same input/beta, rerun twice)', identical, {});
}

{
  const anyInvalidPassedThrough = population.some(rec => rec.oddsArr.some(o => !(Number.isFinite(o) && o > 0)) || rec.valArr.some(v => !/^[1-6]-[1-6]-[1-6]$/.test(v) || new Set(v.split('-')).size !== 3));
  record('invalid/missing odds excluded consistently with production INVALID_ODDS gate', !anyInvalidPassedThrough, { skipCounts });
}

console.log('\n=== SECTION 3 RESULT: ' + (auditAllPass ? 'ALL PASS' : 'FAIL') + ' ===');

const out = {
  generatedAt: new Date().toISOString(),
  caseId: 'GARON-20260905-008',
  scopeNote: 'Research/diagnosis only. No threshold search, no beta/threshold co-optimization, no ROI-based selection. Reuses GARON-20260905-007 population/beta artifacts verbatim.',
  reusedArtifacts: { populationFile: 'logs/research_market_anchored_blend_calibration_population_2026-09-05.json', populationFileHash: popFileHash, calibrationFile: 'logs/research_market_anchored_blend_calibration_2026-09-05.json', calibrationFileHash: calFileHash },
  population: { totalLoaded: popFile.count, usable: population.length, skipCounts, heldOutN: heldOut.length, walkDates, warmupDates, betaByDate },
  mathAudit: { allPass: auditAllPass, rows: auditRows },
};

if (!auditAllPass) {
  out.judgment = { grade: 'D', reasoning: 'Math audit failed; see mathAudit.rows for which check(s) failed.' };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_market_takeout_normalized_estimate_2026-09-05.json'), JSON.stringify(out, null, 2));
  console.log('AUDIT FAILED. Per spec, stopping before section 4/5 (D judgment).');
  process.exit(1);
}

console.log('\n=== SECTION 4: DIAGNOSTIC DISTRIBUTIONS (held-out, n=' + heldOut.length + ') ===');

function computeForMethod(recs, methodFn) {
  const rows = [];
  for (const rec of recs) {
    const dist = methodFn(rec);
    const sel = buildBandSelection(rec, dist);
    if (!sel) continue;
    const normalizedLift = sel.rawEstimate * rec.S;
    rows.push({ key: rec.key, date: rec.date, venue: rec.venue, rawEstimate: sel.rawEstimate, marketBaseline: rec.marketBaseline, normalizedLift, S: rec.S, points: sel.points, chakuju: rec.chakuju, payoutMul: rec.payoutMul, shimekiri: rec.shimekiri });
  }
  return rows;
}
const rowsP0 = computeForMethod(heldOut, rec => pBetaDist(rec, 0.5));
const rowsP1 = computeForMethod(heldOut, rec => pBetaDist(rec, betaByDate[rec.date]));

function reportDist(label, rows) {
  const rawArr = rows.map(r => r.rawEstimate);
  const baseArr = rows.map(r => r.marketBaseline);
  const liftArr = rows.map(r => r.normalizedLift);
  const rawOver1 = rows.filter(r => r.rawEstimate > 1).length;
  const liftOver1 = rows.filter(r => r.normalizedLift > 1).length;
  const liftOverS = rows.filter(r => r.normalizedLift > r.S).length;
  const legacyThreshOver = rows.filter(r => r.rawEstimate >= LEGACY_ENTRY_THRESHOLD).length;
  const byDate = {}; rows.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + 1; });
  const byVenue = {}; rows.forEach(r => { byVenue[r.venue] = (byVenue[r.venue] || 0) + 1; });
  console.log('[' + label + '] bandOK n=' + rows.length);
  console.log('  rawEstimate:', JSON.stringify(distSummary(rawArr)));
  console.log('  marketBaseline:', JSON.stringify(distSummary(baseArr)));
  console.log('  normalizedLift:', JSON.stringify(distSummary(liftArr)));
  console.log('  rawEstimate>1 count=' + rawOver1 + '  normalizedLift>1 count=' + liftOver1 + '  normalizedLift>S count=' + liftOverS + ' (should equal rawEstimate>1 count)');
  console.log('  legacy threshold(' + LEGACY_ENTRY_THRESHOLD + ') pass count=' + legacyThreshOver + ' (reference only, not used for any new decision)');
  console.log('  by-date:', JSON.stringify(byDate));
  console.log('  by-venue:', JSON.stringify(byVenue));
  return {
    bandOkN: rows.length,
    rawEstimateDist: distSummary(rawArr), marketBaselineDist: distSummary(baseArr), normalizedLiftDist: distSummary(liftArr),
    rawEstimateOver1: rawOver1, normalizedLiftOver1: liftOver1, normalizedLiftOverS: liftOverS,
    legacyThresholdPassCount: legacyThreshOver, byDate, byVenue,
  };
}
const diagP0 = reportDist('P0 (beta=0.5, current production)', rowsP0);
const diagP1 = reportDist('P1 (beta_d, walk-forward log-loss calibrated)', rowsP1);

console.log('\n=== SECTION 5: rawEstimate>1 CANDIDATE DIAGNOSIS (breakeven, NOT an ROI-chosen threshold) ===');

function candidateMetrics(rows, label) {
  const cand = rows.filter(r => r.rawEstimate > 1);
  const n = cand.length;
  const stake = n * POINTS_FIXED * FLAT_STAKE;
  let hit = 0, band50 = 0, band30 = 0;
  const payoutList = [];
  const sorted = cand.slice().sort((a, b) => Date.parse(a.date + 'T00:00:00') - Date.parse(b.date + 'T00:00:00') || (a.shimekiri || '').localeCompare(b.shimekiri || ''));
  let maxStreak = 0, curStreak = 0;
  const daysWithEntry = new Set();
  sorted.forEach(r => {
    daysWithEntry.add(r.date);
    const isHit = r.chakuju && r.points.indexOf(r.chakuju) !== -1;
    const payoutYen = isHit ? parsePayout100(r.payoutMul) : 0;
    if (isHit) { hit++; payoutList.push(payoutYen); if (r.payoutMul >= 50 && r.payoutMul <= 150) band50++; if (r.payoutMul >= 30 && r.payoutMul <= 150) band30++; curStreak = 0; }
    else { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
  });
  maxStreak = Math.max(maxStreak, curStreak);
  const payout = payoutList.reduce((s, x) => s + x, 0);
  function roiExcludingTopN(nExclude) {
    const sortedPay = payoutList.slice().sort((a, b) => b - a);
    const reducedPayout = sortedPay.slice(nExclude).reduce((s, x) => s + x, 0);
    const reducedStake = (n - Math.min(nExclude, sortedPay.length)) * POINTS_FIXED * FLAT_STAKE;
    return reducedStake > 0 ? reducedPayout / reducedStake * 100 : null;
  }
  const totalDays = walkDates.length;
  const zeroEntryDays = totalDays - daysWithEntry.size;
  const result = {
    label, targetN: rows.length, candidateN: n,
    hit, hitRate: n ? hit / n * 100 : null,
    band50, band50Rate: n ? band50 / n * 100 : null,
    band30, band30Rate: n ? band30 / n * 100 : null,
    stake, payout, roi: stake ? payout / stake * 100 : null,
    roiExTop1: roiExcludingTopN(1), roiExTop2: roiExcludingTopN(2),
    daysWithEntry: daysWithEntry.size, totalDays, zeroEntryDays,
    avgPerDay: n / totalDays, maxStreak,
    n30Note: n < 30 ? '成績判断不能(n<30、CLAUDE.mdルール3)' : (n < 60 ? '参考傾向(n>=30だがn=60-80未満)' : '傾向として信頼できる目安を満たす'),
  };
  console.log('[' + label + '] candidateN=' + n + '/' + rows.length + ' hit=' + hit + '(' + (result.hitRate || 0).toFixed(1) + '%) band50-150=' + band50 + '(' + (result.band50Rate || 0).toFixed(1) + '%) band30-150=' + band30 + '(' + (result.band30Rate || 0).toFixed(1) + '%)');
  console.log('    stake=' + stake + ' payout=' + payout + ' ROI=' + (result.roi != null ? result.roi.toFixed(1) : 'NA') + '% roiExTop1=' + (result.roiExTop1 != null ? result.roiExTop1.toFixed(1) : 'NA') + '% roiExTop2=' + (result.roiExTop2 != null ? result.roiExTop2.toFixed(1) : 'NA') + '% daysWithEntry=' + daysWithEntry.size + '/' + totalDays + ' avgPerDay=' + result.avgPerDay.toFixed(2) + ' maxStreak=' + maxStreak);
  console.log('    ' + result.n30Note);
  return result;
}
const candP0 = candidateMetrics(rowsP0, 'P0 rawEstimate>1');
const candP1 = candidateMetrics(rowsP1, 'P1 rawEstimate>1');

let grade, reasoning;
if (candP1.candidateN === 0) {
  grade = 'C';
  reasoning = 'P1(beta_d)でrawEstimate>1の候補が0件であり、現行モデルの予測差では市場控除を超える候補を十分生成できていない。参入尺度の探索はここで終了し、純モデルの情報量改善に研究を戻すべき。';
} else if (candP1.candidateN < 30) {
  grade = 'B';
  reasoning = 'P1でrawEstimate>1の候補が存在するが n=' + candP1.candidateN + ' で30未満のため、CLAUDE.mdルール3により成績判断は不能。前向きシャドー記録のみを提案する。';
} else {
  grade = 'A(要期間分割再検証)';
  reasoning = 'P1でrawEstimate>1の候補が n=' + candP1.candidateN + '(>=30)存在。ただし単一の7日間held-outウィンドウのみであり、期間分割での一貫性確認が別途必要。';
}
console.log('\n=== FINAL JUDGMENT: ' + grade + ' ===');
console.log(reasoning);

out.diagnostics = { P0: diagP0, P1: diagP1 };
out.candidates = { P0: candP0, P1: candP1 };
out.judgment = { grade, reasoning };
fs.writeFileSync(path.join(ROOT, 'logs', 'research_market_takeout_normalized_estimate_2026-09-05.json'), JSON.stringify(out, null, 2));
console.log('\nSaved full results to logs/research_market_takeout_normalized_estimate_2026-09-05.json');
