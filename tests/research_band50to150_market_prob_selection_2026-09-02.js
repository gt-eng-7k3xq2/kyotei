'use strict';
// GARON-20260901-003 継続(CEO承認、2026-09-02): レース選別尺度(市場参考分布の確率合計score)を
// 1件だけ実装・比較。買い目集合(Q由来の帯内買い目)は暫定固定し、変えるのはレース選別のみ。
// 新しい閾値・帯・特徴量の追加調整は行わない。本番Q・通知・紙上記録・原本・公開設定は無変更。
//
// score(race) = Σ_{p∈S} q_p,  q_i = (1/O_i) / Σ_{全120通り}(1/O_j)
// S = 発信するQ由来の帯内買い目集合(既存のbandPoints定義そのまま)
// 「真の確率」ではなく市場の参考分布(逆オッズ正規化)における買い目集合の確率合計。p×oddsのような
// 同点ランキング問題を避けるため、閾値通過の判定にのみ使い、日内の順位付けには一切使わない
// (日内は締切順のみ)。

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100; // 主比較
const SHIKIN_EQUALRET = 3000; // 補助表
const DAILY_CAP = 10;
const TRAIN_DATES = ['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25']; // 既存の開発期間
const EVAL_DATES = ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']; // 既存の比較期間

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
  if (!r.archivedAt) return { cls: 'unknown' };
  const archJST = new Date(new Date(r.archivedAt).getTime() + 9 * 3600 * 1000);
  const archDateJST = archJST.toISOString().slice(0, 10);
  const archMinJST = archJST.getUTCHours() * 60 + archJST.getUTCMinutes();
  const sMin = shimekiriMin(r.shimekiri);
  if (archDateJST === r.date && sMin != null) {
    const diff = sMin - archMinJST;
    if (diff >= 0 && diff <= 20) return { cls: 'true' };
  }
  return { cls: 'unknown' };
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
  if (axisBoat === 1) return null;
  const allPoints = [...new Set((bets.formations || []).flatMap(f => f.points || []))];
  const oddsMap = r.oddsMap || {};
  const bandPoints = allPoints.filter(p => { const o = oddsMap[p]; return o != null && o >= 50 && o <= 150; }); // S(暫定固定)
  if (bandPoints.length === 0) return null;

  const validOddsEntries = Object.entries(oddsMap).filter(([, v]) => parseFloat(v) > 0);
  const validCount = validOddsEntries.length;
  let score = null;
  if (validCount === 120) {
    const invSum = validOddsEntries.reduce((s, [, v]) => s + 1 / v, 0);
    const qMap = {};
    for (const [val, v] of validOddsEntries) qMap[val] = (1 / v) / invSum;
    score = bandPoints.reduce((s, p) => s + (qMap[p] || 0), 0);
  }

  const sMin = shimekiriMin(r.shimekiri);
  return {
    date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: sMin, validCount, score,
    bandPoints, k: bandPoints.length, chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100, oddsMap,
  };
}

console.log('=== GARON-20260901-003 継続: 市場参考分布スコアによるレース選別尺度の検証(2026-09-02) ===\n');
console.log('【明記】既存の開発期間(2026-08-21〜25)・比較期間(2026-08-26〜31)を維持。両方とも既に分析済みのため、以下は全て探索的検証であり独立した新規評価ではない。\n');

const engine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
console.log('Q_ENGINE_VERSION:', engine.Q_ENGINE_VERSION);

const all = loadAllRaces();
const usable = all.filter(isUsable);
const trueT10 = usable.filter(r => classifyOddsTiming(r).cls === 'true');
const candidateAll = trueT10.map(r => buildRecord(engine, r)).filter(Boolean);
const excluded120 = candidateAll.filter(r => r.validCount !== 120);
const candidatePool = candidateAll.filter(r => r.validCount === 120); // scoreが計算できるレースのみ(A/B共通)
console.log('真T-10 n=', trueT10.length, ' 帯内買い目ありの候補 n=', candidateAll.length, ' うち全120通り有効オッズ揃い n=', candidatePool.length, ' (除外', excluded120.length, '件、A/B共通適用)');

const trainPool = candidatePool.filter(r => TRAIN_DATES.includes(r.date));
const evalPool = candidatePool.filter(r => EVAL_DATES.includes(r.date));
console.log('開発期間(', TRAIN_DATES[0], '〜', TRAIN_DATES[TRAIN_DATES.length - 1], ') 候補 n=', trainPool.length);
console.log('比較期間(', EVAL_DATES[0], '〜', EVAL_DATES[EVAL_DATES.length - 1], ') 候補 n=', evalPool.length);

