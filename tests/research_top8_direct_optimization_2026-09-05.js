'use strict';
// GARON-20260905-009 research: pure-prediction top8 direct optimization (1 design, pre-registered).
// Full rationale in reports/research_findings_2026-09-05_top8_direct_optimization_v2.md
const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const { loadAllRaces } = require('./q_engine_entry_backtest.js');
const F = require(path.join(ROOT, 'scripts', 'lib', 'alpha_engine', 'features.js'));

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hashObj(o) { return sha256(JSON.stringify(o)); }

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
console.log('P0(alpha.js) loaded. ENTRY_THRESHOLD(reference only)=', alphaOriginal.ENTRY_THRESHOLD);

// ============================================================
// 0. Pre-registration: design fixed BEFORE looking at any results, written to disk first.
// ============================================================
const PREREG = {
  caseId: 'GARON-20260905-009',
  registeredAt: new Date().toISOString(),
  title: 'Correct trifecta top8 direct optimization v2 (WARP ranking loss, linear per-role model)',
  designDecisions: {
    objective: 'K-truncated WARP (Weston/Bengio/Usunier 2011) ranking loss, K=8 order-statistic weighting ' +
      '(Usunier et al. 2009 precision@k variant). Directly optimizes whether the true trifecta lands in the top-8, ' +
      'unlike P0 which optimizes per-stage cross-entropy (log-loss), not top-k inclusion.',
    modelStructure: 'Linear additive score: score(i,j,k) = w1.x_i + w2.x_j + w3.x_k, role-specific weight vectors ' +
      'for 1st/2nd/3rd place, boat-level features only (no boat-pair interaction terms). Chosen over decision trees ' +
      'to isolate the loss-function effect from architecture differences vs P0, keep training fully auditable in ' +
      'plain Node.js with no external ML library, and guarantee deterministic subgradient convergence.',
    featureSet: 'scripts/lib/alpha_engine/features.js features(boats): 21-dim per boat (5 boat-number dummies + ' +
      '8 fields x2 center/missing-flag). Same function P0 uses for its stage-1 tree input. No odds. No relations ' +
      '(pairwise) features. No kinsetsu6m beyond what features.js already includes for boat1 (kimariteNige6m). ' +
      'Standardization (mean/std) computed from TRAIN data only, +1 bias dim (22 total), applied unchanged to eval.',
    lossFunction: 'Weighted hinge subgradient descent. Sample random negative permutation until ' +
      'margin - score(pos) + score(neg) > 0 (violator) or maxTrials reached (skip if none found). ' +
      'rHat = floor(119/trials). Weight = L_K(rHat) = sum_{i=1..min(rHat,K)} 1/i, K=8.',
  },
};
PREREG.designDecisions.hyperparameters = { seed: 20260905, learningRate: 0.02, l2: 0.0001, margin: 1.0, maxTrials: 50, k: 8, maxEpochs: 20, convergenceTol: 0.005 };
PREREG.designDecisions.hyperparameterSelectionNote = 'Fixed a priori from standard WARP practice and compute-budget reasoning, not tuned on any held-out or top8 metric. maxEpochs uses an early-stop rule based ONLY on train-loss relative change (<0.5%), never on held-out accuracy.';
PREREG.designDecisions.trainEvalSplit = {
  train: 'date < 2026-08-21 (same boundary as current production alpha)',
  evalA: '2026-08-21..2026-08-27 (same convention as GARON-20260905-003/005/006/007/008)',
  evalB: '2026-08-28..2026-09-02 (same convention)',
  beyond: '2026-09-03 (reference only, not part of EvalA/EvalB)',
  note: 'Date ranges fixed a priori, not adjusted after seeing results.',
};
PREREG.designDecisions.layer2Reuse = 'Reuses logs/research_market_anchored_blend_calibration_population_2026-09-05.json (n=1648, true T-10 odds, 2026-08-21..09-03) built for GARON-20260905-007. No new odds collection or population construction.';
PREREG.designDecisions.judgmentCriteria = {
  A: 'Pure top8 improves in BOTH EvalA and EvalB vs P0, and layer2 not worse -> alpha v2 shadow candidate',
  B: 'Pure improves but does not convert to payout-band performance -> keep as pure-prediction candidate only',
  C: 'Pure top8 does not improve -> terminate this direct-optimization design',
};
PREREG.designDecisions.prohibitions = ['No multi-model sweep (one design only)', 'No post-hoc feature/threshold tuning', 'No production file edits (in-memory patch only)', 'No odds in layer-1 training'];
const preregPath = path.join(ROOT, 'logs', 'research_top8_direct_optimization_preregistration_2026-09-05.json');
fs.writeFileSync(preregPath, JSON.stringify(PREREG, null, 2));
console.log('Pre-registration written:', preregPath);

