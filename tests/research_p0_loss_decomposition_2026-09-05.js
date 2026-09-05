'use strict';
// GARON-20260905-002 (research)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const BAND_LO = 50, BAND_HI = 150;

const { alphaP0, distributionP1 } = require('./lib/p1_kinsetsu_candidate_predictor_2026-09-05.js');
const { loadAllRaces, isUsable } = require('./q_engine_entry_backtest.js');

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
function mean(arr) { return arr.length ? arr.reduce(function (s, x) { return s + x; }, 0) / arr.length : null; }
function median(arr) { if (!arr.length) return null; const s = arr.slice().sort(function (a, b) { return a - b; }); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

function sortedDesc(dist) {
  return dist.slice().sort(function (a, b) { return b.p - a.p || a.val.localeCompare(b.val); });
}
function rankOf(sortedArr, val) {
  for (let i = 0; i < sortedArr.length; i++) if (sortedArr[i].val === val) return i + 1;
  return null;
}
function stageDecomp(dist, chakuju) {
  const pm = new Map(dist.map(function (c) { return [c.val, c.p]; }));
  const parts = chakuju.split('-').map(Number);
  const b1 = parts[0], b2 = parts[1], b3 = parts[2];
  const p1 = {};
  for (let c = 1; c <= 6; c++) p1[c] = 0;
  for (const e of dist) { const f = Number(e.val.split('-')[0]); p1[f] += e.p; }
  const argmax1 = Object.keys(p1).reduce(function (a, b) { return p1[b] > p1[a] ? b : a; });
  if (Number(argmax1) !== b1) return { stage: 1, greedyMatch: false };
  const p2 = {};
  for (let c = 1; c <= 6; c++) if (c !== b1) p2[c] = 0;
  for (const e of dist) {
    const sp = e.val.split('-');
    if (Number(sp[0]) === b1) { const s = Number(sp[1]); p2[s] += e.p; }
  }
  const argmax2 = Object.keys(p2).reduce(function (a, b) { return p2[b] > p2[a] ? b : a; });
  if (Number(argmax2) !== b2) return { stage: 2, greedyMatch: false };
  const p3 = {};
  for (let c = 1; c <= 6; c++) if (c !== b1 && c !== b2) p3[c] = pm.get(b1 + '-' + b2 + '-' + c) || 0;
  const argmax3 = Object.keys(p3).reduce(function (a, b) { return p3[b] > p3[a] ? b : a; });
  if (Number(argmax3) !== b3) return { stage: 3, greedyMatch: false };
  return { stage: null, greedyMatch: true };
}

function buildRecord(r, opts) {
  opts = opts || {};
  const entries = validOddsEntries(r.oddsMap);
  if (entries.length !== 120) return { skip: 'ODDS_NOT_120' };
  if (!r.chakuju || !/^[1-6]-[1-6]-[1-6]$/.test(r.chakuju)) return { skip: 'NO_CHAKUJU' };
  let distP0;
  try { distP0 = alphaP0.distribution(r.boats); } catch (e) { return { skip: 'P0_DIST_ERROR:' + e.message }; }
  const pmSum = distP0.reduce(function (s, c) { return s + c.p; }, 0);
  if (Math.abs(pmSum - 1) > 1e-9) return { skip: 'INVALID_P0_DIST' };
  const p0Sorted = sortedDesc(distP0);
  const pmP0 = new Map(distP0.map(function (c) { return [c.val, c.p]; }));
  const rankP0Full = rankOf(p0Sorted, r.chakuju);

  const chEntry = entries.find(function (e) { return e.val === r.chakuju; });
  const oddsAtPred = chEntry ? chEntry.odds : null;
  const inBandPred = oddsAtPred != null && oddsAtPred >= BAND_LO && oddsAtPred <= BAND_HI;

  const bandEntries = entries.filter(function (e) { return e.odds >= BAND_LO && e.odds <= BAND_HI; });
  const bandSize = bandEntries.length;

  let bandPureRank = null, bandMixedRank = null;
  if (bandSize > 0) {
    const bandPureSorted = bandEntries.slice().map(function (e) { return { val: e.val, p: pmP0.get(e.val) }; })
      .sort(function (a, b) { return b.p - a.p || a.val.localeCompare(b.val); });
    bandPureRank = inBandPred ? rankOf(bandPureSorted, r.chakuju) : null;
    const bandMixedSorted = bandEntries.slice().map(function (e) { return { val: e.val, mass: Math.sqrt(Math.max(pmP0.get(e.val), Number.MIN_VALUE) / e.odds) }; })
      .sort(function (a, b) { return b.mass - a.mass || a.val.localeCompare(b.val); });
    bandMixedRank = inBandPred ? rankOf(bandMixedSorted.map(function (x) { return { val: x.val, p: x.mass }; }), r.chakuju) : null;
  }

  const deadlineMs = shimekiriMs(r.date, r.shimekiri);
  const input = { boats: r.boats, oddsMap: r.oddsMap, oddsCapturedAt: r.archivedAt, deadlineAt: deadlineMs != null ? new Date(deadlineMs).toISOString() : null };
  const nowMs = Date.parse(r.archivedAt);
  let prod;
  try { prod = alphaP0.predict(input, nowMs); } catch (e) { prod = { error: e.message }; }
  const prodError = prod && prod.error ? prod.error : ((prod && prod.points && prod.points.length === 0) ? prod.reason : null);
  const prodPointsArr = (prod && prod.points) ? prod.points.map(function (p) { return p.combination; }) : [];
  const prodEntered = prod ? !!prod.entered : false;
  const prodEstimate = (prod && typeof prod.estimatedReturn === 'number') ? prod.estimatedReturn : null;
  const actualInBet = prodPointsArr.indexOf(r.chakuju) !== -1;
  const mixOk = (bandMixedRank != null && bandMixedRank <= 8) === actualInBet;
  const mixConsistency = prodPointsArr.length === 0 ? true : mixOk;

  const payoutMul = parsePayout100(r.payout) / 100;
  const confirmedInBand = payoutMul >= BAND_LO && payoutMul <= BAND_HI;
  const hit = prodEntered && actualInBet;

  let stageP0 = null;
  try { stageP0 = stageDecomp(distP0, r.chakuju); } catch (e) { stageP0 = { error: e.message }; }

  const rec = {
    key: r.date + '_' + r.venue + '_' + r.racenum, date: r.date, venue: r.venue, racenum: r.racenum,
    chakuju: r.chakuju, payoutMul: payoutMul, confirmedInBand: confirmedInBand,
    rankP0Full: rankP0Full, oddsAtPred: oddsAtPred, inBandPred: inBandPred, bandSize: bandSize,
    bandPureRank: bandPureRank, bandMixedRank: bandMixedRank,
    prodError: prodError, prodEntered: prodEntered, prodEstimate: prodEstimate,
    actualInBet: actualInBet, hit: hit, mixConsistency: mixConsistency, stageP0: stageP0,
    prodPointsCount: prodPointsArr.length, prodPoints: prodPointsArr,
  };

  if (opts.includeP1) {
    try {
      const distP1 = distributionP1(r.boats);
      const p1Sum = distP1.reduce(function (s, c) { return s + c.p; }, 0);
      if (Math.abs(p1Sum - 1) <= 1e-9) {
        const p1Sorted = sortedDesc(distP1);
        rec.rankP1Full = rankOf(p1Sorted, r.chakuju);
        const pmP1 = new Map(distP1.map(function (c) { return [c.val, c.p]; }));
        if (bandSize > 0 && inBandPred) {
          const bandPureSortedP1 = bandEntries.slice().map(function (e) { return { val: e.val, p: pmP1.get(e.val) }; })
            .sort(function (a, b) { return b.p - a.p || a.val.localeCompare(b.val); });
          rec.bandPureRankP1 = rankOf(bandPureSortedP1, r.chakuju);
          const bandMixedSortedP1 = bandEntries.slice().map(function (e) { return { val: e.val, mass: Math.sqrt(Math.max(pmP1.get(e.val), Number.MIN_VALUE) / e.odds) }; })
            .sort(function (a, b) { return b.mass - a.mass || a.val.localeCompare(b.val); });
          rec.bandMixedRankP1 = rankOf(bandMixedSortedP1.map(function (x) { return { val: x.val, p: x.mass }; }), r.chakuju);
        } else { rec.bandPureRankP1 = null; rec.bandMixedRankP1 = null; }
        rec.stageP1 = stageDecomp(distP1, r.chakuju);
      } else { rec.p1Error = 'INVALID_P1_DIST'; }
    } catch (e) { rec.p1Error = e.message; }
  }
  return { skip: null, rec: rec };
}

console.log('=== P0 loss decomposition (GARON-20260905-002) ===\n');

console.log('--- 1. populations ---');
const snapA = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_pure_prediction_true_t10_snapshot_2026-09-04.json'), 'utf8'));
const racesA = snapA.races;
console.log('(a) true-T10 out-of-sample: n=', racesA.length, racesA[0].date, 'to', racesA[racesA.length - 1].date);

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
const allRaces = loadAllRaces();
const usableRaces = allRaces.filter(isUsable);
const trueT10All = usableRaces.filter(function (r) { return classifyTimingFixed(r).cls === 'true' && validOddsEntries(r.oddsMap).length === 120; });
const racesB = trueT10All.filter(function (r) { return r.date < '2026-08-21'; });
console.log('(b) true-T10 in-sample: n=', racesB.length, '(structurally zero: T-10 archive capture only began 2026-08-21, excluded from structural diagnosis too)');

const extC = usableRaces.filter(function (r) { return validOddsEntries(r.oddsMap).length === 120; });
console.log('(c) extended set (isUsable && valid 120 odds, any timing): n=', extC.length);
const extCband = extC.filter(function (r) { return parsePayout100(r.payout) / 100 >= BAND_LO && parsePayout100(r.payout) / 100 <= BAND_HI; });
console.log('    of which confirmed payout 50-150x: n=', extCband.length);

function loadForwardDay(judgFile, archiveFile) {
  const jp = path.join(ROOT, 'logs', judgFile);
  const ap = path.join(ROOT, archiveFile);
  if (!fs.existsSync(jp) || !fs.existsSync(ap)) return { races: [], attempted: 0, restoreFail: 0, reasons: {} };
  const judg = JSON.parse(fs.readFileSync(jp, 'utf8'));
  const arr = judg.judgments || judg;
  const archive = JSON.parse(fs.readFileSync(ap, 'utf8'));
  const archIndex = new Map(archive.map(function (r) { return [r.date + '_' + r.venue + '_' + r.racenum, r]; }));
  const races = []; const reasons = {};
  let attempted = 0, restoreFail = 0;
  for (const j of arr) {
    if (!j.points || j.points.length === 0) continue;
    attempted++;
    const arch = archIndex.get(j.raceKey);
    if (!arch) { restoreFail++; reasons.NO_ARCHIVE_MATCH = (reasons.NO_ARCHIVE_MATCH || 0) + 1; continue; }
    const diffMs = Math.abs(Date.parse(arch.archivedAt) - Date.parse(j.dataCollectedAt));
    if (!(diffMs <= 5 * 60 * 1000)) { restoreFail++; reasons.ARCHIVEDAT_TOO_FAR = (reasons.ARCHIVEDAT_TOO_FAR || 0) + 1; continue; }
    if (!arch.resulted || !arch.chakuju || !arch.payout) { restoreFail++; reasons.NOT_RESULTED = (reasons.NOT_RESULTED || 0) + 1; continue; }
    if (validOddsEntries(arch.oddsMap).length !== 120) { restoreFail++; reasons.ODDS_NOT_120 = (reasons.ODDS_NOT_120 || 0) + 1; continue; }
    races.push(arch);
  }
  return { races: races, attempted: attempted, restoreFail: restoreFail, reasons: reasons };
}
const fwd0903 = loadForwardDay('alpha_live_judgments_2026-09-03.json', 'daikibo_archive_2026-09-03.json');
const fwd0904 = loadForwardDay('alpha_live_judgments_2026-09-04.json', 'daikibo_archive_2026-09-04.json');
const fwd0905 = loadForwardDay('alpha_live_judgments_2026-09-05.json', 'daikibo_archive_2026-09-05.json');
const racesD = fwd0903.races.concat(fwd0904.races).concat(fwd0905.races);
console.log('(d) forward record restore: 09-03 attempted=' + fwd0903.attempted + ' restored=' + fwd0903.races.length + ' fail=' + JSON.stringify(fwd0903.reasons));
console.log('                     09-04 attempted=' + fwd0904.attempted + ' restored=' + fwd0904.races.length + ' fail=' + JSON.stringify(fwd0904.reasons));
console.log('                     09-05 attempted=' + fwd0905.attempted + ' restored=' + fwd0905.races.length + ' fail=' + JSON.stringify(fwd0905.reasons));
console.log('    (d) total n=', racesD.length, '(n<30, reference only per rule 3)');

console.log('\n--- 2. record building ---');
function buildAll(races, opts) {
  const built = races.map(function (r) { return buildRecord(r, opts); });
  const skipCounts = {};
  built.forEach(function (x) { if (x.skip) skipCounts[x.skip] = (skipCounts[x.skip] || 0) + 1; });
  const pop = built.filter(function (x) { return !x.skip; }).map(function (x) { return x.rec; });
  return { pop: pop, skipCounts: skipCounts, total: races.length };
}
const A = buildAll(racesA, { includeP1: true });
console.log('(a) built: total=' + A.total + ' valid=' + A.pop.length + ' skip=' + JSON.stringify(A.skipCounts));
const D = buildAll(racesD, { includeP1: true });
console.log('(d) built: total=' + D.total + ' valid=' + D.pop.length + ' skip=' + JSON.stringify(D.skipCounts));
const Cband = buildAll(extCband, { includeP1: false });
console.log('(c)-band built: total=' + Cband.total + ' valid=' + Cband.pop.length + ' skip=' + JSON.stringify(Cband.skipCounts));

function qcMixConsistency(pop) { return pop.filter(function (r) { return !r.mixConsistency; }).length; }
console.log('QC mixConsistency violations: (a)=' + qcMixConsistency(A.pop) + ' (d)=' + qcMixConsistency(D.pop) + ' (c-band)=' + qcMixConsistency(Cband.pop));

console.log('\n--- 3-1. exclusive A-G classification (confirmed 50-150x population) ---');
// Priority (documented, applied mechanically, no post-hoc tuning):
// G: bandSize<8 (cannot build 8pt from band) or prod computation error other than BELOW_THRESHOLD/CANDIDATE_ENTRY
// A: rankP0Full > K (pure model does not rate the correct combo highly)
// B: rankP0Full<=K but not in odds band at prediction time
// (else, rankP0Full<=K && inBandPred):
//   if bandMixedRank<=8 (i.e. actually in the 8pt bet): F if entered(=hit), E if not entered
//   else: C if bandPureRank<=8 (mixing specifically pushed it out of top8), D otherwise (already outside band-pure top8; 8pt-limit issue)
function classify3_1(rec, K) {
  if (rec.bandSize < 8) return 'G_INSUFFICIENT_BAND';
  if (rec.prodError && rec.prodError !== 'BELOW_THRESHOLD' && rec.prodError !== 'CANDIDATE_ENTRY') return 'G_OTHER:' + rec.prodError;
  // F/E first: actual outcome (in-band-mixed-top8) must not be pre-empted by a coarse full-120 rank check.
  if (rec.actualInBet) return rec.prodEntered ? 'F' : 'E';
  if (rec.rankP0Full > K) return 'A';
  if (!rec.inBandPred) return 'B';
  if (rec.bandPureRank != null && rec.bandPureRank <= 8) return 'C';
  return 'D';
}
function tally3_1(pop, K) {
  const counts = {};
  for (const rec of pop) { const c = classify3_1(rec, K); counts[c] = (counts[c] || 0) + 1; }
  return counts;
}
const boundaries = [8, 12, 20];
const section3_1 = {};
const Aconfirmed = A.pop.filter(function (r) { return r.confirmedInBand; });
const Dconfirmed = D.pop.filter(function (r) { return r.confirmedInBand; });
console.log('(a) confirmed-band50-150 subset n=' + Aconfirmed.length + ' / total (a) n=' + A.pop.length);
console.log('(d) confirmed-band50-150 subset n=' + Dconfirmed.length + ' / total (d) n=' + D.pop.length);
for (const popName of [['a', Aconfirmed], ['d', Dconfirmed], ['c_band_reference', Cband.pop]]) {
  const name = popName[0], pop = popName[1];
  section3_1[name] = { n: pop.length, byK: {} };
  for (const K of boundaries) section3_1[name].byK[K] = tally3_1(pop, K);
  console.log(name + ' n=' + pop.length);
  for (const K of boundaries) console.log('  K=' + K + ': ' + JSON.stringify(section3_1[name].byK[K]));
}

console.log('\n--- 3-2. 9-category exhaustive miss classification (all races, not just band50-150) ---');
// Priority (documented, applied mechanically):
// 0. bandSize<8 or prod compute error -> OTHER_STRUCTURAL (not one of the 9, logged separately for QC)
// 1. permutation of the 3 actual boats present among the 8 points -> "順序違い"
// 2. some single point shares exactly 2 of the 3 actual boats -> "候補艇は含むが組み合わせ違い"
// 3. stage1 greedy argmax != actual 1着 -> "1着候補の誤り"
// 4. (stage1 ok) stage2 conditional greedy argmax != actual 2着 -> "2着条件付き順位の誤り"
// 5. (stage1,2 ok) stage3 conditional greedy argmax != actual 3着 -> "3着条件付き順位の誤り"
// (else: greedy path exactly matches actual, but exact combo absent from points; check funnel with FIXED K=20 per spec)
// 6. rankP0Full<=20 && !inBandPred -> "オッズ帯による除外"
// 7. rankP0Full<=20 && inBandPred && bandPureRank<=8 && bandMixedRank>8 -> "市場混合による除外"
// 8. inBandPred && bandMixedRank>8 (not covered by 7) -> "8点制限による除外"
// 9. bandMixedRank<=8 && !entered -> "参入判定による見送り"
// else -> residual (QC)
function setOf3(val) { return new Set(val.split('-').map(Number)); }
function classify3_2(rec) {
  if (rec.hit) return null; // hits excluded from this section
  if (rec.bandSize < 8) return 'OTHER_STRUCTURAL:INSUFFICIENT_BAND';
  if (rec.prodError && rec.prodError !== 'BELOW_THRESHOLD' && rec.prodError !== 'CANDIDATE_ENTRY') return 'OTHER_STRUCTURAL:' + rec.prodError;
  const actualSet = setOf3(rec.chakuju);
  const points = rec.prodPoints || [];
  let hasPerm = false, hasTwoOverlap = false;
  for (const p of points) {
    const ps = setOf3(p);
    let overlap = 0;
    for (const b of actualSet) if (ps.has(b)) overlap++;
    if (overlap === 3) hasPerm = true;
    else if (overlap === 2) hasTwoOverlap = true;
  }
  if (hasPerm) return '4_JUNJO_CHIGAI';
  if (hasTwoOverlap) return '5_KUMIAWASE_CHIGAI';
  const sd = rec.stageP0;
  if (sd && sd.greedyMatch === false) {
    if (sd.stage === 1) return '1_ICHAKU_ERROR';
    if (sd.stage === 2) return '2_NICHAKU_COND_ERROR';
    if (sd.stage === 3) return '3_SANCHAKU_COND_ERROR';
  }
  // greedy path matches exactly -> funnel diagnosis with fixed K=20
  if (rec.rankP0Full <= 20 && !rec.inBandPred) return '6_ODDS_BAND_EXCLUSION';
  if (rec.rankP0Full <= 20 && rec.inBandPred && rec.bandPureRank != null && rec.bandPureRank <= 8 && rec.bandMixedRank != null && rec.bandMixedRank > 8) return '7_MARKET_MIX_EXCLUSION';
  if (rec.inBandPred && rec.bandMixedRank != null && rec.bandMixedRank > 8) return '8_EIGHT_POINT_LIMIT';
  if (rec.inBandPred && rec.bandMixedRank != null && rec.bandMixedRank <= 8 && !rec.prodEntered) return '9_ENTRY_THRESHOLD_SKIP';
  return 'RESIDUAL_OTHER';
}
function tally3_2(pop) {
  const counts = {}; let hitCount = 0, unhitCount = 0;
  for (const rec of pop) {
    if (rec.hit) { hitCount++; continue; }
    unhitCount++;
    const c = classify3_2(rec);
    counts[c] = (counts[c] || 0) + 1;
  }
  return { hitCount: hitCount, unhitCount: unhitCount, counts: counts };
}
const section3_2 = { a: tally3_2(A.pop), d: tally3_2(D.pop) };
console.log('(a): hit=' + section3_2.a.hitCount + ' unhit=' + section3_2.a.unhitCount + ' ' + JSON.stringify(section3_2.a.counts));
console.log('(d): hit=' + section3_2.d.hitCount + ' unhit=' + section3_2.d.unhitCount + ' ' + JSON.stringify(section3_2.d.counts));

console.log('\n--- 4. P0 vs P1 pure-model rank difference ---');
function oddsAscRank(entries, val) {
  const sorted = entries.slice().sort(function (a, b) { return a.odds - b.odds || a.val.localeCompare(b.val); });
  for (let i = 0; i < sorted.length; i++) if (sorted[i].val === val) return i + 1;
  return null;
}
function bandLabel(x) { if (x == null) return 'NA'; if (x < 50) return '<50'; if (x <= 150) return '50-150'; return '>150'; }
function buildDiffRows(pop, races) {
  const raceByKey = new Map(races.map(function (r) { return [r.date + '_' + r.venue + '_' + r.racenum, r]; }));
  const rows = [];
  for (const rec of pop) {
    if (rec.rankP1Full == null) continue;
    const r = raceByKey.get(rec.key);
    const entries = validOddsEntries(r.oddsMap);
    const oddsRank = oddsAscRank(entries, rec.chakuju);
    const parts = rec.chakuju.split('-').map(Number);
    rows.push({
      key: rec.key, venue: rec.venue, racenum: rec.racenum, chakuju: rec.chakuju,
      predOddsBand: bandLabel(rec.oddsAtPred), payoutBand: bandLabel(rec.payoutMul),
      firstIs1: parts[0] === 1, oddsPopularityRank: oddsRank,
      rankP0Full: rec.rankP0Full, rankP1Full: rec.rankP1Full, delta: rec.rankP0Full - rec.rankP1Full,
      stageP0: rec.stageP0 && rec.stageP0.stage, stageP1: rec.stageP1 && rec.stageP1.stage,
      bandMixedRank: rec.bandMixedRank, bandMixedRankP1: rec.bandMixedRankP1,
      inBandPred: rec.inBandPred,
    });
  }
  return rows;
}
const diffRowsA = buildDiffRows(A.pop, racesA);
console.log('diff rows (a) n=', diffRowsA.length, '(expect close to', A.pop.length, ', minus P1 dist errors)');

function groupStats(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const k = keyFn(row);
    (groups[k] = groups[k] || []).push(row);
  }
  const out = {};
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    const deltas = g.map(function (r) { return r.delta; });
    const improved = g.filter(function (r) { return r.delta > 0; }).length;
    const worsened = g.filter(function (r) { return r.delta < 0; }).length;
    const tie = g.filter(function (r) { return r.delta === 0; }).length;
    out[k] = { n: g.length, meanDelta: mean(deltas), medianDelta: median(deltas), improvedPct: g.length ? improved / g.length * 100 : null, worsenedPct: g.length ? worsened / g.length * 100 : null, tie: tie };
  }
  return out;
}
const byPredOddsBand = groupStats(diffRowsA, function (r) { return r.predOddsBand; });
const byPayoutBand = groupStats(diffRowsA, function (r) { return r.payoutBand; });
const byFirstBoat = groupStats(diffRowsA, function (r) { return r.firstIs1 ? '1st=boat1' : '1st=other'; });
const byVenue = groupStats(diffRowsA, function (r) { return r.venue; });
const byRacenum = groupStats(diffRowsA, function (r) { return r.racenum; });
const byChakuju = groupStats(diffRowsA, function (r) { return r.chakuju; });
console.log('by predicted-odds band:', JSON.stringify(byPredOddsBand));
console.log('by confirmed payout band:', JSON.stringify(byPayoutBand));
console.log('by first boat:', JSON.stringify(byFirstBoat));

