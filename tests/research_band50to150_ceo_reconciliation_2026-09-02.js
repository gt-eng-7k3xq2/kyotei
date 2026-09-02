'use strict';
// GARON-20260901-003 追跡照合(CEO差し戻し、2026-09-02): 段階A・B検証結果に対する限定照合。
// 新しい係数探索・全面再検証は行わない。research_findings_2026-09-01_band50to150_stage_ab_verification.md
// の③の内訳を、同一データ・同一コードから再構築して照合するだけの診断スクリプト。
// 本番Q・通知・紙上記録・原本・公開設定は無変更。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;
const DAILY_CAP = 10;
const EVAL_DATES = ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'];
const GAP_MIN = 0;

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
function classifyOddsTiming(r) {
  if (!r.archivedAt) return { cls: 'unknown', diff: null };
  const archJST = new Date(new Date(r.archivedAt).getTime() + 9 * 3600 * 1000);
  const archDateJST = archJST.toISOString().slice(0, 10);
  const archMinJST = archJST.getUTCHours() * 60 + archJST.getUTCMinutes();
  const sMin = shimekiriMin(r.shimekiri);
  if (archDateJST === r.date && sMin != null) {
    const diff = sMin - archMinJST;
    if (diff >= 0 && diff <= 20) return { cls: 'true', diff };
  }
  return { cls: 'unknown', diff: null };
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
function allocateStakesFlat100(betVals) {
  return betVals.map(() => 100); // 補助診断: 1点100円固定(本番配分の変更ではない)
}

function buildRaceRecord(engine, r) {
  let bets; try { bets = engine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { return null; }
  if (!bets.judge.entered) return null;
  const axisBoat = bets.axes && bets.axes[0] ? bets.axes[0].boat : null;
  if (axisBoat === 1) return null;
  const allPoints = [...new Set((bets.formations || []).flatMap(f => f.points || []))];
  const bandPoints = allPoints.filter(p => { const o = (r.oddsMap || {})[p]; return o != null && o >= 50 && o <= 150; });
  const sMin = shimekiriMin(r.shimekiri);
  const timing = classifyOddsTiming(r);
  return {
    date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: sMin, archivedAt: r.archivedAt,
    timingDiffMin: timing.diff,
    gap: bets.gap, allPoints, bandPoints, chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
    oddsMap: r.oddsMap,
  };
}

console.log('=== GARON-20260901-003 CEO差し戻し照合(2026-09-02) ===\n');

const engine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
const engineHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'garon_q_engine.html'))).digest('hex');
console.log('Q_ENGINE_VERSION:', engine.Q_ENGINE_VERSION, ' garon_q_engine.html sha256:', engineHash);

const all = loadAllRaces();
const usable = all.filter(isUsable);
const trueT10 = usable.filter(r => classifyOddsTiming(r).cls === 'true');
const records = trueT10.map(r => buildRaceRecord(engine, r)).filter(Boolean);
const candidatePool = records.filter(r => r.bandPoints.length > 0);
const evalCandidates = candidatePool.filter(r => EVAL_DATES.includes(r.date));
const evalRecords = records.filter(r => EVAL_DATES.includes(r.date));

console.log('\n--- 前提再確認: 母集団件数(元レポートと一致するか) ---');
console.log('真T-10 n=', trueT10.length, '(元レポート1215のはず)');
console.log('通知母集団 n=', records.length, '(元567のはず)');
console.log('候補プール n=', candidatePool.length, '(元514のはず)');
console.log('評価期間 通知母集団 n=', evalRecords.length, '(元183のはず) / 候補プール n=', evalCandidates.length, '(元166のはず)');

// ===== 指示2: 段階Aが実際に何を選別したか =====
console.log('\n=== 指示2: GAP_MIN=0は候補プールに対して有効なフィルタか ===');
const gapNegativeInPool = evalCandidates.filter(r => r.gap < GAP_MIN);
console.log('候補プール(166件)のうちgap<0の件数:', gapNegativeInPool.length, '(0なら「段階Aのgapフィルタは無効=何も除外していない」ことが確定)');
console.log('理由: garon_q_engine.html GAP_SKIP_THRESHOLD=0により、judge.entered=trueの時点で既にgap>=0が保証されている(本番エンジン側の既存ルール)。候補プールはjudge.entered済みレースのみで構成されるため、段階Aのgap>=0フィルタは構造的に無条件で全通過する。');

