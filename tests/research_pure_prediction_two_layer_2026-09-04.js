'use strict';
// GARON-20260904-002 research: 純粋予想エンジン(オッズ非依存)二層構造の設計・検証
// 事前登録: logs/research_pure_prediction_preregistration_2026-09-04.json (このスクリプト実行前に確定済み)
// 分析のみ。本番ファイル(alpha.js等)は一切変更しない(メモリ内パッチのみ、GARON-20260904-001と同一手法)。

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const { loadAllRaces, isUsable, hasFullData } = require('./q_engine_entry_backtest.js');
const { loadQEngine } = require('./lib/extract-q-engine.js');

// ===== alpha.js を distribution() つきでメモリ内パッチ読込(ディスク変更なし) =====
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
console.log('=== GARON-20260904-002 純粋予想エンジン 二層構造 設計・検証 ===');
console.log('alpha.js(distribution付きメモリ内パッチ)読込完了。ENTRY_THRESHOLD=', alphaOriginal.ENTRY_THRESHOLD);

const preReg = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_pure_prediction_preregistration_2026-09-04.json'), 'utf8'));
console.log('事前登録読込: registeredAt=', preReg.registeredAt, ' hypothesis=', preReg.hypothesis.id);

function shimekiriMs(dateStr, shimekiriStr) {
  const m = String(shimekiriStr).match(/([0-9]{1,2}):([0-9]{2})/);
  if (!m) return null;
  const ms = Date.parse(dateStr + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00.000+09:00');
  return isNaN(ms) ? null : ms;
}
function classifyTimingFixed(r) {
  if (!r.archivedAt) return { cls: 'unknown', diffMs: null };
  const archMs = Date.parse(r.archivedAt);
  if (isNaN(archMs)) return { cls: 'unknown', diffMs: null };
  const deadlineMs = shimekiriMs(r.date, r.shimekiri);
  if (deadlineMs == null) return { cls: 'unknown', diffMs: null };
  const diffMs = deadlineMs - archMs;
  if (diffMs > 0 && diffMs <= 20 * 60 * 1000) return { cls: 'true', diffMs };
  return { cls: 'unknown', diffMs };
}
function validOddsEntries(oddsMap) {
  return Object.entries(oddsMap || {}).map(([val, v]) => ({ val, odds: Number(v) })).filter(e => Number.isFinite(e.odds) && e.odds > 0);
}
function isUsableForLayer1(r) {
  return !!(r.resulted && r.boats && r.boats.length === 6 && r.boats.every(b => !b.isJogai) && r.chakuju);
}

console.log('\n========== 0. データ読込・6区分分類 ==========');
const all = loadAllRaces();
console.log('総レース数(daikibo_archive全ファイル合計) =', all.length);

const layer1Pop = all.filter(isUsableForLayer1);
console.log('isUsableForLayer1(結果確定・6艇・欠場なし・着順あり、オッズ不問) n =', layer1Pop.length);
const isUsablePop = all.filter(isUsable);
console.log('参考: 既存isUsable(オッズも要求) n =', isUsablePop.length, ' hasFullData(ダッシュボード「完全」定義) n =', isUsablePop.filter(hasFullData).length);

const TRAIN_HI_EXCLUSIVE = '2026-08-21';
const cls1_trainInner = layer1Pop.filter(r => r.date < TRAIN_HI_EXCLUSIVE);
const cls2_trainOuter = layer1Pop.filter(r => r.date >= TRAIN_HI_EXCLUSIVE);
const cls3_trueT10 = isUsablePop.filter(r => classifyTimingFixed(r).cls === 'true' && validOddsEntries(r.oddsMap).length === 120);
const cls4_unknownOdds = isUsablePop.filter(r => classifyTimingFixed(r).cls === 'unknown' && Object.keys(r.oddsMap || {}).length > 0);
const cls5_noOdds = layer1Pop.filter(r => !r.oddsMap || Object.keys(r.oddsMap).length === 0);
console.log('1_学習内(date<2026-08-21) n =', cls1_trainInner.length);
console.log('2_学習外(date>=2026-08-21) n =', cls2_trainOuter.length);
console.log('3_真T10オッズあり n =', cls3_trueT10.length);
console.log('4_時点不明オッズあり n =', cls4_unknownOdds.length);
console.log('5_オッズなし n =', cls5_noOdds.length);
console.log('6_backfill更新あり: daikibo_archiveのスキーマに直接のフラグが存在しないため判別不能(事前登録の通り推測タグ付けはしない)');

console.log('\n========== 1. 純粋予想モデル基準値・仮説の準備 ==========');

function softmax(scores) {
  const max = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - max));
  const tot = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / tot);
}
function distIdx(boats) {
  // distribution()の120通り出力を idx[i][j][k] (0-5, boat番号-1) の3次元配列へ変換
  const dist = alphaExt.distribution(boats);
  const sum = dist.reduce((s, c) => s + c.p, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error('INVALID_DIST_SUM:' + sum);
  const idx = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => new Array(6).fill(0)));
  for (const c of dist) {
    const [a, b, cc] = c.val.split('-').map(x => Number(x) - 1);
    idx[a][b][cc] = c.p;
  }
  return idx;
}
function boatKinMap(boats) {
  const m = new Array(6).fill(null);
  for (const b of boats) m[b.no - 1] = (typeof b.kinsetsu6m === 'number' && Number.isFinite(b.kinsetsu6m)) ? b.kinsetsu6m : 0;
  return m;
}
function chakujuIdx(chakuju) {
  const [a, b, c] = chakuju.split('-').map(x => Number(x) - 1);
  return [a, b, c];
}

