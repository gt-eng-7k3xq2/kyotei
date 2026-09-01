'use strict';
// GARON-20260901-002継続(CEO指示: 「展示-今節平均差」(tenji-avgTenji)だけを使った1着補正検証、1案のみ)。
//
// 【1. データの意味と時点の確認結果(結果を見る前に記録)】
// - tenji="直前展示タイム"(そのレース自身の展示タイム、daikibo_archive.html:490-492)。
//   avgTenji="今節平均展示タイム"(daikibo_archive.html:496-498、コメント「直前なければ補完」)。
//   いずれもkyoteibiyori.comの当該レースページから直接スクレイピングした値で、ローカルでの
//   独自計算ではない(parseData()を実行時抽出、tests/lib/extract-parse-data.js経由で
//   production〈realtime_screening.js〉とarchive収集ツールが完全に同一関数を使用、確認済み)。
// - 【重要】parseFloat(...)||0という実装のため、サイト上「-」(値なし)は数値0として保存され、
//   nullにはならない。前回報告の「カバレッジ100%」は`!=null`判定によるもので誤りだった。
//   **実際の有効値(0でない)での再集計: 艇単位75.0%、レース単位(6艇とも有効)75.0%、
//   n=5,078・51日間(2026-07-01〜08-30)。** 本報告ではこの75.0%版を正しいカバレッジとして扱う。
// - avgTenji=0(欠損)の発生率はレース番号に依存する(R1-R9で26-29%、R10で24%、R11で16%、
//   R12で15%程度、本スクリプト内で再確認)。当日の開催が進むほど「今節平均」が算出可能になる
//   傾向と整合しており、avgTenjiが実際に「その時点までの今節実績」を反映する値であり、
//   未来のレースを含む固定値ではないことを示唆する間接証拠だが、サイト側の内部処理を
//   直接検証したものではない(2026-09-07調査時の一般的な限界がそのまま当てはまる)。
// - avgTenjiが当該レース自身のtenjiを含むかどうかは、サイトの表示ロジック次第であり、
//   既存資料だけでは確認できなかった。含む場合、今節出走数が多い艇ほど「当日の値」が
//   平均に占める寄与が薄まる性質があることを記録しておく(平均への織り込み度合いが
//   艇によって一定ではない可能性)。
// - 初日・初出走等で平均が無い場合は0として保存され、本検証では対象外とする(0を有効な
//   短縮タイムとして扱わない)。後日backfillでavgTenjiが書き換わる一般的なリスクは既存の
//   backfill_missing_fields.js調査(2026-09-06/07)と同一(boats配列を丸ごと再取得する設計)。
//
// 【2. モデル(1案、結果を見る前に固定)】
// score_i = log(market_1st_i) + w × standardized_delta_i
//   delta_i = tenji_i - avgTenji_i (負値ほど平均より速い＝当日の調子が良いことを意味する)
//   standardized_delta_i = (delta_i - mean_train) / std_train (学習期間だけで決めた平均・標準偏差)
// 係数wは1個のみ、正則化・学習率・エポック数は既存のエンジンα試作の既定値(L2=0.01,LR=0.05,
// EPOCHS=300)を据え置く。閾値・非線形変換・交互作用・会場別係数は追加しない。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');

const ROOT = path.join(__dirname, '..');
const L2 = 0.01, LR = 0.05, EPOCHS = 300;

function inRange(d, lo, hi) { return d >= lo && d <= hi; }

function marketFirstProbs(oddsMap) {
  const keys = Object.keys(oddsMap || {});
  if (keys.length < 120) return null;
  let totalInv = 0; const invByCombo = {};
  for (const k of keys) { const o = parseFloat(oddsMap[k]); if (!(o > 0)) return null; invByCombo[k] = 1 / o; totalInv += invByCombo[k]; }
  const firstP = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const k of keys) { const head = k.split('-')[0]; firstP[head] += invByCombo[k] / totalInv; }
  return { firstP, invByCombo, totalInv };
}

function validPair(b) { return b.tenji != null && b.tenji !== 0 && b.avgTenji != null && b.avgTenji !== 0; }

