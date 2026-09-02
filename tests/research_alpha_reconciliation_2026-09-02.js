'use strict';
// GARON-20260902-001 継続、CEO指示(2026-09-02): 前回レビューで誤って適用した「締切順1日10件上限」
// (α本来の仕様には無い)を外し、Codex保存結果(qa_entry_results/qa_volume_results)とレースID単位で
// 照合する。新しい研究・閾値探索は行わない。α側の仕様(8点固定・50-150倍帯・参入閾値1.4402...)は
// 一切変更しない。

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ALPHA_DIR = 'C:\\Users\\ymyin\\AppData\\Local\\Temp\\claude\\C--garon\\a809d265-9097-49b2-b095-410462e81f12\\scratchpad\\alpha_candidate_review\\alpha_handoff_20260902';
const { predict: alphaPredict, ENTRY_THRESHOLD } = require(path.join(ALPHA_DIR, 'alpha.js'));
const CODEX_ENTRY_PATH = 'C:\\Users\\ymyin\\AppData\\Local\\Temp\\claude\\C--garon\\a809d265-9097-49b2-b095-410462e81f12\\scratchpad\\alpha_candidate_review\\raw_candidate\\qa_entry_results\\total_alpha_50_ev0_uniform.json';

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMs(dateStr, shimekiriStr) {
  const m = String(shimekiriStr).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Date.parse(`${dateStr}T${m[1].padStart(2, '0')}:${m[2]}:00.000+09:00`);
}

console.log('=== エンジンα候補: 6.94%訂正・レースID単位照合(2026-09-02) ===\n');

// 前回凍結したスナップショット(内容ハッシュ確認済み、n=1,195)をそのまま使う(再読込しない)
const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_alpha_review_snapshot_2026-09-02.json'), 'utf8'));
console.log('使用データ: logs/research_alpha_review_snapshot_2026-09-02.json');
console.log('  内容ハッシュ =', snap.contentHash, ' 件数 =', snap.count, ' 生成時刻 =', snap.generatedAt);

const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));

// ===== 1. 自分の80件(日次上限なし、α本来の仕様通り)を再計算 =====
const records = [];
for (const r of snap.races) {
  const deadlineMsVal = shimekiriMs(r.date, r.shimekiri);
  const input = { boats: r.boats, oddsMap: r.oddsMap, oddsCapturedAt: r.archivedAt, deadlineAt: new Date(deadlineMsVal).toISOString() };
  const nowMs = Date.parse(r.archivedAt);
  let out; try { out = alphaPredict(input, nowMs); } catch (e) { out = { error: e.message }; }
  const payoutMul = parsePayout100(r.payout) / 100;
  records.push({ key: r.key, date: r.date, venue: r.venue, racenum: r.racenum, chakuju: r.chakuju, payoutMul, alpha: out });
}

const myEntered = records.filter(r => r.alpha && !r.alpha.error && r.alpha.entered);
console.log('\n=== 1. 6.94%の内訳確定(日次上限なし、α本来の仕様のまま) ===');
console.log('対象母集団: 上記スナップショットn=' + snap.count + '(2026-08-21〜08-31)');
console.log('全フィルタ: isUsable ∩ 真T-10(締切前20分以内取得、ミリ秒精度) ∩ 全120通り有効オッズ → α.predict()のentered===true(閾値' + ENTRY_THRESHOLD + '、丸めていない)');
console.log('参入件数(entered===true) n=', myEntered.length);

