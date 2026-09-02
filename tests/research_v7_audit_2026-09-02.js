'use strict';
// GARON-20260901-003 継続、CEO指示(2026-09-02): v7が「小さい評価対象」になった理由の限定照合。
// 新しい学習・特徴量探索は一切行わない。v6/v7の既存関数をそのままrequireし、突合・件数追跡のみ行う。
// 研究用の監査コードであり、v6/v7のモデル・重み・特徴量・閾値には一切触れない。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { isUsable, hasFullData, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { trainWeights: trainPLWeights, prepareDataset } = require('./alpha_train_model.js');
const v7 = require('./research_direct_target_model_v7_2026-09-02.js');

const ROOT = path.join(__dirname, '..');
const DAILY_CAP = 10;
const FLAT_STAKE = 100;
const PL_TRAIN_LO = '2026-07-01', PL_TRAIN_HI = '2026-07-05';
const V6_COMPARE_DATES = ['2026-07-08', '2026-08-11', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'];
const T10_DATES = ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'];
const V7_FOLDS = [
  { trainLo: '2026-08-26', trainHi: '2026-08-28', evalDate: '2026-08-29' },
  { trainLo: '2026-08-26', trainHi: '2026-08-29', evalDate: '2026-08-30' },
  { trainLo: '2026-08-26', trainHi: '2026-08-30', evalDate: '2026-08-31' },
];

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMin(s) { if (!s) return null; const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function inRange(d, lo, hi) { return d >= lo && d <= hi; }
function classifyTiming(r) {
  if (!r.archivedAt) return 'unknown';
  const archJST = new Date(new Date(r.archivedAt).getTime() + 9 * 3600 * 1000);
  const archDateJST = archJST.toISOString().slice(0, 10);
  const archMinJST = archJST.getUTCHours() * 60 + archJST.getUTCMinutes();
  const sMin = shimekiriMin(r.shimekiri);
  if (archDateJST === r.date && sMin != null) {
    const diff = sMin - archMinJST;
    if (diff >= 0 && diff <= 20) return 'true';
  }
  return 'unknown';
}
function raceKey(r) { return `${r.date}_${r.venue}_${r.racenum}`; }
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

console.log('=== v7監査(2026-09-02): 評価対象が小さくなった理由の限定照合 ===\n');
console.log('【明記】新しい学習・特徴量探索なし。v6/v7の既存関数をそのまま再利用し、突合のみ行う。\n');

const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

const all = loadAllRaces();
console.log('=== 1. 件数の流れ(重複なし、各段階の分母を明記) ===');
console.log('(a) 現在のアーカイブ総数(全daikibo_archive_*.jsonの合計レコード数) =', all.length);
const usable = all.filter(isUsable);
console.log('(b) うちisUsable(resulted済み・oddsMapあり・6艇・isJogaiなし・chakujuあり) =', usable.length);
const full = usable.filter(hasFullData);
console.log('(c) うちhasFullData(dashboard.htmlのフルデータ定義と同一) =', full.length);

const trueT10All = usable.filter(r => classifyTiming(r) === 'true'); // isUsable母集団での真T10(hasFullData条件なし)
console.log('(d) isUsable中の締切前オッズ確認済み(真T-10、hasFullData条件なし) =', trueT10All.length);
const trueT10Full = full.filter(r => classifyTiming(r) === 'true'); // v7が使う母集団
console.log('(e) hasFullData∩真T-10(v7の主結果母集団) =', trueT10Full.length, '(', T10_DATES.join(','), 'の6日間のみ)');

const marketOk = trueT10Full.filter(r => !v7.buildMarketRecord(r).skip);
const marketSkipReasons = {};
trueT10Full.forEach(r => { const s = v7.buildMarketRecord(r).skip; if (s) marketSkipReasons[s] = (marketSkipReasons[s] || 0) + 1; });
console.log('(f) (e)のうち帯内8点を生成できる件数 =', marketOk.length, ' 除外理由:', JSON.stringify(marketSkipReasons));

let featureOkCount = 0; const featureFailKeys = [];
const plTrainRaces = full.filter(r => inRange(r.date, PL_TRAIN_LO, PL_TRAIN_HI));
const plSet = prepareDataset(qEngine, plTrainRaces);
const plW = trainPLWeights(plSet, FEATURE_NAMES.length);
for (const r of marketOk) {
  const mk = v7.buildMarketRecord(r);
  const feat = v7.buildFeatureRow(qEngine, plEngine, plW, r, mk);
  if (feat) featureOkCount++; else featureFailKeys.push(raceKey(r));
}
console.log('(g) (f)のうちv7特徴量が利用できる件数(entropy/rank/PL計算とも成功) =', featureOkCount, ' 特徴量失敗 =', featureFailKeys.length, featureFailKeys.length ? '例:' + featureFailKeys.slice(0, 5).join(',') : '');

console.log('\n参照(v7報告記載値の照合): n=498は(e)と一致 =', trueT10Full.length === 498, ' / レコード構築後n=489は(g)と一致 =', featureOkCount === 489);

console.log('\n=== fold別の学習・評価件数、陽性件数 ===');
const t10Records = v7.buildMarketRecord ? null : null; // (実データは下のbuildAllRecords相当をここでも再現)
function buildRecords(races) {
  const out = [];
  for (const r of races) {
    const mk = v7.buildMarketRecord(r);
    if (mk.skip) continue;
    const feat = v7.buildFeatureRow(qEngine, plEngine, plW, r, mk);
    if (!feat) continue;
    const payoutMul = parsePayout100(r.payout) / 100;
    const y = (r.chakuju && mk.points.includes(r.chakuju) && payoutMul >= 50 && payoutMul <= 150) ? 1 : 0;
    out.push({ date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: shimekiriMin(r.shimekiri), chakuju: r.chakuju, payoutMul, marketPoints: mk.points, y });
  }
  return out;
}
const t10Recs = buildRecords(trueT10Full);
for (const fold of V7_FOLDS) {
  const trainRecs = t10Recs.filter(r => inRange(r.date, fold.trainLo, fold.trainHi));
  const evalRecs = t10Recs.filter(r => r.date === fold.evalDate);
  console.log(`[${fold.trainLo}〜${fold.trainHi} → 評価${fold.evalDate}] 学習n=${trainRecs.length}(陽性${trainRecs.filter(r => r.y === 1).length}) 評価n=${evalRecs.length}(陽性${evalRecs.filter(r => r.y === 1).length})`);
}
console.log('評価日の重複チェック: 08-29/08-30/08-31は各foldにつき1回のみ出現(fold設計上、評価日は互いに排他)= true(コード構造上保証)');

// ===== 2. v6の市場基準(73件・帯内8的中)とv7の市場基準(24件・帯内0的中)のレースID突合 =====
console.log('\n=== 2. v6市場基準 vs v7市場基準のレースID突合 ===');
// v6のbuildMarketRecordはbuildRecord(全120通り必須+帯内8点、真T-10フィルタなし)と同一ロジック。
// v7.buildMarketRecordと完全に同一関数(共通化済み)なので、母集団の違い(真T-10フィルタの有無・
// 対象日数)だけを再現すれば良い。
const v6CompareRaces = full.filter(r => V6_COMPARE_DATES.includes(r.date)); // v6は真T-10フィルタなし
function toRecord(r) {
  const mk = v7.buildMarketRecord(r);
  if (mk.skip) return null;
  const payoutMul = parsePayout100(r.payout) / 100;
  return { date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: shimekiriMin(r.shimekiri), chakuju: r.chakuju, payoutMul, marketPoints: mk.points };
}
const v6Pool = v6CompareRaces.map(toRecord).filter(Boolean);
const v6Cap = applyDailyCap(v6Pool);
function isBandHit(r) { return r.chakuju && r.marketPoints.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150; }
const v6Hits = v6Cap.selected.filter(isBandHit);
console.log('v6再現: 発信n=', v6Cap.selected.length, '(元報告73と一致=', v6Cap.selected.length === 73, ') 帯内的中=', v6Hits.length, '(元報告8と一致=', v6Hits.length === 8, ')');
console.log('v6再現の的中レース一覧:', v6Hits.map(r => `${raceKey(r)}(${r.chakuju},${r.payoutMul}倍)`).join(' / '));

// v7側: 真T-10母集団のみ、fold構造(評価日は08-29/08-30/08-31のみ、各日単独capping)
const v7Pool = t10Recs; // 既にbuildMarketRecord+特徴量成功済みのみ
const v7EvalOnly = v7Pool.filter(r => ['2026-08-29', '2026-08-30', '2026-08-31'].includes(r.date));
const v7Cap = applyDailyCap(v7EvalOnly); // fold構造と同じ「評価日は単独」なので一括cappingでも同じ結果になるはず(評価日は互いに他日と競合しない)
const v7Hits = v7Cap.selected.filter(isBandHit);
console.log('\nv7の市場基準(A)再現: 発信n=', v7Cap.selected.length, '(元報告24と一致=', v7Cap.selected.length === 24, ') 帯内的中=', v7Hits.length, '(元報告0と一致=', v7Hits.length === 0, ')');

// v6の8的中それぞれについて、v7側でどう扱われたかを分類
console.log('\n--- v6の帯内的中8件それぞれの追跡 ---');
for (const hit of v6Hits) {
  const key = raceKey(hit);
  let reason;
  if (!T10_DATES.includes(hit.date)) {
    reason = '評価期間外(真T-10の対象日付〈08-26〜08-31〉に含まれない日付)';
  } else {
    // 元データを再取得してtrueT10かどうか確認
    const orig = full.find(r => raceKey(r) === key);
    const timing = orig ? classifyTiming(orig) : 'unknown';
    if (timing !== 'true') {
      reason = '時点不明扱い(締切前確認済み〈真T-10〉の条件を満たさない)';
    } else if (['2026-08-26', '2026-08-27', '2026-08-28'].includes(hit.date)) {
      reason = '学習期間へ移動(v7のfold設計で08-26〜08-28は評価日にならない)';
    } else {
      // 08-29/08-30/08-31のいずれか、真T-10、特徴量も成功しているはずだが選ばれなかった場合
      const inFeatureOk = t10Recs.some(r => raceKey(r) === key);
      if (!inFeatureOk) reason = '特徴量欠損で除外(entropy/rank/PL計算のいずれかが失敗)';
      else {
        const inV7Selected = v7Cap.selected.some(r => raceKey(r) === key);
        reason = inV7Selected ? '(選出されている、要再確認)' : '日次上限による選出変更';
      }
    }
  }
  console.log(`  ${key}(${hit.payoutMul}倍): ${reason}`);
}

// ===== 3. 主比較と運用全体の区別 =====
console.log('\n=== 3. 主比較(共通集合)と運用全体(市場基準が本来発信できる全件)の区別 ===');
console.log('真T-10母集団(hasFullData∩真T-10) n=', trueT10Full.length);
const marketEligibleT10 = trueT10Full.filter(r => !v7.buildMarketRecord(r).skip);
console.log('うち市場基準が帯内8点を生成できる件数(モデルの特徴量条件は問わない) =', marketEligibleT10.length);
const modelIneligible = marketEligibleT10.filter(r => { const mk = v7.buildMarketRecord(r); return !v7.buildFeatureRow(qEngine, plEngine, plW, r, mk); });
console.log('うちモデルが特徴量不足等で対応できない件数(市場基準は発信可能だがモデルは評価不可) =', modelIneligible.length);

const marketFullPotentialPool = marketEligibleT10.map(r => {
  const mk = v7.buildMarketRecord(r);
  const payoutMul = parsePayout100(r.payout) / 100;
  return { date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: shimekiriMin(r.shimekiri), chakuju: r.chakuju, payoutMul, marketPoints: mk.points };
});
const marketFullPotentialCap = applyDailyCap(marketFullPotentialPool); // 真T-10の全6日間(08-26〜08-31)、モデル条件を課さない
const marketFullPotentialHits = marketFullPotentialCap.selected.filter(isBandHit);
console.log('市場基準が真T-10全6日間(モデルの特徴量条件なし)で本来発信できる件数 = n=', marketFullPotentialCap.selected.length, ' 帯内的中=', marketFullPotentialHits.length, '(', (marketFullPotentialHits.length / marketFullPotentialCap.selected.length * 100).toFixed(2), '%)');
console.log('日別:', marketFullPotentialCap.dates.map(d => `${d}:${marketFullPotentialCap.perDay[d].selectedCount}(候補${marketFullPotentialCap.perDay[d].poolCount})`).join('  '));
console.log('【注意】入力不足を中立値で埋める仕様変更はしていない。上記はあくまで「市場基準だけなら」の参考値であり、モデルとの主比較(共通集合)とは明確に区別する。');

console.log('\n=== 5. 結論の判定材料 ===');
console.log('v6市場基準73件・帯内8件の再現一致:', v6Cap.selected.length === 73 && v6Hits.length === 8 ? '完全一致(評価実装に不整合なし)' : '不一致(要調査)');
console.log('v7市場基準24件・帯内0件の再現一致:', v7Cap.selected.length === 24 && v7Hits.length === 0 ? '完全一致(評価実装に不整合なし)' : '不一致(要調査)');
