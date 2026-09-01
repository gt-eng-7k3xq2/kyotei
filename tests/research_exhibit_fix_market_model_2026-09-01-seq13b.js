'use strict';
// GARON-20260901-002継続(CEO承認: 展示欠損0秒問題の研究用最小修正を、直近の市場+ST/展示/機力
// モデル〈seq09の1着+2・3着補正、最後の構成〉で再検証)。学習・評価期間、特徴量、モデル形式、
// 設定は全てseq09と同一、qEngineの読み込みだけをloadFixedQEngine()に差し替える。
// 本番garon_q_engine.htmlは一切変更しない。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadFixedQEngine } = require('./lib/fixed-q-engine.js');
const { isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');

const ROOT = path.join(__dirname, '..');
const L2 = 0.01, LR = 0.05, EPOCHS = 300;

function inRange(d, lo, hi) { return d >= lo && d <= hi; }

function marketTrifecta(oddsMap) {
  const keys = Object.keys(oddsMap || {});
  if (keys.length < 120) return null;
  let totalInv = 0; const q = {};
  for (const k of keys) { const o = parseFloat(oddsMap[k]); if (!(o > 0)) return null; q[k] = 1 / o; totalInv += q[k]; }
  Object.keys(q).forEach(k => { q[k] = q[k] / totalInv; });
  return q;
}
function marginal1(q) { const m = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }; Object.keys(q).forEach(k => { m[k.split('-')[0]] += q[k]; }); return m; }
function cond2(q, m1, head) { const out = {}; Object.keys(q).forEach(k => { const parts = k.split('-'); if (parts[0] === String(head)) out[parts[1]] = (out[parts[1]] || 0) + q[k]; }); Object.keys(out).forEach(j => { out[j] = out[j] / m1[head]; }); return out; }
function cond3(q, head, second) { const rows = Object.keys(q).filter(k => k.startsWith(`${head}-${second}-`)); const total = rows.reduce((s, k) => s + q[k], 0); const out = {}; rows.forEach(k => { out[k.split('-')[2]] = q[k] / total; }); return out; }
function buildFeatMap(boats, ranks) { const norm = r => (r == null ? null : (7 - r) / 6); const f = {}; boats.forEach((b, i) => { f[String(b.no)] = [norm(ranks.st[i]), norm(ranks.exhibit[i]), norm(ranks.motor[i])]; }); return f; }
function softmax(scores) { const max = Math.max(...scores); const exps = scores.map(s => Math.exp(s - max)); const total = exps.reduce((a, b) => a + b, 0); return exps.map(e => e / total); }
function scoreOf1(marketVec, features, w) { return marketVec.map((m, i) => Math.log(Math.max(m, 1e-9)) + features[i].reduce((s, v, k) => s + v * w[k], 0)); }

