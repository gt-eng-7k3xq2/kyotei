'use strict';
// GARON-20260901-002継続(CEO指示: 未検証だった2・3着の市場条件付き分布に、ST・展示・機力が
// 追加予測力を持つかを1方式だけ検証)。1着補正モデル(v5/v6)は完全固定、新しい特徴量・
// 会場別例外は追加しない。
//
// 【市場分布の分解】q(i,j,k) = q1(i) × q2(j|i) × q3(k|i,j)
//   q1(i)   = 市場の1着周辺分布(既存、固定)
//   q2(j|i) = 1着iが決まった条件での市場2着分布(残り5艇で正規化)
//   q3(k|i,j) = 1・2着i,jが決まった条件での市場3着分布(残り4艇で正規化)
// 【補正】p(i,j,k) = p1(i) × p2(j|i) × p3(k|i,j)
//   p1(i)   = 前回固定の1着補正モデル(v5、重み不変)
//   p2(j|i) = log(q2(j|i)) を基準項とし、候補艇jのST/展示/機力(最大3特徴量)で補正した多項ロジット
//   p3(k|i,j) = log(q3(k|i,j)) を基準項とし、候補艇kのST/展示/機力で補正した多項ロジット
// 2着・3着は係数を分けるが、この1構成のみを検証し、他のモデル探索は行わない。
//
// 【学習時と予想時の区別】学習は各レースの実際の1着i*・2着j*を条件として、条件付き尤度
// (残り5艇中で実際の2着がどれだけ選ばれやすいか等)を最大化する(これは条件付きモデルの
// 標準的な学習方法であり、結果情報の混入ではない)。予想時(=評価用の120通り計算)は、
// 実際の着順を一切使わず、6艇×5艇×4艇の全ての仮定上の組み合わせについてp2・p3を計算する。
// 入力に結果が混ざらないことは、predictFullDistribution()がr.chakujuを一切参照しない設計で
// 保証し、下記の検算でも確認する。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
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
  return q; // q(i,j,k)、合計1
}

function marginal1(q) {
  const m = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  Object.keys(q).forEach(k => { m[k.split('-')[0]] += q[k]; });
  return m;
}
function cond2(q, m1, head) {
  // q2(j|head) = Σ_k q(head,j,k) / m1[head]
  const out = {};
  Object.keys(q).forEach(k => { const parts = k.split('-'); if (parts[0] === String(head)) out[parts[1]] = (out[parts[1]] || 0) + q[k]; });
  Object.keys(out).forEach(j => { out[j] = out[j] / m1[head]; });
  return out; // 5艇分、合計1
}
function cond3(q, head, second) {
  // q3(k|head,second) = q(head,second,k) / Σ_k' q(head,second,k')
  const rows = Object.keys(q).filter(k => k.startsWith(`${head}-${second}-`));
  const total = rows.reduce((s, k) => s + q[k], 0);
  const out = {};
  rows.forEach(k => { out[k.split('-')[2]] = q[k] / total; });
  return out; // 4艇分、合計1
}

function buildFeatures3(boats, ranks) {
  const norm = r => (r == null ? null : (7 - r) / 6);
  const f = {};
  boats.forEach((b, i) => { f[b.no] = [norm(ranks.st[i]), norm(ranks.exhibit[i]), norm(ranks.motor[i])]; });
  return f; // {艇番: [ST,展示,機力]}
}

function softmax(scores) { const max = Math.max(...scores); const exps = scores.map(s => Math.exp(s - max)); const total = exps.reduce((a, b) => a + b, 0); return exps.map(e => e / total); }

// ---------- p1(1着、v5と同一構成、固定して再構成のみ) ----------
function marketFirstProbs(oddsMap) {
  const q = marketTrifecta(oddsMap); if (!q) return null;
  return marginal1(q);
}
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