// ============================================================
// 1. Data loading and population construction
// ============================================================
function isUsableForLayer1(r) {
  return !!(r.resulted && r.boats && r.boats.length === 6 && r.boats.every(b => !b.isJogai) && r.chakuju);
}
const archiveFiles = fs.readdirSync(ROOT).filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const archiveHashes = {};
archiveFiles.forEach(f => { archiveHashes[f] = sha256(fs.readFileSync(path.join(ROOT, f))); });

const all = loadAllRaces();
const layer1Pop = all.filter(isUsableForLayer1);
console.log('total races =', all.length, ' isUsableForLayer1 n =', layer1Pop.length);

const TRAIN_HI_EXCLUSIVE = '2026-08-21';
const trainRacesRaw = layer1Pop.filter(r => r.date < TRAIN_HI_EXCLUSIVE);
const evalOuterRaw = layer1Pop.filter(r => r.date >= TRAIN_HI_EXCLUSIVE);
const evalARaw = evalOuterRaw.filter(r => r.date >= '2026-08-21' && r.date <= '2026-08-27');
const evalBRaw = evalOuterRaw.filter(r => r.date >= '2026-08-28' && r.date <= '2026-09-02');
const evalBeyondRaw = evalOuterRaw.filter(r => r.date >= '2026-09-03');
console.log('train n=', trainRacesRaw.length, ' EvalA n=', evalARaw.length, ' EvalB n=', evalBRaw.length, ' Beyond(09-03) n=', evalBeyondRaw.length);

function chakujuIdx(chakuju) { const parts = chakuju.split('-').map(x => Number(x) - 1); return parts; }
function keyOf(r) { return r.date + '_' + r.venue + '_' + r.racenum; }
function rawFeatures(r) { return F.features(r.boats); }

const trainRawFeat = trainRacesRaw.map(r => ({ key: keyOf(r), date: r.date, venue: r.venue, feat: rawFeatures(r), chakuju: chakujuIdx(r.chakuju) }));

const DIM = trainRawFeat[0].feat[0].length;
const means = new Array(DIM).fill(0), stds = new Array(DIM).fill(0);
{
  let count = 0;
  for (const rec of trainRawFeat) for (const v of rec.feat) { count++; for (let d = 0; d < DIM; d++) means[d] += v[d]; }
  for (let d = 0; d < DIM; d++) means[d] /= count;
  const sq = new Array(DIM).fill(0);
  for (const rec of trainRawFeat) for (const v of rec.feat) for (let d = 0; d < DIM; d++) sq[d] += (v[d] - means[d]) * (v[d] - means[d]);
  for (let d = 0; d < DIM; d++) { stds[d] = Math.sqrt(sq[d] / count); if (stds[d] < 1e-8) stds[d] = 1; }
  console.log('standardization computed from TRAIN only, n_boats=' + count);
}
function standardize(raw21) { const out = new Array(DIM + 1); for (let d = 0; d < DIM; d++) out[d] = (raw21[d] - means[d]) / stds[d]; out[DIM] = 1; return out; }
function buildX(feat6) { return feat6.map(standardize); }

const trainData = trainRawFeat.map(rec => ({ key: rec.key, date: rec.date, X: buildX(rec.feat), wi: rec.chakuju[0], wj: rec.chakuju[1], wk: rec.chakuju[2] }));
console.log('trainData n=', trainData.length);

// ============================================================
// 2. Training: K-truncated WARP ranking loss, subgradient SGD
// ============================================================
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const HP = PREREG.designDecisions.hyperparameters;
const rng = mulberry32(HP.seed);
function randInt(n) { return Math.floor(rng() * n); }
function sampleTriple() {
  const a = randInt(6);
  let b = randInt(5); if (b >= a) b++;
  const cpool = [0, 1, 2, 3, 4, 5].filter(x => x !== a && x !== b);
  const c = cpool[randInt(4)];
  return [a, b, c];
}
function shuffleInPlace(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } }
function dot(w, x) { let s = 0; for (let d = 0; d < w.length; d++) s += w[d] * x[d]; return s; }