// popularity rank buckets (1-3 favorite / 4-10 / 11+ by odds ascending rank)
function popBucket(r) { if (r.oddsPopularityRank == null) return 'NA'; if (r.oddsPopularityRank <= 3) return 'fav1-3'; if (r.oddsPopularityRank <= 10) return 'fav4-10'; return 'fav11plus'; }
const byPopularity = groupStats(diffRowsA, popBucket);
console.log('by odds-popularity bucket:', JSON.stringify(byPopularity));

// stage transition matrix (which stage failed under P0 vs P1)
function stageKey(s) { return s == null ? 'match' : 'stage' + s; }
const stageTransition = {};
for (const row of diffRowsA) {
  const k = stageKey(row.stageP0) + '->' + stageKey(row.stageP1);
  stageTransition[k] = (stageTransition[k] || 0) + 1;
}
console.log('stage transition (P0->P1):', JSON.stringify(stageTransition));

// market-mixing persistence: among band-eligible rows where pure rank improved, did band-mixed rank also improve
const bandEligibleImproved = diffRowsA.filter(function (r) { return r.inBandPred && r.bandMixedRank != null && r.bandMixedRankP1 != null && r.delta > 0; });
const bandEligibleWorsened = diffRowsA.filter(function (r) { return r.inBandPred && r.bandMixedRank != null && r.bandMixedRankP1 != null && r.delta < 0; });
function mixedDeltaStats(rows) {
  const mixedDeltas = rows.map(function (r) { return r.bandMixedRank - r.bandMixedRankP1; });
  const persisted = rows.filter(function (r) { return (r.bandMixedRank - r.bandMixedRankP1) > 0; }).length;
  return { n: rows.length, meanMixedDelta: mean(mixedDeltas), persistedPct: rows.length ? persisted / rows.length * 100 : null };
}
const persistenceOnImproved = mixedDeltaStats(bandEligibleImproved);
const persistenceOnWorsened = mixedDeltaStats(bandEligibleWorsened);
console.log('mixed-rank persistence | pure-improved rows:', JSON.stringify(persistenceOnImproved));
console.log('mixed-rank persistence | pure-worsened rows:', JSON.stringify(persistenceOnWorsened));