// ===== 学習データ準備(学習内、date<2026-08-21) =====
const trainRecords = [];
let trainSkip = 0;
for (const r of cls1_trainInner) {
  let idx;
  try { idx = distIdx(r.boats); } catch (e) { trainSkip++; continue; }
  const kin = boatKinMap(r.boats);
  const [wi, wj, wk] = chakujuIdx(r.chakuju);
  trainRecords.push({ idx, kin, wi, wj, wk, date: r.date });
}
console.log('学習内 距離計算成功 n =', trainRecords.length, ' skip(dist計算失敗) =', trainSkip);

// 標準化パラメータ(学習期間のみ)
const allTrainKin = trainRecords.flatMap(r => r.kin);
const meanTrain = allTrainKin.reduce((s, v) => s + v, 0) / allTrainKin.length;
const stdTrain = Math.sqrt(allTrainKin.reduce((s, v) => s + (v - meanTrain) ** 2, 0) / allTrainKin.length);
console.log('kinsetsu6m 標準化パラメータ(学習期間のみ、艇単位n=' + allTrainKin.length + '): 平均=' + meanTrain.toFixed(4) + ' 標準偏差=' + stdTrain.toFixed(4));
function z(kinVal) { return (kinVal - meanTrain) / stdTrain; }

// ===== 学習データの前処理(段別raw確率を事前計算、勾配降下は軽量な算術のみ) =====
function precomputeTrain(rec) {
  const { idx, wi, wj, wk } = rec;
  const p1raw = new Array(6).fill(0);
  for (let i = 0; i < 6; i++) { let s = 0; for (let j = 0; j < 6; j++) for (let k = 0; k < 6; k++) if (j !== i && k !== i && k !== j) s += idx[i][j][k]; p1raw[i] = s; }
  const pPairRawI = new Array(6).fill(0); // pPair(wi, j) for all j != wi
  for (let j = 0; j < 6; j++) { if (j === wi) continue; let s = 0; for (let k = 0; k < 6; k++) if (k !== wi && k !== j) s += idx[wi][j][k]; pPairRawI[j] = s; }
  const cand2 = [0, 1, 2, 3, 4, 5].filter(j => j !== wi);
  const p2raw = cand2.map(j => pPairRawI[j] / Math.max(p1raw[wi], 1e-12));
  const cand3 = [0, 1, 2, 3, 4, 5].filter(k => k !== wi && k !== wj);
  const pPairWiWj = pPairRawI[wj];
  const p3raw = cand3.map(k => idx[wi][wj][k] / Math.max(pPairWiWj, 1e-12));
  return { p1raw, cand2, p2raw, cand3, p3raw, wi, wj, wk, kin: rec.kin };
}
const trainPre = trainRecords.map(precomputeTrain);

