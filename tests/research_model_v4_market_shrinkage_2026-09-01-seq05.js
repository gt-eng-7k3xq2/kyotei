'use strict';
// GARON-20260910-001継続(CEO指示: 三連単確率の市場への縮約補正を1方式だけ検証)。
// 予測モデル(重み)・買い目選択規則(帯制約付き方式C)は前回から完全固定、確率だけを置換する。
// 同じアーカイブを使う追加探索であり、未使用データによる証明ではない(探索的検証)。
// この検証後、係数・帯を変えた類似の微調整は自動で続けない(CEO指示)。
//
// 【1. 前回結論の訂正(結果を見る前に明記)】
// 前回「高オッズ過大評価を直接確認」としたのは、モデル確率/市場確率の比だった。これは
// 「市場との乖離」を示すのみで、真の確率からの過大評価を証明するものではない(市場も
// 正解ではなく比較基準)。今回、以下の3つを明確に分けて報告する:
//   (a) 市場との乖離: モデル確率/市場確率の比(前回既出、再掲のみ)
//   (b) 予測確率と実際の発生頻度の乖離: オッズ帯ごとの予測確率合計 vs 実際の的中件数
//     (レース単位で評価、120通りを独立サンプル扱いしない)
//   (c) 推定payoutと実払戻の乖離(前回既出の方式Cの値、再掲のみ)
//
// 【2. 補正方式(1種類、結果を見る前に固定)】
// corrected(combo) ∝ model(combo)^(1-λ) × market(combo)^λ 、120通り合計が1になるよう正規化。
// market(combo)は同時点(T-10収集)の逆オッズを120通りで正規化したもの(「真の確率」とは呼ばない)。
// ゼロ確率処理: model/marketいずれかがepsilon(1e-6)未満の場合は1e-6にフロアしてから累乗する
// (0^(非整数)のNaN化を防止)。オッズ欠損: そのレースは全方式(A/B/C)から除外(前回と同一方針)。
// λグリッド(結果を見る前に固定、総当たりのROI最適化はしない): [0, 0.25, 0.5, 0.75, 1.0]の5点のみ。
// 帯ごとの個別係数・条件分岐は導入しない(単一のλを全レース・全combo共通で使う)。
//
// 【3. λの選定(結果を見る前に固定した手続き)】
// 設定選択期間(2026-07-06〜07、n=168、既存の3分割をそのまま流用)における実際の三連単結果への
// ログ損失(-log(P_corrected(実際のchakuju)))の平均が最小のλを採用する。ROIでは選ばない。
// 最終比較期間(8/11〜30)はλ選定に一切使わない。選定後、結果を見てからのλ変更もしない。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { allocateStakesEqualRet, isUsable, hasFullData, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs, summarize } = require('./engine_alpha_prototype.js');
const { trainWeights, prepareDataset } = require('./alpha_train_model.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;
const EPS = 1e-6;
const LAMBDA_GRID = [0, 0.25, 0.5, 0.75, 1.0];
const BANDS = [
  { label: '低(<27.6倍)', lo: 0, hi: 27.6 },
  { label: '中(27.6-94.7倍)', lo: 27.6, hi: 94.7 },
  { label: '高(>=94.7倍)', lo: 94.7, hi: Infinity },
];

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function inRange(d, lo, hi) { return d >= lo && d <= hi; }
function bandOf(odds) { return BANDS.find(b => odds >= b.lo && odds < b.hi); }

function marketProbs(comboProbs, oddsMap) {
  const withOdds = comboProbs.map(c => ({ val: c.val, odds: parseFloat(oddsMap[c.val]) || 0 })).filter(c => c.odds > 0);
  const totalInv = withOdds.reduce((s, c) => s + 1 / c.odds, 0);
  const mp = {};
  withOdds.forEach(c => { mp[c.val] = totalInv > 0 ? (1 / c.odds) / totalInv : 0; });
  return mp;
}

function shrink(comboProbs, mp, lambda) {
  const raw = comboProbs.map(c => {
    const m = Math.max(c.p, EPS);
    const mk = Math.max(mp[c.val] || 0, EPS);
    return { val: c.val, raw: Math.pow(m, 1 - lambda) * Math.pow(mk, lambda) };
  });
  const total = raw.reduce((s, c) => s + c.raw, 0);
  return raw.map(c => ({ val: c.val, p: total > 0 ? c.raw / total : 1 / raw.length }));
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

  console.log(`学習n=${train.length} / 設定選択n=${valid.length}(2026-07-06〜07、2日間) / 最終比較n=${final.length}`);

  console.log('\n========== 学習(train n=' + train.length + ', 前回と同一) ==========');
  const trainSet = prepareDataset(qEngine, train);
  const w = trainWeights(trainSet, FEATURE_NAMES.length);

  // 各レースのモデルcombo確率・市場確率を事前計算するヘルパー
  function computeForRace(r) {
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { return null; }
    const feat = buildFeatures(r.boats, ranks);
    const scores = feat.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
    const scoreMap = {}; r.boats.forEach((b, i) => { scoreMap[String(b.no)] = scores[i]; });
    let comboProbs; try { comboProbs = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { return null; }
    const withOdds = comboProbs.every(c => (parseFloat(r.oddsMap[c.val]) || 0) > 0);
    if (!withOdds) return null; // オッズ欠損は全方式から除外
    const mp = marketProbs(comboProbs, r.oddsMap);
    return { comboProbs, mp };
  }

  // ---------- 3. λ選定(設定選択期間、ログ損失のみ、ROI不使用) ----------
  console.log('\n========== 3. λ選定(設定選択期間、ログ損失基準) ==========');
  const validPrepared = valid.map(r => { const c = computeForRace(r); return c ? { r, ...c } : null; }).filter(Boolean);
  console.log(`λ選定に使える対象n=${validPrepared.length}/${valid.length}(オッズ欠損等で除外後)`);
  let bestLambda = null, bestLoss = Infinity;
  for (const lambda of LAMBDA_GRID) {
    let lossSum = 0, n = 0;
    for (const { r, comboProbs, mp } of validPrepared) {
      const corrected = shrink(comboProbs, mp, lambda);
      const actual = corrected.find(c => c.val === r.chakuju);
      if (!actual) continue;
      lossSum += -Math.log(Math.max(actual.p, 1e-9)); n++;
    }
    const meanLoss = lossSum / n;
    console.log(`  λ=${lambda}: ログ損失=${meanLoss.toFixed(3)}(n=${n})`);
    if (meanLoss < bestLoss) { bestLoss = meanLoss; bestLambda = lambda; }
  }
  console.log(`採用λ=${bestLambda}(設定選択期間のログ損失最小、ROI不使用)`);
  if (bestLambda === 1.0) console.log('【報告】λ=1.0(市場のみ)が最良となり、モデル独自情報の追加価値が乏しい可能性があります。');
  if (bestLambda === 0) console.log('【報告】λ=0(補正なし)が最良となり、今回の市場縮約補正には効果がありませんでした。');

  // ---------- 1. 前回結論の訂正・確率品質比較(最終比較期間) ----------
  console.log('\n========== 1・4. 確率品質の比較(最終比較期間、A=補正なし/B=補正後/C=市場のみ) ==========');
  const finalPrepared = final.map(r => { const c = computeForRace(r); return c ? { r, ...c } : null; }).filter(Boolean);
  console.log(`確率品質評価n=${finalPrepared.length}/${final.length}`);

  function evalProbSet(prepared, variant) {
    // variant: 'model' | 'corrected' | 'market'
    let logLossSum = 0, brierSum = 0, n = 0;
    const bandExpected = { 低: 0, 中: 0, 高: 0 };
    const bandActual = { 低: 0, 中: 0, 高: 0 };
    const byDate = {};
    for (const { r, comboProbs, mp } of prepared) {
      let probs;
      if (variant === 'model') probs = comboProbs;
      else if (variant === 'market') probs = comboProbs.map(c => ({ val: c.val, p: mp[c.val] || 0 }));
      else probs = shrink(comboProbs, mp, bestLambda);

      const actual = probs.find(c => c.val === r.chakuju);
      if (!actual) continue;
      logLossSum += -Math.log(Math.max(actual.p, 1e-9));
      brierSum += probs.reduce((s, c) => s + (c.p - (c.val === r.chakuju ? 1 : 0)) ** 2, 0);
      n++;

      probs.forEach(c => {
        const o = parseFloat(r.oddsMap[c.val]) || 0;
        const b = bandOf(o); if (!b) return;
        bandExpected[b.label.slice(0, 1)] += c.p;
      });
      const actualOdds = parseFloat(r.oddsMap[r.chakuju]) || 0;
      const ab = bandOf(actualOdds);
      if (ab) bandActual[ab.label.slice(0, 1)]++;
      const d = r.date; (byDate[d] = byDate[d] || { loss: 0, n: 0 }); byDate[d].loss += -Math.log(Math.max(actual.p, 1e-9)); byDate[d].n++;
    }
    return { n, logLoss: logLossSum / n, brier: brierSum / n, bandExpected, bandActual, byDate };
  }

  const qualA = evalProbSet(finalPrepared, 'model');
  const qualB = evalProbSet(finalPrepared, 'corrected');
  const qualC = evalProbSet(finalPrepared, 'market');
  console.log(`A(補正なしモデル): n=${qualA.n} 組合せログ損失=${qualA.logLoss.toFixed(3)} Brier=${qualA.brier.toFixed(4)}`);
  console.log(`B(補正後モデル,λ=${bestLambda}): n=${qualB.n} 組合せログ損失=${qualB.logLoss.toFixed(3)} Brier=${qualB.brier.toFixed(4)}`);
  console.log(`C(市場分布のみ): n=${qualC.n} 組合せログ損失=${qualC.logLoss.toFixed(3)} Brier=${qualC.brier.toFixed(4)}`);

  console.log('\nオッズ帯別: 予測確率合計(期待件数) vs 実際の的中件数(A/B/Cそれぞれ)');
  for (const key of ['低', '中', '高']) {
    console.log(`  ${key}: A期待${qualA.bandExpected[key].toFixed(1)}/実${qualA.bandActual[key]} | B期待${qualB.bandExpected[key].toFixed(1)}/実${qualB.bandActual[key]} | C期待${qualC.bandExpected[key].toFixed(1)}/実${qualC.bandActual[key]}`);
  }

  console.log('\n日別ログ損失(A/B/C):');
  for (const d of Object.keys(qualA.byDate).sort()) {
    console.log(`  ${d}: n=${qualA.byDate[d].n} A=${(qualA.byDate[d].loss / qualA.byDate[d].n).toFixed(2)} B=${(qualB.byDate[d].loss / qualB.byDate[d].n).toFixed(2)} C=${(qualC.byDate[d].loss / qualC.byDate[d].n).toFixed(2)}`);
  }

  // ---------- 5. 買い目比較(前回方式Cを固定、確率だけ置換) ----------
  console.log('\n========== 5. 買い目比較(方式C固定、A=Q/B=補正なしC/C=補正後C) ==========');
  function buildCRows(prepared, useCorrected) {
    const rows = [];
    let shortageEvents = 0;
    for (const { r, comboProbs, mp } of prepared) {
      let bets; try { bets = qEngine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { continue; }
      if (!bets.judge.entered) continue;
      const qPts = [...new Set(bets.formations.flatMap(f => f.points))];
      const qOdds = qPts.map(p => parseFloat(r.oddsMap[p]) || 0);
      if (qOdds.some(o => o <= 0)) continue;
      const qAmt = allocateStakesEqualRet(qPts, r.oddsMap, SHIKIN);
      const pay100 = parsePayout100(r.payout);

      const probs = useCorrected ? shrink(comboProbs, mp, bestLambda) : comboProbs;
      const withOdds = probs.map(c => ({ val: c.val, p: c.p, odds: parseFloat(r.oddsMap[c.val]) || 0 })).filter(c => c.odds > 0);

      const qByBand = BANDS.map(b => ({ band: b, pts: [], amt: 0 }));
      qPts.forEach((p, i) => { const b = bandOf(qOdds[i]); const slot = qByBand.find(x => x.band === b); if (slot) { slot.pts.push(p); slot.amt += qAmt[i]; } });

      const cPts = [], cAmtList = [];
      for (const slot of qByBand) {
        const wanted = slot.pts.length;
        if (wanted === 0) continue;
        const candidates = withOdds.filter(c => c.odds >= slot.band.lo && c.odds < slot.band.hi)
          .map(c => ({ val: c.val, est: c.p * c.odds })).sort((a, b2) => b2.est - a.est);
        const available = candidates.length;
        const take = Math.min(wanted, available);
        if (take < wanted) shortageEvents++;
        const selected = candidates.slice(0, take).map(c => c.val);
        const bandBudget = Math.round(slot.amt * (take / wanted) / 100) * 100;
        if (selected.length && bandBudget > 0) {
          const amt = allocateStakesEqualRet(selected, r.oddsMap, bandBudget);
          selected.forEach((p, i) => { cPts.push(p); cAmtList.push(amt[i]); });
        }
      }
      if (!cPts.length) continue;
      const hit = cPts.includes(r.chakuju);
      const stake = cAmtList.reduce((s, a) => s + a, 0);
      const payout = hit ? Math.round(cAmtList[cPts.indexOf(r.chakuju)] / 100 * pay100) : 0;
      const pointOdds = cPts.map(p => parseFloat(r.oddsMap[p]) || 0);
      const estSum = cPts.reduce((s, p, i) => { const c = probs.find(x => x.val === p); return s + (c ? c.p * pointOdds[i] * cAmtList[i] : 0); }, 0);

      const qHit = qPts.includes(r.chakuju);
      rows.push({
        date: r.date, hit, stake, payout, points: cPts, amounts: cAmtList, pointOdds, estMultiple: stake > 0 ? estSum / stake : null,
        qRow: { hit: qHit, stake: qAmt.reduce((s, a) => s + a, 0), payout: qHit ? Math.round(qAmt[qPts.indexOf(r.chakuju)] / 100 * pay100) : 0, points: qPts, amounts: qAmt },
      });
    }
    return { rows, shortageEvents };
  }

  const { rows: rowsBraw, shortageEvents: se1 } = buildCRows(finalPrepared, false);
  const { rows: rowsCraw, shortageEvents: se2 } = buildCRows(finalPrepared, true);
  console.log(`帯内候補不足イベント: 補正なし=${se1} / 補正後=${se2}`);
  const rowsA = rowsBraw.map(r => r.qRow); // Qは補正なし版のqRowと同一(同じレース集合)
  console.log(`対象n=${rowsA.length}`);

  const sA = summarize(rowsA), sB = summarize(rowsBraw), sC = summarize(rowsCraw);
  console.log(`A(Q)        : n=${sA.n} 的中率${sA.hitRate.toFixed(1)}% ROI${sA.roi.toFixed(1)}%`);
  console.log(`B(補正なしC): n=${sB.n} 的中率${sB.hitRate.toFixed(1)}% ROI${sB.roi.toFixed(1)}%(差${(sB.roi - sA.roi).toFixed(1)}pt)`);
  console.log(`C(補正後C)  : n=${sC.n} 的中率${sC.hitRate.toFixed(1)}% ROI${sC.roi.toFixed(1)}%(差${(sC.roi - sA.roi).toFixed(1)}pt)`);

  function oddsDist(rows, label) {
    const all2 = []; rows.forEach(r => r.pointOdds.forEach((o, i) => all2.push({ odds: o, amount: r.amounts[i] })));
    const sorted = all2.map(x => x.odds).sort((a, b) => a - b);
    const q = p => sorted[Math.floor(sorted.length * p)];
    const totalAmt = all2.reduce((s, x) => s + x.amount, 0);
    const wMean = all2.reduce((s, x) => s + x.odds * x.amount, 0) / totalAmt;
    const hitP = rows.filter(r => r.hit).map(r => r.payout).sort((a, b) => a - b);
    console.log(`  [${label}] オッズ median${q(0.5)} Q1${q(0.25)} Q3${q(0.75)} 加重平均${wMean.toFixed(1)} / 的中配当 n${hitP.length} mean${hitP.length ? Math.round(hitP.reduce((s, v) => s + v, 0) / hitP.length) : 0} median${hitP.length ? hitP[Math.floor(hitP.length / 2)] : 0}`);
  }
  oddsDist(rowsBraw, 'B(補正なしC)'); oddsDist(rowsCraw, 'C(補正後C)');

  function estGap(rows, label) {
    const valid2 = rows.filter(r => r.estMultiple != null);
    const avgEst = valid2.reduce((s, r) => s + r.estMultiple * r.stake, 0) / valid2.reduce((s, r) => s + r.stake, 0);
    const roi = summarize(rows).roi / 100;
    console.log(`  [${label}] 推定payout=${avgEst.toFixed(2)} vs 実際ROI=${roi.toFixed(2)}(乖離${(avgEst - roi).toFixed(2)})`);
  }
  estGap(rowsBraw, 'B'); estGap(rowsCraw, 'C');

  function hitDiff(base, cand) {
    let lost = 0, gained = 0;
    for (let i = 0; i < base.length; i++) { if (base[i].hit && !cand[i].hit) lost++; if (!base[i].hit && cand[i].hit) gained++; }
    return { lost, gained };
  }
  console.log('的中増減 B vs A:', JSON.stringify(hitDiff(rowsA, rowsBraw)));
  console.log('的中増減 C vs A:', JSON.stringify(hitDiff(rowsA, rowsCraw)));

  function outlierExcl(rows) {
    const hits = rows.filter(r => r.hit).sort((a, b) => b.payout - a.payout);
    const top2 = hits.slice(0, 2).reduce((s, r) => s + r.payout, 0);
    const stake = rows.reduce((s, r) => s + r.stake, 0), payout = rows.reduce((s, r) => s + r.payout, 0);
    return { top2, roiExTop2: stake ? (payout - top2) / stake * 100 : null };
  }
  console.log('上位2件除外ROI: A', JSON.stringify(outlierExcl(rowsA)), '/ B', JSON.stringify(outlierExcl(rowsBraw)), '/ C', JSON.stringify(outlierExcl(rowsCraw)));

  const dates = [...new Set(rowsBraw.map(r => r.date))];
  console.log(`\n評価対象日数=${dates.length}日 n=${rowsA.length}`);
  console.log('日別:');
  // rowsAにはdateフィールドが無いため、同一インデックスのrowsBrawのdateを使って対応付ける
  for (const d of dates) {
    const idxs = []; rowsBraw.forEach((r, i) => { if (r.date === d) idxs.push(i); });
    const aSub = idxs.map(i => rowsA[i]), bSub = idxs.map(i => rowsBraw[i]), cSub = idxs.map(i => rowsCraw[i]);
    const a = summarize(aSub), b = summarize(bSub), c = summarize(cSub);
    console.log(`  ${d}: n=${a.n} A=${a.roi.toFixed(1)}% B=${b.roi.toFixed(1)}% C=${c.roi.toFixed(1)}%`);
  }

  function blockBootstrap(base, cand, dateList, baseDates, iters) {
    const byDateBase = {}; base.forEach((r, i) => { const d = baseDates[i]; (byDateBase[d] = byDateBase[d] || []).push(r); });
    const byDateCand = {}; cand.forEach((r, i) => { const d = baseDates[i]; (byDateCand[d] = byDateCand[d] || []).push(r); });
    let pos = 0; const diffs = [];
    for (let it = 0; it < iters; it++) {
      const sample = Array.from({ length: dateList.length }, () => dateList[Math.floor(Math.random() * dateList.length)]);
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
  const dateList = rowsBraw.map(r => r.date);
  const bbB = blockBootstrap(rowsA, rowsBraw, dates, dateList, 2000);
  const bbC = blockBootstrap(rowsA, rowsCraw, dates, dateList, 2000);
  console.log(`\nB vs A: 95%CI=[${bbB.ci95[0].toFixed(1)}, ${bbB.ci95[1].toFixed(1)}] 改善率=${(bbB.positiveRate * 100).toFixed(1)}%`);
  console.log(`C vs A: 95%CI=[${bbC.ci95[0].toFixed(1)}, ${bbC.ci95[1].toFixed(1)}] 改善率=${(bbC.positiveRate * 100).toFixed(1)}%`);

  return { bestLambda, qualA, qualB, qualC, sA, sB, sC };
}

if (require.main === module) main();
module.exports = { main };