// ===== 閾値の機械的決定(開発期間のみ、的中・payout・ROIは不使用) =====
const TARGET_PER_DAY = 10;
const targetCount = TARGET_PER_DAY * TRAIN_DATES.length; // 50
const sortedTrainScores = trainPool.map(r => r.score).sort((a, b) => b - a); // 降順
const rankIdx = Math.min(targetCount, sortedTrainScores.length) - 1; // 0-indexed
const THRESHOLD = sortedTrainScores[rankIdx];
console.log('\n=== 閾値の機械的決定(指示通り、的中・payout・ROIは不使用) ===');
console.log('目標通過数 =', TARGET_PER_DAY, '件/日 ×', TRAIN_DATES.length, '日 =', targetCount);
console.log('開発期間の候補をscore降順に並べ、', targetCount, '番目の値を閾値とする(同点は閾値を跨いでも全て通過させる、固定規則)');
console.log('THRESHOLD =', THRESHOLD);
const trainPassCount = trainPool.filter(r => r.score >= THRESHOLD).length;
console.log('この閾値で開発期間が実際に通過する件数(上限適用前) =', trainPassCount, '(', (trainPassCount / TRAIN_DATES.length).toFixed(1), '件/日)');

// ===== 比較期間での適用(上限適用前) =====
console.log('\n=== 比較期間・上限適用前の通過状況 ===');
const evalPass = evalPool.filter(r => r.score >= THRESHOLD);
const evalFail = evalPool.filter(r => r.score < THRESHOLD);
console.log('全候補 n=', evalPool.length, ' うちB条件通過 n=', evalPass.length, ' 非通過 n=', evalFail.length);

// ===== 選別(日次上限、締切順のみ・同日並べ替えなし・水増しなし) =====
function applyDailyCap(pool) {
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  const dates = Object.keys(byDate).sort();
  const selected = []; const perDay = {};
  for (const date of dates) {
    const dayRaces = (byDate[date] || []).slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP); // 水増しなし、締切順のみ
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates };
}
const capA = applyDailyCap(evalPool); // 方式A: 既存の帯内買い目あり(scoreフィルタなし)
const capB = applyDailyCap(evalPass); // 方式B: score>=THRESHOLD

function evalFlat(pool) {
  let hit = 0, bandHit = 0, stake = 0, payout = 0, migratedOutHit = 0, totalPoints = 0;
  const dayHitMap = {};
  for (const r of pool) {
    const pts = r.bandPoints;
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isBandHit = isHit && isResultBand;
    const raceStake = pts.length * FLAT_STAKE;
    let racePayout = 0;
    if (isHit) racePayout = Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    stake += raceStake; payout += racePayout; totalPoints += pts.length;
    if (isHit) hit++;
    if (isBandHit) { bandHit++; dayHitMap[r.date] = true; }
    if (isHit && !isResultBand) migratedOutHit++;
  }
  return { n: pool.length, hit, bandHit, stake, payout, roi: stake ? payout / stake * 100 : null, migratedOutHit, avgPoints: pool.length ? totalPoints / pool.length : null, dayHitMap };
}
function evalEqualRet(pool) {
  let stake = 0, payout = 0;
  for (const r of pool) {
    const pts = r.bandPoints;
    const amounts = allocateStakesEqualRet(pts, r.oddsMap, SHIKIN_EQUALRET);
    const raceStake = amounts.reduce((s, a) => s + a, 0);
    const isHit = r.chakuju && pts.includes(r.chakuju);
    let racePayout = 0;
    if (isHit) { const idx = pts.indexOf(r.chakuju); racePayout = Math.round(amounts[idx] / 100 * (r.payoutMul * 100)); }
    stake += raceStake; payout += racePayout;
  }
  return { stake, payout, roi: stake ? payout / stake * 100 : null };
}

const resA = evalFlat(capA.selected);
const resB = evalFlat(capB.selected);
console.log('\n=== 【比較期間・締切順1日10件上限適用後】主比較(1点100円固定) ===');
console.log('A(既存・scoreフィルタなし): n=', resA.n, ' 帯内的中率=', (resA.bandHit / resA.n * 100).toFixed(2) + '%(', resA.bandHit, '件)', ' 全的中率=', (resA.hit / resA.n * 100).toFixed(2) + '%', ' ROI=', resA.roi.toFixed(1) + '%');
console.log('B(score>=閾値): n=', resB.n, ' 帯内的中率=', (resB.bandHit / resB.n * 100).toFixed(2) + '%(', resB.bandHit, '件)', ' 全的中率=', (resB.hit / resB.n * 100).toFixed(2) + '%', ' ROI=', resB.roi.toFixed(1) + '%');
console.log('無的中日数: A=', capA.dates.filter(d => !resA.dayHitMap[d]).length, '/', capA.dates.length, ' B=', capB.dates.filter(d => !resB.dayHitMap[d]).length, '/', capB.dates.length);
console.log('確定時に帯外へ動いた的中数: A=', resA.migratedOutHit, ' B=', resB.migratedOutHit);
console.log('日別発信数 A:', capA.dates.map(d => `${d}:${capA.perDay[d].selectedCount}(候補${capA.perDay[d].poolCount})`).join('  '));
console.log('日別発信数 B:', capB.dates.map(d => `${d}:${capB.perDay[d].selectedCount}(候補${capB.perDay[d].poolCount})`).join('  '));