console.log('\n========== 2. 学習(1係数w、3段共通、L2=' + preReg.hypothesis.fitting.L2 + ' LR=' + preReg.hypothesis.fitting.learningRate + ' EPOCHS=' + preReg.hypothesis.fitting.epochs + ') ==========');
let w = 0;
const L2 = preReg.hypothesis.fitting.L2, LR = preReg.hypothesis.fitting.learningRate, EPOCHS = preReg.hypothesis.fitting.epochs;
for (let epoch = 0; epoch < EPOCHS; epoch++) {
  let grad = 0;
  for (const t of trainPre) {
    const zArr = t.kin.map(z);
    // stage1
    const scores1 = t.p1raw.map((p, i) => Math.log(Math.max(p, 1e-12)) + w * zArr[i]);
    const p1w = softmax(scores1);
    for (let i = 0; i < 6; i++) grad += (p1w[i] - (i === t.wi ? 1 : 0)) * zArr[i];
    // stage2
    const scores2 = t.cand2.map((j, ii) => Math.log(Math.max(t.p2raw[ii], 1e-12)) + w * zArr[j]);
    const p2w = softmax(scores2);
    t.cand2.forEach((j, ii) => { grad += (p2w[ii] - (j === t.wj ? 1 : 0)) * zArr[j]; });
    // stage3
    const scores3 = t.cand3.map((k, ii) => Math.log(Math.max(t.p3raw[ii], 1e-12)) + w * zArr[k]);
    const p3w = softmax(scores3);
    t.cand3.forEach((k, ii) => { grad += (p3w[ii] - (k === t.wk ? 1 : 0)) * zArr[k]; });
  }
  grad = grad / trainPre.length + L2 * w;
  w -= LR * grad;
}
console.log('学習された係数 w =', w.toFixed(5), '(標準化kinsetsu6mに対する、1〜3段共通の加法的ログオッズ係数)');

console.log('\n========== 3. 評価用: 全120通り再構成関数(w=0で基準、w=w_fittedで仮説) ==========');
function reweightFull(idx, kin, wCoef) {
  const zArr = kin.map(z);
  const out = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => new Array(6).fill(0)));
  const p1raw = new Array(6).fill(0);
  for (let i = 0; i < 6; i++) { let s = 0; for (let j = 0; j < 6; j++) for (let k = 0; k < 6; k++) if (j !== i && k !== i && k !== j) s += idx[i][j][k]; p1raw[i] = s; }
  const scores1 = p1raw.map((p, i) => Math.log(Math.max(p, 1e-12)) + wCoef * zArr[i]);
  const p1w = softmax(scores1);
  for (let i = 0; i < 6; i++) {
    const pPairRaw = new Array(6).fill(0);
    for (let j = 0; j < 6; j++) { if (j === i) continue; let s = 0; for (let k = 0; k < 6; k++) if (k !== i && k !== j) s += idx[i][j][k]; pPairRaw[j] = s; }
    const cand2 = [0, 1, 2, 3, 4, 5].filter(j => j !== i);
    const p2raw = cand2.map(j => pPairRaw[j] / Math.max(p1raw[i], 1e-12));
    const scores2 = cand2.map((j, ii) => Math.log(Math.max(p2raw[ii], 1e-12)) + wCoef * zArr[j]);
    const p2w = softmax(scores2);
    cand2.forEach((j, ii) => {
      const cand3 = [0, 1, 2, 3, 4, 5].filter(k => k !== i && k !== j);
      const p3raw = cand3.map(k => idx[i][j][k] / Math.max(pPairRaw[j], 1e-12));
      const scores3 = cand3.map((k, iii) => Math.log(Math.max(p3raw[iii], 1e-12)) + wCoef * zArr[k]);
      const p3w = softmax(scores3);
      cand3.forEach((k, iii) => { out[i][j][k] = p1w[i] * p2w[ii] * p3w[iii]; });
    });
  }
  return out;
}
function idxToRanked(idx) {
  const arr = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (let k = 0; k < 6; k++) if (idx[i][j][k] > 0) arr.push({ val: `${i + 1}-${j + 1}-${k + 1}`, p: idx[i][j][k] });
  arr.sort((a, b) => b.p - a.p || a.val.localeCompare(b.val));
  return arr;
}

