'use strict';
// GARON-20260901-002継続(CEO指示: 1着補正だけで配当上の利点が生まれるか確認。
// 新しい特徴量・重み・閾値の探索は禁止、モデルはv5から完全固定)。
//
// 【2. 三連単分布への変換(新しい着順モデルは作らない)】
// p(i,j,k) = q(i,j,k) × p1(i)/q1(i)
//   q(i,j,k): 市場の三連単分布(120通り、逆オッズ正規化)
//   q1(i)   : qの1着周辺分布(=market_1st、既存関数を再利用)
//   p1(i)   : v5の補正済み1着分布(市場オフセット+ST/展示/機力、重み固定)
// 市場の「1着がiだった場合の2・3着分布」(q(i,j,k)/q1(i))は変更しない。
// 数式上の性質(検算対象、実装後にサンプルレースで確認):
//   - 合計1、非負、1着周辺分布がp1(i)と一致
//   - 補正ゼロ(p1=q1)なら p(i,j,k)=q(i,j,k) に一致
//   - 三連単ログ損失の改善は1着ログ損失の改善と数式上完全に同一(2重計上しない)
//
// 【3. 推定払戻倍率】est(i,j,k)=p(i,j,k)×odds(i,j,k)
//   = q(i,j,k)×odds(i,j,k)×p1(i)/q1(i) = [1/Σ(1/odds_all)]×[p1(i)/q1(i)]
//   同じ1着艇iを持つ買い目では常に同値になる(軸ごとに最大6種類の値、120通り全部が同値には
//   ならない)。数式と実装の両方で検算する。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');

const ROOT = path.join(__dirname, '..');
const L2 = 0.01, LR = 0.05, EPOCHS = 300;

function inRange(d, lo, hi) { return d >= lo && d <= hi; }
function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }

function marketFirstProbs(oddsMap) {
  const keys = Object.keys(oddsMap || {});
  if (keys.length < 120) return null;
  let totalInv = 0; const invByCombo = {};
  for (const k of keys) { const o = parseFloat(oddsMap[k]); if (!(o > 0)) return null; invByCombo[k] = 1 / o; totalInv += invByCombo[k]; }
  const firstP = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const k of keys) { const head = k.split('-')[0]; firstP[head] += invByCombo[k] / totalInv; }
  return { firstP, invByCombo, totalInv };
}

function buildFeatures3(boats, ranks) {
  const norm = r => (r == null ? null : (7 - r) / 6);
  return boats.map((b, i) => [norm(ranks.st[i]), norm(ranks.exhibit[i]), norm(ranks.motor[i])]);
}

function prepareDataset(qEngine, races) {
  const dataset = [];
  for (const r of races) {
    const mk = marketFirstProbs(r.oddsMap);
    if (!mk) continue;
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
    const feat = buildFeatures3(r.boats, ranks);
    if (feat.some(f => f.some(v => v == null))) continue;
    const winnerBoat = r.chakuju.split('-')[0];
    const winnerIdx = r.boats.findIndex(b => String(b.no) === winnerBoat);
    if (winnerIdx < 0) continue;
    const marketVec = r.boats.map(b => mk.firstP[String(b.no)]);
    dataset.push({ race: r, features: feat, marketVec, winnerIdx, mk });
  }
  return dataset;
}

function softmax(scores) { const max = Math.max(...scores); const exps = scores.map(s => Math.exp(s - max)); const total = exps.reduce((a, b) => a + b, 0); return exps.map(e => e / total); }
function scoreOf(marketVec, features, w) { return marketVec.map((m, i) => Math.log(Math.max(m, 1e-9)) + features[i].reduce((s, v, k) => s + v * w[k], 0)); }

function trainWeights(dataset, nFeatures) {
  let w = new Array(nFeatures).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = new Array(nFeatures).fill(0);
    for (const { marketVec, features, winnerIdx } of dataset) {
      const probs = softmax(scoreOf(marketVec, features, w));
      for (let i = 0; i < features.length; i++) {
        const y = (i === winnerIdx) ? 1 : 0; const coef = probs[i] - y;
        for (let k = 0; k < nFeatures; k++) grad[k] += coef * features[i][k];
      }
    }
    for (let k = 0; k < nFeatures; k++) { grad[k] = grad[k] / dataset.length + L2 * w[k]; w[k] -= LR * grad[k]; }
  }
  return w;
}