// direct hypothesis test: P1 improves <50x/honmei, degrades 50-150x
const hyp = {
  lt50: byPayoutBand['<50'] || null,
  band50_150: byPayoutBand['50-150'] || null,
  gt150: byPayoutBand['>150'] || null,
};
console.log('HYPOTHESIS CHECK (P1 improves <50x, degrades 50-150x):', JSON.stringify(hyp));

console.log('\n--- 5. entry-threshold decile analysis (estimatedReturn discriminative power) ---');
function decileAnalysis(pop, nBins) {
  const withEst = pop.filter(function (r) { return r.prodEstimate != null; }).slice().sort(function (a, b) { return a.prodEstimate - b.prodEstimate; });
  const n = withEst.length;
  const binSize = Math.ceil(n / nBins);
  const bins = [];
  for (let i = 0; i < nBins; i++) {
    const slice = withEst.slice(i * binSize, (i + 1) * binSize);
    if (!slice.length) continue;
    const hitN = slice.filter(function (r) { return r.hit; }).length;
    const bandHitN = slice.filter(function (r) { return r.hit && r.confirmedInBand; }).length;
    const stake = slice.length * 8 * FLAT_STAKE;
    // payout needs original payoutMul at 100 yen/point * 100(stake per point) when hit
    const payout = slice.reduce(function (s, r) { return s + (r.hit ? FLAT_STAKE * r.payoutMul : 0); }, 0);
    bins.push({
      binIndex: i, n: slice.length,
      estMin: slice[0].prodEstimate, estMax: slice[slice.length - 1].prodEstimate,
      hitRate: hitN / slice.length * 100, band50HitRate: bandHitN / slice.length * 100,
      roi: stake ? payout / stake * 100 : null,
    });
  }
  return { n: n, nBins: bins.length, bins: bins };
}
const nBinsA = A.pop.filter(function (r) { return r.prodEstimate != null; }).length >= 60 ? 10 : 5;
const decileA = decileAnalysis(A.pop, nBinsA);
console.log('(a) decile analysis, nBins=' + nBinsA + ', n(withEstimate)=' + decileA.n);
decileA.bins.forEach(function (b) { console.log('  bin' + b.binIndex + ' n=' + b.n + ' est[' + b.estMin.toFixed(3) + ',' + b.estMax.toFixed(3) + '] hitRate=' + b.hitRate.toFixed(2) + '% band50HitRate=' + b.band50HitRate.toFixed(2) + '% ROI=' + (b.roi != null ? b.roi.toFixed(1) : 'NA') + '%'); });
const nBinsD = D.pop.filter(function (r) { return r.prodEstimate != null; }).length >= 30 ? 5 : 3;
const decileD = decileAnalysis(D.pop, nBinsD);
console.log('(d) decile analysis (reference, n<30 caution), nBins=' + nBinsD + ', n=' + decileD.n);
decileD.bins.forEach(function (b) { console.log('  bin' + b.binIndex + ' n=' + b.n + ' est[' + b.estMin.toFixed(3) + ',' + b.estMax.toFixed(3) + '] hitRate=' + b.hitRate.toFixed(2) + '% band50HitRate=' + b.band50HitRate.toFixed(2) + '% ROI=' + (b.roi != null ? b.roi.toFixed(1) : 'NA') + '%'); });

