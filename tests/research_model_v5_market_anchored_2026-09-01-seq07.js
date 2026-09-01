'use strict';
// GARON-20260901-001から派生した新規案件(CEO指示: フルデータ限定を外し、アーカイブ全体で
// 「市場の予測に追加できる情報があるか」を1案だけ検証)。GARON-20260910-001(モデル系列)は
// 終了済みで、本件はそれとは別の新しい検証設計(独立モデルを後から混ぜるのではなく、
// 市場の対数確率を固定の基準項とする正則化付き条件付きロジット)。
//
// 【1. 使える期間の確認(結果を見る前に確定)】
// isUsable()(T-10オッズ+結果利用可能): n=6,770、52日間(2026-07-01〜08-30)。
// 艇単位フィールド有効率(qEngine.rankBoatsBySystem()の実出力で確認、n=2000サンプル):
//   ST 91.7%・決まり手91.4%・連対率48.0%(=hasFullDataの制約要因そのもの)・機力99.2%・展示100.0%。
// 個人×コース成績(連対率)が無いことだけを理由に除外していた前回までと異なり、
// ST・展示・機力は艇単位で9割超の有効率がある。ただし「艇ごとに個別チェックすれば9割」であって
// 「レース単位で全艇揃っている割合」は別物のため、レース単位で全艇ST・展示・機力が揃っている
// 集合を実測したところ n=5,956(88.0%)・52日間(2026-07-01〜08-30)確保できた。
// 中立値で埋めて「揃っている」とは扱わず、揃っていないレースは除外する。
//
// 時系列3区間(結果を見る前に固定):
//   学習期間: 2026-07-01〜07-31(n=3,647、30日)
//   評価期間1: 2026-08-01〜08-15(n=1,333、12日)
//   評価期間2: 2026-08-16〜08-30(n=976、10日)
// アーカイブは既に分析済みのため、評価期間も完全な未見データとは主張せず探索的検証として扱う。
//
// 【2. モデル(1案、結果を見る前に固定)】
// 市場の対数確率を固定の基準項(オフセット、係数=1で学習しない)とし、少数の特徴量による
// 線形補正を加える正則化付き多項ロジット(条件付きロジットのオフセット回帰):
//   score_i = log(market_1st_i) + w1*ST_i + w2*展示_i + w3*機力_i
//   P_i = softmax(score)_i
// w=0の初期状態ではP=market_1stと完全一致する(オフセット項の性質を検算済み)。
// 特徴量は艇番ダミーを含めない(艇番=コース位置は市場に最も強く織り込まれている情報であり、
// これを使っても「市場を超える追加情報があるか」を検証したことにならないため、意図的に除外する)。
// 選手ID・レースIDは使わない。正規化は(7-順位)/6の決定論的な順位変換のみ(学習・評価いずれの
// 統計値にも依存しない)。ハイパーパラメータはL2=0.01・LR=0.05・EPOCHS=300で、既存のエンジンα
// 試作の既定値を据え置き、新たな探索は行わない(結果を見てからの変更もしない)。
//
// 【3. 市場分布の定義】
// 三連単120通りのオッズを逆オッズ正規化し(Σ(1/O_j)で割る)、1着艇ごとに該当する組合せの
// 確率を合算してmarket_1st_iを作る。「真の確率」とは呼ばない。同時点のオッズ網羅性(120通り
// 全て存在するか)を確認し、欠けるレースは除外する(サンプル3000件中23件=0.77%で発生)。
// 今回は確率×オッズの順位付けによる買い目選択(方式Cのような検証)は行わない。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');

const ROOT = path.join(__dirname, '..');
const L2 = 0.01, LR = 0.05, EPOCHS = 300;

function inRange(d, lo, hi) { return d >= lo && d <= hi; }

function marketFirstProbs(oddsMap) {
  const keys = Object.keys(oddsMap || {});
  if (keys.length < 120) return null; // 網羅性不足は除外
  let totalInv = 0;
  const invByCombo = {};
  for (const k of keys) {
    const o = parseFloat(oddsMap[k]);
    if (!(o > 0)) return null;
    invByCombo[k] = 1 / o;
    totalInv += invByCombo[k];
  }
  const firstP = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const k of keys) {
    const head = k.split('-')[0];
    firstP[head] += invByCombo[k] / totalInv;
  }
  return firstP;
}

function buildFeatures3(boats, ranks) {
  const norm = r => (r == null ? null : (7 - r) / 6);
  return boats.map((b, i) => [norm(ranks.st[i]), norm(ranks.exhibit[i]), norm(ranks.motor[i])]);
}

function prepareDataset(qEngine, races) {
  const dataset = [];
  let oddsRejected = 0, fieldRejected = 0;
  for (const r of races) {
    const mp = marketFirstProbs(r.oddsMap);
    if (!mp) { oddsRejected++; continue; }
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { fieldRejected++; continue; }
    const feat = buildFeatures3(r.boats, ranks);
    if (feat.some(f => f.some(v => v == null))) { fieldRejected++; continue; } // 中立値で埋めない、除外する
    const winnerBoat = r.chakuju.split('-')[0];
    const winnerIdx = r.boats.findIndex(b => String(b.no) === winnerBoat);
    if (winnerIdx < 0) continue;
    const marketVec = r.boats.map(b => mp[String(b.no)]);
    dataset.push({ race: r, features: feat, marketVec, winnerIdx });
  }
  return { dataset, oddsRejected, fieldRejected };
}