// 三連単combo分布(120通り)を構築: p(i,j,k) = q(i,j,k) * p1(i)/q1(i)
function buildTrifectaDist(r, mk, p1) {
  const ratio = {}; [1, 2, 3, 4, 5, 6].forEach(no => { ratio[no] = p1[no] / Math.max(mk.firstP[no], 1e-12); });
  const out = [];
  for (const k of Object.keys(r.oddsMap)) {
    const head = parseInt(k.split('-')[0], 10);
    const qijk = mk.invByCombo[k] / mk.totalInv;
    out.push({ val: k, p: qijk * ratio[head], odds: parseFloat(r.oddsMap[k]) });
  }
  return out;
}

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  usable.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));
  const trainRaces = usable.filter(r => inRange(r.date, '2026-07-01', '2026-07-31'));
  const eval1Races = usable.filter(r => inRange(r.date, '2026-08-01', '2026-08-15'));
  const eval2Races = usable.filter(r => inRange(r.date, '2026-08-16', '2026-08-30'));

  console.log('========== モデル再構成(v5と同一、学習範囲7/1-31、設定選択範囲なし=既定値据え置き) ==========');
  const trainSet = prepareDataset(qEngine, trainRaces);
  const eval1Set = prepareDataset(qEngine, eval1Races);
  const eval2Set = prepareDataset(qEngine, eval2Races);
  console.log(`学習n=${trainSet.length} / 評価期間1(8/1-15)n=${eval1Set.length} / 評価期間2(8/16-30)n=${eval2Set.length}`);
  const w = trainWeights(trainSet, 3);
  console.log('重み(v5と同一のはず): ST=', w[0].toFixed(3), '展示=', w[1].toFixed(3), '機力=', w[2].toFixed(3));

  // ---- 2. 三連単分布の数式検算(サンプル1レース) ----
  console.log('\n========== 2. 三連単分布変換の検算(サンプル1レース) ==========');
  const sample = eval1Set[5];
  const scores = scoreOf(sample.marketVec, sample.features, w);
  const p1arr = softmax(scores);
  const p1 = {}; sample.race.boats.forEach((b, i) => { p1[b.no] = p1arr[i]; });
  const dist = buildTrifectaDist(sample.race, sample.mk, p1);
  const sumP = dist.reduce((s, c) => s + c.p, 0);
  const allNonNeg = dist.every(c => c.p >= 0);
  const marginal = {}; [1, 2, 3, 4, 5, 6].forEach(no => marginal[no] = 0);
  dist.forEach(c => { const head = parseInt(c.val.split('-')[0], 10); marginal[head] += c.p; });
  console.log('レース:', sample.race.date, sample.race.venue, sample.race.racenum);
  console.log('三連単分布 合計:', sumP.toFixed(6), '(1.0のはず) 全て非負:', allNonNeg);
  console.log('1着周辺分布 vs p1: ', [1, 2, 3, 4, 5, 6].map(no => `${no}:周辺${marginal[no].toFixed(4)}/p1${p1[no].toFixed(4)}`).join(' '));

  // 補正ゼロ(p1=q1)での恒等性確認
  const distZero = buildTrifectaDist(sample.race, sample.mk, sample.mk.firstP);
  const maxDiffZero = Math.max(...distZero.map(c => { const q = sample.mk.invByCombo[c.val] / sample.mk.totalInv; return Math.abs(c.p - q); }));
  console.log('補正ゼロ時、p(i,j,k)とq(i,j,k)の最大差:', maxDiffZero.toExponential(2), '(0のはず)');

  // 三連単ログ損失=1着ログ損失、の数式的同一性確認
  const actualCombo = dist.find(c => c.val === sample.race.chakuju);
  const q_actual = sample.mk.invByCombo[sample.race.chakuju] / sample.mk.totalInv;
  const trifectaLogLossDiff = -Math.log(Math.max(actualCombo.p, 1e-12)) - (-Math.log(Math.max(q_actual, 1e-12)));
  const actualHead = sample.race.chakuju.split('-')[0];
  const firstLogLossDiff = -Math.log(Math.max(p1[actualHead], 1e-12)) - (-Math.log(Math.max(sample.mk.firstP[actualHead], 1e-12)));
  console.log('三連単ログ損失差(補正-市場):', trifectaLogLossDiff.toFixed(6), ' / 1着ログ損失差:', firstLogLossDiff.toFixed(6), '(一致するはず、二重計上しない)');

  // ---- 3. 推定払戻倍率の数式・実装検算 ----
  console.log('\n========== 3. 推定払戻倍率の検算 ==========');
  const estByCombo = dist.map(c => ({ val: c.val, head: c.val.split('-')[0], est: c.p * c.odds }));
  const estByHead = {};
  estByCombo.forEach(c => { (estByHead[c.head] = estByHead[c.head] || []).push(c.est); });
  console.log('同一1着艇内でのest最大-最小差(0のはず):');
  for (const [head, ests] of Object.entries(estByHead)) {
    console.log(`  軸${head}: n=${ests.length} est=${ests[0].toFixed(6)} 最大-最小差=${(Math.max(...ests) - Math.min(...ests)).toExponential(2)}`);
  }
  console.log('軸間のest値(6種類、互いに異なるはず):', Object.entries(estByHead).map(([h, e]) => `軸${h}:${e[0].toFixed(3)}`).join(' '));

  // ---- 評価期間ごとの推定払戻倍率の分布・1超候補の集計 ----
  function analyzeEvalPeriod(dataset, label) {
    console.log(`\n========== ${label}: 推定払戻倍率の分布 ==========`);
    let maxEstAll = -Infinity;
    let over1RaceCount = 0;
    const over1Dates = new Set();
    const over1Heads = {};
    const over1Odds = [];
    const allEstSample = [];
    for (const { race: r, features, marketVec, mk } of dataset) {
      const scores2 = scoreOf(marketVec, features, w);
      const p1arr2 = softmax(scores2);
      const p1_2 = {}; r.boats.forEach((b, i) => { p1_2[b.no] = p1arr2[i]; });
      const dist2 = buildTrifectaDist(r, mk, p1_2);
      let raceHasOver1 = false;
      for (const c of dist2) {
        const est = c.p * c.odds;
        if (allEstSample.length < 50000) allEstSample.push(est);
        if (est > maxEstAll) maxEstAll = est;
        if (est > 1) {
          raceHasOver1 = true;
          const head = c.val.split('-')[0];
          over1Heads[head] = (over1Heads[head] || 0) + 1;
          over1Odds.push(c.odds);
        }
      }
      if (raceHasOver1) { over1RaceCount++; over1Dates.add(r.date); }
    }
    allEstSample.sort((a, b) => a - b);
    const q = p => allEstSample[Math.floor(allEstSample.length * p)];
    console.log(`推定払戻倍率: median=${q(0.5).toFixed(3)} Q1=${q(0.25).toFixed(3)} Q3=${q(0.75).toFixed(3)} 最大値=${maxEstAll.toFixed(3)}`);
    console.log(`1を超える候補があるレース数: ${over1RaceCount}/${dataset.length} 日数: ${over1Dates.size}`);
    console.log(`1超候補の1着艇分布: ${JSON.stringify(over1Heads)}`);
    if (over1Odds.length) {
      over1Odds.sort((a, b) => a - b);
      console.log(`1超候補の購入時オッズ: n=${over1Odds.length} median=${over1Odds[Math.floor(over1Odds.length / 2)]} min=${over1Odds[0]} max=${over1Odds[over1Odds.length - 1]}`);
    }
    return { maxEstAll, over1RaceCount, over1Dates, over1Odds, dataset };
  }
  const r1 = analyzeEvalPeriod(eval1Set, '評価期間1(8/1-15)');
  const r2 = analyzeEvalPeriod(eval2Set, '評価期間2(8/16-30)');

  return { w, r1, r2 };
}

if (require.main === module) main();
module.exports = { main };
