'use strict';
// GARON-20260901-001から派生した新規案件(CEO指示: 「Qとは別の研究用予測モデルを1種類だけ比較」)。
// 目的はQの点数配分・閾値の微調整ではなく、保存データから着順をより適切に予測できるかの確認。
// Qの全面置換・新エンジンの本番実装は目的外。
//
// 既存資産の再利用(独自実装を増やさない): tests/lib/alpha-features.js(特徴量)、
// tests/lib/extract-pl-engine.js(sg_narutou.htmlのPlackett-Luce確率計算)、
// tests/engine_alpha_prototype.js(computeAllComboProbs/marketImpliedProbs/allocateStakesEqualRet)、
// tests/alpha_train_model.js(多項ロジット回帰=Plackett-Luceの勝者スロット学習、softmax/trainWeights)。
// これらは2026-08-27のエンジンα試作(5アプローチ全てROI55-83%止まりで黒字化せず、CEOが限界を
// 受容した既存案件)の成果物。今回はその枠組みを再利用しつつ、①母集団をCEO指定の
// 「フルデータ(hasFullData、約1,300件)」に限定②時系列3分割③Qと完全一致する点数・投資額での
// 買い目比較④予測性能(accuracy/log-loss/Brier/較正/組合せ)を購入成績と分離して報告、という
// 新しい評価設計を追加する点で従来のエンジンα試作とは異なる。
//
// 【事前登録(結果を見る前に固定)】
// 母集団: isUsable() && hasFullData()(dashboard.htmlの「完全」タイルと同一定義、独自の絞り込み
//   条件を新設しない)。2026-09-10時点でn=1,332、日付は2026-07-01〜08-30の13日間のみ(07-01〜07、
//   08-11、08-26〜30に集中)。この日付の偏りは2026-08-27のエンジンα試作時点で既に反証部隊から
//   「日付に紐づく未知の交絡因子を排除できていない」と指摘済みの制約であり、今回も解消していない。
//
// 時系列3分割(日付順、レース単位、艇の分割はしない):
//   学習期間: 2026-07-01〜07-05(n=797)
//   設定選択期間: 2026-07-06〜07-07(n=167、ハイパーパラメータの追加チューニングには使わない。
//     学習が破綻していないかの確認のみに使う。既存のalpha_train_model.jsの値を据え置く)
//   最終比較期間: 2026-08-11〜08-30(n=368、暦月が異なるが、上記の日付偏り制約を引き継ぐため
//     「完全な未見データ」ではなく探索的比較として扱う)
//
// モデル仕様(結果を見る前に固定):
//   多項ロジット回帰(Plackett-Luce型、勝者スロットの尤度を最大化する標準的な学習)。
//   特徴量(10次元、tests/lib/alpha-features.js): 艇番ダミー5個(2〜6号艇、1号艇が基準)+
//   ST/決まり手/連対率/機力/展示の系統別順位を(7-順位)/6で0〜1正規化した5個。情報なしはrankBoat
//   BySystem側で艇ごとに独立してnull→0.5中立扱い(Qの中立処理と同一ロジックを再利用、独自の
//   欠損処理を新設しない)。選手ID・レースIDそのものは特徴量に含まない。確定オッズ・結果・
//   後日更新統計は一切使わない。市場情報(oddsMap)は特徴量に使わない(モデルには含めず、
//   人気順ベースラインの比較対象としてのみ、予想時点の値=T-10収集値を使う)。
//   ハイパーパラメータ: L2=0.01, LR=0.05, EPOCHS=300(alpha_train_model.jsの既定値を据え置き、
//   総当たりのグリッドサーチは行わない)。標準化は行わない(特徴量は元々0-1正規化済みのため)。
//
// 買い目選択規則(結果を見る前に固定): 各レースでQの実際の点数(betCount)と完全に同数、
//   モデル方式は「PL combo確率の高い順」、人気順方式は「市場逆オッズ由来のcombo確率の高い順」で
//   選ぶ。100円単位の資金配分は既存のallocateStakesEqualRet()をそのまま使用。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { allocateStakesEqualRet, isUsable, hasFullData, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs, marketImpliedProbs, summarize } = require('./engine_alpha_prototype.js');
const { trainWeights, prepareDataset, softmax } = require('./alpha_train_model.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function inRange(dateStr, lo, hi) { return dateStr >= lo && dateStr <= hi; }

// ---------- 1. 予測性能(全評価対象、Qの参戦判定とは無関係) ----------
function predictionQuality(qEngine, plEngine, w, races, label) {
  const dataset = prepareDataset(qEngine, races);
  let correct = 0, logLossSum = 0, brierSum = 0, comboLogLossSum = 0, comboLogLossN = 0;
  const calRows = [];
  for (const { race: r, features, winnerIdx } of dataset) {
    const scores = features.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
    const probs = softmax(scores);
    const predIdx = probs.indexOf(Math.max(...probs));
    if (predIdx === winnerIdx) correct++;
    logLossSum += -Math.log(Math.max(probs[winnerIdx], 1e-9));
    brierSum += probs.reduce((s, p, i) => s + (p - (i === winnerIdx ? 1 : 0)) ** 2, 0);
    probs.forEach((p, i) => calRows.push({ p, won: i === winnerIdx ? 1 : 0 }));

    const scoreMap = {}; r.boats.forEach((b, i) => { scoreMap[String(b.no)] = scores[i]; });
    try {
      const comboProbs = computeAllComboProbs(plEngine, scoreMap, 1);
      const actual = comboProbs.find(c => c.val === r.chakuju);
      if (actual) { comboLogLossSum += -Math.log(Math.max(actual.p, 1e-9)); comboLogLossN++; }
    } catch (e) { /* skip */ }
  }
  const n = dataset.length;
  calRows.sort((a, b) => a.p - b.p);
  const bins = 5, binSize = Math.ceil(calRows.length / bins);
  const calTable = [];
  for (let b = 0; b < bins; b++) {
    const slice = calRows.slice(b * binSize, (b + 1) * binSize);
    if (!slice.length) continue;
    calTable.push({ n: slice.length, avgP: slice.reduce((s, r2) => s + r2.p, 0) / slice.length, actual: slice.reduce((s, r2) => s + r2.won, 0) / slice.length });
  }
  console.log(`[${label}] n=${n} 1着的中率=${(correct / n * 100).toFixed(1)}% logLoss(勝者)=${(logLossSum / n).toFixed(3)} Brier=${(brierSum / n).toFixed(3)} 組合せlogLoss=${(comboLogLossSum / comboLogLossN).toFixed(3)}(n=${comboLogLossN})`);
  console.log(`  較正(5分位、予測確率帯 vs 実際の勝率): ${calTable.map(t => `n${t.n}:${(t.avgP * 100).toFixed(1)}%→実${(t.actual * 100).toFixed(1)}%`).join(' / ')}`);
  return { n, accuracy: correct / n, logLoss: logLossSum / n, brier: brierSum / n, comboLogLoss: comboLogLossSum / comboLogLossN };
}

function qAccuracy(qEngine, races, label) {
  let correct = 0, n = 0;
  for (const r of races) {
    let bets; try { bets = qEngine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { continue; }
    n++;
    if (String(bets.axes[0].boat) === r.chakuju.split('-')[0]) correct++;
  }
  console.log(`[${label}] Q 1着的中率(軸、校正済み確率ではない)=${(correct / n * 100).toFixed(1)}%(n=${n})`);
  return { n, accuracy: correct / n };
}

function marketAccuracyAndLoss(races, label) {
  let correct = 0, n = 0, logLossSum = 0, count = 0;
  for (const r of races) {
    const boats = r.boats.map(b => String(b.no));
    const minOdds = {};
    boats.forEach(no => {
      let m = Infinity;
      for (const k of Object.keys(r.oddsMap || {})) if (k.startsWith(`${no}-`)) { const o = parseFloat(r.oddsMap[k]); if (o > 0 && o < m) m = o; }
      minOdds[no] = m;
    });
    if (Object.values(minOdds).some(v => !isFinite(v))) continue;
    const inv = {}; let sum = 0; boats.forEach(no => { inv[no] = 1 / minOdds[no]; sum += inv[no]; });
    const probs = {}; boats.forEach(no => { probs[no] = inv[no] / sum; });
    const pred = boats.slice().sort((a, b) => probs[b] - probs[a])[0];
    n++;
    if (pred === r.chakuju.split('-')[0]) correct++;
    const winnerNo = r.chakuju.split('-')[0];
    if (probs[winnerNo] != null) { logLossSum += -Math.log(Math.max(probs[winnerNo], 1e-9)); count++; }
  }
  console.log(`[${label}] 人気順(市場逆オッズ) 1着的中率=${(correct / n * 100).toFixed(1)}% logLoss=${(logLossSum / count).toFixed(3)}(n=${n})`);
  return { n, accuracy: correct / n, logLoss: logLossSum / count };
}

// ---------- 2. 買い目比較(Qの参戦集合、最終比較期間のみ、Qと同点数・同投資額) ----------
// 1レースにつきQ/モデル/人気順を同時に計算し、いずれかが失敗したレースは3方式とも除外する
// (行の対応関係を崩さないため。的中の増減比較で位置対応を使うことの前提を保証する)。
function bettingComparison(qEngine, plEngine, w, races) {
  const qRows = [], modelRows = [], popRows = [];
  for (const r of races) {
    let bets; try { bets = qEngine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { continue; }
    if (!bets.judge.entered) continue;
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }

    const qPts = [...new Set(bets.formations.flatMap(f => f.points))];
    const wanted = qPts.length;
    const feat = buildFeatures(r.boats, ranks);
    const scores = feat.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
    const scoreMap = {}; r.boats.forEach((b, i) => { scoreMap[String(b.no)] = scores[i]; });
    let comboProbs; try { comboProbs = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { continue; }
    const modelPts = [...comboProbs].sort((a, b) => b.p - a.p).slice(0, wanted).map(c => c.val);
    const marketP = marketImpliedProbs(comboProbs, r.oddsMap);
    const popPts = Object.entries(marketP).sort((a, b) => b[1] - a[1]).slice(0, wanted).map(x => x[0]);
    if (modelPts.length !== wanted || popPts.length !== wanted) continue; // 候補不足レースは3方式とも除外

    const pay100 = parsePayout100(r.payout);
    function buildRow(pts) {
      const amt = allocateStakesEqualRet(pts, r.oddsMap, SHIKIN);
      const hit = pts.includes(r.chakuju);
      const pointOdds = pts.map(p => parseFloat(r.oddsMap[p]) || 0);
      return { date: r.date, hit, stake: amt.reduce((s, a) => s + a, 0), payout: hit ? Math.round(amt[pts.indexOf(r.chakuju)] / 100 * pay100) : 0, points: pts, amounts: amt, pointOdds };
    }
    qRows.push(buildRow(qPts));
    modelRows.push(buildRow(modelPts));
    popRows.push(buildRow(popPts));
  }
  return { qRows, modelRows, popRows };
}

function oddsDistribution(rows, label) {
  const all2 = []; rows.forEach(r => r.pointOdds.forEach((o, i) => all2.push({ odds: o, amount: r.amounts[i] })));
  const sorted = all2.map(x => x.odds).filter(o => o > 0).sort((a, b) => a - b);
  const q = p => sorted[Math.floor(sorted.length * p)];
  const totalAmt = all2.reduce((s, x) => s + x.amount, 0);
  const wMean = all2.reduce((s, x) => s + x.odds * x.amount, 0) / totalAmt;
  const hitPayouts = rows.filter(r => r.hit).map(r => r.payout).sort((a, b) => a - b);
  console.log(`  [${label}] 購入オッズ: median${q(0.5)} Q1${q(0.25)} Q3${q(0.75)} 投資加重平均${wMean.toFixed(1)} / 的中配当: n${hitPayouts.length} mean${hitPayouts.length ? Math.round(hitPayouts.reduce((s, v) => s + v, 0) / hitPayouts.length) : 0} median${hitPayouts.length ? hitPayouts[Math.floor(hitPayouts.length / 2)] : 0}`);
}

function outlierExcl(rows) {
  const hits = rows.filter(r => r.hit).sort((a, b) => b.payout - a.payout);
  const top2 = hits.slice(0, 2).reduce((s, r) => s + r.payout, 0);
  const stake = rows.reduce((s, r) => s + r.stake, 0);
  const payout = rows.reduce((s, r) => s + r.payout, 0);
  return { top2, roiExTop2: stake ? (payout - top2) / stake * 100 : null };
}

function blockBootstrap(base, cand, iters) {
  const dates = [...new Set(base.map(r => r.date))];
  const byDateBase = {}; base.forEach(r => { (byDateBase[r.date] = byDateBase[r.date] || []).push(r); });
  const byDateCand = {}; cand.forEach(r => { (byDateCand[r.date] = byDateCand[r.date] || []).push(r); });
  let pos = 0; const diffs = [];
  for (let it = 0; it < iters; it++) {
    const sample = Array.from({ length: dates.length }, () => dates[Math.floor(Math.random() * dates.length)]);
    let bS = 0, bP = 0, cS = 0, cP = 0;
    for (const d of sample) {
      (byDateBase[d] || []).forEach(r => { bS += r.stake; bP += r.payout; });
      (byDateCand[d] || []).forEach(r => { cS += r.stake; cP += r.payout; });
    }
    if (!bS || !cS) continue;
    const diff = (cP / cS * 100) - (bP / bS * 100);
    diffs.push(diff); if (diff > 0) pos++;
  }
  diffs.sort((a, b) => a - b);
  return { ci95: [diffs[Math.floor(diffs.length * 0.025)], diffs[Math.floor(diffs.length * 0.975)]], positiveRate: pos / diffs.length };
}

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

  const all = loadAllRaces();
  const full = all.filter(isUsable).filter(hasFullData);
  full.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));

  const train = full.filter(r => inRange(r.date, '2026-07-01', '2026-07-05'));
  const valid = full.filter(r => inRange(r.date, '2026-07-06', '2026-07-07'));
  const final = full.filter(r => inRange(r.date, '2026-08-11', '2026-08-30'));
  console.log(`母集団(isUsable&&hasFullData) n=${full.length} / 学習n=${train.length} / 設定選択n=${valid.length} / 最終比較n=${final.length}`);

  console.log('\n========== 学習 ==========');
  const trainSet = prepareDataset(qEngine, train);
  const w = trainWeights(trainSet, FEATURE_NAMES.length);
  console.log('学習された重み:'); FEATURE_NAMES.forEach((name, i) => console.log(`  ${name}: ${w[i].toFixed(3)}`));

  console.log('\n========== 1. 予測性能(全評価対象、参戦判定と無関係) ==========');
  predictionQuality(qEngine, plEngine, w, train, '学習期間(参考、自己適合)');
  predictionQuality(qEngine, plEngine, w, valid, '設定選択期間(破綻確認のみ)');
  predictionQuality(qEngine, plEngine, w, final, '最終比較期間(主要)');
  qAccuracy(qEngine, final, '最終比較期間');
  marketAccuracyAndLoss(final, '最終比較期間');

  console.log('\n========== 2. 買い目比較(Qの参戦集合、最終比較期間、Qと同点数・同投資額) ==========');
  const { qRows, modelRows, popRows } = bettingComparison(qEngine, plEngine, w, final);
  const qS = summarize(qRows), mS = summarize(modelRows), pS = summarize(popRows);
  console.log(`Q     : n=${qS.n} 的中率${qS.hitRate.toFixed(1)}% ROI${qS.roi.toFixed(1)}%`);
  console.log(`モデル: n=${mS.n} 的中率${mS.hitRate.toFixed(1)}% ROI${mS.roi.toFixed(1)}%(差${(mS.roi - qS.roi).toFixed(1)}pt)`);
  console.log(`人気順: n=${pS.n} 的中率${pS.hitRate.toFixed(1)}% ROI${pS.roi.toFixed(1)}%(差${(pS.roi - qS.roi).toFixed(1)}pt)`);

  function hitDiff(base, cand) {
    let lost = 0, gained = 0;
    for (let i = 0; i < base.length; i++) { if (base[i].hit && !cand[i].hit) lost++; if (!base[i].hit && cand[i].hit) gained++; }
    return { lost, gained };
  }
  console.log('的中の増減(モデル vs Q):', JSON.stringify(hitDiff(qRows, modelRows)));
  console.log('的中の増減(人気順 vs Q):', JSON.stringify(hitDiff(qRows, popRows)));

  console.log('\n購入オッズ・的中配当分布:');
  oddsDistribution(qRows, 'Q');
  oddsDistribution(modelRows, 'モデル');
  oddsDistribution(popRows, '人気順');

  console.log('\n上位2件除外ROI: Q', JSON.stringify(outlierExcl(qRows)), '/ モデル', JSON.stringify(outlierExcl(modelRows)), '/ 人気順', JSON.stringify(outlierExcl(popRows)));

  console.log('\n========== 期間別(最終比較期間内、日付クラスタごと) ==========');
  function byCluster(rows, lo, hi) { return rows.filter(r => inRange(r.date, lo, hi)); }
  for (const [label, lo, hi] of [['08-11', '2026-08-11', '2026-08-11'], ['08-26〜30', '2026-08-26', '2026-08-30']]) {
    const q2 = summarize(byCluster(qRows, lo, hi)), m2 = summarize(byCluster(modelRows, lo, hi)), p2 = summarize(byCluster(popRows, lo, hi));
    console.log(`${label}: Q=${q2.n ? q2.roi.toFixed(1) : '-'}%(n${q2.n}) モデル=${m2.n ? m2.roi.toFixed(1) : '-'}%(n${m2.n}) 人気順=${p2.n ? p2.roi.toFixed(1) : '-'}%(n${p2.n})`);
  }

  console.log('\n========== 不確実性(日単位ブロックブートストラップ、対 Q) ==========');
  const bbModel = blockBootstrap(qRows, modelRows, 2000);
  const bbPop = blockBootstrap(qRows, popRows, 2000);
  console.log('モデル vs Q: 95%CI=', bbModel.ci95.map(v => v.toFixed(1)), '改善率=', (bbModel.positiveRate * 100).toFixed(1) + '%');
  console.log('人気順 vs Q: 95%CI=', bbPop.ci95.map(v => v.toFixed(1)), '改善率=', (bbPop.positiveRate * 100).toFixed(1) + '%');

  return { w, qS, mS, pS };
}

if (require.main === module) main();
module.exports = { main };