// サニティチェック: w=0のreweightFullが元のpmと数値一致するか(訓練内から1件抜き取り確認)
(function sanity() {
  const rec = trainRecords[0];
  const orig = idxToRanked(rec.idx);
  const rw = idxToRanked(reweightFull(rec.idx, rec.kin, 0));
  let maxDiff = 0;
  const origMap = new Map(orig.map(e => [e.val, e.p]));
  for (const e of rw) maxDiff = Math.max(maxDiff, Math.abs(e.p - origMap.get(e.val)));
  console.log('サニティチェック(w=0時、reweightFullが元pmと一致するか): 最大差分 =', maxDiff.toExponential(3), maxDiff < 1e-9 ? '(合格)' : '(不合格!要確認)');
})();

const TOPNS = [1, 3, 5, 8, 12, 20];
function evalRace(idx, kin, chakuju, wCoef) {
  const idxW = wCoef === 0 ? idx : reweightFull(idx, kin, wCoef);
  const ranked = idxToRanked(idxW);
  const rank = ranked.findIndex(e => e.val === chakuju) + 1; // 1-indexed, 0なら未発見(不可)
  const top1 = ranked[0];
  const [ai, aj, ak] = top1.val.split('-').map(Number);
  const [ci, cj, ck] = chakuju.split('-').map(Number);
  const firstHit = ai === ci;
  const secondHitCond = firstHit ? (aj === cj) : null; // 1着的中時のみ評価
  const thirdHitCond = (firstHit && aj === cj) ? (ak === ck) : null; // 1・2着的中時のみ評価
  const topNHit = {};
  for (const n of TOPNS) topNHit[n] = rank > 0 && rank <= n;
  return { rank, firstHit, secondHitCond, thirdHitCond, topNHit };
}

function summarize(records, label) {
  const n = records.length;
  const firstRate = records.filter(r => r.firstHit).length / n;
  const secCondN = records.filter(r => r.secondHitCond !== null).length;
  const secCondRate = secCondN ? records.filter(r => r.secondHitCond === true).length / secCondN : null;
  const thirdCondN = records.filter(r => r.thirdHitCond !== null).length;
  const thirdCondRate = thirdCondN ? records.filter(r => r.thirdHitCond === true).length / thirdCondN : null;
  const topNRates = {};
  for (const nn of TOPNS) topNRates[nn] = records.filter(r => r.topNHit[nn]).length / n;
  const ranks = records.map(r => r.rank).sort((a, b) => a - b);
  const median = ranks[Math.floor(ranks.length / 2)];
  const mean = ranks.reduce((s, v) => s + v, 0) / ranks.length;
  console.log(`[${label}] n=${n}  1着的中率=${(firstRate*100).toFixed(2)}%  条件付き2着的中率(n=${secCondN})=${secCondRate!==null?(secCondRate*100).toFixed(2)+'%':'N/A'}  条件付き3着的中率(n=${thirdCondN})=${thirdCondRate!==null?(thirdCondRate*100).toFixed(2)+'%':'N/A'}`);
  console.log(`   上位N的中率: ${TOPNS.map(nn=>'top'+nn+'='+(topNRates[nn]*100).toFixed(2)+'%').join(' ')}`);
  console.log(`   正解組合せの順位: 中央値=${median} 平均=${mean.toFixed(1)} (120通り中)`);
  return { n, firstRate, secCondN, secCondRate, thirdCondN, thirdCondRate, topNRates, rankMedian: median, rankMean: mean };
}

