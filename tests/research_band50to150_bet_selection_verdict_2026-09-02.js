'use strict';
// GARON-20260901-003 継続(CEO承認、2026-09-02): 「Qの買い目選択が単純な市場基準を上回るか」の
// 限定比較。レース選別ではなく買い目選択(どの点を買うか)だけを差し替えた比較。
// 新しい特徴量探索(市場エントロピー等)は行わない。本番Q・通知・紙上記録・原本・公開設定は無変更。
//
// A: 現行研究方式のQ由来の帯内買い目(formationsの帯内点、既存のbandPoints定義そのまま)
// B: 全120通りのうち予想時点50-150倍の点から、オッズが低い順に、Aと同じ点数だけ選ぶ単純基準
//    (同値オッズは点表記の文字列昇順という結果と無関係な固定規則でタイブレーク。p×oddsは不使用)

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN_EQUALRET = 3000; // 補助表のみ
const FLAT_STAKE = 100; // 主比較
const DAILY_CAP = 10;

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

function buildRecord(engine, r) {
  let bets; try { bets = engine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { return null; }
  if (!bets.judge.entered) return null;
  const axisBoat = bets.axes && bets.axes[0] ? bets.axes[0].boat : null;
  if (axisBoat === 1) return null; // 現行通知条件
  const allPoints = [...new Set((bets.formations || []).flatMap(f => f.points || []))];
  const oddsMap = r.oddsMap || {};
  const bandPointsA = allPoints.filter(p => { const o = oddsMap[p]; return o != null && o >= 50 && o <= 150; });
  if (bandPointsA.length === 0) return null; // 既存の研究用候補集合(帯内買い目あり)

  // 全120通りのうち有効オッズの件数(120未満は除外対象として記録)
  const validOddsEntries = Object.entries(oddsMap).filter(([, v]) => parseFloat(v) > 0);
  const validCount = validOddsEntries.length;

  // 市場基準B: 予想時点50-150倍の全候補(Qの点数に限らない)を、オッズ昇順・同値は点表記文字列昇順で並べる
  const bandUniverse = validOddsEntries
    .filter(([, v]) => v >= 50 && v <= 150)
    .map(([val, v]) => ({ val, odds: v }))
    .sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));

  const k = bandPointsA.length;
  const bandPointsB = bandUniverse.slice(0, k).map(p => p.val);
  const kMatched = bandPointsB.length === k;

  const sMin = shimekiriMin(r.shimekiri);
  return {
    date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: sMin,
    chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100, oddsMap,
    bandPointsA, bandPointsB, k, kMatched, validCount, bandUniverseSize: bandUniverse.length,
    chakujuOddsAtBet: oddsMap[r.chakuju] != null ? parseFloat(oddsMap[r.chakuju]) : null,
  };
}

console.log('=== GARON-20260901-003 継続: 「Qの買い目選択 vs 単純な市場基準」限定比較(2026-09-02) ===\n');
console.log('【明記】使用データは既に分析済みの真T-10(2026-08-21〜08-31)。全て探索的比較であり独立した新規評価ではない。\n');

const engine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
console.log('Q_ENGINE_VERSION:', engine.Q_ENGINE_VERSION);

const all = loadAllRaces();
const usable = all.filter(isUsable);
const trueT10 = usable.filter(r => classifyOddsTiming(r).cls === 'true');
const candidatePool = trueT10.map(r => buildRecord(engine, r)).filter(Boolean);
console.log('真T-10 n=', trueT10.length, ' 既存の研究用候補プール(帯内買い目あり・軸≠1号艇) n=', candidatePool.length, '(前回514のはず)');
console.log('※この比較はQの参入条件(judge.entered && axis!=1)とQ自身の帯内買い目の有無に依存する範囲の比較であり、Q非依存の全レース評価ではない。\n');

// ===== 除外の適用(A/B共通) =====
const excluded120 = candidatePool.filter(r => r.validCount !== 120);
const excludedKMismatch = candidatePool.filter(r => r.validCount === 120 && !r.kMatched);
const comparePool = candidatePool.filter(r => r.validCount === 120 && r.kMatched);
console.log('=== 除外の内訳(A/B共通適用) ===');
console.log('全120通り有効オッズが揃っていないため除外: ', excluded120.length, '件');
console.log('120通り揃っているが帯内候補が点数kに届かずB構成不能で除外: ', excludedKMismatch.length, '件');
console.log('比較対象(matchedPool) n=', comparePool.length, '\n');