const NDIM = DIM + 1;
let w1 = new Array(NDIM).fill(0), w2 = new Array(NDIM).fill(0), w3 = new Array(NDIM).fill(0);
const harmonicCache = [0];
for (let i = 1; i <= HP.k; i++) harmonicCache.push(harmonicCache[i - 1] + 1 / i);
function Ltrunc(r) { return harmonicCache[Math.min(r, HP.k)]; }

console.log('training start: WARP K=' + HP.k + ' maxEpochs=' + HP.maxEpochs);
let prevEpochLoss = null;
let epochsRun = 0;
const trainCurve = [];
const trainIdx = trainData.map((_, i) => i);
for (let epoch = 0; epoch < HP.maxEpochs; epoch++) {
  shuffleInPlace(trainIdx);
  let lossSum = 0, updatedCount = 0, skippedCount = 0;
  for (const idx of trainIdx) {
    const rec = trainData[idx];
    const X = rec.X, wi = rec.wi, wj = rec.wj, wk = rec.wk;
    const scorePos = dot(w1, X[wi]) + dot(w2, X[wj]) + dot(w3, X[wk]);
    let trials = 0, foundA = -1, foundB = -1, foundC = -1, scoreNeg = 0;
    while (trials < HP.maxTrials) {
      trials++;
      const t = sampleTriple();
      const a = t[0], b = t[1], c = t[2];
      if (a === wi && b === wj && c === wk) continue;
      const s = dot(w1, X[a]) + dot(w2, X[b]) + dot(w3, X[c]);
      if (HP.margin - scorePos + s > 0) { foundA = a; foundB = b; foundC = c; scoreNeg = s; break; }
    }
    if (foundA === -1) { skippedCount++; continue; }
    const rHat = Math.floor(119 / trials);
    const weight = Ltrunc(rHat);
    const hinge = HP.margin - scorePos + scoreNeg;
    lossSum += weight * hinge;
    updatedCount++;
    const lr = HP.learningRate;
    for (let d = 0; d < NDIM; d++) {
      w1[d] += lr * (weight * (X[wi][d] - X[foundA][d]) - HP.l2 * w1[d]);
      w2[d] += lr * (weight * (X[wj][d] - X[foundB][d]) - HP.l2 * w2[d]);
      w3[d] += lr * (weight * (X[wk][d] - X[foundC][d]) - HP.l2 * w3[d]);
    }
  }
  const epochLoss = lossSum / trainData.length;
  trainCurve.push({ epoch, epochLoss, updatedCount, skippedCount });
  console.log('  epoch=' + epoch + ' avgWeightedHinge=' + epochLoss.toFixed(5) + ' updated=' + updatedCount + ' skipped=' + skippedCount);
  epochsRun = epoch + 1;
  if (prevEpochLoss !== null) {
    const relChange = Math.abs(epochLoss - prevEpochLoss) / Math.max(prevEpochLoss, 1e-9);
    if (relChange < HP.convergenceTol) { console.log('  converged: relChange=' + relChange.toFixed(5) + ' < ' + HP.convergenceTol); prevEpochLoss = epochLoss; break; }
  }
  prevEpochLoss = epochLoss;
}
console.log('training done. epochsRun=' + epochsRun);

// ============================================================
// 3. Save training artifacts (CLAUDE.md rule 7)
// ============================================================
const trainSnapshotForHash = trainRawFeat.map(r => ({ key: r.key, date: r.date, venue: r.venue, chakuju: r.chakuju }));
const trainRaceIds = trainRawFeat.map(r => r.key);
const featuresJsSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'alpha_engine', 'features.js'));
const modelArtifact = {
  caseId: 'GARON-20260905-009', modelId: 'garon_top8_warp_linear_v2',
  generatedAt: new Date().toISOString(),
  hyperparameters: HP, epochsRun: epochsRun, trainCurve: trainCurve,
  standardization: { dim: DIM, means: means, stds: stds },
  weights: { w1: w1, w2: w2, w3: w3 },
  nodeVersion: process.version,
  featureCodeSha256: sha256(featuresJsSrc),
  trainRaceCount: trainData.length,
  trainRaceIdsSha256: hashObj(trainRaceIds),
  archiveFileHashes: archiveHashes,
};
const modelPath = path.join(ROOT, 'logs', 'research_top8_direct_optimization_model_2026-09-05.json');
fs.writeFileSync(modelPath, JSON.stringify(modelArtifact, null, 2));
const modelHash = sha256(fs.readFileSync(modelPath));
console.log('model artifact saved:', modelPath, 'sha256=', modelHash);

