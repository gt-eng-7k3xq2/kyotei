'use strict';
// GARON-20260904-001 research: alpha engine (C) market-mixing decomposition audit.
// A (pure model), B (pure market), C (current, geometric mean 0.5:0.5 mix of model pm and
// inverse-odds market signal) compared on identical population, fixed 8 points, 100 yen/point.
// Analysis only. No production code changes, no reflection to production.
// Data used: logs/research_alpha_review_snapshot_2026-09-02.json (frozen, not re-read from source)
//            daikibo_archive_2026-09-03.json / 09-04.json (recent 2 days, boats/oddsMap restore)
//            logs/alpha_live_judgments_2026-09-03.json / 09-04.json (actual entered&&notified bets)

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;

const alphaPath = path.join(ROOT, 'scripts', 'lib', 'alpha_engine', 'alpha.js');
const alphaOriginal = require(alphaPath);
const alphaSrc = fs.readFileSync(alphaPath, 'utf8');
const MARK = 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD};';
if (alphaSrc.indexOf(MARK) === -1) throw new Error('alpha.js export line mismatch');
const patchedSrc = alphaSrc.replace(MARK, 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD,distribution};');
const mm = new Module(alphaPath, module);
mm.filename = alphaPath;
mm.paths = Module._nodeModulePaths(path.dirname(alphaPath));
mm._compile(patchedSrc, alphaPath);
const alphaExt = mm.exports;
console.log('alpha.js loaded. ENTRY_THRESHOLD=', alphaOriginal.ENTRY_THRESHOLD);

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMs(dateStr, shimekiriStr) {
  const m = String(shimekiriStr).match(/([0-9]{1,2}):([0-9]{2})/);
  if (!m) return null;
  const ms = Date.parse(dateStr + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00.000+09:00');
  return isNaN(ms) ? null : ms;
}
function validOddsEntries(oddsMap) {
  return Object.entries(oddsMap || {}).map(function(e){ return { val: e[0], odds: Number(e[1]) }; }).filter(function(e){ return Number.isFinite(e.odds) && e.odds > 0; });
}
function rankdata(values) {
  const idx = values.map(function(v,i){ return [v,i]; }).sort(function(a,b){ return b[0]-a[0]; });
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avgRank;
    i = j + 1;
  }
  return ranks;
}
function spearman(a, b) {
  const n = a.length;
  if (n < 2) return null;
  const ra = rankdata(a), rb = rankdata(b);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) { const d = ra[i] - rb[i]; sumD2 += d * d; }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}
function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce(function(s,x){return s+x;},0) / n, mb = b.reduce(function(s,x){return s+x;},0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) * (a[i] - ma); db += (b[i] - mb) * (b[i] - mb); }
  const den = Math.sqrt(da * db);
  return den === 0 ? null : num / den;
}
function mean(arr) { return arr.length ? arr.reduce(function(s,x){return s+x;},0) / arr.length : null; }

const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_alpha_review_snapshot_2026-09-02.json'), 'utf8'));
console.log('snapshot count=', snap.count, 'generatedAt=', snap.generatedAt);

function buildRecord(r) {
  const entries = validOddsEntries(r.oddsMap);
  if (entries.length !== 120) return { skip: 'ODDS_NOT_120' };
  let dist;
  try { dist = alphaExt.distribution(r.boats); } catch (e) { return { skip: 'DIST_ERROR:' + e.message }; }
  const pmSum = dist.reduce(function(s,c){return s+c.p;}, 0);
  if (Math.abs(pmSum - 1) > 1e-9) return { skip: 'INVALID_DIST_SUM' };
  const pm = new Map(dist.map(function(c){ return [c.val, c.p]; }));
  const allMass = entries.map(function(e){ return { val: e.val, odds: e.odds, mass: Math.sqrt(Math.max(pm.get(e.val), Number.MIN_VALUE) / e.odds) }; });
  const den = allMass.reduce(function(s,c){return s+c.mass;}, 0);
  const band = allMass.filter(function(e){ return e.odds >= 50 && e.odds <= 150; });
  if (band.length < 8) return { skip: 'INSUFFICIENT_BAND_CANDIDATES', bandSize: band.length };

  const cSorted = band.slice().map(function(e){ return { val: e.val, odds: e.odds, score: e.mass / den }; }).sort(function(a,b){ return b.score - a.score || a.val.localeCompare(b.val); });
  const aSorted = band.slice().map(function(e){ return { val: e.val, odds: e.odds, score: pm.get(e.val) }; }).sort(function(a,b){ return b.score - a.score || a.val.localeCompare(b.val); });
  const bSorted = band.slice().map(function(e){ return { val: e.val, odds: e.odds, score: e.odds }; }).sort(function(a,b){ return a.score - b.score || a.val.localeCompare(b.val); });

  const cTop8 = cSorted.slice(0, 8), aTop8 = aSorted.slice(0, 8), bTop8 = bSorted.slice(0, 8);

  const deadlineIso = new Date(shimekiriMs(r.date, r.shimekiri)).toISOString();
  const input = { boats: r.boats, oddsMap: r.oddsMap, oddsCapturedAt: r.archivedAt, deadlineAt: deadlineIso };
  const nowMs = Date.parse(r.archivedAt);
  let prod;
  try { prod = alphaOriginal.predict(input, nowMs); } catch (e) { prod = { error: e.message }; }

  return {
    skip: null, bandSize: band.length,
    cSorted: cSorted, aSorted: aSorted, bSorted: bSorted, cTop8: cTop8, aTop8: aTop8, bTop8: bTop8,
    estimateA: mean(aTop8.map(function(p){ return pm.get(p.val) * p.odds; })),
    prodEntered: prod && !prod.error ? prod.entered : null,
    prodEstimate: prod && !prod.error ? prod.estimatedReturn : null,
    prodPoints: prod && !prod.error && prod.points ? prod.points.map(function(p){return p.combination;}).sort() : null,
    prodError: prod && prod.error ? prod.error : null,
  };
}

