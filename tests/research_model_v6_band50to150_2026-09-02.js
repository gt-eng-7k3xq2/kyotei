'use strict';
// GARON-20260901-003 継続、CEO最優先指示(2026-09-02): 前向き記録の準備ではなく、既存アーカイブに
// よる予測エンジン改善開発を優先する。50-150倍帯・8点固定・1日10本前後・帯内的中率20%目標を、
// Q非依存の予測候補で追えるかを検証する。8点は比較用の暫定条件であり、最適点数の証明ではない。
//
// 【事前登録: 実装前に固定、結果を見る前】
// 1. 何を予測するか: 各レースの三連単120通りの的中確率分布(Plackett-Luce)。艇の系統別順位
//    (ST/決まり手/連対率/機力/展示、Qのrank BoatsBySystemをそのまま流用)+コース位置ダミーを
//    入力とする多項ロジット回帰(既存のtests/alpha_train_model.js・tests/lib/alpha-features.js を
//    そのまま再利用、独自実装を増やさない)。市場オッズは学習・スコア計算のいずれにも使わない。
// 2. どの入力を使うか: boats配列の系統別順位(そのレース時点のスナップショット値)のみ。艇番・
//    レースIDそのものは特徴量に含めない。確定オッズ・確定結果・後日更新統計は使わない
//    (oddsMapはbackfill_official_results.jsが一切書き換えないことを確認済み
//    〈research_findings_2026-09-01_band50to150_stage_ab_verification.md §1〉のため、
//    予測入力ではなく評価専用として安全に扱える)。
// 3. 以前の不採用モデルと何が実質的に違うか:
//    - GARON-20260901-002(λ較正、市場+3特徴量): モデルを市場とブレンドし、市場のみ(λ=1)が
//      最良と判明。今回はブレンドせず、モデル単独ランキングと市場単独ランキングを別々に構築して
//      比較する(「市場に上乗せできるか」ではなく「モデル単独が市場に劣らないか」を問う)。
//    - GARON-20260910-001方式C(帯制約付き選択): 分位ベースの帯・Q参戦集合に限定した母集団・
//      P×oddsの「推定払戻倍率」で選択(推定2.01倍 vs 実績0.79倍の乖離が判明済み)。今回は
//      固定帯(50-150倍)・Q非依存母集団・モデル確率の順位のみで選択し、P×oddsは使わない。
//      レース選別スコアも複数点合計(点数と交絡することが既に判明済み)ではなく、単一トップ確率
//      (そのレースでモデルが最も自信を持つ1点の確率)を使う。
//    - 市場オッズ昇順基準(GARON-20260901-003一連): 艇特徴量を一切使わない基準。今回はその対極
//      (艇特徴量のみ、市場オッズは点数選定に一切使わない)を独立に構築し、同一条件で比較する。
//    - CEO訂正の踏襲: λ選定結果を「艇情報全般に価値がない証明」とは扱わない/市場スコアの
//      期間差を「非定常」と断定しない/session効果等の不採用理由を検証範囲を超えて一般化しない。
//
// 使い方: node tests/research_model_v6_band50to150_2026-09-02.js

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { isUsable, hasFullData, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs } = require('./engine_alpha_prototype.js');
const { trainWeights, prepareDataset } = require('./alpha_train_model.js');

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const DAILY_CAP = 10;
const TRAIN_LO = '2026-07-01', TRAIN_HI = '2026-07-05';
// 探索的時系列比較区間(学習期間より後、日付順)。08-11〜08-30はGARON-20260910-001方式Cと
// 一部重複するため「モデル形式決定履歴から完全独立ではない」という既存の限界をそのまま引き継ぐ。
// 07-08・08-31は当時未使用だった区間(08-31は本検証で初めて使う最新区間)。
const COMPARE_CLUSTERS = [
  { label: '07-08', lo: '2026-07-08', hi: '2026-07-08' },
  { label: '08-11', lo: '2026-08-11', hi: '2026-08-11' },
  { label: '08-26〜08-30', lo: '2026-08-26', hi: '2026-08-30' },
  { label: '08-31(最新・最も未使用)', lo: '2026-08-31', hi: '2026-08-31' },
];

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMin(s) { if (!s) return null; const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function validOdds(r) { return Object.entries(r.oddsMap || {}).filter(([, v]) => parseFloat(v) > 0); }
function inRange(d, lo, hi) { return d >= lo && d <= hi; }

function buildMarketRecord(r) {
  const entries = validOdds(r);
  if (entries.length !== 120) return { skip: 'INCOMPLETE_ODDS_120' };
  const band = entries.filter(([, v]) => v >= 50 && v <= 150).map(([val, v]) => ({ val, odds: v }));
  if (band.length < POINTS_FIXED) return { skip: 'INSUFFICIENT_BAND_CANDIDATES' };
  const sorted = band.sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  return { skip: null, points: sorted.slice(0, POINTS_FIXED).map(p => p.val) };
}

function buildModelRecord(qEngine, plEngine, w, r) {
  let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { return { skip: 'RANK_ERROR' }; }
  const feat = buildFeatures(r.boats, ranks);
  const scores = feat.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
  const scoreMap = {}; r.boats.forEach((b, i) => { scoreMap[String(b.no)] = scores[i]; });
  let comboProbs; try { comboProbs = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { return { skip: 'PL_ERROR' }; }
  const entries = validOdds(r);
  if (entries.length !== 120) return { skip: 'INCOMPLETE_ODDS_120' };
  const oddsOf = {}; entries.forEach(([val, v]) => { oddsOf[val] = v; });
  const band = comboProbs.filter(c => oddsOf[c.val] != null && oddsOf[c.val] >= 50 && oddsOf[c.val] <= 150);
  if (band.length < POINTS_FIXED) return { skip: 'INSUFFICIENT_BAND_CANDIDATES' };
  const sortedBand = band.slice().sort((a, b) => (b.p - a.p) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  const topProb = comboProbs.slice().sort((a, b) => b.p - a.p)[0].p; // レース選別スコア(全120通り中のモデル最上位確率、単一値)
  return { skip: null, points: sortedBand.slice(0, POINTS_FIXED).map(c => c.val), topProb };
}

function evalFlat(pool, pointsField) {
  let hit = 0, bandHit = 0, migratedOutHit = 0, stake = 0, payout = 0;
  const dayHitMap = {};
  for (const r of pool) {
    const pts = r[pointsField];
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isBandHit = isHit && isResultBand;
    stake += pts.length * FLAT_STAKE;
    if (isHit) payout += Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    if (isHit) hit++;
    if (isBandHit) { bandHit++; dayHitMap[r.date] = true; }
    if (isHit && !isResultBand) migratedOutHit++;
  }
  const n = pool.length;
  return { n, hit, bandHit, migratedOutHit, stake, payout, roi: stake ? payout / stake * 100 : null, dayHitMap };
}

function applyDailyCap(pool) {
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  const dates = Object.keys(byDate).sort();
  const selected = []; const perDay = {};
  for (const date of dates) {
    const dayRaces = byDate[date].slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP);
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates };
}

function main() {
  console.log('=== GARON-20260901-003 継続: Q非依存の予測候補(PL多項ロジット) vs 市場オッズ昇順基準(2026-09-02) ===\n');
  console.log('【明記】全て既存アーカイブのみを使用。新しい外部取得・AI/API呼び出しは行っていない。探索的時系列比較。\n');

  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  const full = usable.filter(hasFullData);
  full.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));

  console.log('=== 1. データの役割別確認 ===');
  console.log('着順学習用(isUsable && hasFullData) n=', full.length);
  const dates = [...new Set(full.map(r => r.date))].sort();
  console.log('日付範囲:', dates[0], '〜', dates[dates.length - 1], ' 日数=', dates.length);
  const full120 = full.filter(r => validOdds(r).length === 120);
  console.log('うち帯・ROI評価可能(全120通り有効オッズ) n=', full120.length, '(', (full120.length / full.length * 100).toFixed(1), '%)');
  console.log('※本検証は評価専用にoddsMapを使う(学習には一切使わない)。oddsMapはbackfillで書き換わらないことを確認済みのため、締切前オッズの厳密な取得時刻分類〈真T-10〉は今回は要求しない(点数選定は学習済み特徴量またはoddsMapの値のみに基づき、確定結果を一切参照しないため)。\n');

  const train = full.filter(r => inRange(r.date, TRAIN_LO, TRAIN_HI));
  console.log(`学習期間(${TRAIN_LO}〜${TRAIN_HI}) n=`, train.length);

  console.log('\n=== 2. 学習(多項ロジット回帰、既存の学習ループ・ハイパーパラメータをそのまま再利用) ===');
  const trainSet = prepareDataset(qEngine, train);
  const w = trainWeights(trainSet, FEATURE_NAMES.length);
  console.log('学習された重み:'); FEATURE_NAMES.forEach((name, i) => console.log(`  ${name}: ${w[i].toFixed(3)}`));

  // ===== レコード構築(学習期間・比較期間とも) =====
  function buildRecords(races) {
    const out = [];
    for (const r of races) {
      const market = buildMarketRecord(r);
      const model = buildModelRecord(qEngine, plEngine, w, r);
      out.push({
        date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: shimekiriMin(r.shimekiri),
        chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
        marketSkip: market.skip, marketPoints: market.points,
        modelSkip: model.skip, modelPoints: model.points, topProb: model.topProb,
      });
    }
    return out;
  }
  const trainRecords = buildRecords(train);

  // ===== 3. レース選別スコアの閾値を機械的決定(学習期間のみ、的中・payout・ROI不使用) =====
  console.log('\n=== 3. モデルのレース選別スコア(topProb)閾値の機械的決定 ===');
  const trainModelPool = trainRecords.filter(r => !r.modelSkip);
  const trainDaysCount = [...new Set(train.map(r => r.date))].length;
  const target = DAILY_CAP * trainDaysCount;
  const sortedTopProb = trainModelPool.map(r => r.topProb).sort((a, b) => b - a);
  const rankIdx = Math.min(target, sortedTopProb.length) - 1;
  const THRESHOLD = sortedTopProb[Math.max(0, rankIdx)];
  console.log('学習期間の帯内候補確保レース n=', trainModelPool.length, ' 目標通過数=', DAILY_CAP, '件/日×', trainDaysCount, '日=', target);
  console.log('THRESHOLD(topProb) =', THRESHOLD.toFixed(4));
  const trainPass = trainModelPool.filter(r => r.topProb >= THRESHOLD).length;
  console.log('この閾値で学習期間が実際に通過する件数(上限適用前) =', trainPass, '(', (trainPass / trainDaysCount).toFixed(1), '件/日)');

  // ===== 4-1. 買い目順位付けの差(同一レース集合、帯内8点、100円固定、上限なし) =====
  console.log('\n=== 4-1. 買い目順位付けの差(同一レース集合、帯内8点、100円固定、選別なし) ===');
  for (const cl of COMPARE_CLUSTERS) {
    const races = full.filter(r => inRange(r.date, cl.lo, cl.hi));
    const recs = buildRecords(races);
    const both = recs.filter(r => !r.marketSkip && !r.modelSkip); // 両方式とも帯内8点を構成できるレースの積集合
    const marketRes = evalFlat(both, 'marketPoints');
    const modelRes = evalFlat(both, 'modelPoints');
    console.log(`[${cl.label}] 母集団=${races.length} 両方式構成可能(積集合)n=${both.length}`);
    if (both.length) {
      console.log(`  市場基準: 帯内的中${marketRes.bandHit}/${marketRes.n}=${(marketRes.bandHit / marketRes.n * 100).toFixed(2)}% 全的中${marketRes.hit} ROI${marketRes.roi.toFixed(1)}%`);
      console.log(`  モデル  : 帯内的中${modelRes.bandHit}/${modelRes.n}=${(modelRes.bandHit / modelRes.n * 100).toFixed(2)}% 全的中${modelRes.hit} ROI${modelRes.roi.toFixed(1)}%`);
      let onlyModel = 0, onlyMarket = 0, bothHit = 0;
      for (const r of both) {
        const hm = r.chakuju && r.modelPoints.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
        const hk = r.chakuju && r.marketPoints.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
        if (hm && hk) bothHit++; else if (hm) onlyModel++; else if (hk) onlyMarket++;
      }
      console.log(`  帯内的中の内訳: モデルだけ=${onlyModel} 市場だけ=${onlyMarket} 両方=${bothHit}`);
    }
  }

  // 全比較期間集計(積集合)
  const allCompare = full.filter(r => COMPARE_CLUSTERS.some(cl => inRange(r.date, cl.lo, cl.hi)));
  const allCompareRecs = buildRecords(allCompare);
  const allBoth = allCompareRecs.filter(r => !r.marketSkip && !r.modelSkip);
  const allMarketRes = evalFlat(allBoth, 'marketPoints');
  const allModelRes = evalFlat(allBoth, 'modelPoints');
  console.log(`\n[全比較期間合計] 積集合n=${allBoth.length}`);
  console.log(`  市場基準: 帯内的中${allMarketRes.bandHit}/${allMarketRes.n}=${(allMarketRes.bandHit / allMarketRes.n * 100).toFixed(2)}% 全的中${allMarketRes.hit} ROI${allMarketRes.roi.toFixed(1)}%`);
  console.log(`  モデル  : 帯内的中${allModelRes.bandHit}/${allModelRes.n}=${(allModelRes.bandHit / allModelRes.n * 100).toFixed(2)}% 全的中${allModelRes.hit} ROI${allModelRes.roi.toFixed(1)}%`);

  // ===== 4-2. 参入判断+日次上限を含めた運用成績(全比較期間、締切順・水増しなし) =====
  console.log('\n=== 4-2. 参入判断+日次上限10件を含めた運用成績(全比較期間まとめ) ===');
  const marketPool = allCompareRecs.filter(r => !r.marketSkip);
  const modelCandidatePool = allCompareRecs.filter(r => !r.modelSkip);
  const modelPassPool = modelCandidatePool.filter(r => r.topProb >= THRESHOLD);

  const capMarket = applyDailyCap(marketPool); // 市場基準: 帯内候補あり→締切順→上限10件(閾値なし、既存min-spec baselineと同一設計)
  const capModel = applyDailyCap(modelPassPool); // モデル: 帯内候補あり かつ topProb>=閾値→締切順→上限10件

  const resMarket = evalFlat(capMarket.selected, 'marketPoints');
  const resModel = evalFlat(capModel.selected, 'modelPoints');

  console.log('--- 市場基準(帯内候補あり→締切順1日10件、参入スコアなし) ---');
  console.log(`n=${resMarket.n} 日数=${capMarket.dates.length} 1日平均=${(resMarket.n / capMarket.dates.length).toFixed(1)}`);
  console.log(`帯内的中率=${(resMarket.bandHit / resMarket.n * 100).toFixed(2)}%(${resMarket.bandHit}件) 全的中率=${(resMarket.hit / resMarket.n * 100).toFixed(2)}% ROI=${resMarket.roi.toFixed(1)}%`);
  console.log(`無的中日数=${capMarket.dates.filter(d => !resMarket.dayHitMap[d]).length}/${capMarket.dates.length} 帯外移動的中=${resMarket.migratedOutHit}`);
  console.log('日別:', capMarket.dates.map(d => `${d}:${capMarket.perDay[d].selectedCount}(候補${capMarket.perDay[d].poolCount})`).join('  '));

  console.log('\n--- モデル(帯内候補あり かつ topProb>=閾値→締切順1日10件) ---');
  console.log(`n=${resModel.n} 日数=${capModel.dates.length} 1日平均=${(resModel.n / Math.max(1, capModel.dates.length)).toFixed(1)}`);
  if (resModel.n) {
    console.log(`帯内的中率=${(resModel.bandHit / resModel.n * 100).toFixed(2)}%(${resModel.bandHit}件) 全的中率=${(resModel.hit / resModel.n * 100).toFixed(2)}% ROI=${resModel.roi.toFixed(1)}%`);
    console.log(`無的中日数=${capModel.dates.filter(d => !resModel.dayHitMap[d]).length}/${capModel.dates.length} 帯外移動的中=${resModel.migratedOutHit}`);
  }
  console.log('日別:', capModel.dates.map(d => `${d}:${capModel.perDay[d].selectedCount}(候補${capModel.perDay[d].poolCount})`).join('  '));

  // ===== 4-3. 切り分け: モデルの点選択を「市場と同じ選別方式(閾値なし・帯内候補のみ)」に適用 =====
  // 4-1(点選択のみの差)と4-2(参入スコア込み)の差が「点の選び方」由来か「参入スコア」由来かを
  // 分離するための追加比較(結果を見た事後調整ではなく、原因切り分けのための3本目の腕)。
  console.log('\n=== 4-3. 切り分け: モデルの点選択+市場と同じ選別方式(帯内候補のみ、topProb閾値なし) ===');
  const capModelNoThreshold = applyDailyCap(modelCandidatePool);
  const resModelNoThreshold = evalFlat(capModelNoThreshold.selected, 'modelPoints');
  console.log(`n=${resModelNoThreshold.n} 日数=${capModelNoThreshold.dates.length} 1日平均=${(resModelNoThreshold.n / capModelNoThreshold.dates.length).toFixed(1)}`);
  console.log(`帯内的中率=${(resModelNoThreshold.bandHit / resModelNoThreshold.n * 100).toFixed(2)}%(${resModelNoThreshold.bandHit}件) 全的中率=${(resModelNoThreshold.hit / resModelNoThreshold.n * 100).toFixed(2)}% ROI=${resModelNoThreshold.roi.toFixed(1)}%`);
  console.log('日別:', capModelNoThreshold.dates.map(d => `${d}:${capModelNoThreshold.perDay[d].selectedCount}(候補${capModelNoThreshold.perDay[d].poolCount})`).join('  '));
  console.log('→ この結果が市場基準(4-2)に近ければ問題は「参入スコア(topProb閾値)」側、4-2のモデル結果に近ければ「点選択」側にあることを示す参考情報。');

  console.log('\n=== 目標(10本前後・帯内的中率20%)との差 ===');
  console.log(`市場基準: 1日平均${(resMarket.n / capMarket.dates.length).toFixed(1)}本 帯内的中率${(resMarket.bandHit / resMarket.n * 100).toFixed(2)}%(差${(20 - resMarket.bandHit / resMarket.n * 100).toFixed(1)}pt)`);
  if (resModel.n) console.log(`モデル  : 1日平均${(resModel.n / Math.max(1, capModel.dates.length)).toFixed(1)}本 帯内的中率${(resModel.bandHit / resModel.n * 100).toFixed(2)}%(差${(20 - resModel.bandHit / resModel.n * 100).toFixed(1)}pt)`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    scopeNote: '既存アーカイブのみ使用。新規外部取得・AI/API呼び出しなし。探索的時系列比較(08-11〜08-30はモデル形式決定履歴と一部重複、08-31が最も未使用)。',
    weights: FEATURE_NAMES.reduce((o, name, i) => { o[name] = w[i]; return o; }, {}),
    trainCount: train.length, trainDaysCount, threshold: THRESHOLD, trainPassCount: trainPass,
    dataRoles: { fullDataCount: full.length, full120Count: full120.length },
    step4_1_pureRanking: { allCompareN: allBoth.length, market: allMarketRes, model: allModelRes },
    step4_2_withEntryScore: { market: { ...resMarket, dayHitMap: undefined, days: capMarket.dates.length }, model: { ...resModel, dayHitMap: undefined, days: capModel.dates.length } },
    step4_3_modelPointsNoThreshold: { ...resModelNoThreshold, dayHitMap: undefined, days: capModelNoThreshold.dates.length },
  };
  const fs = require('fs');
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_model_v6_band50to150_2026-09-02.json'), JSON.stringify(manifest, null, 2));
  console.log('\n結果を logs/research_model_v6_band50to150_2026-09-02.json へ保存しました。');

  return { w, THRESHOLD, allMarketRes, allModelRes, resMarket, resModel, resModelNoThreshold };
}

if (require.main === module) main();
module.exports = { main, buildMarketRecord, buildModelRecord, evalFlat, applyDailyCap };