const rawSnapshotPath = path.join(ROOT, 'logs', 'research_top8_direct_optimization_train_snapshot_2026-09-05.json');
fs.writeFileSync(rawSnapshotPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: trainSnapshotForHash.length, contentHash: hashObj(trainSnapshotForHash), races: trainSnapshotForHash }, null, 2));
const rawSnapshotHash = sha256(fs.readFileSync(rawSnapshotPath));
console.log('train race-id/result snapshot saved:', rawSnapshotPath, 'sha256=', rawSnapshotHash);

// ============================================================
// 4. Layer 1 evaluation (no odds)
// ============================================================
console.log('=== LAYER 1 EVALUATION (no odds) ===');

function idxToRankedFromDist(dist) { return dist.slice().sort((a, b) => b.p - a.p || a.val.localeCompare(b.val)); }
function v2Ranked(X) {
  const arr = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (j !== i) for (let k = 0; k < 6; k++) if (k !== i && k !== j) {
    const score = dot(w1, X[i]) + dot(w2, X[j]) + dot(w3, X[k]);
    arr.push({ val: (i + 1) + '-' + (j + 1) + '-' + (k + 1), score: score });
  }
  arr.sort((a, b) => b.score - a.score || a.val.localeCompare(b.val));
  return arr;
}

const TOPNS = [1, 3, 5, 8, 12, 20];
function evalOneRace(r) {
  const feat = rawFeatures(r);
  const X = buildX(feat);
  let distP0;
  try { distP0 = alphaExt.distribution(r.boats); } catch (e) { return null; }
  const rankedP0 = idxToRankedFromDist(distP0);
  const rankedV2 = v2Ranked(X);
  const chakuju = r.chakuju;
  function rec(ranked) {
    const rank = ranked.findIndex(e => e.val === chakuju) + 1;
    const top1v = ranked[0].val.split('-').map(Number);
    const parts = chakuju.split('-').map(Number);
    const ci = parts[0], cj = parts[1], ck = parts[2];
    const firstHit = top1v[0] === ci;
    const secondHitCond = firstHit ? (top1v[1] === cj) : null;
    const thirdHitCond = (firstHit && top1v[1] === cj) ? (top1v[2] === ck) : null;
    const topNHit = {}; for (const n of TOPNS) topNHit[n] = rank > 0 && rank <= n;
    const top8Boats = ranked.slice(0, 8).flatMap(e => e.val.split('-').map(Number));
    return { rank: rank, firstHit: firstHit, secondHitCond: secondHitCond, thirdHitCond: thirdHitCond, topNHit: topNHit, top8Boats: top8Boats, top1Leader: top1v[0] };
  }
  return { key: keyOf(r), date: r.date, venue: r.venue, month: r.date.slice(0, 7), p0: rec(rankedP0), v2: rec(rankedV2) };
}

function buildEvalRecords(races) {
  const out = []; let skip = 0;
  for (const r of races) { const e = evalOneRace(r); if (e) out.push(e); else skip++; }
  return { out: out, skip: skip };
}
const evalARes = buildEvalRecords(evalARaw), evalA = evalARes.out, skipA = evalARes.skip;
const evalBRes = buildEvalRecords(evalBRaw), evalB = evalBRes.out, skipB = evalBRes.skip;
const evalBeyondRes = buildEvalRecords(evalBeyondRaw), evalBeyond = evalBeyondRes.out, skipBeyond = evalBeyondRes.skip;
const evalAll = evalA.concat(evalB);
console.log('EvalA n=', evalA.length, '(skip', skipA, ') EvalB n=', evalB.length, '(skip', skipB, ') Beyond(09-03) n=', evalBeyond.length, '(skip', skipBeyond, ')');