function computeStats(pool, pointsFn) {
  let hit = 0, band30 = 0, band50 = 0, stake = 0, payout = 0;
  for (const r of pool) {
    const pts = pointsFn(r);
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const in50 = r.payoutMul >= 50 && r.payoutMul <= 150;
    const in30 = r.payoutMul >= 30 && r.payoutMul <= 150;
    stake += pts.length * FLAT_STAKE;
    if (isHit) payout += Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    if (isHit) hit++;
    if (isHit && in50) band50++;
    if (isHit && in30) band30++;
  }
  return { n: pool.length, hit, band30, band50, stake, payout, roi: stake ? payout / stake * 100 : null, band50rate: pool.length ? band50 / pool.length * 100 : null };
}
const myAlphaStats = computeStats(myEntered, r => r.alpha.points.map(p => p.combination));
console.log('自分の再計算結果: 帯内的中/分母 =', myAlphaStats.band50 + '/' + myAlphaStats.n, '=', myAlphaStats.band50rate.toFixed(2) + '%', ' 全的中=', myAlphaStats.hit, ' ROI=', myAlphaStats.roi.toFixed(2) + '%');

// ===== Codex保存結果(qa_entry_results)との照合 =====
console.log('\n=== Codex保存結果(qa_entry_results/total_alpha_50_ev0_uniform.json)との照合 ===');
const codexAll = JSON.parse(fs.readFileSync(CODEX_ENTRY_PATH, 'utf8'));
const codexEntered = codexAll.filter(r => r.estimate >= ENTRY_THRESHOLD);
console.log('Codex側 全件 =', codexAll.length, ' entered(estimate>=閾値) =', codexEntered.length);
function codexStats(arr) {
  const n = arr.length, hit = arr.filter(r => r.hit).length, band50 = arr.filter(r => r.band50).length, band30 = arr.filter(r => r.band30).length;
  const stake = arr.reduce((s, r) => s + r.stake, 0), payout = arr.reduce((s, r) => s + r.payout, 0); // payoutフィールド(hit時のみ非ゼロ)を使用。payoutYenは的中有無に関わらず参考値のため使わない
  return { n, hit, band30, band50, stake, payout, roi: stake ? payout / stake * 100 : null, band50rate: n ? band50 / n * 100 : null };
}
const codexStatsResult = codexStats(codexEntered);
console.log('Codex側集計(payoutフィールド使用): 帯内的中/分母 =', codexStatsResult.band50 + '/' + codexStatsResult.n, '=', codexStatsResult.band50rate.toFixed(2) + '%', ' 全的中=', codexStatsResult.hit, ' ROI=', codexStatsResult.roi.toFixed(2) + '%');
console.log('CEO引用値(参入80・全的中15・帯内的中7=8.75%・ROI159.77%)との一致:', codexEntered.length === 80 && codexStatsResult.hit === 15 && codexStatsResult.band50 === 7 && Math.abs(codexStatsResult.roi - 159.77) < 0.01);

// レースID単位の差分
const myKeys = new Set(myEntered.map(r => r.key));
const codexKeys = new Set(codexEntered.map(r => r.key));
const onlyMine = [...myKeys].filter(k => !codexKeys.has(k));
const onlyCodex = [...codexKeys].filter(k => !myKeys.has(k));
const common = [...myKeys].filter(k => codexKeys.has(k));
console.log('\nレースID単位の差分: 共通 =', common.length, ' 自分のみ =', onlyMine.length, ' Codexのみ =', onlyCodex.length);
if (onlyMine.length) console.log('  自分のみの内訳:', JSON.stringify(onlyMine));
if (onlyCodex.length) console.log('  Codexのみの内訳:', JSON.stringify(onlyCodex));

// 共通レースで点数・estimate・hit/band50が一致するか
let pointsMismatch = 0, estimateMismatch = 0, hitMismatch = 0, band50Mismatch = 0;
for (const key of common) {
  const mine = myEntered.find(r => r.key === key);
  const cx = codexEntered.find(r => r.key === key);
  const minePts = mine.alpha.points.map(p => p.combination).slice().sort();
  const cxPts = cx.points.slice().sort();
  if (JSON.stringify(minePts) !== JSON.stringify(cxPts)) pointsMismatch++;
  if (Math.abs(mine.alpha.estimatedReturn - cx.estimate) > 1e-6) estimateMismatch++;
  const mineHit = mine.chakuju && minePts.includes(mine.chakuju);
  if (!!mineHit !== !!cx.hit) hitMismatch++;
  const mineBand50 = mineHit && mine.payoutMul >= 50 && mine.payoutMul <= 150;
  if (!!mineBand50 !== !!cx.band50) band50Mismatch++;
}
console.log('共通レースでの内容一致確認: points不一致=', pointsMismatch, ' estimate不一致=', estimateMismatch, ' hit不一致=', hitMismatch, ' band50不一致=', band50Mismatch);

