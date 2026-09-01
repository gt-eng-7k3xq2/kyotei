'use strict';
// GARON-20260901-003(CEO承認、2026-09-01): 三連単50〜150倍 選別型予想システムの研究用検証。
// 本番Q(garon_q_engine.html、展示欠損修正済みv2)をそのまま使い、新しいスコアリングエンジンは
// 作らない。段階A(レース選別)・段階B(買い目選択)は各1方式のみに限定。
//
// 【処理順序・依存関係(事前固定、CEO要求通り)】
//   1. オッズ取得時点の分類(archivedAtと締切shimekiriの関係。日付だけで判定しない)
//      - 真の予想時点オッズ: archivedAtのJST暦日がレース日と同一 かつ 締切より前20分以内
//      - それ以外は「時点不明・過去ページ由来」(参考のみ、主たる学習・評価には使わない)
//   2. 真の予想時点オッズの母集団のみを対象に、本番Q v2(generateQBets)を実行
//   3. 候補プール = judge.entered && axis!==1(現行の通知条件) && formations.pointsに
//      予想時点oddsMapで50〜150倍の点が1つ以上ある
//   4. 時系列分割(暦日で固定、結果を見て境界を選んでいない): 学習=2026-08-21〜08-25、
//      評価=2026-08-26〜08-31
//   5. 学習期間の候補プールだけを使い、段階Aの閾値(gap下限)を1つ固定
//      (gap = Qが既に計算している「軸のweight - 軸以外の最高スコア」。確率ではなく
//       Q内部の既存の支持スコア差、GARON-20260827-001でgap<0の有意な劣化が既に確認済みの指標)
//   6. 段階A(確定): 候補プール ∩ {gap >= GAP_MIN}。締切時刻順に処理し、1日10件で打ち切り
//      (同日内の並べ替え・後から選び直しはしない)
//   7. 段階B(確定): 選ばれたレースについて、formations.points ∩ 帯内(50-150倍)の点全てを
//      1レース3,000円・均等回収配分(allocateStakesEqualRet、既存の統一手法をそのまま流用)で購入。
//      新しい点は追加しない、帯外の点は使わない
//   8. 評価期間で、新方式と「現行Q v2+現行通知条件のみ(段階Aなし)」を同一データ・同一予算条件で比較
//
// 確定payout/chakujuは評価にのみ使用し、選別・買い目選択のいずれの入力にも一切渡していない。

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;
const DAILY_CAP = 10;
const TRAIN_DATES = ['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25'];
const EVAL_DATES = ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'];

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMin(s) { if (!s) return null; const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }

function loadAllRaces() {
  const files = fs.readdirSync(ROOT).filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const races = [];
  for (const f of files) { const d = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); for (const r of d) races.push(r); }
  return races;
}
function isUsable(r) {
  return r.resulted && r.oddsMap && Object.keys(r.oddsMap).length > 0 &&
    r.boats && r.boats.length === 6 && r.boats.every(b => !b.isJogai) && r.chakuju;
}

// ステップ1: オッズ取得時点の分類(日付だけで判定しない。取得時刻・締切との関係で判定)
function classifyOddsTiming(r) {
  if (!r.archivedAt) return 'unknown';
  const archJST = new Date(new Date(r.archivedAt).getTime() + 9 * 3600 * 1000);
  const archDateJST = archJST.toISOString().slice(0, 10);
  const archMinJST = archJST.getUTCHours() * 60 + archJST.getUTCMinutes();
  const sMin = shimekiriMin(r.shimekiri);
  if (archDateJST === r.date && sMin != null) {
    const diff = sMin - archMinJST; // 締切までの残り分数(正なら締切前)
    if (diff >= 0 && diff <= 20) return 'true'; // 真の予想時点オッズ(締切20分以内に取得)
  }
  return 'unknown'; // 時点不明・過去ページ由来(同日でも締切から離れている3件を含む、安全側)
}

function allocateStakesEqualRet(betVals, oddsMap, shikin) {
  const odds = betVals.map(v => parseFloat(oddsMap[v]) || 0);
  const anyOdds = odds.some(o => o > 0);
  let weights;
  if (anyOdds) {
    const validOdds = odds.filter(o => o > 0);
    const avgOdds = validOdds.reduce((s, o) => s + o, 0) / Math.max(1, validOdds.length);
    weights = odds.map(o => 1 / (o > 0 ? o : avgOdds));
  } else weights = odds.map(() => 1);
  const totalW = weights.reduce((s, w) => s + w, 0);
  let amounts = weights.map(w => Math.max(100, Math.floor(w / totalW * shikin / 100) * 100));
  let tot = amounts.reduce((s, a) => s + a, 0);
  for (let i = amounts.length - 1; i >= 0 && tot > shikin; i--) {
    const cut = Math.min(amounts[i] - 100, Math.ceil((tot - shikin) / 100) * 100);
    if (cut > 0) { amounts[i] -= cut; tot -= cut; }
  }
  const rem = shikin - amounts.reduce((s, a) => s + a, 0);
  if (rem > 0 && amounts.length > 0) amounts[0] += rem;
  return amounts;
}