function softmax(scores) {
  const max = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / total);
}

function scoreOf(marketVec, features, w) {
  return marketVec.map((m, i) => Math.log(Math.max(m, 1e-9)) + features[i].reduce((s, v, k) => s + v * w[k], 0));
}

function trainWeights(dataset, nFeatures) {
  let w = new Array(nFeatures).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = new Array(nFeatures).fill(0);
    let loss = 0;
    for (const { marketVec, features, winnerIdx } of dataset) {
      const scores = scoreOf(marketVec, features, w);
      const probs = softmax(scores);
      loss += -Math.log(Math.max(probs[winnerIdx], 1e-9));
      for (let i = 0; i < features.length; i++) {
        const y = (i === winnerIdx) ? 1 : 0;
        const coef = probs[i] - y;
        for (let k = 0; k < nFeatures; k++) grad[k] += coef * features[i][k];
      }
    }
    for (let k = 0; k < nFeatures; k++) { grad[k] = grad[k] / dataset.length + L2 * w[k]; w[k] -= LR * grad[k]; }
    if (epoch % 50 === 0 || epoch === EPOCHS - 1) console.log(`  epoch=${epoch} loss=${(loss / dataset.length).toFixed(4)}`);
  }
  return w;
}

function evaluate(dataset, w, label) {
  let logLossMarket = 0, logLossModel = 0, correctMarket = 0, correctModel = 0, brierMarket = 0, brierModel = 0;
  const calBins = 5;
  const calRowsModel = [], calRowsMarket = [];
  for (const { marketVec, features, winnerIdx } of dataset) {
    const pMarket = marketVec;
    const scores = w ? scoreOf(marketVec, features, w) : marketVec.map(m => Math.log(Math.max(m, 1e-9)));
    const pModel = softmax(scores);
    logLossMarket += -Math.log(Math.max(pMarket[winnerIdx], 1e-9));
    logLossModel += -Math.log(Math.max(pModel[winnerIdx], 1e-9));
    brierMarket += pMarket.reduce((s, p, i) => s + (p - (i === winnerIdx ? 1 : 0)) ** 2, 0);
    brierModel += pModel.reduce((s, p, i) => s + (p - (i === winnerIdx ? 1 : 0)) ** 2, 0);
    if (pMarket.indexOf(Math.max(...pMarket)) === winnerIdx) correctMarket++;
    if (pModel.indexOf(Math.max(...pModel)) === winnerIdx) correctModel++;
    pMarket.forEach((p, i) => calRowsMarket.push({ p, won: i === winnerIdx ? 1 : 0 }));
    pModel.forEach((p, i) => calRowsModel.push({ p, won: i === winnerIdx ? 1 : 0 }));
  }
  const n = dataset.length;
  function calTable(rows) {
    rows.sort((a, b) => a.p - b.p);
    const binSize = Math.ceil(rows.length / calBins);
    const out = [];
    for (let b = 0; b < calBins; b++) {
      const slice = rows.slice(b * binSize, (b + 1) * binSize);
      if (!slice.length) continue;
      out.push(`n${slice.length}:${(slice.reduce((s, r) => s + r.p, 0) / slice.length * 100).toFixed(1)}%→実${(slice.reduce((s, r) => s + r.won, 0) / slice.length * 100).toFixed(1)}%`);
    }
    return out.join(' / ');
  }
  console.log(`[${label}] n=${n}`);
  console.log(`  市場のみ  : ログ損失=${(logLossMarket / n).toFixed(3)} Brier=${(brierMarket / n).toFixed(3)} 的中率=${(correctMarket / n * 100).toFixed(1)}%`);
  console.log(`  市場+補正: ログ損失=${(logLossModel / n).toFixed(3)} Brier=${(brierModel / n).toFixed(3)} 的中率=${(correctModel / n * 100).toFixed(1)}%`);
  console.log(`  較正(市場のみ、5分位): ${calTable(calRowsMarket)}`);
  console.log(`  較正(市場+補正、5分位): ${calTable(calRowsModel)}`);
  return { n, logLossMarket: logLossMarket / n, logLossModel: logLossModel / n, brierMarket: brierMarket / n, brierModel: brierModel / n, correctMarket: correctMarket / n, correctModel: correctModel / n };
}

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  usable.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));

  const trainRaces = usable.filter(r => inRange(r.date, '2026-07-01', '2026-07-31'));
  const eval1Races = usable.filter(r => inRange(r.date, '2026-08-01', '2026-08-15'));
  const eval2Races = usable.filter(r => inRange(r.date, '2026-08-16', '2026-08-30'));

  console.log('========== 1. 対象確認 ==========');
  console.log(`isUsable母集団 n=${usable.length}、52日間(2026-07-01〜08-30)`);
  const { dataset: trainSet, oddsRejected: tOR, fieldRejected: tFR } = prepareDataset(qEngine, trainRaces);
  const { dataset: eval1Set, oddsRejected: e1OR, fieldRejected: e1FR } = prepareDataset(qEngine, eval1Races);
  const { dataset: eval2Set, oddsRejected: e2OR, fieldRejected: e2FR } = prepareDataset(qEngine, eval2Races);
  console.log(`学習期間(7/1-31): 候補${trainRaces.length}→使用${trainSet.length}(オッズ網羅性不足${tOR}・ST/展示/機力欠損${tFR})`);
  console.log(`評価期間1(8/1-15): 候補${eval1Races.length}→使用${eval1Set.length}(オッズ${e1OR}・欠損${e1FR})`);
  console.log(`評価期間2(8/16-30): 候補${eval2Races.length}→使用${eval2Set.length}(オッズ${e2OR}・欠損${e2FR})`);

  console.log('\n========== 学習(2. モデル、市場オフセット+3特徴量) ==========');
  const w = trainWeights(trainSet, 3);
  console.log('学習された重み: ST=', w[0].toFixed(3), '展示=', w[1].toFixed(3), '機力=', w[2].toFixed(3));

  console.log('\n========== 5. 評価(市場のみ vs 市場+補正) ==========');
  evaluate(trainSet, w, '学習期間(参考、自己適合)');
  const q1 = evaluate(eval1Set, w, '評価期間1(8/1-15)');
  const q2 = evaluate(eval2Set, w, '評価期間2(8/16-30)');

  console.log('\n========== 期間ごとの改善方向 ==========');
  console.log(`評価期間1: ログ損失 市場${q1.logLossMarket.toFixed(3)}→補正${q1.logLossModel.toFixed(3)}(差${(q1.logLossModel - q1.logLossMarket).toFixed(3)}、負なら改善)`);
  console.log(`評価期間2: ログ損失 市場${q2.logLossMarket.toFixed(3)}→補正${q2.logLossModel.toFixed(3)}(差${(q2.logLossModel - q2.logLossMarket).toFixed(3)}、負なら改善)`);

  console.log('\n========== 日単位の不確実性(評価期間1+2、対応のある差) ==========');
  function byDateLoss(dataset, w) {
    const byDate = {};
    for (const { race, marketVec, features, winnerIdx } of dataset) {
      const scores = scoreOf(marketVec, features, w);
      const pModel = softmax(scores);
      const lm = -Math.log(Math.max(marketVec[winnerIdx], 1e-9));
      const lc = -Math.log(Math.max(pModel[winnerIdx], 1e-9));
      (byDate[race.date] = byDate[race.date] || []).push({ lm, lc });
    }
    return byDate;
  }
  const combined = [...eval1Set, ...eval2Set];
  const byDate = byDateLoss(combined, w);
  const dates = Object.keys(byDate).sort();
  let improvedDays = 0;
  for (const d of dates) {
    const rows = byDate[d];
    const avgLm = rows.reduce((s, r) => s + r.lm, 0) / rows.length;
    const avgLc = rows.reduce((s, r) => s + r.lc, 0) / rows.length;
    if (avgLc < avgLm) improvedDays++;
  }
  console.log(`評価対象日数=${dates.length}日、うち補正後ログ損失が市場のみを下回った日数=${improvedDays}日(${(improvedDays / dates.length * 100).toFixed(1)}%)`);

  // 日単位ブロックブートストラップ(ログ損失差、対応のある差)
  function blockBootstrap(dataset, w, iters) {
    const byDate2 = byDateLoss(dataset, w);
    const dates2 = Object.keys(byDate2);
    let pos = 0; const diffs = [];
    for (let it = 0; it < iters; it++) {
      const sample = Array.from({ length: dates2.length }, () => dates2[Math.floor(Math.random() * dates2.length)]);
      let sumLm = 0, sumLc = 0, cnt = 0;
      for (const d of sample) { for (const r of byDate2[d]) { sumLm += r.lm; sumLc += r.lc; cnt++; } }
      if (!cnt) continue;
      const diff = (sumLc / cnt) - (sumLm / cnt); // 負なら改善
      diffs.push(diff); if (diff < 0) pos++;
    }
    diffs.sort((a, b) => a - b);
    return { ci95: [diffs[Math.floor(diffs.length * 0.025)], diffs[Math.floor(diffs.length * 0.975)]], improveRate: pos / diffs.length };
  }
  const bb = blockBootstrap(combined, w, 2000);
  console.log(`ログ損失差(補正-市場)の95%CI=[${bb.ci95[0].toFixed(3)}, ${bb.ci95[1].toFixed(3)}](負が改善方向)、改善方向だった試行の割合=${(bb.improveRate * 100).toFixed(1)}%`);

  return { w, q1, q2 };
}

if (require.main === module) main();
module.exports = { main };
