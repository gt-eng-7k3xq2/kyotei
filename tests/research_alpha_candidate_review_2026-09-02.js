'use strict';
// GARON-20260901-003 継続、CEO承認(2026-09-02): Codex提供のエンジンα候補パッケージについて、
// コード精査(別途完了)を踏まえた最新データでの比較・差分照合。通知なし。本番Q・通知・原本は変更しない。
// αのモデル・8点・50-150倍帯・参入閾値(1.440209615716716、丸めない)は一切変更しない。

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadAllRaces, isUsable } = require('./q_engine_entry_backtest.js');

const ALPHA_DIR = 'C:\\Users\\ymyin\\AppData\\Local\\Temp\\claude\\C--garon\\a809d265-9097-49b2-b095-410462e81f12\\scratchpad\\alpha_candidate_review\\alpha_handoff_20260902';
const { predict: alphaPredict, ENTRY_THRESHOLD } = require(path.join(ALPHA_DIR, 'alpha.js'));

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const DAILY_CAP = 10;

function hashObj(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMs(dateStr, shimekiriStr) {
  const m = String(shimekiriStr).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${dateStr}T${m[1].padStart(2, '0')}:${m[2]}:00.000+09:00`);
  return isNaN(ms) ? null : ms;
}
function classifyTimingFixed(r) {
  if (!r.archivedAt) return { cls: 'unknown', diffMs: null };
  const archMs = Date.parse(r.archivedAt);
  if (isNaN(archMs)) return { cls: 'unknown', diffMs: null };
  const deadlineMs = shimekiriMs(r.date, r.shimekiri);
  if (deadlineMs == null) return { cls: 'unknown', diffMs: null };
  const diffMs = deadlineMs - archMs;
  if (diffMs > 0 && diffMs <= 20 * 60 * 1000) return { cls: 'true', diffMs };
  return { cls: 'unknown', diffMs };
}
function validOdds(r) { return Object.entries(r.oddsMap || {}).filter(([, v]) => parseFloat(v) > 0); }

console.log('=== エンジンα候補の最新データ比較・差分照合(2026-09-02) ===\n');

// ===== 2. 最新データを一度だけ読み取り、研究用コピーを固定 =====
const loadedAt = new Date().toISOString();
const all = loadAllRaces();
console.log('データ読込完了(loadedAt=' + loadedAt + ')、以降このスナップショットのみ使用。総数=', all.length);

const usable = all.filter(isUsable);
const { hasFullData } = require('./q_engine_entry_backtest.js');
const fullDataCount = usable.filter(hasFullData).length;
console.log('参考: ダッシュボード「完全」定義(isUsable&&hasFullData)での件数 =', fullDataCount, '(検証にそのまま使える、レビュー対象はこれに限定しない)');

const eligible = usable.filter(r => classifyTimingFixed(r).cls === 'true' && validOdds(r).length === 120);
console.log('レビュー対象(αが必要な入力を扱える保存済みレース: isUsable ∩ 真T-10 ∩ 全120通り有効オッズ) n=', eligible.length);
const dates = [...new Set(eligible.map(r => r.date))].sort();
console.log('日付範囲:', dates[0], '〜', dates[dates.length - 1], '(', dates.length, '日間)');
console.log('日別件数:', dates.map(d => d + ':' + eligible.filter(r => r.date === d).length).join(' '));

const snapshot = eligible.map(r => ({ key: `${r.date}_${r.venue}_${r.racenum}`, date: r.date, venue: r.venue, racenum: r.racenum, boats: r.boats, oddsMap: r.oddsMap, chakuju: r.chakuju, payout: r.payout, resulted: r.resulted, shimekiri: r.shimekiri, archivedAt: r.archivedAt }));
const snapshotHash = hashObj(snapshot);
fs.writeFileSync(path.join(ROOT, 'logs', 'research_alpha_review_snapshot_2026-09-02.json'), JSON.stringify({ generatedAt: loadedAt, contentHash: snapshotHash, count: snapshot.length, races: snapshot }));
console.log('研究用スナップショットを凍結保存(logs/research_alpha_review_snapshot_2026-09-02.json)。内容ハッシュ=', snapshotHash);

// ===== 3. 提供済み評価データ(v9_frozen_eval、1214件)との差分照合 =====
console.log('\n=== 3. 提供済み評価データとの差分照合 ===');
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v9_frozen_eval_2026-09-02.json'), 'utf8'));
const refByKey = new Map(reference.races.map(r => [r.key, r]));
const snapByKey = new Map(snapshot.map(r => [r.key, r]));

let sameIdSameContent = 0, sameIdChanged = 0;
const changedDetails = [];
for (const [key, refRace] of refByKey) {
  const cur = snapByKey.get(key);
  if (!cur) continue; // 現在の対象から消えたケース(下で別集計)
  const refH = hashObj({ boats: refRace.boats, oddsMap: refRace.oddsMap, chakuju: refRace.chakuju, payout: refRace.payout, shimekiri: refRace.shimekiri, archivedAt: refRace.archivedAt });
  const curH = hashObj({ boats: cur.boats, oddsMap: cur.oddsMap, chakuju: cur.chakuju, payout: cur.payout, shimekiri: cur.shimekiri, archivedAt: cur.archivedAt });
  if (refH === curH) sameIdSameContent++; else { sameIdChanged++; changedDetails.push(key); }
}
const missingFromCurrent = [...refByKey.keys()].filter(k => !snapByKey.has(k));
const newIds = [...snapByKey.keys()].filter(k => !refByKey.has(k));
const TRAIN_HI_EXCLUSIVE = '2026-08-21';
const newIdsInTrainPeriod = newIds.filter(k => k.split('_')[0] < TRAIN_HI_EXCLUSIVE);
const newIdsAfterRefWindow = newIds.filter(k => k.split('_')[0] > '2026-08-31');
const newIdsWithinRefWindow = newIds.filter(k => k.split('_')[0] >= TRAIN_HI_EXCLUSIVE && k.split('_')[0] <= '2026-08-31');

console.log('参照データ件数(v9_frozen_eval) =', reference.races.length);
console.log('同一ID・内容一致 =', sameIdSameContent);
console.log('同一ID・内容変更 =', sameIdChanged, changedDetails.length ? '(' + changedDetails.slice(0, 5).join(', ') + (changedDetails.length > 5 ? ' 等' : '') + ')' : '');
console.log('参照にあったが現在の対象から消えた件数 =', missingFromCurrent.length);
console.log('新規ID合計 =', newIds.length);
console.log('  うち学習期間内(date<' + TRAIN_HI_EXCLUSIVE + ', 学習用途であり未使用評価ではない) =', newIdsInTrainPeriod.length);
console.log('  うち評価期間内(2026-08-21〜08-31、参照ファイル生成後に真T-10へ新規参入した分) =', newIdsWithinRefWindow.length);
console.log('  うち評価期間より後(2026-09-01以降、真に未使用の新規評価候補) =', newIdsAfterRefWindow.length, newIdsAfterRefWindow.length ? JSON.stringify(newIdsAfterRefWindow.slice(0, 10)) : '');
console.log('→ 件数増加だけをもって「未使用評価データが増えた」とは呼ばない。日付区分ごとの内訳を上記の通り分離した。');

// ===== 4. Q・α・市場基準の比較 =====
console.log('\n=== 4. 固定したQ・α・市場基準の比較 ===');
const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));

function buildMarketBand8(r) {
  const entries = validOdds(r);
  const band = entries.filter(([, v]) => v >= 50 && v <= 150).map(([val, v]) => ({ val, odds: v }));
  if (band.length < POINTS_FIXED) return null;
  const sorted = band.slice().sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  return sorted.slice(0, POINTS_FIXED).map(p => p.val);
}
function buildQRecord(r) {
  let bets; try { bets = qEngine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { return null; }
  const axisBoat = bets.axes && bets.axes[0] ? bets.axes[0].boat : null;
  const qPts = [...new Set((bets.formations || []).flatMap(f => f.points || []))];
  const oddsOf = {}; validOdds(r).forEach(([val, v]) => { oddsOf[val] = v; });
  const bandPts = qPts.filter(p => oddsOf[p] != null && oddsOf[p] >= 50 && oddsOf[p] <= 150);
  const bandSorted = bandPts.slice().sort((a, b) => (oddsOf[a] - oddsOf[b]) || (a < b ? -1 : a > b ? 1 : 0));
  const band8 = bandSorted.length >= POINTS_FIXED ? bandSorted.slice(0, POINTS_FIXED) : null; // 8点未満は「同一投資額」比較の対象外
  return {
    entered: bets.judge.entered, axisBoat, gap: bets.gap,
    band8, bandAll: bandSorted, // bandAll: Q自身の参入条件比較で使う(8点に切り詰めない)
  };
}
function buildAlphaRecord(r) {
  const deadlineIso = new Date(shimekiriMs(r.date, r.shimekiri)).toISOString();
  const input = { boats: r.boats, oddsMap: r.oddsMap, oddsCapturedAt: r.archivedAt, deadlineAt: deadlineIso };
  const nowMs = Date.parse(r.archivedAt); // 実際の取得直後に判定したものとして再現(締切前・取得後の妥当な時点)
  let out; try { out = alphaPredict(input, nowMs); } catch (e) { return { error: e.message }; }
  return out;
}

const records = [];
for (const r of eligible) {
  const marketBand8 = buildMarketBand8(r);
  const q = buildQRecord(r);
  const alpha = buildAlphaRecord(r);
  records.push({
    date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMs: shimekiriMs(r.date, r.shimekiri),
    chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
    marketBand8, q, alpha,
  });
}
const alphaErrors = records.filter(r => r.alpha && r.alpha.error);
if (alphaErrors.length) console.log('αでエラーが出たレース数(異常終了、点数なし扱い) =', alphaErrors.length, JSON.stringify(alphaErrors.slice(0, 3)));
const alphaSkipReasons = {};
records.forEach(r => { if (r.alpha && !r.alpha.error && r.alpha.points.length === 0) alphaSkipReasons[r.alpha.reason] = (alphaSkipReasons[r.alpha.reason] || 0) + 1; });
console.log('αが0点を返した理由の内訳:', JSON.stringify(alphaSkipReasons));

function evalFlat(pool, pointsFn) {
  let hit = 0, band30 = 0, band50 = 0, migratedOutHit = 0, stake = 0, payout = 0;
  const dayHitMap = {}; const seq = [];
  for (const r of pool) {
    const pts = pointsFn(r);
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const in50_150 = r.payoutMul >= 50 && r.payoutMul <= 150;
    const in30_150 = r.payoutMul >= 30 && r.payoutMul <= 150;
    stake += pts.length * FLAT_STAKE;
    if (isHit) payout += Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    if (isHit) hit++;
    if (isHit && in50_150) { band50++; dayHitMap[r.date] = true; }
    if (isHit && in30_150) band30++;
    if (isHit && !in50_150) migratedOutHit++;
    seq.push((isHit && in50_150) ? 1 : 0);
  }
  const n = pool.length;
  let maxStreak = 0, cur = 0;
  for (const s of seq) { if (s === 0) { cur++; maxStreak = Math.max(maxStreak, cur); } else cur = 0; }
  return { n, hit, band30, band50, migratedOutHit, stake, payout, roi: stake ? payout / stake * 100 : null, dayHitMap, maxStreak };
}
function applyDailyCap(pool) {
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  const dArr = Object.keys(byDate).sort();
  const selected = []; const perDay = {};
  for (const date of dArr) {
    const dayRaces = byDate[date].slice().sort((a, b) => (a.shimekiriMs ?? 0) - (b.shimekiriMs ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP);
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates: dArr };
}
function report(label, res, days) {
  console.log(`[${label}] n=${res.n} 日数=${days} 1日平均=${(res.n / Math.max(1, days)).toFixed(1)}`);
  console.log(`  全的中率=${res.n ? (res.hit / res.n * 100).toFixed(2) : '-'}% 30-150倍的中率=${res.n ? (res.band30 / res.n * 100).toFixed(2) : '-'}% 50-150倍的中率=${res.n ? (res.band50 / res.n * 100).toFixed(2) : '-'}%`);
  console.log(`  ROI=${res.roi != null ? res.roi.toFixed(1) : '-'}% 帯外移動的中=${res.migratedOutHit} 最大連敗=${res.maxStreak}`);
}

// ---- 4-1. 同一レース・同一投資額(積集合、帯内8点・100円均等、選別なし) ----
console.log('\n--- 4-1. 同一レース・同一投資額(3方式とも帯内8点を構成できるレースの積集合、選別なし) ---');
const commonPool = records.filter(r => r.marketBand8 && r.q.band8 && r.alpha && !r.alpha.error && r.alpha.points.length === 8);
console.log('積集合 n=', commonPool.length, '(全体', eligible.length, '中)');
const marketCommon = evalFlat(commonPool, r => r.marketBand8);
const qCommon = evalFlat(commonPool, r => r.q.band8);
const alphaCommon = evalFlat(commonPool, r => r.alpha.points.map(p => p.combination));
report('市場基準(積集合)', marketCommon, [...new Set(commonPool.map(r => r.date))].length);
report('Q固定(積集合、band8=帯内オッズ昇順8点)', qCommon, [...new Set(commonPool.map(r => r.date))].length);
report('α候補(積集合)', alphaCommon, [...new Set(commonPool.map(r => r.date))].length);

// ---- 4-2. 各方式の参入条件を適用した比較(締切順・1日10件上限、各方式独自の候補プール) ----
console.log('\n--- 4-2. 各方式の参入条件を適用した比較(締切順・1日10件上限) ---');
// 市場基準: 帯内候補あり(8点構成可能)→締切順→上限
const marketPool = records.filter(r => r.marketBand8);
const marketCap = applyDailyCap(marketPool);
const marketRes = evalFlat(marketCap.selected, r => r.marketBand8);
report('市場基準(帯内候補あり→締切順10件/日)', marketRes, marketCap.dates.length);
console.log('  日別:', marketCap.dates.map(d => `${d}:${marketCap.perDay[d].selectedCount}(候補${marketCap.perDay[d].poolCount})`).join('  '));

// Q: 実際の本番条件(judge.entered=gap>=0)。参考として「通知条件(axis≠1号艇)」も併記。
// 本番は日次上限なし(無制限通知)。研究比較のため締切順10件/日キャップ版も併記する(本番挙動そのものではない)。
const qEnteredAll = records.filter(r => r.q.entered);
const qEnteredAxisNot1 = qEnteredAll.filter(r => r.q.axisBoat !== 1);
console.log(`\nQ実際の参入(judge.entered、日次上限なし=本番の実挙動): n=${qEnteredAll.length} / 全対象${eligible.length}件`);
console.log(`Qのうち通知条件(軸≠1号艇、2026-08-31導入・暫定ルール)も満たす: n=${qEnteredAxisNot1.length}`);
const qBandCapableEntered = qEnteredAll.filter(r => r.q.band8); // 帯内8点構成可能なentered分のみ、同一投資額の評価に使う
console.log('Qのentered中、帯内8点を構成できる件数(50-150倍帯評価の対象) =', qBandCapableEntered.length);
const qResUncapped = evalFlat(qBandCapableEntered, r => r.q.band8);
report('Q(entered全件、日次上限なし、帯内8点構成可能分のみ帯評価)', qResUncapped, [...new Set(qBandCapableEntered.map(r => r.date))].length);
const qCap = applyDailyCap(qBandCapableEntered);
const qResCapped = evalFlat(qCap.selected, r => r.q.band8);
report('Q(entered→締切順10件/日、研究比較用の参考値であり本番の実挙動ではない)', qResCapped, qCap.dates.length);

// α: 実際のentered===true(閾値1.44...、丸めない)→締切順→10件/日
const alphaEnteredPool = records.filter(r => r.alpha && !r.alpha.error && r.alpha.entered);
console.log(`\nαの参入(entered、閾値=${ENTRY_THRESHOLD}): n=${alphaEnteredPool.length} / 全対象${eligible.length}件`);
const alphaCap = applyDailyCap(alphaEnteredPool);
const alphaRes = evalFlat(alphaCap.selected, r => r.alpha.points.map(p => p.combination));
report('α(entered→締切順10件/日)', alphaRes, alphaCap.dates.length);
console.log('  日別:', alphaCap.dates.map(d => `${d}:${alphaCap.perDay[d].selectedCount}(候補${alphaCap.perDay[d].poolCount})`).join('  '));

// ---- 4-3. Codex申告値の独立再現(全1,193件、entered不問・上限なし、市場 vs α) ----
console.log('\n--- 4-3. Codex申告値の独立再現(α8点構成可能な全レース、entered不問・上限なし) ---');
const alphaConstructiblePool = records.filter(r => r.alpha && !r.alpha.error && r.alpha.points.length === 8);
console.log('αが8点構成できたレース数 =', alphaConstructiblePool.length, '(Codex申告1,193との一致=', alphaConstructiblePool.length === 1193, ')');
const alphaFullRes = evalFlat(alphaConstructiblePool, r => r.alpha.points.map(p => p.combination));
const marketOnAlphaPool = evalFlat(alphaConstructiblePool.filter(r => r.marketBand8), r => r.marketBand8);
console.log(`α(全構成可能分、entered不問): n=${alphaFullRes.n} ROI=${alphaFullRes.roi.toFixed(2)}% (Codex申告90.37%との差=${(alphaFullRes.roi - 90.37).toFixed(2)}pt)`);
console.log(`市場基準(同一母集団、帯8点構成可能分のみ): n=${marketOnAlphaPool.n} ROI=${marketOnAlphaPool.roi.toFixed(2)}% (Codex申告79.70%との差=${(marketOnAlphaPool.roi - 79.70).toFixed(2)}pt)`);
console.log(`  全的中率: α=${(alphaFullRes.hit / alphaFullRes.n * 100).toFixed(2)}% 市場=${(marketOnAlphaPool.hit / marketOnAlphaPool.n * 100).toFixed(2)}%`);
console.log(`  50-150倍的中率: α=${(alphaFullRes.band50 / alphaFullRes.n * 100).toFixed(2)}% 市場=${(marketOnAlphaPool.band50 / marketOnAlphaPool.n * 100).toFixed(2)}%`);

const manifest = {
  generatedAt: loadedAt,
  scopeNote: '既存データのみ使用。通知なし。本番Q・原本・通知設定は変更していない。αのモデル・閾値は不変。',
  reviewPopulation: { count: eligible.length, dates, snapshotHash },
  diffAgainstReference: { referenceCount: reference.races.length, sameIdSameContent, sameIdChanged, missingFromCurrentCount: missingFromCurrent.length, newIdsTotal: newIds.length, newIdsInTrainPeriod: newIdsInTrainPeriod.length, newIdsWithinRefWindow: newIdsWithinRefWindow.length, newIdsAfterRefWindow: newIdsAfterRefWindow.length, newIdsAfterRefWindowList: newIdsAfterRefWindow },
  comparison4_1_commonPool: { n: commonPool.length, market: marketCommon, q: qCommon, alpha: alphaCommon },
  comparison4_2: {
    market: { ...marketRes, dayHitMap: undefined, days: marketCap.dates.length },
    qUncapped: { ...qResUncapped, dayHitMap: undefined, enteredAllCount: qEnteredAll.length, enteredAxisNot1Count: qEnteredAxisNot1.length },
    qCapped: { ...qResCapped, dayHitMap: undefined, days: qCap.dates.length },
    alpha: { ...alphaRes, dayHitMap: undefined, days: alphaCap.dates.length, enteredCount: alphaEnteredPool.length },
  },
  comparison4_3_codexReplication: {
    alphaConstructibleCount: alphaConstructiblePool.length,
    alpha: { ...alphaFullRes, dayHitMap: undefined },
    market: { ...marketOnAlphaPool, dayHitMap: undefined },
    codexReported: { alphaRoi: 90.37, marketRoi: 79.70 },
  },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_alpha_candidate_review_2026-09-02.json'), JSON.stringify(manifest, null, 2));
console.log('\n結果を logs/research_alpha_candidate_review_2026-09-02.json へ保存しました。');
