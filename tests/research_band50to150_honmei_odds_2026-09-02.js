'use strict';
// GARON-20260901-003 継続(CEO承認、2026-09-02): 「Q本命目の締切前オッズが50〜150倍」という
// 選別条件の限定研究実装・探索的検証。新規モデル学習・新しい閾値探索は行わない。
// 本番Q・通知・紙上記録・原本・公開設定は無変更。

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;
const DAILY_CAP = 10;
const ODDS_WEIGHT = 1.5; // 本番tieredFormation()と同一定数(garon_q_engine.html)
const EPS = 1e-9;

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

function scoreOfPoint(support, val, oddsMap) {
  const [, b2, b3] = val.split('-').map(Number);
  const s2 = support.find(s => s.no === b2); const s3 = support.find(s => s.no === b3);
  const raw = (s2 ? s2.rawScore : 0) + (s3 ? s3.rawScore : 0);
  const o = oddsMap[val];
  const bonus = (o && o > 0) ? Math.log(o) * ODDS_WEIGHT : 0;
  return raw + bonus;
}

function buildRaceRecord(engine, r) {
  let bets; try { bets = engine.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { return null; }
  if (!bets.judge.entered) return null;
  const axisBoat = bets.axes && bets.axes[0] ? bets.axes[0].boat : null;
  if (axisBoat === 1) return null; // 現行通知条件(軸≠1号艇)
  const allPoints = [...new Set((bets.formations || []).flatMap(f => f.points || []))];
  const bandPoints = allPoints.filter(p => { const o = (r.oddsMap || {})[p]; return o != null && o >= 50 && o <= 150; });
  if (bandPoints.length === 0) return null; // 候補プールの前提(帯内候補が1つ以上)

  // 「Q本命目」= formations[0](=軸0=topAxis、gap計算と同一の軸)のpoints[0]
  // (tieredFormation内で score=scoreOf(b2)+scoreOf(b3)+oddsBonus(val) により降順ソート済みの先頭)
  const f0 = bets.formations && bets.formations[0];
  let honmeiPoint = null, honmeiOdds = null, honmeiInBand = false, topTie = null, topScore = null, secondScore = null;
  if (f0 && f0.axis === axisBoat && f0.points && f0.points.length >= 1) {
    honmeiPoint = f0.points[0];
    honmeiOdds = (r.oddsMap || {})[honmeiPoint];
    honmeiInBand = honmeiOdds != null && honmeiOdds >= 50 && honmeiOdds <= 150;
    topScore = scoreOfPoint(bets.support, f0.points[0], r.oddsMap || {});
    if (f0.points.length >= 2) {
      secondScore = scoreOfPoint(bets.support, f0.points[1], r.oddsMap || {});
      topTie = Math.abs(topScore - secondScore) < EPS;
    } else {
      topTie = false; // 候補が1点のみ=タイの余地なし
    }
  }

  const sMin = shimekiriMin(r.shimekiri);
  return {
    date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: sMin,
    allPoints, bandPoints, chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100, oddsMap: r.oddsMap,
    honmeiPoint, honmeiOdds, honmeiInBand, topTie, topScore, secondScore, f0PointsCount: f0 ? f0.points.length : 0,
  };
}

console.log('=== GARON-20260901-003 継続: 「Q本命目オッズ50-150倍」選別条件の限定検証(2026-09-02) ===\n');
console.log('【明記】この報告の評価期間は全て既に分析済みのデータ(真T-10、2026-08-21〜08-31)。探索的評価であり独立した最終評価ではない。\n');

const engine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
console.log('Q_ENGINE_VERSION:', engine.Q_ENGINE_VERSION);

const all = loadAllRaces();
const usable = all.filter(isUsable);
const trueT10 = usable.filter(r => classifyOddsTiming(r).cls === 'true');
const candidatePool = trueT10.map(r => buildRaceRecord(engine, r)).filter(Boolean);
console.log('真T-10 n=', trueT10.length, ' 候補プール(帯内買い目あり・軸≠1号艇) n=', candidatePool.length, '(前回514のはず)');

// ===== 指示1: 「本命目」の意味のある順位が存在するか(タイ率チェック) =====
console.log('\n=== 指示1: 「Q本命目」(formations[0].points[0])のタイ率チェック ===');
const withSecond = candidatePool.filter(r => r.f0PointsCount >= 2);
const singlePoint = candidatePool.filter(r => r.f0PointsCount === 1);
const ties = withSecond.filter(r => r.topTie);
console.log('formations[0]の候補が2点以上あるレース n=', withSecond.length, '(候補1点のみ=タイ判定不可 n=', singlePoint.length, ')');
console.log('うち1位と2位のスコアが完全同点(タイ) n=', ties.length, ' 比率=', (ties.length / Math.max(1, withSecond.length) * 100).toFixed(1) + '%');
console.log('→ タイでない(意味のある順位が付いている)レース n=', withSecond.length - ties.length, ' 比率=', ((withSecond.length - ties.length) / Math.max(1, withSecond.length) * 100).toFixed(1) + '%');
if (ties.length > 0) {
  console.log('タイ発生時のスコア差分布(先頭3件のサンプル):');
  ties.slice(0, 3).forEach(r => console.log(`  ${r.date} ${r.venue}${r.racenum}R: score=${r.topScore.toFixed(3)} (points[0]=${r.honmeiPoint})`));
}

// ===== 仮説の記録 =====
console.log('\n=== 検証前の仮説記録(指示1) ===');
console.log('仮説: 「Q本命目(軸を含む最有力の三連単1点)の締切前オッズが50〜150倍の帯内にある」レースは、');
console.log('市場とQの評価がどちらも「大穴でも堅すぎもしない」という中間的な合意状態にあることを意味する。');
console.log('この状態のレースは、レース結果の不確実性がQの買い目集合(軸+紐候補群)の想定する分散と近く、');
console.log('本命目そのものが外れても紐候補群でカバーできる確率、および当たった場合の配当が50〜150倍という');
console.log('狙う帯に収まる確率の両方が、本命目が超堅い(オッズ<50)か超大穴(オッズ>150)のレースより高いはず、という仮説。');
console.log('注意: これは「帯への適合条件」であり検証前の時点では的中率改善の根拠ではない。的中率が実際に上がるかはB群/A群比較で確認する。\n');

// ===== 指示2・3: 全期間(既知データ、探索的)でA/B比較 =====
console.log('=== 指示2/3: 方式A(帯内買い目あり)と方式B(+Q本命目も帯内)の比較 ===');
const passB = candidatePool.filter(r => r.honmeiInBand);
const failB = candidatePool.filter(r => !r.honmeiInBand);
console.log('全候補プール n=', candidatePool.length, ' うちB条件通過(本命目も帯内) n=', passB.length, ' 非通過 n=', failB.length);

function bandHitRateNoCap(pool) {
  const hits = pool.filter(r => r.chakuju && r.bandPoints.includes(r.chakuju)).length;
  return { n: pool.length, bandHit: hits, rate: pool.length ? hits / pool.length * 100 : null };
}
console.log('【上限適用前】条件通過群の帯内的中率(実際に購入した場合、bandPoints基準):', JSON.stringify(bandHitRateNoCap(passB)));
console.log('【上限適用前】条件非通過群の帯内的中率:', JSON.stringify(bandHitRateNoCap(failB)));
console.log('【上限適用前】全候補プール(参考、方式A相当の母集団全体):', JSON.stringify(bandHitRateNoCap(candidatePool)));

function evaluateSelected(selected, betField) {
  let confirmedBandHit = 0, anyHit = 0, resultBand = 0, stake = 0, payout = 0;
  const dayHitMap = {};
  for (const r of selected) {
    const betPoints = r[betField];
    const isHit = r.chakuju && betPoints.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isConfirmedBandHit = isHit && isResultBand;
    const amounts = allocateStakesEqualRet(betPoints, r.oddsMap, SHIKIN);
    const raceStake = amounts.reduce((s, a) => s + a, 0);
    let racePayout = 0;
    if (isHit) { const idx = betPoints.indexOf(r.chakuju); racePayout = Math.round(amounts[idx] / 100 * (r.payoutMul * 100)); }
    stake += raceStake; payout += racePayout;
    if (isConfirmedBandHit) { confirmedBandHit++; }
    if (isHit) anyHit++;
    if (isResultBand) resultBand++;
    if (isConfirmedBandHit) dayHitMap[r.date] = true;
  }
  const n = selected.length;
  return { n, confirmedBandHit, anyHit, resultBand, stake, payout, roi: stake ? payout / stake * 100 : null, dayHitMap };
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

const capA = applyDailyCap(candidatePool);
const capB = applyDailyCap(passB);
const resA = evaluateSelected(capA.selected, 'bandPoints');
const resB = evaluateSelected(capB.selected, 'bandPoints');

console.log('\n--- 【上限適用後】方式A(帯内買い目あり→締切順1日10件) ---');
console.log('n=', resA.n, ' 日数=', capA.dates.length, ' 1日平均=', (resA.n / capA.dates.length).toFixed(1));
console.log('帯内的中率(主指標)=', (resA.confirmedBandHit / resA.n * 100).toFixed(2) + '%', ' 全的中率=', (resA.anyHit / resA.n * 100).toFixed(2) + '%');
console.log('投資=', resA.stake, ' 払戻=', resA.payout, ' ROI=', resA.roi.toFixed(1) + '%');
console.log('無的中日数=', capA.dates.filter(d => !resA.dayHitMap[d]).length, '/', capA.dates.length);
console.log('日別発信数:', capA.dates.map(d => `${d}:${capA.perDay[d].selectedCount}(候補${capA.perDay[d].poolCount})`).join('  '));
console.log('10本以上出せた日=', capA.dates.filter(d => capA.perDay[d].selectedCount >= 10).length, '/', capA.dates.length,
  ' 8本以上=', capA.dates.filter(d => capA.perDay[d].selectedCount >= 8).length, '/', capA.dates.length);

console.log('\n--- 【上限適用後】方式B(帯内買い目あり+Q本命目も帯内→締切順1日10件) ---');
console.log('n=', resB.n, ' 日数=', capB.dates.length, ' 1日平均=', (resB.n / capB.dates.length).toFixed(1));
console.log('帯内的中率(主指標)=', (resB.confirmedBandHit / resB.n * 100).toFixed(2) + '%', ' 全的中率=', (resB.anyHit / resB.n * 100).toFixed(2) + '%');
console.log('投資=', resB.stake, ' 払戻=', resB.payout, ' ROI=', resB.roi.toFixed(1) + '%');
console.log('無的中日数=', capB.dates.filter(d => !resB.dayHitMap[d]).length, '/', capB.dates.length);
console.log('日別発信数:', capB.dates.map(d => `${d}:${capB.perDay[d].selectedCount}(候補${capB.perDay[d].poolCount})`).join('  '));
console.log('10本以上出せた日=', capB.dates.filter(d => capB.perDay[d].selectedCount >= 10).length, '/', capB.dates.length,
  ' 8本以上=', capB.dates.filter(d => capB.perDay[d].selectedCount >= 8).length, '/', capB.dates.length);

console.log('\n=== 比較サマリー ===');
console.log('方式A: n=', resA.n, ' 帯内的中率=', (resA.confirmedBandHit / resA.n * 100).toFixed(2) + '%', ' ROI=', resA.roi.toFixed(1) + '%', ' 1日平均=', (resA.n / capA.dates.length).toFixed(1) + '本');
console.log('方式B: n=', resB.n, ' 帯内的中率=', (resB.confirmedBandHit / resB.n * 100).toFixed(2) + '%', ' ROI=', resB.roi.toFixed(1) + '%', ' 1日平均=', (resB.n / capB.dates.length).toFixed(1) + '本');

const manifest = {
  generatedAt: new Date().toISOString(), qEngineVersion: engine.Q_ENGINE_VERSION,
  scopeNote: '探索的評価(既に分析済みのデータ)。独立ホールドアウトではない。新規閾値探索なし。',
  tieCheck: { withSecondCount: withSecond.length, singlePointCount: singlePoint.length, tieCount: ties.length, tieRatePct: (ties.length / Math.max(1, withSecond.length) * 100) },
  candidatePoolCount: candidatePool.length, passBCount: passB.length, failBCount: failB.length,
  noCapBandHitRate: { passB: bandHitRateNoCap(passB), failB: bandHitRateNoCap(failB), all: bandHitRateNoCap(candidatePool) },
  afterCap: { A: { ...resA, dayHitMap: undefined, perDay: capA.perDay, dates: capA.dates }, B: { ...resB, dayHitMap: undefined, perDay: capB.perDay, dates: capB.dates } },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_band50to150_honmei_odds_2026-09-02.json'), JSON.stringify(manifest, null, 2));
console.log('\n結果を logs/research_band50to150_honmei_odds_2026-09-02.json へ保存しました。');