// monotonicity check: correlation between bin index and hitRate
function monotonicityCheck(bins) {
  const idx = bins.map(function (b, i) { return i; });
  const hr = bins.map(function (b) { return b.hitRate; });
  function pearsonLocal(a, b) {
    const n2 = a.length; const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n2; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) * (a[i] - ma); db += (b[i] - mb) * (b[i] - mb); }
    const den = Math.sqrt(da * db);
    return den === 0 ? null : num / den;
  }
  return pearsonLocal(idx, hr);
}
const monotonicityA = monotonicityCheck(decileA.bins);
console.log('(a) monotonicity (corr binIndex vs hitRate):', monotonicityA);

console.log('\n--- 6. odds migration (pre-race band judgment vs confirmed band) ---');
function migrationTally(pop) {
  let predIn_confIn = 0, predIn_confOut = 0, predOut_confIn = 0, predOut_confOut = 0;
  for (const r of pop) {
    if (r.inBandPred && r.confirmedInBand) predIn_confIn++;
    else if (r.inBandPred && !r.confirmedInBand) predIn_confOut++;
    else if (!r.inBandPred && r.confirmedInBand) predOut_confIn++;
    else predOut_confOut++;
  }
  return { predIn_confIn: predIn_confIn, predIn_confOut: predIn_confOut, predOut_confIn: predOut_confIn, predOut_confOut: predOut_confOut, n: pop.length };
}
const migrationA = migrationTally(A.pop);
console.log('(a) migration (full population n=' + migrationA.n + '):', JSON.stringify(migrationA));
const migrationOnConfirmedBandA = migrationTally(A.pop.filter(function (r) { return r.confirmedInBand; }));
console.log('(a) restricted to confirmed-band50-150 (n=' + migrationOnConfirmedBandA.n + '): predOut_confIn (moved INTO band, i.e. missed by pre-race band filter regardless of model rank) =', migrationOnConfirmedBandA.predOut_confIn);
const migrationD = migrationTally(D.pop.filter(function (r) { return r.confirmedInBand; }));
console.log('(d) restricted to confirmed-band50-150 (n=' + migrationD.n + '): predOut_confIn =', migrationD.predOut_confIn);