function summarize(records, whichModel, label) {
  const n = records.length;
  if (!n) return { n: 0 };
  const rs = records.map(r => r[whichModel]);
  const firstRate = rs.filter(r => r.firstHit).length / n;
  const secCondN = rs.filter(r => r.secondHitCond !== null).length;
  const secCondRate = secCondN ? rs.filter(r => r.secondHitCond === true).length / secCondN : null;
  const thirdCondN = rs.filter(r => r.thirdHitCond !== null).length;
  const thirdCondRate = thirdCondN ? rs.filter(r => r.thirdHitCond === true).length / thirdCondN : null;
  const topNRates = {}; for (const nn of TOPNS) topNRates[nn] = rs.filter(r => r.topNHit[nn]).length / n;
  const ranks = rs.map(r => r.rank).sort((a, b) => a - b);
  const median = ranks[Math.floor(ranks.length / 2)];
  const meanRank = ranks.reduce((s, v) => s + v, 0) / ranks.length;
  const boatFreq = new Array(7).fill(0);
  rs.forEach(r => r.top8Boats.forEach(b => boatFreq[b]++));
  const boatShare = boatFreq.slice(1).map(c => c / (n * 24));
  const leaderFreq = new Array(7).fill(0);
  rs.forEach(r => leaderFreq[r.top1Leader]++);
  const leaderShare = leaderFreq.slice(1).map(c => c / n);
  console.log('[' + label + '/' + whichModel + '] n=' + n + ' firstHit=' + (firstRate * 100).toFixed(2) + '% cond2nd(n=' + secCondN + ')=' + (secCondRate !== null ? (secCondRate * 100).toFixed(2) + '%' : 'N/A') + ' cond3rd(n=' + thirdCondN + ')=' + (thirdCondRate !== null ? (thirdCondRate * 100).toFixed(2) + '%' : 'N/A'));
  console.log('   topN: ' + TOPNS.map(nn => 'top' + nn + '=' + (topNRates[nn] * 100).toFixed(2) + '%').join(' ') + '  rankMedian=' + median + ' rankMean=' + meanRank.toFixed(1));
  console.log('   top8 boat-share(of 24 slots):', boatShare.map((v, i) => (i + 1) + ':' + (v * 100).toFixed(1) + '%').join(' '), ' / top1-leader-share:', leaderShare.map((v, i) => (i + 1) + ':' + (v * 100).toFixed(1) + '%').join(' '));
  return { n: n, firstRate: firstRate, secCondN: secCondN, secCondRate: secCondRate, thirdCondN: thirdCondN, thirdCondRate: thirdCondRate, topNRates: topNRates, rankMedian: median, rankMean: meanRank, boatShare: boatShare, leaderShare: leaderShare };
}

const layer1 = {};
const layer1Groups = [['EvalA', evalA], ['EvalB', evalB], ['EvalAll', evalAll], ['Beyond0903', evalBeyond]];
for (let gi = 0; gi < layer1Groups.length; gi++) {
  const label = layer1Groups[gi][0], recs = layer1Groups[gi][1];
  layer1[label] = { p0: summarize(recs, 'p0', label), v2: summarize(recs, 'v2', label) };
}

console.log('--- monthly (reference) ---');
const byMonth = {};
evalAll.concat(evalBeyond).forEach(r => { (byMonth[r.month] = byMonth[r.month] || []).push(r); });
const monthly = {};
Object.keys(byMonth).sort().forEach(m => { monthly[m] = { p0: summarize(byMonth[m], 'p0', 'month=' + m), v2: summarize(byMonth[m], 'v2', 'month=' + m) }; });

console.log('--- by venue (EvalA+EvalB) ---');
const byVenue = {};
evalAll.forEach(r => { (byVenue[r.venue] = byVenue[r.venue] || []).push(r); });
const venueStats = {};
Object.keys(byVenue).sort().forEach(v => {
  const recs = byVenue[v];
  const p0Top8 = recs.filter(r => r.p0.topNHit[8]).length / recs.length;
  const v2Top8 = recs.filter(r => r.v2.topNHit[8]).length / recs.length;
  venueStats[v] = { n: recs.length, p0Top8: p0Top8 * 100, v2Top8: v2Top8 * 100, diff: (v2Top8 - p0Top8) * 100 };
  const note = recs.length < 30 ? ' (n<30, not treated as a trend)' : '';
  console.log('  ' + v + ' n=' + recs.length + ' P0top8=' + (p0Top8 * 100).toFixed(1) + '% V2top8=' + (v2Top8 * 100).toFixed(1) + '% diff=' + ((v2Top8 - p0Top8) * 100).toFixed(1) + 'pt' + note);
});