// 日別内訳: 候補プール件数 vs 先着10件上限で選ばれた件数 vs 見送り件数
console.log('\n--- 日別内訳(候補プール件数・段階A選出・先着上限見送り) ---');
const byDate = {};
for (const r of evalCandidates) (byDate[r.date] = byDate[r.date] || []).push(r);
let totalSelected = 0, totalSkipped = 0;
const dailyRows = [];
for (const date of EVAL_DATES) {
  const dayRaces = (byDate[date] || []).slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
  const selected = dayRaces.slice(0, DAILY_CAP);
  const skipped = dayRaces.slice(DAILY_CAP);
  totalSelected += selected.length; totalSkipped += skipped.length;
  dailyRows.push({ date, candidatePool: dayRaces.length, selected: selected.length, skippedByCappOnly: skipped.length });
  console.log(`  ${date}: 候補プール=${dayRaces.length}件 → 先着10件上限のみで選出=${selected.length}件 見送り=${skipped.length}件`);
}
console.log('合計: 選出=', totalSelected, '(元レポート③のn=43のはず) 見送り=', totalSkipped, '(元レポートcappedSkipped=123のはず)');
console.log('→ gapフィルタを完全に外し「候補プールを締切順に1日10件で機械的に打ち切るだけ」の対照でも、選出数・見送り数が完全一致するかを確認する(指示2の対照実験)。');

// ===== 指示2 対照実験: 「②を締切順に1日10件まで採るだけ」 vs ③ =====
function evaluateSelected(selected, betField) {
  let confirmedBandHit = 0, anyHit = 0, resultBand = 0, stake = 0, payout = 0, totalPoints = 0;
  let confirmedBandPayout = 0, migratedOutHit = 0, migratedOutPayout = 0;
  const dayHitMap = {}; const seq = [];
  const hitDetails = [];
  for (const r of selected) {
    const betPoints = r[betField];
    const isHit = r.chakuju && betPoints.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isConfirmedBandHit = isHit && isResultBand;
    const amounts = allocateStakesEqualRet(betPoints, r.oddsMap, SHIKIN);
    const raceStake = amounts.reduce((s, a) => s + a, 0);
    let racePayout = 0, hitAmount = 0, hitOddsAtBetTime = null;
    if (isHit) {
      const idx = betPoints.indexOf(r.chakuju);
      hitAmount = amounts[idx];
      hitOddsAtBetTime = parseFloat(r.oddsMap[r.chakuju]) || null;
      racePayout = Math.round(amounts[idx] / 100 * (r.payoutMul * 100));
      hitDetails.push({
        date: r.date, venue: r.venue, racenum: r.racenum, chakuju: r.chakuju,
        purchaseAmount: hitAmount, oddsAtBetTime: hitOddsAtBetTime, confirmedPayoutMul: r.payoutMul,
        confirmedPayout: racePayout, isConfirmedBandHit, wasBandAtBetTime: betField === 'bandPoints',
      });
    }
    stake += raceStake; payout += racePayout; totalPoints += betPoints.length;
    if (isConfirmedBandHit) { confirmedBandHit++; confirmedBandPayout += racePayout; }
    if (isHit && !isResultBand) { migratedOutHit++; migratedOutPayout += racePayout; }
    if (isHit) anyHit++;
    if (isResultBand) resultBand++;
    if (isConfirmedBandHit) dayHitMap[r.date] = true;
    seq.push(isConfirmedBandHit ? 1 : 0);
  }
  const n = selected.length;
  let maxStreak = 0, cur = 0;
  for (const h of seq) { if (h === 0) { cur++; maxStreak = Math.max(maxStreak, cur); } else cur = 0; }
  return {
    n, A: n ? confirmedBandHit / n : null, B: n ? anyHit / n : null,
    C: resultBand ? confirmedBandHit / resultBand : null, D: n ? resultBand / n : null,
    confirmedBandHit, anyHit, resultBand, stake, payout, roi: stake ? payout / stake * 100 : null,
    confirmedBandPayout, migratedOutHit, migratedOutPayout, avgPoints: n ? totalPoints / n : null,
    maxStreak, hitDetails,
  };
}