const built = snap.races.map(function(r){ return { r: r, rec: buildRecord(r) }; });
const skipCounts = {};
built.forEach(function(x){ if (x.rec.skip) skipCounts[x.rec.skip] = (skipCounts[x.rec.skip] || 0) + 1; });
console.log('buildRecord skip breakdown:', JSON.stringify(skipCounts));

const pop = built.filter(function(x){ return !x.rec.skip; });
console.log('population n=', pop.length, '(expected 1193 match=', pop.length === 1193, ')');

let prodMismatch = 0, prodEnteredNull = 0;
for (const x of pop) {
  if (x.rec.prodError) { prodEnteredNull++; continue; }
  const manualSet = x.rec.cTop8.map(function(p){return p.val;}).sort();
  if (JSON.stringify(manualSet) !== JSON.stringify(x.rec.prodPoints)) prodMismatch++;
}
console.log('manual C top8 vs production predict() mismatch count=', prodMismatch, '/ predict error count=', prodEnteredNull);

function overlapRate(top8a, top8b) {
  const setB = new Set(top8b.map(function(p){return p.val;}));
  return top8a.filter(function(p){return setB.has(p.val);}).length / 8;
}
const overlapCB = pop.map(function(x){ return overlapRate(x.rec.cTop8, x.rec.bTop8); });
const overlapCA = pop.map(function(x){ return overlapRate(x.rec.cTop8, x.rec.aTop8); });
const overlapAB = pop.map(function(x){ return overlapRate(x.rec.aTop8, x.rec.bTop8); });

const spearmanCB = [], spearmanCA = [];
for (const x of pop) {
  const cRankMap = new Map(x.rec.cSorted.map(function(p,i){ return [p.val, i]; }));
  const bRankMap = new Map(x.rec.bSorted.map(function(p,i){ return [p.val, i]; }));
  const aRankMap = new Map(x.rec.aSorted.map(function(p,i){ return [p.val, i]; }));
  const vals = x.rec.cSorted.map(function(p){return p.val;});
  const cArr = vals.map(function(v){ return cRankMap.get(v); });
  const bArr = vals.map(function(v){ return bRankMap.get(v); });
  const aArr = vals.map(function(v){ return aRankMap.get(v); });
  const sCB = spearman(cArr, bArr);
  const sCA = spearman(cArr, aArr);
  if (sCB != null) spearmanCB.push(sCB);
  if (sCA != null) spearmanCA.push(sCA);
}

let addedByMarketVsA = 0, removedByModelVsB = 0;
const perRaceAddedRemoved = [];
for (const x of pop) {
  const cSet = new Set(x.rec.cTop8.map(function(p){return p.val;}));
  const aOnly = x.rec.aTop8.filter(function(p){ return !cSet.has(p.val); }).map(function(p){return p.val;});
  const bOnly = x.rec.bTop8.filter(function(p){ return !cSet.has(p.val); }).map(function(p){return p.val;});
  addedByMarketVsA += aOnly.length;
  removedByModelVsB += bOnly.length;
  perRaceAddedRemoved.push({ key: x.r.key, aOnlyCount: aOnly.length, bOnlyCount: bOnly.length });
}