console.log('\n========== 4. 学習外(EvalA/EvalB)での基準・仮説 評価 ==========');
function buildEvalRecords(races) {
  const out = [];
  let skip = 0;
  for (const r of races) {
    let idx;
    try { idx = distIdx(r.boats); } catch (e) { skip++; continue; }
    const kin = boatKinMap(r.boats);
    out.push({ r, idx, kin });
  }
  return { out, skip };
}
const evalA_races = cls2_trainOuter.filter(r => r.date >= '2026-08-21' && r.date <= '2026-08-27');
const evalB_races = cls2_trainOuter.filter(r => r.date >= '2026-08-28' && r.date <= '2026-09-02');
console.log('EvalA(08-21〜08-27) 対象レース数 =', evalA_races.length, ' EvalB(08-28〜09-02) 対象レース数 =', evalB_races.length);
const { out: evalA, skip: skipA } = buildEvalRecords(evalA_races);
const { out: evalB, skip: skipB } = buildEvalRecords(evalB_races);
console.log('distribution計算skip: EvalA=', skipA, ' EvalB=', skipB);

function runBoth(evalSet, labelPrefix) {
  const baseRecs = evalSet.map(e => evalRace(e.idx, e.kin, e.r.chakuju, 0));
  const hypRecs = evalSet.map(e => evalRace(e.idx, e.kin, e.r.chakuju, w));
  console.log(`--- ${labelPrefix} 基準(baseline, pure model pm) ---`);
  const baseSum = summarize(baseRecs, labelPrefix + '-baseline');
  console.log(`--- ${labelPrefix} 仮説(H1 kinsetsu6m stagewise reweight, w=${w.toFixed(5)}) ---`);
  const hypSum = summarize(hypRecs, labelPrefix + '-hypothesis');
  return { baseSum, hypSum };
}
const resA = runBoth(evalA, 'EvalA');
const resB = runBoth(evalB, 'EvalB');

// 合算(EvalA+EvalB)
const evalAll = evalA.concat(evalB);
console.log('\n--- EvalA+EvalB 合算 ---');
const baseAllRecs = evalAll.map(e => evalRace(e.idx, e.kin, e.r.chakuju, 0));
const hypAllRecs = evalAll.map(e => evalRace(e.idx, e.kin, e.r.chakuju, w));
const baseAllSum = summarize(baseAllRecs, 'EvalAll-baseline');
const hypAllSum = summarize(hypAllRecs, 'EvalAll-hypothesis');

// 参考: 学習内(自己適合、過学習チェック用)
console.log('\n--- 参考: 学習内(自己適合、参考値のみ) ---');
const trainEvalRecs = trainRecords.map(rec => ({ idx: rec.idx, kin: rec.kin, r: { chakuju: `${rec.wi+1}-${rec.wj+1}-${rec.wk+1}` } }));
const trainBaseRecs = trainEvalRecs.map(e => evalRace(e.idx, e.kin, e.r.chakuju, 0));
const trainHypRecs = trainEvalRecs.map(e => evalRace(e.idx, e.kin, e.r.chakuju, w));
summarize(trainBaseRecs, 'TrainInner-baseline(参考、自己適合)');
summarize(trainHypRecs, 'TrainInner-hypothesis(参考、自己適合)');