function softmax(scores) { const max = Math.max(...scores); const exps = scores.map(s => Math.exp(s - max)); const total = exps.reduce((a, b) => a + b, 0); return exps.map(e => e / total); }

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  usable.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));

  console.log('========== 1. カバレッジ再確認(有効数値ベース) ==========');
  let validRaceCount = 0;
  const validByDate = {};
  const validByRaceNum = {};
  for (const r of usable) {
    const allValid = r.boats.every(validPair);
    validByRaceNum[r.racenum] = validByRaceNum[r.racenum] || { total: 0, valid: 0 };
    validByRaceNum[r.racenum].total++;
    if (allValid) { validRaceCount++; validByDate[r.date] = (validByDate[r.date] || 0) + 1; validByRaceNum[r.racenum].valid++; }
  }
  console.log(`母集団(isUsable) n=${usable.length}`);
  console.log(`有効(tenji≠0 & avgTenji≠0が6艇とも) n=${validRaceCount}(${(validRaceCount / usable.length * 100).toFixed(1)}%) 日数=${Object.keys(validByDate).length}`);
  console.log('レース番号別有効率:', Object.keys(validByRaceNum).sort((a, b) => a - b).map(rn => `R${rn}:${(validByRaceNum[rn].valid / validByRaceNum[rn].total * 100).toFixed(0)}%`).join(' '));

  const trainRaces = usable.filter(r => inRange(r.date, '2026-07-01', '2026-07-31') && r.boats.every(validPair));
  const eval1Races = usable.filter(r => inRange(r.date, '2026-08-01', '2026-08-15') && r.boats.every(validPair));
  const eval2Races = usable.filter(r => inRange(r.date, '2026-08-16', '2026-08-30') && r.boats.every(validPair));
  console.log(`\n学習期間(7/1-31) n=${trainRaces.length} / 評価期間1(8/1-15) n=${eval1Races.length} / 評価期間2(8/16-30) n=${eval2Races.length}`);
  if (trainRaces.length < 100 || eval1Races.length < 30 || eval2Races.length < 30) {
    console.log('有効対象が不足しているため学習へ進まず終了します。');
    return { insufficientData: true };
  }

  function prep(races) {
    const out = [];
    for (const r of races) {
      const mk = marketFirstProbs(r.oddsMap); if (!mk) continue;
      const winnerBoat = r.chakuju.split('-')[0];
      const winnerIdx = r.boats.findIndex(b => String(b.no) === winnerBoat);
      if (winnerIdx < 0) continue;
      const marketVec = r.boats.map(b => mk.firstP[String(b.no)]);
      const deltas = r.boats.map(b => b.tenji - b.avgTenji);
      out.push({ race: r, mk, marketVec, deltas, winnerIdx });
    }
    return out;
  }
  const trainSet = prep(trainRaces), eval1Set = prep(eval1Races), eval2Set = prep(eval2Races);

  // 標準化パラメータは学習期間だけで決める
  const allTrainDeltas = trainSet.flatMap(d => d.deltas);
  const meanTrain = allTrainDeltas.reduce((s, v) => s + v, 0) / allTrainDeltas.length;
  const stdTrain = Math.sqrt(allTrainDeltas.reduce((s, v) => s + (v - meanTrain) ** 2, 0) / allTrainDeltas.length);
  console.log(`\n標準化パラメータ(学習期間のみ): 平均=${meanTrain.toFixed(4)}秒 標準偏差=${stdTrain.toFixed(4)}秒`);

  function standardize(delta) { return (delta - meanTrain) / stdTrain; }

  console.log('\n========== 2. 学習(1係数のみ) ==========');
  let w = 0;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let grad = 0;
    for (const { marketVec, deltas, winnerIdx } of trainSet) {
      const scores = marketVec.map((m, i) => Math.log(Math.max(m, 1e-9)) + w * standardize(deltas[i]));
      const probs = softmax(scores);
      for (let i = 0; i < 6; i++) { const y = i === winnerIdx ? 1 : 0; grad += (probs[i] - y) * standardize(deltas[i]); }
    }
    grad = grad / trainSet.length + L2 * w;
    w -= LR * grad;
  }
  console.log(`学習された係数 w=${w.toFixed(4)}(標準化済みdeltaに対する係数。deltaは負=平均より速い)`);
  console.log(`入力差の大きさの目安: 標準偏差1つ分(=${stdTrain.toFixed(3)}秒)速い場合、スコアへの寄与=${w.toFixed(4)}`);

  function evaluate(dataset, label) {
    let llMarket = 0, llModel = 0, brMarket = 0, brModel = 0, corMarket = 0, corModel = 0, n = 0;
    const calMarket = [], calModel = [];
    const byDate = {};
    for (const { race: r, marketVec, deltas, winnerIdx } of dataset) {
      const scores = marketVec.map((m, i) => Math.log(Math.max(m, 1e-9)) + w * standardize(deltas[i]));
      const pModel = softmax(scores);
      const pMarket = marketVec;
      llMarket += -Math.log(Math.max(pMarket[winnerIdx], 1e-9)); llModel += -Math.log(Math.max(pModel[winnerIdx], 1e-9));
      brMarket += pMarket.reduce((s, p, i) => s + (p - (i === winnerIdx ? 1 : 0)) ** 2, 0);
      brModel += pModel.reduce((s, p, i) => s + (p - (i === winnerIdx ? 1 : 0)) ** 2, 0);
      if (pMarket.indexOf(Math.max(...pMarket)) === winnerIdx) corMarket++;
      if (pModel.indexOf(Math.max(...pModel)) === winnerIdx) corModel++;
      pMarket.forEach((p, i) => calMarket.push({ p, won: i === winnerIdx ? 1 : 0 }));
      pModel.forEach((p, i) => calModel.push({ p, won: i === winnerIdx ? 1 : 0 }));
      n++;
      const d = r.date; (byDate[d] = byDate[d] || { llMarket: 0, llModel: 0, n: 0 });
      byDate[d].llMarket += -Math.log(Math.max(pMarket[winnerIdx], 1e-9)); byDate[d].llModel += -Math.log(Math.max(pModel[winnerIdx], 1e-9)); byDate[d].n++;
    }
    function calTable(rows) {
      rows.sort((a, b) => a.p - b.p);
      const bins = 5, binSize = Math.ceil(rows.length / bins);
      const out = [];
      for (let b = 0; b < bins; b++) { const slice = rows.slice(b * binSize, (b + 1) * binSize); if (!slice.length) continue; out.push(`${(slice.reduce((s, r2) => s + r2.p, 0) / slice.length * 100).toFixed(1)}%→実${(slice.reduce((s, r2) => s + r2.won, 0) / slice.length * 100).toFixed(1)}%`); }
      return out.join(' / ');
    }
    console.log(`[${label}] n=${n}`);
    console.log(`  ログ損失: 市場${(llMarket / n).toFixed(4)} → モデル${(llModel / n).toFixed(4)}(差${((llModel - llMarket) / n * n / n).toFixed(4)})`);
    console.log(`  Brier: 市場${(brMarket / n).toFixed(4)} → モデル${(brModel / n).toFixed(4)}`);
    console.log(`  1着的中率: 市場${(corMarket / n * 100).toFixed(1)}% → モデル${(corModel / n * 100).toFixed(1)}%`);
    console.log(`  較正(市場、5分位): ${calTable(calMarket)}`);
    console.log(`  較正(モデル、5分位): ${calTable(calModel)}`);
    return { n, llMarket: llMarket / n, llModel: llModel / n, byDate };
  }

  console.log('\n========== 4. 予測性能比較(市場のみ vs 市場+今回の1特徴量) ==========');
  const rTrain = evaluate(trainSet, '学習期間(参考、自己適合)');
  const r1 = evaluate(eval1Set, '評価期間1(8/1-15)');
  const r2 = evaluate(eval2Set, '評価期間2(8/16-30)');

  console.log('\n========== 期間別改善方向・日単位不確実性 ==========');
  console.log(`評価期間1: ログ損失差(モデル-市場)=${(r1.llModel - r1.llMarket).toFixed(4)}(負なら改善)`);
  console.log(`評価期間2: ログ損失差(モデル-市場)=${(r2.llModel - r2.llMarket).toFixed(4)}(負なら改善)`);

  function blockBootstrap(byDate, iters) {
    const dates = Object.keys(byDate);
    let pos = 0; const diffs = [];
    for (let it = 0; it < iters; it++) {
      const sample = Array.from({ length: dates.length }, () => dates[Math.floor(Math.random() * dates.length)]);
      let sumM = 0, sumMo = 0, cnt = 0;
      for (const d of sample) { sumM += byDate[d].llMarket; sumMo += byDate[d].llModel; cnt += byDate[d].n; }
      if (!cnt) continue;
      const diff = (sumMo / cnt) - (sumM / cnt);
      diffs.push(diff); if (diff < 0) pos++;
    }
    diffs.sort((a, b) => a - b);
    return { ci95: [diffs[Math.floor(diffs.length * 0.025)], diffs[Math.floor(diffs.length * 0.975)]], improveRate: pos / diffs.length };
  }
  const combined = { ...r1.byDate, ...r2.byDate };
  const bb = blockBootstrap(combined, 2000);
  console.log(`日単位ブロックブートストラップ(評価期間1+2合算): ログ損失差95%CI=[${bb.ci95[0].toFixed(4)}, ${bb.ci95[1].toFixed(4)}] 改善方向の割合=${(bb.improveRate * 100).toFixed(1)}%`);

  const bothImproved = (r1.llModel < r1.llMarket) && (r2.llModel < r2.llMarket);
  console.log(`\n両評価期間で改善方向が一致: ${bothImproved}`);

  if (!bothImproved) {
    console.log('\n両評価期間で改善方向が一致しなかったため、配当上の診断は行わず終了します(CEO指示5.)。');
    return { w, r1, r2, bothImproved: false };
  }

  console.log('\n========== 5. 配当上の診断(改善が両期間で一致したため実施) ==========');
  // 既存の市場2・3着条件付き分布を保持した変換: p(i,j,k)=q(i,j,k)*p1(i)/q1(i)
  function analyzePayout(dataset, label) {
    let maxEst = -Infinity; const estAll = []; let over1Count = 0; const over1Dates = new Set(); const over1Odds = [];
    for (const { race: r, mk, marketVec, deltas } of dataset) {
      const scores = marketVec.map((m, i) => Math.log(Math.max(m, 1e-9)) + w * standardize(deltas[i]));
      const p1arr = softmax(scores);
      const p1 = {}; r.boats.forEach((b, i) => { p1[String(b.no)] = p1arr[i]; });
      let raceOver1 = false;
      for (const k of Object.keys(r.oddsMap)) {
        const head = k.split('-')[0];
        const qijk = mk.invByCombo[k] / mk.totalInv;
        const p = qijk * (p1[head] / mk.firstP[head]);
        const odds = parseFloat(r.oddsMap[k]);
        const est = p * odds;
        if (estAll.length < 20000) estAll.push(est);
        if (est > maxEst) maxEst = est;
        if (est > 1) { raceOver1 = true; over1Odds.push(odds); }
      }
      if (raceOver1) { over1Count++; over1Dates.add(r.date); }
    }
    estAll.sort((a, b) => a - b);
    console.log(`[${label}] 推定払戻倍率 median=${estAll[Math.floor(estAll.length / 2)].toFixed(3)} 最大=${maxEst.toFixed(3)}`);
    console.log(`  1超候補があるレース数=${over1Count}/${dataset.length} 日数=${over1Dates.size}`);
    if (over1Odds.length) { over1Odds.sort((a, b) => a - b); console.log(`  1超候補のオッズ: n=${over1Odds.length} median=${over1Odds[Math.floor(over1Odds.length / 2)]} max=${over1Odds[over1Odds.length - 1]}`); }
    console.log('  ※同一1着艇内では推定払戻倍率が同値になる性質があり、買い目順位付けの根拠にはしていません。');
  }
  analyzePayout(eval1Set, '評価期間1(8/1-15)');
  analyzePayout(eval2Set, '評価期間2(8/16-30)');

  return { w, r1, r2, bothImproved: true };
}

if (require.main === module) main();
module.exports = { main };