function evalFlatIndexed(kind) {
  let hit = 0, band50 = 0, stake = 0, payout = 0;
  const byDate = {};
  const hitPayouts = [];
  for (let i = 0; i < pop.length; i++) {
    const r = pop[i].r; const rec = pop[i].rec;
    const pts = (kind === 'A' ? rec.aTop8 : kind === 'B' ? rec.bTop8 : rec.cTop8).map(function(p){return p.val;});
    const isHit = r.chakuju && pts.indexOf(r.chakuju) !== -1;
    stake += pts.length * FLAT_STAKE;
    let thisPayout = 0;
    if (isHit) { thisPayout = Math.round(FLAT_STAKE / 100 * parsePayout100(r.payout)); payout += thisPayout; hitPayouts.push(thisPayout); hit++; }
    const payoutMul = parsePayout100(r.payout) / 100;
    const in50_150 = payoutMul >= 50 && payoutMul <= 150;
    if (isHit && in50_150) band50++;
    (byDate[r.date] = byDate[r.date] || { n: 0, hit: 0, stake: 0, payout: 0 }).n++;
    byDate[r.date].stake += pts.length * FLAT_STAKE;
    if (isHit) { byDate[r.date].hit++; byDate[r.date].payout += thisPayout; }
  }
  const n = pop.length;
  const maxPayout = hitPayouts.length ? Math.max.apply(null, hitPayouts) : 0;
  return { n: n, hit: hit, band50: band50, stake: stake, payout: payout, hitRate: n ? hit / n * 100 : null, band50Rate: n ? band50 / n * 100 : null, roi: stake ? payout / stake * 100 : null, maxSinglePayoutShare: payout ? maxPayout / payout * 100 : null, byDate: byDate };
}
const fullPopA = evalFlatIndexed('A');
const fullPopB = evalFlatIndexed('B');
const fullPopC = evalFlatIndexed('C');

const enteredIdx = [];
for (let i = 0; i < pop.length; i++) { if (pop[i].rec.prodEntered === true) enteredIdx.push(i); }
function evalFlatOnIndices(kind, indices) {
  let hit = 0, band50 = 0, stake = 0, payout = 0;
  const byDate = {};
  const hitPayouts = [];
  for (const i of indices) {
    const r = pop[i].r; const rec = pop[i].rec;
    const pts = (kind === 'A' ? rec.aTop8 : kind === 'B' ? rec.bTop8 : rec.cTop8).map(function(p){return p.val;});
    const isHit = r.chakuju && pts.indexOf(r.chakuju) !== -1;
    stake += pts.length * FLAT_STAKE;
    let thisPayout = 0;
    if (isHit) { thisPayout = Math.round(FLAT_STAKE / 100 * parsePayout100(r.payout)); payout += thisPayout; hitPayouts.push(thisPayout); hit++; }
    const payoutMul = parsePayout100(r.payout) / 100;
    const in50_150 = payoutMul >= 50 && payoutMul <= 150;
    if (isHit && in50_150) band50++;
    (byDate[r.date] = byDate[r.date] || { n: 0, hit: 0, stake: 0, payout: 0 }).n++;
    byDate[r.date].stake += pts.length * FLAT_STAKE;
    if (isHit) { byDate[r.date].hit++; byDate[r.date].payout += thisPayout; }
  }
  const n = indices.length;
  const maxPayout = hitPayouts.length ? Math.max.apply(null, hitPayouts) : 0;
  return { n: n, hit: hit, band50: band50, stake: stake, payout: payout, hitRate: n ? hit / n * 100 : null, band50Rate: n ? band50 / n * 100 : null, roi: stake ? payout / stake * 100 : null, maxSinglePayoutShare: payout ? maxPayout / payout * 100 : null, byDate: byDate };
}
const enteredA = evalFlatOnIndices('A', enteredIdx);
const enteredB = evalFlatOnIndices('B', enteredIdx);
const enteredC = evalFlatOnIndices('C', enteredIdx);
console.log('C entered count (of population', pop.length, ') =', enteredIdx.length);