// ===== 2. 比較目的の分離: 同じα参入80件での市場オッズ昇順8点 =====
console.log('\n=== 2. 同一レース(α参入80件)での市場オッズ昇順8点比較 ===');
function buildMarketBand8FromSnap(rRaw) {
  const entries = Object.entries(rRaw.oddsMap || {}).filter(([, v]) => parseFloat(v) > 0);
  const band = entries.filter(([, v]) => v >= 50 && v <= 150).map(([val, v]) => ({ val, odds: v }));
  if (band.length < 8) return null;
  const sorted = band.slice().sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  return sorted.slice(0, 8).map(p => p.val);
}
const snapByKey = new Map(snap.races.map(r => [r.key, r]));
const marketOnMyEntered = myEntered.map(r => ({ ...r, marketPts: buildMarketBand8FromSnap(snapByKey.get(r.key)) })).filter(r => r.marketPts);
console.log('α参入80件のうち市場側も帯内8点を構成できる件数 =', marketOnMyEntered.length, '/', myEntered.length);
const marketStats = computeStats(marketOnMyEntered, r => r.marketPts);
console.log('市場オッズ昇順8点(α参入と同一レース集合): 帯内的中/分母=', marketStats.band50 + '/' + marketStats.n, '=', (marketStats.band50rate || 0).toFixed(2) + '%', ' 全的中=', marketStats.hit, ' ROI=', (marketStats.roi || 0).toFixed(2) + '%');
console.log('CEO引用値(市場全的中8件・帯内的中2件=2.50%・ROI65.47%)との一致:', marketStats.n === 80 && marketStats.hit === 8 && marketStats.band50 === 2 && Math.abs(marketStats.roi - 65.47) < 0.01);

console.log('\n=== 参考: 市場基準の独立した運用ベースライン(締切順・1日10件上限、α参入80件とは別集合) ===');
console.log('前回report記載のn=103・帯内的中率10.68%は、"α参入80件"とは異なる母集団(市場基準自身の参入条件〈帯内候補あり〉+締切順1日10件上限を適用した独立集合)であり、同一レース上での買い目選択比較(今回の2.50%)とは目的が異なる運用ベースラインの数字である。両者を混同しない。');

const manifest = {
  generatedAt: new Date().toISOString(),
  scopeNote: '新しい研究・閾値探索なし。前回の誤り(α本来の仕様に無い締切順1日10件上限を適用していた)を修正し、日次上限なしで再計算。Codex保存結果とレースID単位で照合。',
  snapshotUsed: { contentHash: snap.contentHash, count: snap.count, generatedAt: snap.generatedAt },
  myRecalculation: { entryThreshold: ENTRY_THRESHOLD, ...myAlphaStats },
  codexSaved: { entryThreshold: ENTRY_THRESHOLD, ...codexStatsResult, matchesCeoQuote: codexEntered.length === 80 && codexStatsResult.hit === 15 && codexStatsResult.band50 === 7 },
  idDiff: { commonCount: common.length, onlyMineCount: onlyMine.length, onlyCodexCount: onlyCodex.length, onlyMine, onlyCodex },
  contentDiffOnCommon: { pointsMismatch, estimateMismatch, hitMismatch, band50Mismatch },
  marketOnAlphaEnteredRaces: { n: marketOnMyEntered.length, ...marketStats, matchesCeoQuote: marketStats.n === 80 && marketStats.hit === 8 && marketStats.band50 === 2 },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_alpha_reconciliation_2026-09-02.json'), JSON.stringify(manifest, null, 2));
console.log('\n結果を logs/research_alpha_reconciliation_2026-09-02.json へ保存しました。');