// ===== 主比較: 1点100円固定 =====
function evalFlat(pool, field) {
  let hit = 0, bandHit = 0, stake = 0, payout = 0;
  const dayHitMap = {};
  for (const r of pool) {
    const pts = r[field];
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const isBandHit = isHit && r.payoutMul >= 50 && r.payoutMul <= 150;
    const raceStake = pts.length * FLAT_STAKE;
    let racePayout = 0;
    if (isHit) racePayout = Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    stake += raceStake; payout += racePayout;
    if (isHit) hit++; if (isBandHit) { bandHit++; dayHitMap[r.date] = true; }
  }
  return { n: pool.length, hit, bandHit, stake, payout, roi: stake ? payout / stake * 100 : null, dayHitMap };
}
function evalEqualRet(pool, field) {
  let hit = 0, bandHit = 0, stake = 0, payout = 0;
  for (const r of pool) {
    const pts = r[field];
    const amounts = allocateStakesEqualRet(pts, r.oddsMap, SHIKIN_EQUALRET);
    const raceStake = amounts.reduce((s, a) => s + a, 0);
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const isBandHit = isHit && r.payoutMul >= 50 && r.payoutMul <= 150;
    let racePayout = 0;
    if (isHit) { const idx = pts.indexOf(r.chakuju); racePayout = Math.round(amounts[idx] / 100 * (r.payoutMul * 100)); }
    stake += raceStake; payout += racePayout;
    if (isHit) hit++; if (isBandHit) bandHit++;
  }
  return { n: pool.length, hit, bandHit, stake, payout, roi: stake ? payout / stake * 100 : null };
}

function applyDailyCap(pool) {
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  const dates = Object.keys(byDate).sort();
  const selected = [];
  const perDay = {};
  for (const date of dates) {
    const dayRaces = byDate[date].slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP);
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates };
}

console.log('=== 【日次上限適用前】全候補(matchedPool、n=' + comparePool.length + ') ===');
const preA = evalFlat(comparePool, 'bandPointsA');
const preB = evalFlat(comparePool, 'bandPointsB');
console.log('A(Q由来): 帯内的中', preA.bandHit, '/', preA.n, '=', (preA.bandHit / preA.n * 100).toFixed(2) + '%', ' 全的中', preA.hit, ' ROI(100円固定)=', preA.roi.toFixed(1) + '%');
console.log('B(市場基準・オッズ昇順): 帯内的中', preB.bandHit, '/', preB.n, '=', (preB.bandHit / preB.n * 100).toFixed(2) + '%', ' 全的中', preB.hit, ' ROI(100円固定)=', preB.roi.toFixed(1) + '%');

const cap = applyDailyCap(comparePool); // レースID選定はA/B共通
console.log('\n=== 【締切順・1日10件上限適用後】(A/B共通のレースID、n=' + cap.selected.length + ') ===');
const postA = evalFlat(cap.selected, 'bandPointsA');
const postB = evalFlat(cap.selected, 'bandPointsB');
console.log('A(Q由来・主比較100円固定): n=', postA.n, ' 帯内的中率=', (postA.bandHit / postA.n * 100).toFixed(2) + '%', ' 全的中率=', (postA.hit / postA.n * 100).toFixed(2) + '%', ' stake=', postA.stake, ' payout=', postA.payout, ' ROI=', postA.roi.toFixed(1) + '%');
console.log('B(市場基準・主比較100円固定): n=', postB.n, ' 帯内的中率=', (postB.bandHit / postB.n * 100).toFixed(2) + '%', ' 全的中率=', (postB.hit / postB.n * 100).toFixed(2) + '%', ' stake=', postB.stake, ' payout=', postB.payout, ' ROI=', postB.roi.toFixed(1) + '%');
console.log('無的中日数: A=', cap.dates.filter(d => !postA.dayHitMap[d]).length, '/', cap.dates.length, ' B=', cap.dates.filter(d => !postB.dayHitMap[d]).length, '/', cap.dates.length);
console.log('日別発信数:', cap.dates.map(d => `${d}:${cap.perDay[d].selectedCount}(候補${cap.perDay[d].poolCount})`).join('  '));