function buildRaceRecord(engine, r) {
  // 帯内候補の有無で足切りしない(現行Qの実際の通知母集団=真の比較対象を別途作れるように)。
  // 「候補プール(帯内候補が1つ以上)」への絞り込みは呼び出し側で行う。
  let bets; try { bets = engine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { return null; }
  if (!bets.judge.entered) return null;
  const axisBoat = bets.axes && bets.axes[0] ? bets.axes[0].boat : null;
  if (axisBoat === 1) return null; // 現行通知条件(軸≠1号艇)
  const allPoints = [...new Set((bets.formations || []).flatMap(f => f.points || []))];
  const bandPoints = allPoints.filter(p => { const o = (r.oddsMap || {})[p]; return o != null && o >= 50 && o <= 150; });
  const sMin = shimekiriMin(r.shimekiri);
  return {
    date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: sMin,
    gap: bets.gap, allPoints, bandPoints, chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
    oddsMap: r.oddsMap,
  };
}

function evaluateSet(races, opts) {
  // races: buildRaceRecordの出力配列。opts.useStageA=trueならgap>=gapMinかつ1日10件の
  // 締切順キャップを適用。opts.requireBandCandidate=trueなら帯内候補が無いレースは対象外
  // (候補プールの前提)。opts.betField: 'bandPoints'=帯内候補のみ購入、'allPoints'=Qの
  // フォーメーション全点購入(現行の実際の通知挙動そのもの)。
  const { useStageA, gapMin, requireBandCandidate, betField } = opts;
  const pool = requireBandCandidate ? races.filter(r => r.bandPoints.length > 0) : races;
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  let selected = [];
  let cappedSkipped = 0;
  for (const date of Object.keys(byDate).sort()) {
    const dayRaces = byDate[date].slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
    let dayCount = 0;
    for (const r of dayRaces) {
      if (useStageA && r.gap < gapMin) continue; // 段階Aのgap閾値
      if (useStageA && dayCount >= DAILY_CAP) { cappedSkipped++; continue; } // 締切順・上限到達で以降は見送り
      selected.push(r);
      dayCount++;
    }
  }
  // isHit: 買った点のいずれかが的中(配当帯を問わず、実際に払戻を受け取るかどうか)
  // isConfirmedBandHit: 的中 かつ 確定payoutも50-150倍のまま(主指標Aの分子)
  // isResultBand: そのレースの実際の結果(確定payout)が50-150倍だったか(買ったかどうかは無関係)
  let confirmedBandHit = 0, anyHit = 0, resultBand = 0, stake = 0, payout = 0, totalPoints = 0;
  let confirmedBandPayout = 0, migratedOutHit = 0, migratedOutPayout = 0;
  const dayHitMap = {}; // date -> 主指標(帯内的中)が1件でもあったか
  const seq = []; // 締切順の主指標フラグ(連敗計算用)
  for (const r of selected) {
    const betPoints = r[betField];
    const isHit = r.chakuju && betPoints.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isConfirmedBandHit = isHit && isResultBand;
    const amounts = allocateStakesEqualRet(betPoints, r.oddsMap, SHIKIN);
    const raceStake = amounts.reduce((s, a) => s + a, 0);
    let racePayout = 0;
    if (isHit) { const idx = betPoints.indexOf(r.chakuju); racePayout = Math.round(amounts[idx] / 100 * (r.payoutMul * 100)); }
    stake += raceStake; payout += racePayout; totalPoints += betPoints.length;
    if (isConfirmedBandHit) { confirmedBandHit++; confirmedBandPayout += racePayout; }
    if (isHit && !isResultBand) { migratedOutHit++; migratedOutPayout += racePayout; } // 予想時点は帯内だったが確定時に帯外へ動いた的中
    if (isHit) anyHit++;
    if (isResultBand) resultBand++;
    if (isConfirmedBandHit) dayHitMap[r.date] = true;
    seq.push(isConfirmedBandHit ? 1 : 0);
  }
  const n = selected.length;
  const days = Object.keys(byDate).sort();
  const zeroHitDays = days.filter(d => !dayHitMap[d]).length;
  let maxStreak = 0, cur = 0;
  for (const h of seq) { if (h === 0) { cur++; maxStreak = Math.max(maxStreak, cur); } else cur = 0; }
  return {
    n, days: days.length, dailyAvg: n / Math.max(1, days.length),
    A: n ? confirmedBandHit / n : null, // 主指標: 帯内的中レース数÷全発信レース数
    B: n ? anyHit / n : null, // 全的中レース数(配当帯を問わない)÷全発信レース数
    C: resultBand ? confirmedBandHit / resultBand : null, // 結果が帯内だったレースでの的中率(原因分析用)
    D: n ? resultBand / n : null, // 選別後のレースが結果として帯内になった割合
    confirmedBandHit, anyHit, resultBand, stake, payout, roi: stake ? payout / stake * 100 : null,
    confirmedBandPayout, migratedOutHit, migratedOutPayout, // item5: 予想時点帯内→確定時帯外へ動いた的中の内訳
    avgPoints: n ? totalPoints / n : null, zeroHitDays, maxStreak, cappedSkipped,
  };
}

// ===== 実行 =====
const engine = loadQEngine(path.join(ROOT, 'garon_q_engine.html')); // 本番v2(展示欠損修正済み)
console.log('Q_ENGINE_VERSION:', engine.Q_ENGINE_VERSION, '(2のはず)');

const all = loadAllRaces();
const usable = all.filter(isUsable);
console.log('母集団(isUsable) n=', usable.length);

const timing = { true: 0, unknown: 0 };
for (const r of usable) timing[classifyOddsTiming(r)]++;
console.log('オッズ取得時点分類: 真の予想時点オッズ=', timing.true, ' 時点不明・過去ページ由来=', timing.unknown);

const trueT10 = usable.filter(r => classifyOddsTiming(r) === 'true');
console.log('真の予想時点オッズのみ(以降はこの母集団だけを使用) n=', trueT10.length);

const records = trueT10.map(r => buildRaceRecord(engine, r)).filter(Boolean); // entered && axis!=1 (帯内候補の有無は問わない)
const candidatePool = records.filter(r => r.bandPoints.length > 0);
console.log('現行Qの通知母集団(entered && axis!=1) n=', records.length);
console.log('候補プール(そのうち帯内候補が1つ以上) n=', candidatePool.length);

const trainCandidates = candidatePool.filter(r => TRAIN_DATES.includes(r.date));
const evalRecords = records.filter(r => EVAL_DATES.includes(r.date));
const evalCandidates = candidatePool.filter(r => EVAL_DATES.includes(r.date));
console.log('学習期間(', TRAIN_DATES[0], '〜', TRAIN_DATES[TRAIN_DATES.length - 1], ')候補プール n=', trainCandidates.length);
console.log('評価期間(', EVAL_DATES[0], '〜', EVAL_DATES[EVAL_DATES.length - 1], ')通知母集団 n=', evalRecords.length, ' うち候補プール n=', evalCandidates.length);

// ステップ5: 学習期間のみでgap閾値を検討(結果を見て評価期間側を調整しない)
console.log('\n=== 学習期間: gap閾値ごとの帯内的中率(参考、この中から1つを固定して評価期間に適用) ===');
const gapCandidates = [0, 1, 2, 3, 5, 8];
for (const g of gapCandidates) {
  const sub = trainCandidates.filter(r => r.gap >= g);
  const hits = sub.filter(r => r.chakuju && r.bandPoints.includes(r.chakuju)).length;
  console.log(`  gap>=${g}: n=${sub.length} 帯内的中=${hits} 帯内的中率=${sub.length ? (hits / sub.length * 100).toFixed(1) : '-'}%`);
}

const GAP_MIN = 0; // 固定(理由は本文参照。学習期間のn不足のため既存のQ標準閾値〈gap>=0〉から変更しない)
console.log('\n採用する段階A閾値: GAP_MIN =', GAP_MIN, '(理由: 学習期間のn不足のため新規最適化はせず、Q既存のgap>=0基準を据え置く)');

console.log('\n=== 評価期間(2026-08-26〜08-31、真T-10データのみ)の比較 ===');
const trueBaseline = evaluateSet(evalRecords, { useStageA: false, gapMin: 0, requireBandCandidate: false, betField: 'allPoints' });
const bandOnlyDiagnostic = evaluateSet(evalRecords, { useStageA: false, gapMin: 0, requireBandCandidate: true, betField: 'bandPoints' });
const newMethod = evaluateSet(evalRecords, { useStageA: true, gapMin: GAP_MIN, requireBandCandidate: true, betField: 'bandPoints' });
console.log('①現行Q v2・現行通知対象(通常フォーメーション全点、段階A/帯フィルタなし=実際の現行挙動):', JSON.stringify(trueBaseline, null, 2));
console.log('②参考(診断用): 段階Aなし・帯内候補のみ購入(段階Bだけを現行に足した場合):', JSON.stringify(bandOnlyDiagnostic, null, 2));
console.log('③新方式(段階A+B):', JSON.stringify(newMethod, null, 2));

fs.writeFileSync(path.join(ROOT, 'logs', 'research_band50to150_result_2026-09-01.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), qEngineVersion: engine.Q_ENGINE_VERSION,
  timingClassification: timing, trueT10Count: trueT10.length,
  notifyPopulationCount: records.length, candidatePoolCount: candidatePool.length,
  trainDates: TRAIN_DATES, evalDates: EVAL_DATES, trainCandidatesCount: trainCandidates.length,
  evalRecordsCount: evalRecords.length, evalCandidatesCount: evalCandidates.length,
  gapMin: GAP_MIN, trueBaseline, bandOnlyDiagnostic, newMethod,
}, null, 2));
console.log('\n結果を logs/research_band50to150_result_2026-09-01.json へ保存しました。');