console.log('--- day-block bootstrap (top8 hit-rate diff V2-P0, EvalA+EvalB) ---');
const byDate = {};
evalAll.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
const dateList = Object.keys(byDate).sort();
const BOOT_B = 2000;
const bootRng = mulberry32(HP.seed + 1);
function bootRandInt(n) { return Math.floor(bootRng() * n); }
const diffs = [];
for (let b = 0; b < BOOT_B; b++) {
  let recs = [];
  for (let i = 0; i < dateList.length; i++) recs = recs.concat(byDate[dateList[bootRandInt(dateList.length)]]);
  const p0Rate = recs.filter(r => r.p0.topNHit[8]).length / recs.length;
  const v2Rate = recs.filter(r => r.v2.topNHit[8]).length / recs.length;
  diffs.push((v2Rate - p0Rate) * 100);
}
diffs.sort((a, b) => a - b);
function pct(arr, q) { const idx = (arr.length - 1) * q; const lo = Math.floor(idx), hi = Math.ceil(idx); return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (idx - lo); }
const bootCI = { p2_5: pct(diffs, 0.025), p50: pct(diffs, 0.5), p97_5: pct(diffs, 0.975), positiveShare: diffs.filter(d => d > 0).length / diffs.length };
console.log('  95% CI=[' + bootCI.p2_5.toFixed(2) + ', ' + bootCI.p97_5.toFixed(2) + ']pt median=' + bootCI.p50.toFixed(2) + 'pt shareV2wins=' + (bootCI.positiveShare * 100).toFixed(1) + '%');

// ============================================================
// 5. Layer 2 evaluation (model ranking fixed, then filter by true T-10 odds band 50-150)
// ============================================================
console.log('=== LAYER 2 EVALUATION (true T-10 odds, band50-150, ranking fixed) ===');
const popPath = path.join(ROOT, 'logs', 'research_market_anchored_blend_calibration_population_2026-09-05.json');
const popFile = JSON.parse(fs.readFileSync(popPath, 'utf8'));
const popFileHash = sha256(fs.readFileSync(popPath));
console.log('reused population (GARON-20260905-007) n=', popFile.count, 'sha256=', popFileHash);

function validOddsEntries(oddsMap) { return Object.entries(oddsMap || {}).map(function (e) { return { val: e[0], odds: Number(e[1]) }; }).filter(function (e) { return Number.isFinite(e.odds) && e.odds > 0; }); }
function parsePayout100(mul) { return Math.round(mul * 100); }

function buildLayer2Rec(r) {
  const entries = validOddsEntries(r.oddsMap);
  if (entries.length !== 120) return null;
  const oddsMap2 = new Map(entries.map(function (e) { return [e.val, e.odds]; }));
  let distP0;
  try { distP0 = alphaExt.distribution(r.boats); } catch (e) { return null; }
  const rankedP0 = idxToRankedFromDist(distP0);
  const feat = rawFeatures(r); const X = buildX(feat);
  const rankedV2 = v2Ranked(X);
  return { key: r.key, date: r.date, venue: r.venue, shimekiri: r.shimekiri, chakuju: r.chakuju, payoutMul: r.payoutMul, oddsMap: oddsMap2, rankedP0: rankedP0, rankedV2: rankedV2 };
}
const l2All = popFile.races.map(buildLayer2Rec).filter(Boolean);
console.log('layer2 target (120 valid odds, distribution computable) n=', l2All.length);

function bandSelect(ranked, oddsMap, lo, hi) {
  const cand = ranked.filter(function (e) { const o = oddsMap.get(e.val); return o >= lo && o <= hi; });
  if (cand.length < 8) return null;
  return cand.slice(0, 8);
}