function bandStatsForRow(rec) {
  const bandOdds = rec.cSorted.map(function(p){return p.odds;});
  const meanBandOdds = mean(bandOdds);
  const meanBandInvOdds = mean(bandOdds.map(function(o){return 1/o;}));
  const top8MeanOdds = mean(rec.cTop8.map(function(p){return p.odds;}));
  return { meanBandOdds: meanBandOdds, meanBandInvOdds: meanBandInvOdds, top8MeanOdds: top8MeanOdds };
}
const enteredTrueStats = [], enteredFalseStats = [];
const estimateBArr = [], estimateCArr = [];
for (let i = 0; i < pop.length; i++) {
  const rec = pop[i].rec;
  const s = bandStatsForRow(rec);
  if (rec.prodEntered === true) enteredTrueStats.push(s); else if (rec.prodEntered === false) enteredFalseStats.push(s);
  estimateBArr.push(mean(rec.bTop8.map(function(p){return p.odds;})));
  estimateCArr.push(rec.prodEstimate);
}
function avgStats(arr) {
  return {
    n: arr.length,
    meanBandOdds: mean(arr.map(function(s){return s.meanBandOdds;})),
    meanBandInvOdds: mean(arr.map(function(s){return s.meanBandInvOdds;})),
    top8MeanOdds: mean(arr.map(function(s){return s.top8MeanOdds;})),
  };
}
const enteredTrueAgg = avgStats(enteredTrueStats);
const enteredFalseAgg = avgStats(enteredFalseStats);

const validPairs = [];
for (let i = 0; i < pop.length; i++) { if (estimateCArr[i] != null && estimateBArr[i] != null) validPairs.push(i); }
const corrCestimate_Boverdds = pearson(validPairs.map(function(i){return estimateCArr[i];}), validPairs.map(function(i){return estimateBArr[i];}));
const overallMeanBandOdds = mean(pop.map(function(x){ return mean(x.rec.cSorted.map(function(p){return p.odds;})); }));

function loadLiveDay(judgFile, archiveFile) {
  const judg = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', judgFile), 'utf8'));
  const arr = judg.judgments || judg;
  const archive = JSON.parse(fs.readFileSync(path.join(ROOT, archiveFile), 'utf8'));
  const archIndex = new Map(archive.map(function(r){ return [r.date + '_' + r.venue + '_' + r.racenum, r]; }));
  const ranks = [];
  let restoreFail = 0, restoreOk = 0;
  for (const j of arr) {
    if (!j.entered || !j.notified) continue;
    const arch = archIndex.get(j.raceKey);
    if (!arch) { restoreFail++; continue; }
    const diffMs = Math.abs(Date.parse(arch.archivedAt) - Date.parse(j.dataCollectedAt));
    if (!(diffMs <= 5 * 60 * 1000)) { restoreFail++; continue; }
    const entries = validOddsEntries(arch.oddsMap);
    const band = entries.filter(function(e){ return e.odds >= 50 && e.odds <= 150; }).sort(function(a,b){ return a.odds - b.odds || a.val.localeCompare(b.val); });
    const rankMap = new Map(band.map(function(e,idx){ return [e.val, idx + 1]; }));
    for (const pt of (j.points || [])) {
      const rk = rankMap.get(pt.combination);
      if (rk != null) ranks.push(rk);
    }
    restoreOk++;
  }
  return { ranks: ranks, restoreFail: restoreFail, restoreOk: restoreOk, totalEnteredNotified: arr.filter(function(j){return j.entered && j.notified;}).length };
}

const live0903 = loadLiveDay('alpha_live_judgments_2026-09-03.json', 'daikibo_archive_2026-09-03.json');
const live0904 = loadLiveDay('alpha_live_judgments_2026-09-04.json', 'daikibo_archive_2026-09-04.json');
const allLiveRanks = live0903.ranks.concat(live0904.ranks);
function median(arr) { const s = arr.slice().sort(function(a,b){return a-b;}); const n = s.length; if (!n) return null; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }

console.log('');
console.log('=== SUMMARY ===');
console.log('1) C-B overlap mean=', mean(overlapCB).toFixed(3), ' 2) C-A overlap mean=', mean(overlapCA).toFixed(3), ' (ref A-B overlap=', mean(overlapAB).toFixed(3), ')');
console.log('3) Spearman C-B mean=', mean(spearmanCB).toFixed(3), ' C-A mean=', mean(spearmanCA).toFixed(3));
console.log('4) addedByMarketVsA(A has, C not)=', addedByMarketVsA, ' removedByModelVsB(B has, C not)=', removedByModelVsB, ' (n=', pop.length, ')');
console.log('5-6) full population n=' + pop.length + ':');
console.log('  A: hit=' + fullPopA.hitRate.toFixed(2) + '% band50=' + fullPopA.band50Rate.toFixed(2) + '% ROI=' + fullPopA.roi.toFixed(1) + '% maxPayoutShare=' + (fullPopA.maxSinglePayoutShare||0).toFixed(1) + '%');
console.log('  B: hit=' + fullPopB.hitRate.toFixed(2) + '% band50=' + fullPopB.band50Rate.toFixed(2) + '% ROI=' + fullPopB.roi.toFixed(1) + '% maxPayoutShare=' + (fullPopB.maxSinglePayoutShare||0).toFixed(1) + '%');
console.log('  C: hit=' + fullPopC.hitRate.toFixed(2) + '% band50=' + fullPopC.band50Rate.toFixed(2) + '% ROI=' + fullPopC.roi.toFixed(1) + '% maxPayoutShare=' + (fullPopC.maxSinglePayoutShare||0).toFixed(1) + '%');
console.log('C entered fixed population n=' + enteredIdx.length + ':');
console.log('  A: hit=' + (enteredA.hitRate||0).toFixed(2) + '% band50=' + (enteredA.band50Rate||0).toFixed(2) + '% ROI=' + (enteredA.roi||0).toFixed(1) + '%');
console.log('  B: hit=' + (enteredB.hitRate||0).toFixed(2) + '% band50=' + (enteredB.band50Rate||0).toFixed(2) + '% ROI=' + (enteredB.roi||0).toFixed(1) + '%');
console.log('  C: hit=' + (enteredC.hitRate||0).toFixed(2) + '% band50=' + (enteredC.band50Rate||0).toFixed(2) + '% ROI=' + (enteredC.roi||0).toFixed(1) + '%');
console.log('7) entered=true group n=' + enteredTrueAgg.n + ' meanBandOdds=' + (enteredTrueAgg.meanBandOdds||0).toFixed(1) + ' top8MeanOdds=' + (enteredTrueAgg.top8MeanOdds||0).toFixed(1));
console.log('   entered=false group n=' + enteredFalseAgg.n + ' meanBandOdds=' + (enteredFalseAgg.meanBandOdds||0).toFixed(1) + ' top8MeanOdds=' + (enteredFalseAgg.top8MeanOdds||0).toFixed(1));
console.log('   overall meanBandOdds(ref)=', overallMeanBandOdds.toFixed(1));
console.log('   corr(C estimatedReturn, B-top8 mean odds)=', corrCestimate_Boverdds != null ? corrCestimate_Boverdds.toFixed(3) : 'null');
console.log('8) live 2-day entered&&notified points band-odds-rank: n=' + allLiveRanks.length + ' mean=' + (mean(allLiveRanks)||0).toFixed(2) + ' median=' + median(allLiveRanks));
console.log('   09-03: restored ' + live0903.restoreOk + '/' + live0903.totalEnteredNotified + ' (fail ' + live0903.restoreFail + ')');
console.log('   09-04: restored ' + live0904.restoreOk + '/' + live0904.totalEnteredNotified + ' (fail ' + live0904.restoreFail + ')');

const out = {
  generatedAt: new Date().toISOString(),
  scopeNote: 'Analysis only, no production changes. Reuses snapshot logs/research_alpha_review_snapshot_2026-09-02.json (n=' + snap.count + ').',
  population: { n: pop.length, expected1193Match: pop.length === 1193, skipCounts: skipCounts, prodMismatch: prodMismatch, prodEnteredNull: prodEnteredNull },
  overlap: { CB_mean: mean(overlapCB), CA_mean: mean(overlapCA), AB_mean_reference: mean(overlapAB), CB_all: overlapCB, CA_all: overlapCA },
  spearman: { CB_mean: mean(spearmanCB), CA_mean: mean(spearmanCA), CB_all: spearmanCB, CA_all: spearmanCA },
  addedRemoved: { addedByMarketVsA_total: addedByMarketVsA, removedByModelVsB_total: removedByModelVsB, perRace: perRaceAddedRemoved },
  performance: {
    fullPopulation: { n: pop.length, A: fullPopA, B: fullPopB, C: fullPopC },
    cEnteredFixedPopulation: { n: enteredIdx.length, A: enteredA, B: enteredB, C: enteredC },
  },
  marketDependency: {
    enteredTrueAgg: enteredTrueAgg, enteredFalseAgg: enteredFalseAgg, overallMeanBandOdds: overallMeanBandOdds,
    corr_Cestimate_vs_Btop8MeanOdds: corrCestimate_Boverdds,
  },
  liveNotifiedRankDistribution: {
    pooled: { n: allLiveRanks.length, mean: mean(allLiveRanks), median: median(allLiveRanks), ranks: allLiveRanks },
    day0903: live0903, day0904: live0904,
  },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_alpha_market_mixing_decomposition_2026-09-04.json'), JSON.stringify(out, null, 2));
console.log('');
console.log('Saved to logs/research_alpha_market_mixing_decomposition_2026-09-04.json');
