'use strict';
// GARON-20260910-001継続(CEO指示: モデルを固定し、配当帯を揃えた買い目選択を1方式だけ検証)。
//
// 【1. 既存モデルの利用履歴の確認(結果を見る前に開示)】
// - 今回の学習は2026-07-01〜05(n=797)のみで実施(tests/research_model_v2_2026-09-10.jsと
//   完全に同じ学習ループ、trainWeights()はwを毎回ゼロ初期化するため過去の学習係数の混入は無い)
// - 【重要な限界、正直に開示】特徴量セット(tests/lib/alpha-features.js)・モデル形式(多項ロジット)・
//   ハイパーパラメータ(L2=0.01/LR=0.05/EPOCHS=300)は2026-08-27の「エンジンα」試作で決定された
//   ものをそのまま流用している。エンジンα試作時点(2026-08-27)では、当時の全期間アーカイブ
//   (7月〜8月27日ごろまで)に既にアクセスがあり、今回の「最終比較期間」(8/11〜30)の一部
//   (8/11〜27ごろ)は、モデルの「形」自体が決まった時点で開発者(過去のセッション)が既に
//   見ていた可能性がある。**今回の学習データ(7/1〜5)自体は独立しているが、モデル形式・
//   ハイパーパラメータの選定過程は評価期間全体から独立していたとは言えない。** これを
//   「独立した未使用データでの証拠」とは呼ばない。8/28〜30分については、エンジンα試作
//   (2026-08-27完了)より後に収集されたデータであり、モデル形式決定時にはまだ存在しなかった。
// - 前処理: 特徴量は(7-順位)/6の決定論的な順位変換のみで、学習期間・評価期間いずれの統計値
//   (平均・分散等)にも依存しない(標準化なし)。欠損時の中立値0.5も固定定数。期間依存の
//   前処理は行っていない
//
// 【2. 三連単確率の確認(結果を見る前に開示)】
// - computeAllComboProbs()の出力(120通り)を検算: 確率合計1.000000・全て非負・重複0件を
//   サンプルレースで確認済み(_plWinProbs×_plConditionalProbsの数学的性質により、実装が
//   正しければ常に1に正規化される。今回のサンプルで実装バグが無いことを確認)
// - 2着・3着条件付き確率(_plConditionalProbs、sg_narutou.html:2042-2059)はPlackett-Luceの
//   標準形(逐次的に「残った艇の中でのシェア」を掛け合わせる方式)で、恣意的な補正は無い
// - 前回報告の「較正も概ね妥当」は、**1着(勝者スロット)の予測確率を5分位に分けた表のみ**に
//   基づく評価であり、**三連単組合せの確率については較正チェックを行っていない**(組合せ
//   logLossの数値は報告したが、これは較正の確認ではなく単なる損失指標)。三連単の較正は
//   今回も追加検証しない(CEO指示により再学習・較正手法の追加探索はしない)。このため
//   以下で使う「推定払戻倍率」は較正確認済みの確率とは呼ばず、**モデル推定値**として扱う
// - 高オッズ組合せの過大評価について: 下記main()内で簡易チェックを実施(モデル確率/市場
//   逆オッズ確率の比が、オッズ帯によって偏っていないかを確認)
//
// oddsMap値は確定payoutと直接比較し、100円あたりの払戻倍率(元本込み)であることを確認済み
// (サンプルレースでoddsMap[chakuju]=16.7、確定payout=¥1,670で完全一致)。控除率の二重差引は
// していない(推定払戻倍率=P(combo)×oddsMapは、既存のpickBetsByEV()と同じ式を踏襲)。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { allocateStakesEqualRet, isUsable, hasFullData, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs, summarize } = require('./engine_alpha_prototype.js');
const { trainWeights, prepareDataset } = require('./alpha_train_model.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;
// 【事前登録】オッズ帯境界は学習期間(7/1〜5)のQ購入点オッズの三分位から機械的に決定、
// 最終比較期間のデータは一切見ていない。3区分固定、境界の総当たりはしない。
const BANDS = [
  { label: '低(<27.6倍)', lo: 0, hi: 27.6 },
  { label: '中(27.6-94.7倍)', lo: 27.6, hi: 94.7 },
  { label: '高(>=94.7倍)', lo: 94.7, hi: Infinity },
];

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function inRange(d, lo, hi) { return d >= lo && d <= hi; }
function bandOf(odds) { return BANDS.find(b => odds >= b.lo && odds < b.hi); }

// ---------- 事前フライトチェック ----------
function preflightCheck(rowsA, rowsB, rowsC, expectedStake) {
  const errors = [];
  if (rowsA.length !== rowsB.length || rowsA.length !== rowsC.length) errors.push(`対象数不一致: A=${rowsA.length} B=${rowsB.length} C=${rowsC.length}`);
  for (const [label, rows] of [['A', rowsA], ['B', rowsB], ['C', rowsC]]) {
    for (const r of rows) {
      if (new Set(r.points).size !== r.points.length) errors.push(`${label} ${r.date}: 重複買い目`);
      for (const p of r.points) if (!/^[1-6]-[1-6]-[1-6]$/.test(p) || new Set(p.split('-')).size !== 3) errors.push(`${label} ${r.date}: 不正三連単 ${p}`);
      const stakeSum = r.amounts.reduce((s, a) => s + a, 0);
      if (Math.abs(stakeSum - r.stake) > 1) errors.push(`${label} ${r.date}: stake不整合`);
      for (const a of r.amounts) if (a % 100 !== 0) errors.push(`${label} ${r.date}: 100円単位でない`);
    }
  }
  // A(Q)とB(Cも含む)の点数がレースごとに一致しているか
  for (let i = 0; i < rowsA.length; i++) {
    if (rowsA[i].points.length !== rowsB[i].points.length) errors.push(`${rowsA[i].date}: A/B点数不一致`);
    if (rowsA[i].points.length !== rowsC[i].points.length) errors.push(`${rowsA[i].date}: A/C点数不一致`);
    if (Math.abs(rowsA[i].stake - rowsC[i].stake) > rowsA[i].points.length) errors.push(`${rowsA[i].date}: A/C投資額乖離大`); // 候補不足時のみ許容
  }
  return errors;
}

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

  const all = loadAllRaces();
  const full = all.filter(isUsable).filter(hasFullData);
  full.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));
  const train = full.filter(r => inRange(r.date, '2026-07-01', '2026-07-05'));
  const final = full.filter(r => inRange(r.date, '2026-08-11', '2026-08-30'));

  console.log('========== 学習(train n=' + train.length + ', 7/1-5のみ) ==========');
  const trainSet = prepareDataset(qEngine, train);
  const w = trainWeights(trainSet, FEATURE_NAMES.length);

  // ---- 高オッズ過大評価チェック(train期間、参考) ----
  console.log('\n========== 高オッズ過大評価の簡易チェック(学習期間) ==========');
  const ratioByBand = { 低: [], 中: [], 高: [] };
  for (const r of train.slice(0, 200)) {
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
    const feat = buildFeatures(r.boats, ranks);
    const scores = feat.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
    const scoreMap = {}; r.boats.forEach((b, i) => { scoreMap[String(b.no)] = scores[i]; });
    let combos; try { combos = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { continue; }
    const withOdds = combos.map(c => ({ ...c, odds: parseFloat(r.oddsMap[c.val]) || 0 })).filter(c => c.odds > 0);
    const totalInv = withOdds.reduce((s, c) => s + 1 / c.odds, 0);
    withOdds.forEach(c => {
      const marketP = totalInv > 0 ? (1 / c.odds) / totalInv : 0;
      const b = bandOf(c.odds); if (!b || marketP <= 0) return;
      const key = b.label.slice(0, 1);
      ratioByBand[key].push(c.p / marketP);
    });
  }
  for (const [k, arr] of Object.entries(ratioByBand)) {
    if (!arr.length) continue;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    console.log(`  ${k}オッズ帯: n=${arr.length} モデル確率/市場確率の平均比=${mean.toFixed(2)}(1.0が市場と一致、大きく上振れなら高オッズ側で過大評価の疑い)`);
  }

  // ---- 方式A(Q)/B(モデル確率上位N点)/C(帯制約付き推定払戻倍率選択) ----
  console.log('\n========== 方式A/B/Cの構築(最終比較期間、Qの参戦集合) ==========');
  const rowsA = [], rowsB = [], rowsC = [];
  let shortageEvents = 0;
  for (const r of final) {
    let bets; try { bets = qEngine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { continue; }
    if (!bets.judge.entered) continue;
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }

    const qPts = [...new Set(bets.formations.flatMap(f => f.points))];
    const qOdds = qPts.map(p => parseFloat(r.oddsMap[p]) || 0);
    if (qOdds.some(o => o <= 0)) continue; // 購入時オッズが欠ける場合は全方式とも対象外
    const qAmt = allocateStakesEqualRet(qPts, r.oddsMap, SHIKIN);
    const pay100 = parsePayout100(r.payout);

    const feat = buildFeatures(r.boats, ranks);
    const scores = feat.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
    const scoreMap = {}; r.boats.forEach((b, i) => { scoreMap[String(b.no)] = scores[i]; });
    let comboProbs; try { comboProbs = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { continue; }
    const withOdds = comboProbs.map(c => ({ ...c, odds: parseFloat(r.oddsMap[c.val]) || 0 })).filter(c => c.odds > 0);
    if (!withOdds.length) continue;

    // 方式B: モデル確率上位N点(前回と同一規則)
    const bPts = [...comboProbs].sort((a, b2) => b2.p - a.p).slice(0, qPts.length).map(c => c.val);
    if (bPts.length !== qPts.length) continue;

    // 方式C: 帯ごとにQと同じ点数・投資額、推定払戻倍率(P×odds)で入れ替え
    const qByBand = BANDS.map(b => ({ band: b, pts: [], amt: 0 }));
    qPts.forEach((p, i) => { const b = bandOf(qOdds[i]); const slot = qByBand.find(x => x.band === b); if (slot) { slot.pts.push(p); slot.amt += qAmt[i]; } });

    const cPts = [], cAmtList = [];
    for (const slot of qByBand) {
      const wanted = slot.pts.length;
      if (wanted === 0) continue;
      const candidates = withOdds.filter(c => c.odds >= slot.band.lo && c.odds < slot.band.hi)
        .map(c => ({ val: c.val, est: c.p * c.odds }))
        .sort((a, b2) => b2.est - a.est);
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

    function buildRow(pts, amt) {
      const hit = pts.includes(r.chakuju);
      return { date: r.date, hit, stake: amt.reduce((s, a) => s + a, 0), payout: hit ? Math.round(amt[pts.indexOf(r.chakuju)] / 100 * pay100) : 0, points: pts, amounts: amt, pointOdds: pts.map(p => parseFloat(r.oddsMap[p]) || 0) };
    }
    const rowA = buildRow(qPts, qAmt);
    const rowB = buildRow(bPts, allocateStakesEqualRet(bPts, r.oddsMap, SHIKIN));
    const rowC = buildRow(cPts, cAmtList);
    // 推定払戻倍率(方式Cで買った点の、購入時点でのstake加重平均P×odds)
    const cEstSum = cPts.reduce((s, p, i) => {
      const c = comboProbs.find(x => x.val === p);
      return s + (c ? c.p * (parseFloat(r.oddsMap[p]) || 0) * cAmtList[i] : 0);
    }, 0);
    rowC.estMultiple = rowC.stake > 0 ? cEstSum / rowC.stake : null;

    rowsA.push(rowA); rowsB.push(rowB); rowsC.push(rowC);
  }
  console.log(`対象n=${rowsA.length} / 帯内候補不足イベント数=${shortageEvents}`);

  console.log('\n========== 事前フライトチェック ==========');
  const errs = preflightCheck(rowsA, rowsB, rowsC, SHIKIN);
  console.log(errs.length === 0 ? '異常なし' : `異常${errs.length}件`);
  if (errs.length) { console.log(errs.slice(0, 10)); return; }

  console.log('\n========== 5. 評価 ==========');
  const sA = summarize(rowsA), sB = summarize(rowsB), sC = summarize(rowsC);
  console.log(`A(Q)     : n=${sA.n} 的中率${sA.hitRate.toFixed(1)}% ROI${sA.roi.toFixed(1)}%`);
  console.log(`B(モデル): n=${sB.n} 的中率${sB.hitRate.toFixed(1)}% ROI${sB.roi.toFixed(1)}%(差${(sB.roi - sA.roi).toFixed(1)}pt)`);
  console.log(`C(帯制約): n=${sC.n} 的中率${sC.hitRate.toFixed(1)}% ROI${sC.roi.toFixed(1)}%(差${(sC.roi - sA.roi).toFixed(1)}pt)`);

  function oddsDist(rows, label) {
    const all2 = []; rows.forEach(r => r.pointOdds.forEach((o, i) => all2.push({ odds: o, amount: r.amounts[i] })));
    const sorted = all2.map(x => x.odds).sort((a, b) => a - b);
    const q = p => sorted[Math.floor(sorted.length * p)];
    const totalAmt = all2.reduce((s, x) => s + x.amount, 0);
    const wMean = all2.reduce((s, x) => s + x.odds * x.amount, 0) / totalAmt;
    const hitP = rows.filter(r => r.hit).map(r => r.payout).sort((a, b) => a - b);
    console.log(`  [${label}] オッズ median${q(0.5)} Q1${q(0.25)} Q3${q(0.75)} 加重平均${wMean.toFixed(1)} / 的中配当 n${hitP.length} mean${hitP.length ? Math.round(hitP.reduce((s, v) => s + v, 0) / hitP.length) : 0} median${hitP.length ? hitP[Math.floor(hitP.length / 2)] : 0}`);
  }
  oddsDist(rowsA, 'A(Q)'); oddsDist(rowsB, 'B(モデル)'); oddsDist(rowsC, 'C(帯制約)');

  function hitDiff(base, cand) {
    let lost = 0, gained = 0;
    for (let i = 0; i < base.length; i++) { if (base[i].hit && !cand[i].hit) lost++; if (!base[i].hit && cand[i].hit) gained++; }
    return { lost, gained };
  }
  console.log('的中増減 C vs A:', JSON.stringify(hitDiff(rowsA, rowsC)));

  const estValid = rowsC.filter(r => r.estMultiple != null);
  const avgEst = estValid.reduce((s, r) => s + r.estMultiple * r.stake, 0) / estValid.reduce((s, r) => s + r.stake, 0);
  console.log(`\nC方式の推定払戻倍率(stake加重平均、モデル推定値・較正未確認): ${avgEst.toFixed(2)} vs 実際のROI: ${(sC.roi / 100).toFixed(2)}(乖離: ${(avgEst - sC.roi / 100).toFixed(2)})`);

  function outlierExcl(rows) {
    const hits = rows.filter(r => r.hit).sort((a, b) => b.payout - a.payout);
    const top2 = hits.slice(0, 2).reduce((s, r) => s + r.payout, 0);
    const stake = rows.reduce((s, r) => s + r.stake, 0), payout = rows.reduce((s, r) => s + r.payout, 0);
    return { top2, roiExTop2: stake ? (payout - top2) / stake * 100 : null };
  }
  console.log('\n上位2件除外ROI: A', JSON.stringify(outlierExcl(rowsA)), '/ B', JSON.stringify(outlierExcl(rowsB)), '/ C', JSON.stringify(outlierExcl(rowsC)));

  const dates = [...new Set(rowsA.map(r => r.date))];
  console.log(`\n評価対象日数: ${dates.length}日、n=${rowsA.length}件`);
  console.log('日別:');
  for (const d of dates) {
    const a = summarize(rowsA.filter(r => r.date === d)), c = summarize(rowsC.filter(r => r.date === d));
    console.log(`  ${d}: n=${a.n} A=${a.roi != null ? a.roi.toFixed(1) : '-'}% C=${c.roi != null ? c.roi.toFixed(1) : '-'}%`);
  }

  function blockBootstrap(base, cand, iters) {
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
  const bb = blockBootstrap(rowsA, rowsC, 2000);
  console.log(`\nC vs A 日単位ブロックブートストラップ(${dates.length}日から復元抽出、注意: 実質2クラスタ): 95%CI=[${bb.ci95[0].toFixed(1)}, ${bb.ci95[1].toFixed(1)}] 改善率=${(bb.positiveRate * 100).toFixed(1)}%`);

  return { sA, sB, sC };
}

if (require.main === module) main();
module.exports = { main };