function layer2Metrics(recs, whichRanked, lo, hi, label) {
  const rows = [];
  const dateSet = new Set();
  for (const r of recs) {
    dateSet.add(r.date);
    const sel = bandSelect(r[whichRanked], r.oddsMap, lo, hi);
    if (!sel) continue;
    const vals = sel.map(function (e) { return e.val; });
    const hit = vals.indexOf(r.chakuju) !== -1;
    const payoutYen = hit ? parsePayout100(r.payoutMul) : 0;
    rows.push({ date: r.date, venue: r.venue, hit: hit, payoutYen: payoutYen, payoutMul: r.payoutMul, key: r.key, shimekiri: r.shimekiri });
  }
  const n = rows.length;
  const totalDays = dateSet.size;
  const stake = n * 8 * 100;
  const hitRows = rows.filter(function (r) { return r.hit; });
  const hit = hitRows.length;
  const payout = hitRows.reduce(function (s, r) { return s + r.payoutYen; }, 0);
  const band50Hit = hitRows.filter(function (r) { return r.payoutMul >= 50 && r.payoutMul <= 150; }).length;
  const band30Hit = hitRows.filter(function (r) { return r.payoutMul >= 30 && r.payoutMul <= 150; }).length;
  const sorted = rows.slice().sort(function (a, b) { return a.date.localeCompare(b.date) || (a.shimekiri || '').localeCompare(b.shimekiri || ''); });
  let maxStreak = 0, curStreak = 0;
  const daysWithEntry = new Set();
  sorted.forEach(function (r) { daysWithEntry.add(r.date); if (r.hit) curStreak = 0; else { curStreak++; maxStreak = Math.max(maxStreak, curStreak); } });
  maxStreak = Math.max(maxStreak, curStreak);
  function roiExTopN(nExclude) {
    const sortedPay = hitRows.map(function (r) { return r.payoutYen; }).sort(function (a, b) { return b - a; });
    const reducedPayout = sortedPay.slice(nExclude).reduce(function (s, x) { return s + x; }, 0);
    const reducedStake = (n - Math.min(nExclude, sortedPay.length)) * 8 * 100;
    return reducedStake > 0 ? reducedPayout / reducedStake * 100 : null;
  }
  const result = {
    label: label, band: lo + '-' + hi, targetN: recs.length, enteredN: n,
    hit: hit, hitRate: n ? hit / n * 100 : null,
    band50Hit: band50Hit, band50Rate: n ? band50Hit / n * 100 : null,
    band30Hit: band30Hit, band30Rate: n ? band30Hit / n * 100 : null,
    stake: stake, payout: payout, roi: n ? payout / stake * 100 : null,
    roiExTop1: roiExTopN(1), roiExTop2: roiExTopN(2),
    maxStreak: maxStreak, avgPointsPerRace: n ? 8 : 0,
    daysWithEntry: daysWithEntry.size, totalDaysInPop: totalDays, avgPerDay: totalDays ? n / totalDays : null,
  };
  console.log('[' + label + '] enteredN=' + n + '/' + recs.length + ' hit=' + hit + '(' + (result.hitRate || 0).toFixed(1) + '%) band50-150=' + band50Hit + '(' + (result.band50Rate || 0).toFixed(1) + '%) band30-150=' + band30Hit + '(' + (result.band30Rate || 0).toFixed(1) + '%)');
  console.log('    ROI=' + (result.roi != null ? result.roi.toFixed(1) : 'NA') + '% roiExTop1=' + (result.roiExTop1 != null ? result.roiExTop1.toFixed(1) : 'NA') + '% roiExTop2=' + (result.roiExTop2 != null ? result.roiExTop2.toFixed(1) : 'NA') + '% maxStreak=' + maxStreak + ' avgPerDay=' + (result.avgPerDay != null ? result.avgPerDay.toFixed(2) : 'NA') + ' daysWithEntry=' + daysWithEntry.size + '/' + totalDays);
  return result;
}

const layer2P0_50_150 = layer2Metrics(l2All, 'rankedP0', 50, 150, 'P0 band50-150 (primary)');
const layer2V2_50_150 = layer2Metrics(l2All, 'rankedV2', 50, 150, 'V2 band50-150 (primary)');
console.log('--- auxiliary: band30-150 (selection itself still fixed at 50-150, reference only) ---');
const layer2P0_30_150 = layer2Metrics(l2All, 'rankedP0', 30, 150, 'P0 band30-150 (aux)');
const layer2V2_30_150 = layer2Metrics(l2All, 'rankedV2', 30, 150, 'V2 band30-150 (aux)');