console.log('\n========== 5. 判定(事前登録基準の適用) ==========');
const top8DiffA = (resA.hypSum.topNRates[8] - resA.baseSum.topNRates[8]) * 100;
const top8DiffB = (resB.hypSum.topNRates[8] - resB.baseSum.topNRates[8]) * 100;
const top8DiffAll = (hypAllSum.topNRates[8] - baseAllSum.topNRates[8]) * 100;
console.log('上位8点的中率 差(仮説-基準): EvalA=' + top8DiffA.toFixed(2) + 'pt  EvalB=' + top8DiffB.toFixed(2) + 'pt  合算=' + top8DiffAll.toFixed(2) + 'pt');
const directionConsistent = (top8DiffA >= 0) && (top8DiffB >= 0);
const n30ok = resA.baseSum.n >= 30 && resB.baseSum.n >= 30;
let verdict;
if (!n30ok) verdict = 'HOLD(n<30、CLAUDE.md厳守ルール3により判定不可)';
else if (top8DiffA < 0 || top8DiffB < 0) verdict = 'REJECT(いずれかの期間で悪化)';
else if (directionConsistent && top8DiffAll >= 1.0) verdict = 'ADOPT(両期間非劣化、合算+1.0pt以上)';
else verdict = 'HOLD(方向一致だが合算改善が+1.0pt未満)';
console.log('【事前登録基準による判定】', verdict);


console.log('\n========== 6. 第2層: 真T10母集団の凍結・オッズ精査 ==========');
const trueT10Races = isUsablePop.filter(r => classifyTimingFixed(r).cls === 'true' && validOddsEntries(r.oddsMap).length === 120);
console.log('真T10(isUsable ∩ cls=true ∩ 120通り有効オッズ) n =', trueT10Races.length);
const trueT10Dates = [...new Set(trueT10Races.map(r => r.date))].sort();
console.log('日付範囲:', trueT10Dates[0], '〜', trueT10Dates[trueT10Dates.length - 1], '(', trueT10Dates.length, '日間)');

// 凍結スナップショット保存
const snapshotRecords = trueT10Races.map(r => ({ key: `${r.date}_${r.venue}_${r.racenum}`, date: r.date, venue: r.venue, racenum: r.racenum, boats: r.boats, oddsMap: r.oddsMap, chakuju: r.chakuju, payout: r.payout, resulted: r.resulted, shimekiri: r.shimekiri, archivedAt: r.archivedAt }));
const crypto = require('crypto');
function hashObj(o) { return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex'); }
const snapshotHash = hashObj(snapshotRecords);
fs.writeFileSync(path.join(ROOT, 'logs', 'research_pure_prediction_true_t10_snapshot_2026-09-04.json'), JSON.stringify({ generatedAt: new Date().toISOString(), contentHash: snapshotHash, count: snapshotRecords.length, races: snapshotRecords }));
console.log('凍結スナップショット保存(logs/research_pure_prediction_true_t10_snapshot_2026-09-04.json)、内容ハッシュ=', snapshotHash);

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }

// モデル順位(w=wCoefで)上位K点を求め、各点のオッズ帯・的中・払戻を集計
function layer2Diagnose(races, wCoef, label) {
  const bandDist = { under50: 0, band50to150: 0, over150: 0 };
  const perN = {};
  for (const n of TOPNS) perN[n] = { hits: 0, total: 0, bandCounts: { under50: 0, band50to150: 0, over150: 0 } };
  let skip = 0;
  const bandInTopKCounts = {}; // K=20固定探索: レースごとの帯内点数の分布
  let participateRaces = 0, participatePoints = 0, participateHits = 0, participateStakeYen = 0, participatePayoutYen = 0;
  const K = 20;
  for (const r of races) {
    let idx;
    try { idx = distIdx(r.boats); } catch (e) { skip++; continue; }
    const kin = boatKinMap(r.boats);
    const idxW = wCoef === 0 ? idx : reweightFull(idx, kin, wCoef);
    const ranked = idxToRanked(idxW);
    const oddsOf = (val) => Number(r.oddsMap[val]);
    for (const n of TOPNS) {
      const topN = ranked.slice(0, n);
      const hit = topN.some(p => p.val === r.chakuju);
      perN[n].total++; if (hit) perN[n].hits++;
      for (const p of topN) {
        const o = oddsOf(p.val);
        const b = o < 50 ? 'under50' : (o <= 150 ? 'band50to150' : 'over150');
        perN[n].bandCounts[b]++;
      }
    }
    // K=20固定探索、帯内点のみ採用(市場人気点での穴埋めなし、モデル順位はそのまま維持)
    const top20 = ranked.slice(0, K);
    const bandPoints = top20.filter(p => { const o = oddsOf(p.val); return o >= 50 && o <= 150; });
    bandInTopKCounts[bandPoints.length] = (bandInTopKCounts[bandPoints.length] || 0) + 1;
    if (bandPoints.length >= 1) {
      participateRaces++;
      participatePoints += bandPoints.length;
      participateStakeYen += bandPoints.length * 100;
      const hitPoint = bandPoints.find(p => p.val === r.chakuju);
      if (hitPoint) { participateHits++; participatePayoutYen += Math.round(100 / 100 * parsePayout100(r.payout)); }
    }
  }
  console.log(`\n[${label}] 対象n=${races.length} skip=${skip}`);
  for (const n of TOPNS) {
    const d = perN[n];
    console.log(`  top${n}: 的中率=${(d.hits/d.total*100).toFixed(2)}%(${d.hits}/${d.total})  帯分布(全候補点、n=${d.bandCounts.under50+d.bandCounts.band50to150+d.bandCounts.over150}点): <50倍=${d.bandCounts.under50} 50-150倍=${d.bandCounts.band50to150} >150倍=${d.bandCounts.over150}`);
  }
  console.log(`  K=${K}固定探索・帯内点数分布(レース単位): ${Object.keys(bandInTopKCounts).sort((a,b)=>a-b).map(k=>k+'点:'+bandInTopKCounts[k]+'件').join(' ')}`);
  console.log(`  実運用候補診断(top${K}のうち50-150倍のみ採用、最低点数条件なし、市場人気での穴埋めなし):`);
  console.log(`    参加レース数=${participateRaces}/${races.length}(${(participateRaces/races.length*100).toFixed(1)}%)  総採用点数=${participatePoints}  平均点数/参加レース=${(participatePoints/Math.max(1,participateRaces)).toFixed(2)}`);
  console.log(`    的中数=${participateHits}  的中率(参加レース内)=${(participateHits/Math.max(1,participateRaces)*100).toFixed(2)}%  投資額=${participateStakeYen}円  払戻額=${participatePayoutYen}円  ROI=${(participatePayoutYen/Math.max(1,participateStakeYen)*100).toFixed(1)}%`);
  return { perN, bandInTopKCounts, participateRaces, participatePoints, participateHits, participateStakeYen, participatePayoutYen };
}
console.log('--- 基準(baseline)モデルでの第2層診断 ---');
const l2Base = layer2Diagnose(trueT10Races, 0, 'baseline(w=0)');
console.log('\n--- 仮説(H1)モデルでの第2層診断(参考、採否に関わらず記録) ---');
const l2Hyp = layer2Diagnose(trueT10Races, w, `H1(w=${w.toFixed(5)})`);

console.log('\n========== 7. 基準(A)/現行α混合後(C)/Q の3方式比較(真T10母集団) ==========');
const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));

function cFullRanked(r, pmMap) {
  const entries = validOddsEntries(r.oddsMap);
  const massed = entries.map(e => ({ val: e.val, odds: e.odds, mass: Math.sqrt(Math.max(pmMap.get(e.val) || Number.MIN_VALUE, Number.MIN_VALUE) / e.odds) }));
  const den = massed.reduce((s, e) => s + e.mass, 0);
  return massed.map(e => ({ val: e.val, p: e.mass / den })).sort((a, b) => b.p - a.p || a.val.localeCompare(b.val));
}