console.log('\n--- 補助表(3,000円均等回収配分、配分規則固定) ---');
const postA_er = evalEqualRet(cap.selected, 'bandPointsA');
const postB_er = evalEqualRet(cap.selected, 'bandPointsB');
console.log('A: stake=', postA_er.stake, ' payout=', postA_er.payout, ' ROI=', postA_er.roi.toFixed(1) + '%');
console.log('B: stake=', postB_er.stake, ' payout=', postB_er.payout, ' ROI=', postB_er.roi.toFixed(1) + '%');

// ===== Aだけ的中/Bだけ的中/両方的中(上限適用後の集合で) =====
let onlyA = 0, onlyB = 0, both = 0, neither = 0;
for (const r of cap.selected) {
  const hitA = r.chakuju && r.bandPointsA.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
  const hitB = r.chakuju && r.bandPointsB.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
  if (hitA && hitB) both++; else if (hitA) onlyA++; else if (hitB) onlyB++; else neither++;
}
console.log('\n=== Aだけ的中/Bだけ的中/両方的中(帯内的中基準、上限適用後) ===');
console.log('Aだけ:', onlyA, ' Bだけ:', onlyB, ' 両方:', both, ' どちらも外れ:', neither);

// ===== 事後診断(実行可能な選別ルールとは扱わない) =====
console.log('\n=== 事後診断: 結果が帯内だったのに外したレース(A・Bそれぞれ) ===');
function missDiagnosis(pool, field, universeField) {
  let outOfBandAtBet = 0, inBandNotSelected = 0, resultBandTotal = 0;
  for (const r of pool) {
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    if (!isResultBand) continue;
    resultBandTotal++;
    const pts = r[field];
    const isHit = r.chakuju && pts.includes(r.chakuju);
    if (isHit) continue; // 的中していれば「外した」対象ではない
    const oddsAtBet = r.chakujuOddsAtBet;
    const wasInBandAtBet = oddsAtBet != null && oddsAtBet >= 50 && oddsAtBet <= 150;
    if (!wasInBandAtBet) outOfBandAtBet++; else inBandNotSelected++;
  }
  return { resultBandTotal, outOfBandAtBet, inBandNotSelected };
}
const diagA = missDiagnosis(cap.selected, 'bandPointsA');
const diagB = missDiagnosis(cap.selected, 'bandPointsB');
console.log('A: 結果帯内レース', diagA.resultBandTotal, '件のうち、①予想時点で帯外だった=', diagA.outOfBandAtBet, '件 ②予想時点は帯内だったが選べなかった=', diagA.inBandNotSelected, '件');
console.log('B: 結果帯内レース', diagB.resultBandTotal, '件のうち、①予想時点で帯外だった=', diagB.outOfBandAtBet, '件 ②予想時点は帯内だったが選べなかった=', diagB.inBandNotSelected, '件');
console.log('(注: これは事後診断であり、実行可能な選別ルールや救済可能率としては扱わない)');

const manifest = {
  generatedAt: new Date().toISOString(), qEngineVersion: engine.Q_ENGINE_VERSION,
  scopeNote: '探索的比較(既に分析済みのデータ)。独立ホールドアウトではない。新たな閾値・特徴量探索なし。Qの参入条件・帯内買い目有無に依存する範囲の比較。',
  candidatePoolCount: candidatePool.length,
  excluded: { notFull120: excluded120.length, kMismatch: excludedKMismatch.length },
  comparePoolCount: comparePool.length,
  preCap: { A: preA, B: preB },
  postCap: { A: { ...postA, dayHitMap: undefined }, B: { ...postB, dayHitMap: undefined }, perDay: cap.perDay, dates: cap.dates },
  postCapEqualRet: { A: postA_er, B: postB_er },
  onlyAOnlyBBoth: { onlyA, onlyB, both, neither },
  missDiagnosis: { A: diagA, B: diagB },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_band50to150_bet_selection_verdict_2026-09-02.json'), JSON.stringify(manifest, null, 2));
console.log('\n結果を logs/research_band50to150_bet_selection_verdict_2026-09-02.json へ保存しました。');