console.log('\n--- 補助表(3,000円均等回収配分) ---');
const resA_er = evalEqualRet(capA.selected);
const resB_er = evalEqualRet(capB.selected);
console.log('A: stake=', resA_er.stake, ' payout=', resA_er.payout, ' ROI=', resA_er.roi.toFixed(1) + '%');
console.log('B: stake=', resB_er.stake, ' payout=', resB_er.payout, ' ROI=', resB_er.roi.toFixed(1) + '%');

// ===== scoreの平均 vs 実際の全的中率 =====
console.log('\n=== scoreの平均と実際の全的中率の差(較正チェック) ===');
const avgScoreB = capB.selected.reduce((s, r) => s + r.score, 0) / Math.max(1, capB.selected.length);
const actualHitRateB = resB.hit / Math.max(1, resB.n);
console.log('B選出レースのscore平均(=市場参考分布での「買い目集合が当たる」想定確率) =', (avgScoreB * 100).toFixed(2) + '%');
console.log('B選出レースの実際の全的中率 =', (actualHitRateB * 100).toFixed(2) + '%');
console.log('差(実際−score平均) =', ((actualHitRateB - avgScoreB) * 100).toFixed(2) + 'pt');

// ===== 選別前後の点数分布(高scoreが単に点数の多さを拾っている可能性) =====
console.log('\n=== 選別前後の点数(k)分布 ===');
function stats(arr) { if (!arr.length) return { mean: null, median: null }; const s = arr.slice().sort((a, b) => a - b); const mean = s.reduce((x, y) => x + y, 0) / s.length; const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; return { mean, median }; }
console.log('候補全体(比較期間、n=' + evalPool.length + '): 点数平均=', stats(evalPool.map(r => r.k)).mean.toFixed(2), ' 中央値=', stats(evalPool.map(r => r.k)).median);
console.log('A選出(n=' + capA.selected.length + '): 点数平均=', stats(capA.selected.map(r => r.k)).mean.toFixed(2), ' 中央値=', stats(capA.selected.map(r => r.k)).median);
console.log('B選出(n=' + capB.selected.length + '): 点数平均=', stats(capB.selected.map(r => r.k)).mean.toFixed(2), ' 中央値=', stats(capB.selected.map(r => r.k)).median);
// score と k の相関(候補全体、比較期間)
function pearson(xs, ys) {
  const n = xs.length; const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / Math.sqrt(dx2 * dy2);
}
const corr = pearson(evalPool.map(r => r.k), evalPool.map(r => r.score));
console.log('比較期間候補全体でのscoreと点数kの相関係数(Pearson) =', corr.toFixed(3), '(1に近いほど「高scoreは単に点数が多いだけ」の疑いが強い)');

// ===== 目標との差 =====
console.log('\n=== 目標(10本前後・帯内的中率20%)との実際の差 ===');
console.log('A: 1日平均', (resA.n / capA.dates.length).toFixed(1), '本(目標10本) / 帯内的中率', (resA.bandHit / resA.n * 100).toFixed(2) + '%(目標20%、差', (20 - resA.bandHit / resA.n * 100).toFixed(1), 'pt)');
console.log('B: 1日平均', (resB.n / capB.dates.length).toFixed(1), '本(目標10本) / 帯内的中率', (resB.bandHit / resB.n * 100).toFixed(2) + '%(目標20%、差', (20 - resB.bandHit / resB.n * 100).toFixed(1), 'pt)');

const manifest = {
  generatedAt: new Date().toISOString(), qEngineVersion: engine.Q_ENGINE_VERSION,
  scopeNote: '探索的検証(既存の開発期間・比較期間を維持、両方使用済み)。独立ホールドアウトではない。結果を見た追加調整なし。',
  candidateAllCount: candidateAll.length, excluded120: excluded120.length, candidatePoolCount: candidatePool.length,
  trainPoolCount: trainPool.length, evalPoolCount: evalPool.length,
  threshold: { targetCount, threshold: THRESHOLD, trainPassCount, trainPassPerDay: trainPassCount / TRAIN_DATES.length },
  evalPassCount: evalPass.length, evalFailCount: evalFail.length,
  afterCap: { A: { ...resA, dayHitMap: undefined }, B: { ...resB, dayHitMap: undefined }, perDayA: capA.perDay, perDayB: capB.perDay, datesA: capA.dates, datesB: capB.dates },
  afterCapEqualRet: { A: resA_er, B: resB_er },
  calibration: { avgScoreB, actualHitRateB, diffPt: (actualHitRateB - avgScoreB) * 100 },
  pointDistribution: { candidateAll: stats(evalPool.map(r => r.k)), selectedA: stats(capA.selected.map(r => r.k)), selectedB: stats(capB.selected.map(r => r.k)), corrScoreK: corr },
  targetGap: { A: { avgPerDay: resA.n / capA.dates.length, bandHitRatePct: resA.bandHit / resA.n * 100 }, B: { avgPerDay: resB.n / capB.dates.length, bandHitRatePct: resB.bandHit / resB.n * 100 } },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_band50to150_market_prob_selection_2026-09-02.json'), JSON.stringify(manifest, null, 2));
console.log('\n結果を logs/research_band50to150_market_prob_selection_2026-09-02.json へ保存しました。');