const controlSelected = [];
for (const date of EVAL_DATES) {
  const dayRaces = (byDate[date] || []).slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
  controlSelected.push(...dayRaces.slice(0, DAILY_CAP));
}
const control = evaluateSelected(controlSelected, 'bandPoints');
console.log('\n=== 対照実験: 「候補プール166件を締切順に1日10件だけ採る」(gapフィルタなし) ===');
console.log(JSON.stringify({ n: control.n, A: control.A, confirmedBandHit: control.confirmedBandHit, anyHit: control.anyHit, stake: control.stake, payout: control.payout, roi: control.roi }, null, 2));

console.log('\n=== ③(段階A+B、元レポート)を同一コードで再現 ===');
const stageASelected = [];
{
  const byDate2 = {};
  for (const r of evalCandidates) (byDate2[r.date] = byDate2[r.date] || []).push(r);
  for (const date of EVAL_DATES) {
    const dayRaces = (byDate2[date] || []).slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
    let dayCount = 0;
    for (const r of dayRaces) {
      if (r.gap < GAP_MIN) continue;
      if (dayCount >= DAILY_CAP) continue;
      stageASelected.push(r); dayCount++;
    }
  }
}
const stageA = evaluateSelected(stageASelected, 'bandPoints');
console.log(JSON.stringify({ n: stageA.n, A: stageA.A, confirmedBandHit: stageA.confirmedBandHit, anyHit: stageA.anyHit, stake: stageA.stake, payout: stageA.payout, roi: stageA.roi }, null, 2));

console.log('\n=== 対照 vs ③ 完全一致確認 ===');
const identical = control.n === stageA.n && control.confirmedBandHit === stageA.confirmedBandHit &&
  control.anyHit === stageA.anyHit && control.stake === stageA.stake && control.payout === stageA.payout;
console.log('完全一致:', identical, identical ? '→ 段階Aは先着上限以外の選別を一切行っていないことが確定(結論B)。' : '→ 差異あり。gapフィルタが何らかの除外を行っている(下記diff参照)。');
if (!identical) {
  const stageASet = new Set(stageASelected.map(r => `${r.date}_${r.venue}_${r.racenum}`));
  const controlSet = new Set(controlSelected.map(r => `${r.date}_${r.venue}_${r.racenum}`));
  const onlyInControl = [...controlSet].filter(k => !stageASet.has(k));
  const onlyInStageA = [...stageASet].filter(k => !controlSet.has(k));
  console.log('対照のみに含まれる:', onlyInControl);
  console.log('③のみに含まれる:', onlyInStageA);
}

// ===== 指示1: ③の的中4件の内訳(購入額・払戻倍率・払戻額) =====
console.log('\n=== 指示1: ③の的中4件の内訳(購入額・締切前オッズ・確定払戻倍率・確定払戻額) ===');
for (const h of stageA.hitDetails) {
  console.log(`  ${h.date} ${h.venue}${h.racenum}R 目 ${h.chakuju}: 購入額=${h.purchaseAmount}円 締切前オッズ=${h.oddsAtBetTime}倍 確定払戻倍率=${h.confirmedPayoutMul}倍 確定払戻額=${h.confirmedPayout}円 帯内的中=${h.isConfirmedBandHit}`);
}
const sumCheck = stageA.hitDetails.reduce((s, h) => s + h.confirmedPayout, 0);
console.log('4件合計払戻:', sumCheck, '(元レポート321,140円のはず)');
const bandSum = stageA.hitDetails.filter(h => h.isConfirmedBandHit).reduce((s, h) => s + h.confirmedPayout, 0);
const outSum = stageA.hitDetails.filter(h => !h.isConfirmedBandHit).reduce((s, h) => s + h.confirmedPayout, 0);
console.log('帯内的中(2件)の寄与:', bandSum, '円 / 帯外へ移動した的中(2件)の寄与:', outSum, '円');