// ============================================================
// 6. Judgment
// ============================================================
console.log('=== JUDGMENT ===');
const top8DiffA = (layer1.EvalA.v2.topNRates[8] - layer1.EvalA.p0.topNRates[8]) * 100;
const top8DiffB = (layer1.EvalB.v2.topNRates[8] - layer1.EvalB.p0.topNRates[8]) * 100;
console.log('top8 diff (V2-P0): EvalA=' + top8DiffA.toFixed(2) + 'pt EvalB=' + top8DiffB.toFixed(2) + 'pt');
const pureImproved = top8DiffA > 0 && top8DiffB > 0;
console.log('pure top8 improved in BOTH EvalA/EvalB =', pureImproved);

let grade, reasoning;
if (!pureImproved) {
  grade = 'C';
  reasoning = 'Pure top8 inclusion did not improve over P0 in both EvalA and EvalB (EvalA diff=' + top8DiffA.toFixed(2) + 'pt, EvalB diff=' + top8DiffB.toFixed(2) + 'pt). Judgment C: terminate this direct-optimization design.';
} else {
  const p0Roi = layer2P0_50_150.roi, v2Roi = layer2V2_50_150.roi;
  const layer2NotWorse = (v2Roi != null && p0Roi != null) ? (v2Roi >= p0Roi - 1e-9) : false;
  const layer2Computable = layer2V2_50_150.enteredN >= 30 && layer2P0_50_150.enteredN >= 30;
  if (layer2Computable && layer2NotWorse) {
    grade = 'A';
    reasoning = 'Pure top8 improved in both EvalA/EvalB, and layer2 (band50-150) ROI did not worsen (P0=' + (p0Roi || 0).toFixed(1) + '% V2=' + (v2Roi || 0).toFixed(1) + '%). n=' + layer2V2_50_150.enteredN + ' single held-out window; shadow-candidate stage only, not production.';
  } else {
    grade = 'B';
    reasoning = 'Pure top8 improved, but layer2 conversion ' + (layer2Computable ? ('ROI worsened (P0=' + (p0Roi || 0).toFixed(1) + '% V2=' + (v2Roi || 0).toFixed(1) + '%)') : ('insufficient population (P0 n=' + layer2P0_50_150.enteredN + ', V2 n=' + layer2V2_50_150.enteredN + ')')) + '. Keep as pure-prediction candidate only.';
  }
}
console.log('FINAL JUDGMENT: ' + grade);
console.log(reasoning);

// ============================================================
// 7. Save full output
// ============================================================
const out = {
  generatedAt: new Date().toISOString(),
  caseId: 'GARON-20260905-009',
  preregistration: preregPath,
  reproduction: { command: 'node tests/research_top8_direct_optimization_2026-09-05.js', nodeVersion: process.version, seed: HP.seed },
  artifacts: {
    modelPath: 'logs/research_top8_direct_optimization_model_2026-09-05.json', modelSha256: modelHash,
    trainSnapshotPath: 'logs/research_top8_direct_optimization_train_snapshot_2026-09-05.json', trainSnapshotSha256: rawSnapshotHash,
    fixedEvalPopulation: 'logs/research_market_anchored_blend_calibration_population_2026-09-05.json', fixedEvalPopulationSha256: popFileHash,
    featureCodeSha256: sha256(featuresJsSrc),
  },
  dataCounts: { total: all.length, layer1Pop: layer1Pop.length, train: trainData.length, evalA: evalA.length, evalB: evalB.length, beyond: evalBeyond.length, layer2Population: l2All.length },
  trainCurve: trainCurve, epochsRun: epochsRun,
  layer1: layer1, monthly: monthly, venueStats: venueStats, bootstrap: { evalWindow: 'EvalA+EvalB', B: BOOT_B, ci: bootCI },
  layer2: { band50_150: { P0: layer2P0_50_150, V2: layer2V2_50_150 }, band30_150_aux: { P0: layer2P0_30_150, V2: layer2V2_30_150 } },
  judgment: { grade: grade, reasoning: reasoning, top8DiffA: top8DiffA, top8DiffB: top8DiffB },
};
const outPath = path.join(ROOT, 'logs', 'research_top8_direct_optimization_2026-09-05.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('saved:', outPath);