function trainW1(dataset) {
  let w = [0, 0, 0];
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = [0, 0, 0];
    for (const { race, marketVec, featMap, winnerIdx } of dataset) {
      const features = race.boats.map(b => featMap[String(b.no)]);
      const probs = softmax(scoreOf1(marketVec, features, w));
      for (let i = 0; i < features.length; i++) { const y = i === winnerIdx ? 1 : 0; const coef = probs[i] - y; for (let k = 0; k < 3; k++) grad[k] += coef * features[i][k]; }
    }
    for (let k = 0; k < 3; k++) { grad[k] = grad[k] / dataset.length + L2 * w[k]; w[k] -= LR * grad[k]; }
  }
  return w;
}
function trainW2(trainData) {
  let w = [0, 0, 0];
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = [0, 0, 0];
    for (const { candidates2, feat, q2cond, actualJ } of trainData) {
      const scores = candidates2.map(j => Math.log(Math.max(q2cond[j], 1e-9)) + feat[j].reduce((s, v, k) => s + v * w[k], 0));
      const probs = softmax(scores);
      candidates2.forEach((j, idx) => { const y = j === actualJ ? 1 : 0; const coef = probs[idx] - y; for (let k = 0; k < 3; k++) grad[k] += coef * feat[j][k]; });
    }
    for (let k = 0; k < 3; k++) { grad[k] = grad[k] / trainData.length + L2 * w[k]; w[k] -= LR * grad[k]; }
  }
  return w;
}
function trainW3(trainData) {
  let w = [0, 0, 0];
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = [0, 0, 0];
    for (const { candidates3, feat, q3cond, actualK } of trainData) {
      const scores = candidates3.map(k2 => Math.log(Math.max(q3cond[k2], 1e-9)) + feat[k2].reduce((s, v, kk) => s + v * w[kk], 0));
      const probs = softmax(scores);
      candidates3.forEach((k2, idx) => { const y = k2 === actualK ? 1 : 0; const coef = probs[idx] - y; for (let kk = 0; kk < 3; kk++) grad[kk] += coef * feat[k2][kk]; });
    }
    for (let k = 0; k < 3; k++) { grad[k] = grad[k] / trainData.length + L2 * w[k]; w[k] -= LR * grad[k]; }
  }
  return w;
}
function predictDist(r, q, m1, p1map, w2, w3, featMap) {
  const boatsNo = r.boats.map(b => String(b.no));
  const dist = [];
  for (const i of boatsNo) {
    const q2c = cond2(q, m1, i);
    const cand2 = boatsNo.filter(x => x !== i);
    const scores2 = cand2.map(j => Math.log(Math.max(q2c[j], 1e-9)) + featMap[j].reduce((s, v, k) => s + v * w2[k], 0));
    const p2arr = softmax(scores2);
    const p2 = {}; cand2.forEach((j, idx) => { p2[j] = p2arr[idx]; });
    for (const j of cand2) {
      const q3c = cond3(q, i, j);
      const cand3 = boatsNo.filter(x => x !== i && x !== j);
      const scores3 = cand3.map(k => Math.log(Math.max(q3c[k], 1e-9)) + featMap[k].reduce((s, v, kk) => s + v * w3[kk], 0));
      const p3arr = softmax(scores3);
      cand3.forEach((k, idx) => { dist.push({ val: `${i}-${j}-${k}`, p: p1map[i] * p2[j] * p3arr[idx] }); });
    }
  }
  return dist;
}

function buildModel(qEngine, races) {
  function prep(list) {
    const out = [];
    for (const r of list) {
      const q = marketTrifecta(r.oddsMap); if (!q) continue;
      const m1 = marginal1(q);
      let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
      const featMap = buildFeatMap(r.boats, ranks);
      if (Object.values(featMap).some(f => f.some(v => v == null))) continue;
      const marketVec = r.boats.map(b => m1[String(b.no)]);
      const winnerBoat = r.chakuju.split('-')[0];
      const winnerIdx = r.boats.findIndex(b => String(b.no) === winnerBoat);
      if (winnerIdx < 0) continue;
      out.push({ race: r, q, m1, featMap, marketVec, winnerIdx });
    }
    return out;
  }
  return prep;
}