// ===== 指示3: 点数・配分の影響(補助診断: 1点100円固定) =====
console.log('\n=== 指示3: 補助診断(1点100円固定配分、本番配分の変更ではない) ===');
function evaluateFlat100(selected, betField) {
  let hit = 0, bandHit = 0, stake = 0, payout = 0;
  for (const r of selected) {
    const betPoints = r[betField];
    const amounts = allocateStakesFlat100(betPoints);
    const raceStake = amounts.reduce((s, a) => s + a, 0);
    const isHit = r.chakuju && betPoints.includes(r.chakuju);
    const isConfirmedBandHit = isHit && r.payoutMul >= 50 && r.payoutMul <= 150;
    let racePayout = 0;
    if (isHit) { const idx = betPoints.indexOf(r.chakuju); racePayout = Math.round(amounts[idx] / 100 * (r.payoutMul * 100)); }
    stake += raceStake; payout += racePayout;
    if (isHit) hit++; if (isConfirmedBandHit) bandHit++;
  }
  return { n: selected.length, hit, bandHit, stake, payout, roi: stake ? payout / stake * 100 : null };
}
const flat100 = evaluateFlat100(stageASelected, 'bandPoints');
console.log('1点100円固定(③と同一43レース・同一買い目集合):', JSON.stringify(flat100, null, 2));
console.log('3,000円均等回収配分(元レポート③): stake=', stageA.stake, 'payout=', stageA.payout, 'roi=', stageA.roi.toFixed(1) + '%');
console.log('→ 買い目集合(何を買ったか)の成績と、配分方法(3,000円均等回収 vs 100円固定)による資金集中の影響を分離して比較。');

// ===== 指示4: 比較データの固定(締切前20分以内 vs 厳密なT-10の分布) =====
console.log('\n=== 指示4: 「締切前20分以内」の分布(厳密なT-10=10分ちょうどとの違い) ===');
const diffHist = {};
for (const r of trueT10) {
  const d = r.timingDiffMin;
  // trueT10はbuildRaceRecordを通していないのでarchivedAtから再計算
}
const trueT10WithDiff = trueT10.map(r => classifyOddsTiming(r).diff);
for (const d of trueT10WithDiff) { diffHist[d] = (diffHist[d] || 0) + 1; }
console.log('締切までの残り分数の分布(真T-10、全1215件):');
for (const k of Object.keys(diffHist).map(Number).sort((a, b) => a - b)) console.log(`  残り${k}分: ${diffHist[k]}件`);
const evalDiffHist = {};
for (const r of stageASelected) { const d = r.timingDiffMin; evalDiffHist[d] = (evalDiffHist[d] || 0) + 1; }
console.log('③選出43件の分布:');
for (const k of Object.keys(evalDiffHist).map(Number).sort((a, b) => a - b)) console.log(`  残り${k}分: ${evalDiffHist[k]}件`);

// 再現用データ固定(manifest)
const manifest = {
  generatedAt: new Date().toISOString(),
  purpose: 'GARON-20260901-003 CEO差し戻し照合(限定照合、新規探索なし)',
  qEngineVersion: engine.Q_ENGINE_VERSION,
  qEngineFileSha256: engineHash,
  gapMin: GAP_MIN, dailyCap: DAILY_CAP, shikin: SHIKIN, evalDates: EVAL_DATES,
  populationCounts: { trueT10: trueT10.length, notifyPopulation: records.length, candidatePool: candidatePool.length, evalRecords: evalRecords.length, evalCandidates: evalCandidates.length },
  gapZeroCheckInEvalCandidates: gapNegativeInPool.length,
  dailyRows,
  controlVsStageAIdentical: identical,
  stageASelectedRaces: stageASelected.map(r => ({ date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: r.shimekiriMin, archivedAt: r.archivedAt, timingDiffMin: r.timingDiffMin, gap: r.gap, bandPoints: r.bandPoints, chakuju: r.chakuju, payoutMul: r.payoutMul })),
  hitDetails: stageA.hitDetails,
  flat100Diagnostic: flat100,
  equalRetSummary: { n: stageA.n, A: stageA.A, confirmedBandHit: stageA.confirmedBandHit, anyHit: stageA.anyHit, stake: stageA.stake, payout: stageA.payout, roi: stageA.roi },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_band50to150_ceo_reconciliation_2026-09-02.json'), JSON.stringify(manifest, null, 2));
console.log('\n結果を logs/research_band50to150_ceo_reconciliation_2026-09-02.json へ保存しました。');