console.log('\n--- 6. final verdict: largest loss stage (headline K=12, population (a) primary) ---');
const headlineK = 12;
const tallyA_K12 = section3_1.a.byK[headlineK];
const tallyD_K12 = section3_1.d.byK[headlineK];
const stageCandidates = {
  A_pureModel: tallyA_K12.A || 0,
  B_bandJudgment: tallyA_K12.B || 0,
  C_marketMix: tallyA_K12.C || 0,
  D_eightPointLimit: tallyA_K12.D || 0,
  E_entryThreshold: tallyA_K12.E || 0,
  F_oddsMigration_confirmedBandOnly: migrationOnConfirmedBandA.predOut_confIn,
};
console.log('stage candidate loss counts (population a, confirmed-band50-150 subset, K=12):', JSON.stringify(stageCandidates));
const maxStage = Object.keys(stageCandidates).reduce(function (a, b) { return stageCandidates[b] > stageCandidates[a] ? b : a; });
console.log('LARGEST LOSS STAGE =', maxStage, 'count=', stageCandidates[maxStage], '/ n(confirmed band50-150, a)=', Cband.pop.length === undefined ? 'n/a' : A.pop.filter(function (r) { return r.confirmedInBand; }).length);

const out = {
  generatedAt: new Date().toISOString(),
  caseId: 'GARON-20260905-002',
  scopeNote: 'Diagnosis only. No production changes, no re-training, no threshold changes. P0=alpha.js(production), P1=kinsetsu6m candidate v2(already rejected, reference only). market mix 0.5 fixed, band 50-150 fixed, 8pt fixed, entry threshold 1.440209615716716 fixed(unrounded).',
  populations: {
    a: { n: racesA.length, valid: A.pop.length, dateRange: [racesA[0].date, racesA[racesA.length - 1].date] },
    b: { n: racesB.length, note: 'structurally zero, true-T10 capture began 2026-08-21' },
    c_extended: { n: extC.length, confirmedBand50to150: extCband.length, validBuilt: Cband.pop.length },
    d_forward: { total: racesD.length, valid: D.pop.length, byDay: { '2026-09-03': { attempted: fwd0903.attempted, restored: fwd0903.races.length, fail: fwd0903.reasons }, '2026-09-04': { attempted: fwd0904.attempted, restored: fwd0904.races.length, fail: fwd0904.reasons }, '2026-09-05': { attempted: fwd0905.attempted, restored: fwd0905.races.length, fail: fwd0905.reasons } } },
  },
  qc: { mixConsistencyViolations: { a: qcMixConsistency(A.pop), d: qcMixConsistency(D.pop), c_band: qcMixConsistency(Cband.pop) } },
  section3_1: section3_1,
  section3_2: section3_2,
  section4_diff: {
    n: diffRowsA.length,
    byPredOddsBand: byPredOddsBand, byPayoutBand: byPayoutBand, byFirstBoat: byFirstBoat,
    byVenue: byVenue, byRacenum: byRacenum, byPopularityBucket: byPopularity,
    stageTransition: stageTransition,
    marketMixPersistence: { onPureImproved: persistenceOnImproved, onPureWorsened: persistenceOnWorsened },
    hypothesisCheck_P1_improves_lt50_degrades_50to150: hyp,
  },
  section5_deciles: { a: decileA, d: decileD, monotonicity_a: monotonicityA },
  section6_migration: { a_full: migrationA, a_confirmedBandOnly: migrationOnConfirmedBandA, d_confirmedBandOnly: migrationD },
  section6_verdict: { headlineK: headlineK, stageCandidates: stageCandidates, largestLossStage: maxStage, denominator_confirmedBand50to150_a: A.pop.filter(function (r) { return r.confirmedInBand; }).length },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_p0_loss_decomposition_2026-09-05.json'), JSON.stringify(out, null, 2));
console.log('\nSaved to logs/research_p0_loss_decomposition_2026-09-05.json');

console.log('\n--- addendum: pure-model rank distribution & stage1 boat1-bias diagnostic (confirmed-band50-150, population a) ---');
const confirmedA = A.pop.filter(function (r) { return r.confirmedInBand; });
const ranksConfirmedA = confirmedA.map(function (r) { return r.rankP0Full; }).sort(function (a, b) { return a - b; });
function pctLe(arr, k) { return arr.filter(function (x) { return x <= k; }).length / arr.length * 100; }
const rankDist = {
  n: ranksConfirmedA.length, median: median(ranksConfirmedA), mean: mean(ranksConfirmedA),
  top5Pct: pctLe(ranksConfirmedA, 5), top8Pct: pctLe(ranksConfirmedA, 8), top12Pct: pctLe(ranksConfirmedA, 12),
  top20Pct: pctLe(ranksConfirmedA, 20), top40Pct: pctLe(ranksConfirmedA, 40), top60Pct: pctLe(ranksConfirmedA, 60),
};
console.log('rankP0Full distribution over confirmed-band50-150 (n=' + rankDist.n + '): median=' + rankDist.median + ' mean=' + rankDist.mean.toFixed(1));
console.log('  top5=' + rankDist.top5Pct.toFixed(1) + '% top8=' + rankDist.top8Pct.toFixed(1) + '% top12=' + rankDist.top12Pct.toFixed(1) + '% top20=' + rankDist.top20Pct.toFixed(1) + '% top40=' + rankDist.top40Pct.toFixed(1) + '% top60=' + rankDist.top60Pct.toFixed(1) + '%');

let stage1Fail = 0, stage2Fail = 0, stage3Fail = 0, greedyMatch = 0, actualIs1 = 0, stage1FailPredicted1 = 0;
const stage1WrongDist = {};
for (const r of confirmedA) {
  const sd = r.stageP0;
  const actual1 = Number(r.chakuju.split('-')[0]);
  if (actual1 === 1) actualIs1++;
  if (!sd || sd.greedyMatch === false) {
    if (sd.stage === 1) {
      stage1Fail++;
      // recompute model's stage1 argmax directly for the over-favoring diagnostic
    } else if (sd.stage === 2) stage2Fail++;
    else if (sd.stage === 3) stage3Fail++;
  } else greedyMatch++;
}
console.log('stage decomposition (confirmed-band50-150, n=' + confirmedA.length + '): stage1Fail=' + stage1Fail + ' (' + (stage1Fail / confirmedA.length * 100).toFixed(1) + '%) stage2Fail=' + stage2Fail + ' stage3Fail=' + stage3Fail + ' greedyMatch=' + greedyMatch);
console.log('actual 1chaku == boat1 in confirmed-band50-150: ' + actualIs1 + '/' + confirmedA.length + ' (' + (actualIs1 / confirmedA.length * 100).toFixed(1) + '%)');

// recompute stage1 argmax explicitly to quantify boat1 over-favoring among stage1 failures
function stage1Argmax(dist) {
  const p1 = {}; for (let c = 1; c <= 6; c++) p1[c] = 0;
  for (const e of dist) { const f = Number(e.val.split('-')[0]); p1[f] += e.p; }
  return Number(Object.keys(p1).reduce(function (a, b) { return p1[b] > p1[a] ? b : a; }));
}
const raceByKeyA = new Map(racesA.map(function (r) { return [r.date + '_' + r.venue + '_' + r.racenum, r]; }));
let stage1WrongPredictedBoat1 = 0, stage1WrongTotal = 0;
for (const r of confirmedA) {
  if (!r.stageP0 || r.stageP0.stage !== 1) continue;
  stage1WrongTotal++;
  const race = raceByKeyA.get(r.key);
  const dist = alphaP0.distribution(race.boats);
  const argmax1 = stage1Argmax(dist);
  if (argmax1 === 1) stage1WrongPredictedBoat1++;
}
console.log('of stage1 failures (n=' + stage1WrongTotal + '), model predicted boat1 as 1chaku=' + stage1WrongPredictedBoat1 + ' (' + (stage1WrongTotal ? (stage1WrongPredictedBoat1 / stage1WrongTotal * 100).toFixed(1) : 'NA') + '%)');

const addendum = {
  rankDistributionConfirmedBand: rankDist,
  stageDecompositionConfirmedBand: { n: confirmedA.length, stage1Fail: stage1Fail, stage2Fail: stage2Fail, stage3Fail: stage3Fail, greedyMatch: greedyMatch, actualFirstIsBoat1: actualIs1 },
  stage1Boat1OverfavoringDiagnostic: { stage1FailureCount: stage1WrongTotal, modelPredictedBoat1Count: stage1WrongPredictedBoat1 },
};
const finalOut = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_p0_loss_decomposition_2026-09-05.json'), 'utf8'));
finalOut.addendum_stage1_diagnostic = addendum;
fs.writeFileSync(path.join(ROOT, 'logs', 'research_p0_loss_decomposition_2026-09-05.json'), JSON.stringify(finalOut, null, 2));
console.log('\nAddendum appended to logs/research_p0_loss_decomposition_2026-09-05.json');