// ---------- p2(2着|1着実測)・p3(3着|1・2着実測) の学習 ----------
// 各レースの実際のi*・j*を条件として、条件付き尤度を最大化する(標準的な条件付きモデルの学習)。
function trainW2(trainData) {
  // trainData: [{candidates2:[艇番...5艇], feat: {艇番:[ST,展示,機力]}, q2cond: {艇番:確率}, actualJ}]
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

// ---------- 全120通りの予測分布(実際の着順を一切参照しない) ----------
function buildFeatMap(boats, ranks) {
  const norm = r => (r == null ? null : (7 - r) / 6);
  const f = {};
  boats.forEach((b, i) => { f[String(b.no)] = [norm(ranks.st[i]), norm(ranks.exhibit[i]), norm(ranks.motor[i])]; });
  return f;
}

function predictDist(r, q, m1, p1map, w2, w3, featMap) {
  // r.chakujuは一切参照しない。全ての仮定上のi,j,kを走査する。
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
      cand3.forEach((k, idx) => {
        const p = p1map[i] * p2[j] * p3arr[idx];
        dist.push({ val: `${i}-${j}-${k}`, p });
      });
    }
  }
  return dist;
}

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  usable.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));
  const trainRaces = usable.filter(r => inRange(r.date, '2026-07-01', '2026-07-31'));
  const eval1Races = usable.filter(r => inRange(r.date, '2026-08-01', '2026-08-15'));
  const eval2Races = usable.filter(r => inRange(r.date, '2026-08-16', '2026-08-30'));

  function prep(races) {
    const out = [];
    for (const r of races) {
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
  const trainSet = prep(trainRaces), eval1Set = prep(eval1Races), eval2Set = prep(eval2Races);
  console.log(`学習n=${trainSet.length}(7/1-31) / 評価期間1n=${eval1Set.length}(8/1-15) / 評価期間2n=${eval2Set.length}(8/16-30)`);
  console.log('対象集合はv5/v6と同一のisUsable+3特徴量完備条件を使用(変更なし)。');

  console.log('\n========== 1着モデル(v5と同一、固定して再構成) ==========');
  const w1 = trainW1(trainSet);
  console.log('w1: ST=', w1[0].toFixed(3), '展示=', w1[1].toFixed(3), '機力=', w1[2].toFixed(3));

  console.log('\n========== 2・3着モデルの学習(実際のi*・j*を条件とした標準的な条件付き学習) ==========');
  const train2 = [], train3 = [];
  for (const { race: r, q, m1, featMap } of trainSet) {
    const boatsNo = r.boats.map(b => String(b.no));
    const chakuju = r.chakuju.split('-');
    const [iStar, jStar, kStar] = chakuju;
    if (!boatsNo.includes(iStar) || !boatsNo.includes(jStar) || !boatsNo.includes(kStar)) continue;
    const q2c = cond2(q, m1, iStar);
    const cand2 = boatsNo.filter(x => x !== iStar);
    train2.push({ candidates2: cand2, feat: featMap, q2cond: q2c, actualJ: jStar });
    const q3c = cond3(q, iStar, jStar);
    const cand3 = boatsNo.filter(x => x !== iStar && x !== jStar);
    train3.push({ candidates3: cand3, feat: featMap, q3cond: q3c, actualK: kStar });
  }
  console.log(`2着学習データ n=${train2.length} / 3着学習データ n=${train3.length}(1着的中の有無を問わず、実測i*/j*で条件付け)`);
  const w2 = trainW2(train2);
  const w3 = trainW3(train3);
  console.log('w2(2着補正): ST=', w2[0].toFixed(3), '展示=', w2[1].toFixed(3), '機力=', w2[2].toFixed(3));
  console.log('w3(3着補正): ST=', w3[0].toFixed(3), '展示=', w3[1].toFixed(3), '機力=', w3[2].toFixed(3));

  // ---------- 数学的・実装上の検査(サンプル1レース) ----------
  console.log('\n========== 数学的検査(サンプル1レース) ==========');
  const sample = eval1Set[3];
  const p1arr = softmax(scoreOf1(sample.marketVec, sample.race.boats.map(b => sample.featMap[String(b.no)]), w1));
  const p1map = {}; sample.race.boats.forEach((b, i) => { p1map[String(b.no)] = p1arr[i]; });

  const distC = predictDist(sample.race, sample.q, sample.m1, p1map, w2, w3, sample.featMap);
  console.log('レース:', sample.race.date, sample.race.venue, sample.race.racenum);
  console.log('120通り件数:', distC.length, '(120のはず)');
  console.log('確率合計:', distC.reduce((s, c) => s + c.p, 0).toFixed(6), '(1.0のはず)');
  console.log('全て非負:', distC.every(c => c.p >= 0));
  console.log('重複val数:', distC.length - new Set(distC.map(c => c.val)).size, '(0のはず)');
  // 各艇が各位置で重複していないか(同じ艇が2度出てこないか)
  const invalidCombo = distC.some(c => new Set(c.val.split('-')).size !== 3);
  console.log('同艇重複のある組合せ:', invalidCombo ? 'あり(異常)' : 'なし(正常)');

  // 2・3着補正ゼロで1着補正のみの分布(v6のp(i,j,k))へ戻るか
  const distZero23 = predictDist(sample.race, sample.q, sample.m1, p1map, [0, 0, 0], [0, 0, 0], sample.featMap);
  let maxDiffZero23 = 0;
  for (const c of distZero23) {
    const i = c.val.split('-')[0];
    const qval = sample.q[c.val];
    const expected = qval * (p1map[i] / sample.m1[i]); // v6の定義 p=q×p1/q1
    maxDiffZero23 = Math.max(maxDiffZero23, Math.abs(c.p - expected));
  }
  console.log('2・3着補正ゼロ時、v6の1着補正のみ分布との最大差:', maxDiffZero23.toExponential(2), '(0のはず)');

  // 全補正ゼロで市場分布へ戻るか
  const distAllZero = predictDist(sample.race, sample.q, sample.m1, sample.m1, [0, 0, 0], [0, 0, 0], sample.featMap);
  const maxDiffMarket = Math.max(...distAllZero.map(c => Math.abs(c.p - sample.q[c.val])));
  console.log('全補正ゼロ時、市場分布qとの最大差:', maxDiffMarket.toExponential(2), '(0のはず)');

  // 1着周辺分布が固定済みp1と一致するか
  const marginalC = {}; distC.forEach(c => { const i = c.val.split('-')[0]; marginalC[i] = (marginalC[i] || 0) + c.p; });
  const maxDiffMarginal = Math.max(...Object.keys(p1map).map(i => Math.abs(marginalC[i] - p1map[i])));
  console.log('1着周辺分布とp1の最大差:', maxDiffMarginal.toExponential(2), '(0のはず)');

  // 実行順序を変えても予測が一致するか(艇の走査順を逆にして再計算)
  function predictDistReversed(r, q, m1, p1map2, w2b, w3b, featMap) {
    const boatsNo = r.boats.map(b => String(b.no)).slice().reverse();
    const dist = [];
    for (const i of boatsNo) {
      const q2c = cond2(q, m1, i);
      const cand2 = boatsNo.filter(x => x !== i).slice().reverse();
      const scores2 = cand2.map(j => Math.log(Math.max(q2c[j], 1e-9)) + featMap[j].reduce((s, v, k) => s + v * w2b[k], 0));
      const p2arr = softmax(scores2);
      const p2 = {}; cand2.forEach((j, idx) => { p2[j] = p2arr[idx]; });
      for (const j of cand2) {
        const q3c = cond3(q, i, j);
        const cand3 = boatsNo.filter(x => x !== i && x !== j).slice().reverse();
        const scores3 = cand3.map(k => Math.log(Math.max(q3c[k], 1e-9)) + featMap[k].reduce((s, v, kk) => s + v * w3b[kk], 0));
        const p3arr = softmax(scores3);
        cand3.forEach((k, idx) => { dist.push({ val: `${i}-${j}-${k}`, p: p1map2[i] * p2[j] * p3arr[idx] }); });
      }
    }
    return dist;
  }
  const distRev = predictDistReversed(sample.race, sample.q, sample.m1, p1map, w2, w3, sample.featMap);
  const mapRev = {}; distRev.forEach(c => { mapRev[c.val] = c.p; });
  const maxDiffOrder = Math.max(...distC.map(c => Math.abs(c.p - mapRev[c.val])));
  console.log('走査順序を変えた場合の最大差:', maxDiffOrder.toExponential(2), '(0のはず)');

  // ---------- 比較 A(市場)/B(1着補正のみ)/C(1着固定+2/3着補正) ----------
  function evaluateSet(dataset, label) {
    let llA = 0, llB = 0, llC = 0, brA = 0, brB = 0, brC = 0, n = 0;
    let condLL2 = 0, condLL2Market = 0, n2 = 0, condLL3 = 0, condLL3Market = 0, n3 = 0;
    const bandsFn = o => (o < 27.6 ? '低' : o < 94.7 ? '中' : '高');
    const bandExpA = { 低: 0, 中: 0, 高: 0 }, bandExpB = { 低: 0, 中: 0, 高: 0 }, bandExpC = { 低: 0, 中: 0, 高: 0 };
    const bandActual = { 低: 0, 中: 0, 高: 0 };
    const byDate = {};
    const estAll = [];
    let over1Count = 0; const over1Dates = new Set(); const over1Odds = [];
    for (const { race: r, q, m1, featMap, marketVec } of dataset) {
      const p1arr2 = softmax(scoreOf1(marketVec, r.boats.map(b => featMap[String(b.no)]), w1));
      const p1m = {}; r.boats.forEach((b, i) => { p1m[String(b.no)] = p1arr2[i]; });
      const distB = predictDist(r, q, m1, p1m, [0, 0, 0], [0, 0, 0], featMap);
      const distCr = predictDist(r, q, m1, p1m, w2, w3, featMap);
      const chakuju = r.chakuju;
      const qActual = q[chakuju], bActual = distB.find(c => c.val === chakuju), cActual = distCr.find(c => c.val === chakuju);
      if (!bActual || !cActual) continue;
      n++;
      llA += -Math.log(Math.max(qActual, 1e-12)); llB += -Math.log(Math.max(bActual.p, 1e-12)); llC += -Math.log(Math.max(cActual.p, 1e-12));
      // Brierスコア: 全120通りに対する(p-y)^2の和(yは実際のcomboのみ1)
      const brierOf = dist => dist.reduce((s, c) => s + (c.p - (c.val === chakuju ? 1 : 0)) ** 2, 0);
      brA += Object.keys(q).reduce((s, k) => s + (q[k] - (k === chakuju ? 1 : 0)) ** 2, 0);
      brB += brierOf(distB); brC += brierOf(distCr);

      // 条件付き診断(実測i*/j*で条件付け、三連単全体成績とは別集計)
      const chParts = chakuju.split('-');
      const q2c = cond2(q, m1, chParts[0]);
      const cand2 = r.boats.map(b => String(b.no)).filter(x => x !== chParts[0]);
      const scores2 = cand2.map(j => Math.log(Math.max(q2c[j], 1e-9)) + featMap[j].reduce((s, v, k) => s + v * w2[k], 0));
      const p2arr = softmax(scores2); const p2idx = cand2.indexOf(chParts[1]);
      if (p2idx >= 0) { condLL2 += -Math.log(Math.max(p2arr[p2idx], 1e-12)); condLL2Market += -Math.log(Math.max(q2c[chParts[1]], 1e-12)); n2++; }
      const q3c = cond3(q, chParts[0], chParts[1]);
      const cand3 = r.boats.map(b => String(b.no)).filter(x => x !== chParts[0] && x !== chParts[1]);
      const scores3 = cand3.map(k => Math.log(Math.max(q3c[k], 1e-9)) + featMap[k].reduce((s, v, kk) => s + v * w3[kk], 0));
      const p3arr = softmax(scores3); const p3idx = cand3.indexOf(chParts[2]);
      if (p3idx >= 0) { condLL3 += -Math.log(Math.max(p3arr[p3idx], 1e-12)); condLL3Market += -Math.log(Math.max(q3c[chParts[2]], 1e-12)); n3++; }

      // オッズ帯別 期待件数 vs 実件数
      distB.forEach(c => { const o = parseFloat(r.oddsMap[c.val]) || 0; if (o > 0) bandExpB[bandsFn(o)] += c.p; });
      distCr.forEach(c => { const o = parseFloat(r.oddsMap[c.val]) || 0; if (o > 0) bandExpC[bandsFn(o)] += c.p; });
      Object.keys(q).forEach(k => { const o = parseFloat(r.oddsMap[k]) || 0; if (o > 0) bandExpA[bandsFn(o)] += q[k]; });
      const actualOdds = parseFloat(r.oddsMap[chakuju]) || 0; if (actualOdds > 0) bandActual[bandsFn(actualOdds)]++;

      const d = r.date; (byDate[d] = byDate[d] || { llB: 0, llC: 0, n: 0 }); byDate[d].llB += -Math.log(Math.max(bActual.p, 1e-12)); byDate[d].llC += -Math.log(Math.max(cActual.p, 1e-12)); byDate[d].n++;

      // 配当診断
      let raceOver1 = false;
      distCr.forEach(c => { const o = parseFloat(r.oddsMap[c.val]) || 0; if (o > 0) { const est = c.p * o; if (estAll.length < 30000) estAll.push(est); if (est > 1) { raceOver1 = true; over1Odds.push(o); } } });
      if (raceOver1) { over1Count++; over1Dates.add(r.date); }
    }
    console.log(`[${label}] n=${n}`);
    console.log(`  三連単ログ損失: A(市場)=${(llA / n).toFixed(3)} B(1着補正のみ)=${(llB / n).toFixed(3)} C(1着固定+2/3着補正)=${(llC / n).toFixed(3)}`);
    console.log(`  三連単Brier: A=${(brA / n).toFixed(4)} B=${(brB / n).toFixed(4)} C=${(brC / n).toFixed(4)}`);
    console.log(`  条件付き診断(実測i*/j*で条件付け、三連単全体とは別集計): 2着条件付きログ損失 市場${(condLL2Market / n2).toFixed(3)}→補正${(condLL2 / n2).toFixed(3)}(n=${n2}) / 3着条件付きログ損失 市場${(condLL3Market / n3).toFixed(3)}→補正${(condLL3 / n3).toFixed(3)}(n=${n3})`);
    console.log(`  オッズ帯別 期待件数(A/B/C) vs 実件数: 低=${bandExpA.低.toFixed(1)}/${bandExpB.低.toFixed(1)}/${bandExpC.低.toFixed(1)} vs実${bandActual.低} | 中=${bandExpA.中.toFixed(1)}/${bandExpB.中.toFixed(1)}/${bandExpC.中.toFixed(1)} vs実${bandActual.中} | 高=${bandExpA.高.toFixed(1)}/${bandExpB.高.toFixed(1)}/${bandExpC.高.toFixed(1)} vs実${bandActual.高}`);
    const dates = Object.keys(byDate).sort();
    let improvedDays = 0; dates.forEach(d => { if (byDate[d].llC / byDate[d].n < byDate[d].llB / byDate[d].n) improvedDays++; });
    console.log(`  日数=${dates.length} うちC<Bだった日数=${improvedDays}`);
    estAll.sort((a, b) => a - b);
    const q_ = p => estAll[Math.floor(estAll.length * p)];
    console.log(`  配当診断(C方式): 推定payout median=${q_(0.5).toFixed(3)} Q3=${q_(0.75).toFixed(3)} 最大=${Math.max(...estAll).toFixed(3)}`);
    console.log(`  1超候補があるレース数=${over1Count}/${n} 日数=${over1Dates.size}`);
    if (over1Odds.length) { over1Odds.sort((a, b) => a - b); console.log(`  1超候補のオッズ: n=${over1Odds.length} median=${over1Odds[Math.floor(over1Odds.length / 2)]} max=${over1Odds[over1Odds.length - 1]}`); }
    return { n, llA: llA / n, llB: llB / n, llC: llC / n, byDate };
  }
  console.log('\n========== A/B/C比較 ==========');
  const res1 = evaluateSet(eval1Set, '評価期間1(8/1-15)');
  const res2 = evaluateSet(eval2Set, '評価期間2(8/16-30)');

  console.log('\n========== 期間別改善方向・不確実性 ==========');
  console.log(`評価期間1: B→Cログ損失差=${(res1.llC - res1.llB).toFixed(4)}(負なら改善)`);
  console.log(`評価期間2: B→Cログ損失差=${(res2.llC - res2.llB).toFixed(4)}(負なら改善)`);

  function blockBootstrap(byDate, iters) {
    const dates = Object.keys(byDate);
    let pos = 0; const diffs = [];
    for (let it = 0; it < iters; it++) {
      const sample2 = Array.from({ length: dates.length }, () => dates[Math.floor(Math.random() * dates.length)]);
      let sumB = 0, sumC = 0, cnt = 0;
      for (const d of sample2) { sumB += byDate[d].llB; sumC += byDate[d].llC; cnt += byDate[d].n; }
      if (!cnt) continue;
      const diff = (sumC / cnt) - (sumB / cnt);
      diffs.push(diff); if (diff < 0) pos++;
    }
    diffs.sort((a, b) => a - b);
    return { ci95: [diffs[Math.floor(diffs.length * 0.025)], diffs[Math.floor(diffs.length * 0.975)]], improveRate: pos / diffs.length };
  }
  const combinedByDate = { ...res1.byDate, ...res2.byDate };
  const bb = blockBootstrap(combinedByDate, 2000);
  console.log(`日単位ブロックブートストラップ(評価期間1+2合算): B→Cログ損失差95%CI=[${bb.ci95[0].toFixed(4)}, ${bb.ci95[1].toFixed(4)}] 改善方向の割合=${(bb.improveRate * 100).toFixed(1)}%`);

  return { w1, w2, w3, res1, res2 };
}

if (require.main === module) main();
module.exports = { main };