let aFirst = 0, cFirst = 0, qFirst = 0, aTop8 = 0, cTop8 = 0, nCmp = 0, distFail = 0, qFail = 0;
for (const r of trueT10Races) {
  let idx;
  try { idx = distIdx(r.boats); } catch (e) { distFail++; continue; }
  const ranked = idxToRanked(idx);
  const pmMap = new Map(ranked.map(e => [e.val, e.p]));
  const cRanked = cFullRanked(r, pmMap);
  const [ci, cj, ck] = r.chakuju.split('-').map(Number);
  const aTop1 = Number(ranked[0].val.split('-')[0]);
  const cTop1 = Number(cRanked[0].val.split('-')[0]);
  let qTop1 = null;
  try {
    const bets = qEngine.generateQBets(r.boats, r.oddsMap);
    qTop1 = bets.axes && bets.axes[0] ? bets.axes[0].boat : null;
  } catch (e) { qFail++; }
  if (qTop1 == null) continue;
  nCmp++;
  if (aTop1 === ci) aFirst++;
  if (cTop1 === ci) cFirst++;
  if (qTop1 === ci) qFirst++;
  if (ranked.slice(0, 8).some(p => p.val === r.chakuju)) aTop8++;
  if (cRanked.slice(0, 8).some(p => p.val === r.chakuju)) cTop8++;
}
console.log('比較対象 n =', nCmp, ' (distribution失敗=', distFail, ' Q失敗=', qFail, ')');
console.log('1着的中率: A(純粋モデル)=' + (aFirst/nCmp*100).toFixed(2) + '%  C(現行α混合後)=' + (cFirst/nCmp*100).toFixed(2) + '%  Q(軸)=' + (qFirst/nCmp*100).toFixed(2) + '%');
console.log('上位8点的中率: A=' + (aTop8/nCmp*100).toFixed(2) + '%  C=' + (cTop8/nCmp*100).toFixed(2) + '%  (Qは点数が可変のため上位8点の定義が異なり単純比較不可、参考: Qの軸的中率のみ併記)');

console.log('\n========== 8. 結果保存 ==========');
const output = {
  generatedAt: new Date().toISOString(),
  caseId: 'GARON-20260904-002',
  counts: {
    totalArchiveRaces: all.length,
    layer1Population: layer1Pop.length,
    isUsable: isUsablePop.length,
    hasFullData: isUsablePop.filter(hasFullData).length,
    cls1_trainInner: cls1_trainInner.length,
    cls2_trainOuter: cls2_trainOuter.length,
    cls3_trueT10: cls3_trueT10.length,
    cls4_unknownOdds: cls4_unknownOdds.length,
    cls5_noOdds: cls5_noOdds.length,
  },
  trainRecordsN: trainRecords.length,
  kinsetsu6mStandardization: { meanTrain, stdTrain },
  fittedW: w,
  evalA: { n: resA.baseSum.n, baseSum: resA.baseSum, hypSum: resA.hypSum },
  evalB: { n: resB.baseSum.n, baseSum: resB.baseSum, hypSum: resB.hypSum },
  evalAll: { baseSum: baseAllSum, hypSum: hypAllSum },
  trainInnerRef: { baseSum: summarize(trainBaseRecs, 'ref'), hypSum: summarize(trainHypRecs, 'ref') },
  decision: { top8DiffA, top8DiffB, top8DiffAll, directionConsistent, n30ok, verdict },
  trueT10: { n: trueT10Races.length, dateRange: [trueT10Dates[0], trueT10Dates[trueT10Dates.length - 1]], snapshotHash },
  layer2: { baseline: l2Base, hypothesis: l2Hyp },
  item8Comparison: { n: nCmp, aFirst, cFirst, qFirst, aTop8, cTop8 },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_pure_prediction_two_layer_2026-09-04.json'), JSON.stringify(output, null, 1));
console.log('結果をlogs/research_pure_prediction_two_layer_2026-09-04.jsonへ保存しました。');
console.log('\n=== 完了 ===');