function main() {
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  usable.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));
  const trainRaces = usable.filter(r => inRange(r.date, '2026-07-01', '2026-07-31'));
  const eval1Races = usable.filter(r => inRange(r.date, '2026-08-01', '2026-08-15'));
  const eval2Races = usable.filter(r => inRange(r.date, '2026-08-16', '2026-08-30'));

  function runFor(qEngine, label) {
    const prep = buildModel(qEngine, usable);
    const trainSet = prep(trainRaces), eval1Set = prep(eval1Races), eval2Set = prep(eval2Races);
    const w1 = trainW1(trainSet);
    const train2 = [], train3 = [];
    for (const { race: r, q, m1, featMap } of trainSet) {
      const boatsNo = r.boats.map(b => String(b.no));
      const chakuju = r.chakuju.split('-'); const [iStar, jStar, kStar] = chakuju;
      if (!boatsNo.includes(iStar) || !boatsNo.includes(jStar) || !boatsNo.includes(kStar)) continue;
      const q2c = cond2(q, m1, iStar); const cand2 = boatsNo.filter(x => x !== iStar);
      train2.push({ candidates2: cand2, feat: featMap, q2cond: q2c, actualJ: jStar });
      const q3c = cond3(q, iStar, jStar); const cand3 = boatsNo.filter(x => x !== iStar && x !== jStar);
      train3.push({ candidates3: cand3, feat: featMap, q3cond: q3c, actualK: kStar });
    }
    const w2 = trainW2(train2), w3 = trainW3(train3);
    console.log(`[${label}] 学習n=${trainSet.length} 評価1n=${eval1Set.length} 評価2n=${eval2Set.length} w1=${w1.map(v => v.toFixed(3))} w2=${w2.map(v => v.toFixed(3))} w3=${w3.map(v => v.toFixed(3))}`);
    return { qEngine, trainSet, eval1Set, eval2Set, w1, w2, w3 };
  }

  const orig = runFor(loadQEngine(path.join(ROOT, 'garon_q_engine.html')), '原本(バグあり)');
  const fixed = runFor(loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html')), '修正後');

  // 共通対象の特定(除外理由: 展示3特徴量完備フィルタの結果が原本/修正後で異なる場合がある)
  function keyOf(set) { return new Set(set.map(d => `${d.race.date}_${d.race.venue}_${d.race.racenum}`)); }
  function commonEval(origSet, fixedSet, label) {
    const origKeys = keyOf(origSet), fixedKeys = keyOf(fixedSet);
    const common = [...origKeys].filter(k => fixedKeys.has(k));
    const onlyOrig = origKeys.size - common.length, onlyFixed = fixedKeys.size - common.length;
    console.log(`[${label}] 原本n=${origSet.length} 修正後n=${fixedSet.length} 共通n=${common.length}(原本のみ${onlyOrig}件・修正後のみ${onlyFixed}件は比較対象から除外)`);
    const commonSet = new Set(common);
    return {
      orig: origSet.filter(d => commonSet.has(`${d.race.date}_${d.race.venue}_${d.race.racenum}`)),
      fixed: fixedSet.filter(d => commonSet.has(`${d.race.date}_${d.race.venue}_${d.race.racenum}`)),
    };
  }
  console.log('\n========== 共通対象の特定(展示欠損フィルタの結果差を除外) ==========');
  const ce1 = commonEval(orig.eval1Set, fixed.eval1Set, '評価期間1(8/1-15)');
  const ce2 = commonEval(orig.eval2Set, fixed.eval2Set, '評価期間2(8/16-30)');

  function evaluate(dataset, w1, w2, w3, label) {
    let llMarket = 0, llOrig = 0, n = 0;
    const byDate = {};
    for (const { race: r, q, m1, featMap, marketVec, winnerIdx } of dataset) {
      const p1arr = softmax(scoreOf1(marketVec, r.boats.map(b => featMap[String(b.no)]), w1));
      const p1m = {}; r.boats.forEach((b, i) => { p1m[String(b.no)] = p1arr[i]; });
      const dist = predictDist(r, q, m1, p1m, w2, w3, featMap);
      const chakuju = r.chakuju;
      const qActual = q[chakuju]; const dActual = dist.find(c => c.val === chakuju);
      if (!dActual) continue;
      n++;
      llMarket += -Math.log(Math.max(qActual, 1e-12)); llOrig += -Math.log(Math.max(dActual.p, 1e-12));
      const d = r.date; (byDate[d] = byDate[d] || { llMarket: 0, llModel: 0, n: 0 }); byDate[d].llMarket += -Math.log(Math.max(qActual, 1e-12)); byDate[d].llModel += -Math.log(Math.max(dActual.p, 1e-12)); byDate[d].n++;
    }
    console.log(`  [${label}] n=${n} 三連単ログ損失: 市場=${(llMarket / n).toFixed(4)} モデル=${(llOrig / n).toFixed(4)}`);
    return { n, llMarket: llMarket / n, llModel: llOrig / n, byDate };
  }

  console.log('\n========== 比較: 市場のみ / 原本モデル(バグあり) / 修正後モデル(共通対象) ==========');
  console.log('評価期間1:');
  const o1 = evaluate(ce1.orig, orig.w1, orig.w2, orig.w3, '原本モデル');
  const f1 = evaluate(ce1.fixed, fixed.w1, fixed.w2, fixed.w3, '修正後モデル');
  console.log('評価期間2:');
  const o2 = evaluate(ce2.orig, orig.w1, orig.w2, orig.w3, '原本モデル');
  const f2 = evaluate(ce2.fixed, fixed.w1, fixed.w2, fixed.w3, '修正後モデル');

  console.log('\n========== まとめ ==========');
  console.log(`評価期間1: 市場${o1.llMarket.toFixed(4)} 原本${o1.llModel.toFixed(4)}(差${(o1.llModel - o1.llMarket).toFixed(4)}) 修正後${f1.llModel.toFixed(4)}(差${(f1.llModel - f1.llMarket).toFixed(4)})`);
  console.log(`評価期間2: 市場${o2.llMarket.toFixed(4)} 原本${o2.llModel.toFixed(4)}(差${(o2.llModel - o2.llMarket).toFixed(4)}) 修正後${f2.llModel.toFixed(4)}(差${(f2.llModel - f2.llMarket).toFixed(4)})`);

  function blockBootstrap(byDateA, byDateB, iters) {
    const dates = Object.keys(byDateA);
    let pos = 0; const diffs = [];
    for (let it = 0; it < iters; it++) {
      const sample = Array.from({ length: dates.length }, () => dates[Math.floor(Math.random() * dates.length)]);
      let sumA = 0, sumB = 0, cnt = 0;
      for (const d of sample) { if (!byDateA[d] || !byDateB[d]) continue; sumA += byDateA[d].llModel; sumB += byDateB[d].llModel; cnt += byDateA[d].n; }
      if (!cnt) continue;
      const diff = (sumB / cnt) - (sumA / cnt);
      diffs.push(diff); if (diff < 0) pos++;
    }
    diffs.sort((a, b) => a - b);
    return { ci95: [diffs[Math.floor(diffs.length * 0.025)], diffs[Math.floor(diffs.length * 0.975)]], improveRate: pos / diffs.length };
  }
  const combinedOrig = { ...o1.byDate, ...o2.byDate };
  const combinedFixed = { ...f1.byDate, ...f2.byDate };
  const bb = blockBootstrap(combinedOrig, combinedFixed, 2000);
  console.log(`\n原本モデル→修正後モデルのログ損失差、日単位ブロックブートストラップ95%CI=[${bb.ci95[0].toFixed(4)}, ${bb.ci95[1].toFixed(4)}] 修正後が改善方向だった割合=${(bb.improveRate * 100).toFixed(1)}%`);

  console.log('\n========== 推定払戻倍率の変化(共通対象) ==========');
  function payoutStats(dataset, w1, w2, w3, label) {
    let maxEst = -Infinity; let over1 = 0; const estAll = [];
    for (const { race: r, q, m1, featMap, marketVec } of dataset) {
      const p1arr = softmax(scoreOf1(marketVec, r.boats.map(b => featMap[String(b.no)]), w1));
      const p1m = {}; r.boats.forEach((b, i) => { p1m[String(b.no)] = p1arr[i]; });
      const dist = predictDist(r, q, m1, p1m, w2, w3, featMap);
      for (const c of dist) {
        const odds = parseFloat(r.oddsMap[c.val]) || 0; if (!(odds > 0)) continue;
        const est = c.p * odds;
        if (estAll.length < 20000) estAll.push(est);
        if (est > maxEst) maxEst = est;
        if (est > 1) over1++;
      }
    }
    estAll.sort((a, b) => a - b);
    console.log(`  [${label}] median=${estAll[Math.floor(estAll.length / 2)].toFixed(3)} 最大=${maxEst.toFixed(3)} 1超候補点数=${over1}`);
  }
  console.log('評価期間1:');
  payoutStats(ce1.orig, orig.w1, orig.w2, orig.w3, '原本モデル');
  payoutStats(ce1.fixed, fixed.w1, fixed.w2, fixed.w3, '修正後モデル');
  console.log('評価期間2:');
  payoutStats(ce2.orig, orig.w1, orig.w2, orig.w3, '原本モデル');
  payoutStats(ce2.fixed, fixed.w1, fixed.w2, fixed.w3, '修正後モデル');

  return { orig, fixed, o1, f1, o2, f2 };
}

if (require.main === module) main();
module.exports = { main };
