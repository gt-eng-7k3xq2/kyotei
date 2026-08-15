'use strict';
// 実際の資金配分ロジック(sg_narutou.html:recalcAlloc()の「均等回収」モード)を移植し、
// 1点100円均等ではなく実運用と同じ3,000円加重配分で収支シミュレーションを行う。
// あわせて、露出量の下限を外し「黒字化・高精度」だけを目的にROI閾値を86〜92で再探索する
// (held-out: 前半17日でチューニング→後半16日で検証、を維持)。
// ロジックは一切変更しない(診断専用)。
//
// 使い方: node tests/weighted_optimization_search.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const ARCHIVE_DATE_MIN = '2026-07-01';
const ARCHIVE_DATE_MAX = '2026-08-03';
const SHIKIN = 3000;
const CURRENT_GAP_THRESH = 10;
const CURRENT_ROI_THRESH = 82;
const ROI_SWEEP = [86, 87, 88, 89, 90, 91, 92];

const FUNCTION_NAMES = [
  'calcAreScore', 'calcNigeRate', 'calcAreIndex', 'judgeMode',
  'decideProbabilisticPts', '_plWinProbs', '_plConditionalProbs', '_selectWithPairCap',
  'buildBetsProbabilistic', 'calcStdev', 'estimateROI', 'stdevROIDelta',
  'goseiOddsDelta', 'calcGoseiOdds',
];
const CONST_NAMES = ['VENUE_ROI', 'MODE_ROI_BASE', 'OVERALL_AVG_ROI'];

function loadEngine(htmlPath) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const version = extractScoreEngineVersion(source);
  const funcSources = FUNCTION_NAMES.map(name => extractFunctionSource(source, name));
  const constSources = CONST_NAMES.map(name => extractConstSource(source, name));
  const moduleSource = [
    "'use strict';",
    "let selectedRaceType = 'ippan';",
    ...constSources.map((s, i) => `const ${CONST_NAMES[i]} = ${s.replace(/^const\s+\w+\s*=\s*/, '')}`),
    ...funcSources,
    'module.exports = {',
    '  setRaceType(v) { selectedRaceType = v; },',
    ...FUNCTION_NAMES.map(name => `  ${name},`),
    '};',
  ].join('\n\n');
  const tmpDir = path.join(os.tmpdir(), 'garon-weighted-opt');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `weighted_opt.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);
  const engine = require(tmpFile);
  engine.version = version;
  return engine;
}

function listArchiveFiles() {
  return fs.readdirSync(ROOT)
    .filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter(f => {
      const d = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
      return d >= ARCHIVE_DATE_MIN && d <= ARCHIVE_DATE_MAX;
    })
    .sort();
}

function shimekiriMinutes(s) {
  if (!s) return 9999;
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function parsePayout100(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// sg_narutou.html:recalcAlloc()の「均等回収(equalret)」を忠実に移植。
// betVals: ['1-2-3', ...] / oddsMap: {'1-2-3': 4.5, ...} / shikin: 3000
function allocateStakesEqualRet(betVals, oddsMap, shikin) {
  const odds = betVals.map(v => parseFloat(oddsMap[v]) || 0);
  const anyOdds = odds.some(o => o > 0);
  let weights;
  if (anyOdds) {
    const validOdds = odds.filter(o => o > 0);
    const avgOdds = validOdds.reduce((s, o) => s + o, 0) / Math.max(1, validOdds.length);
    weights = odds.map(o => 1 / (o > 0 ? o : avgOdds));
  } else {
    weights = odds.map(() => 1);
  }
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

const MARKS = ['◎', '○', '▲', '△', '▽', '×'];

function buildRaceRecord(engine, entry) {
  const d = { boats: entry.boats, venue: entry.venue, raceNum: entry.racenum };
  const areScores = engine.calcAreScore(d);
  const b1RankBeforeFix = areScores.findIndex(s => String(s.no) === '1');
  if (b1RankBeforeFix === 1) {
    const promoGap = areScores[0].raw - areScores[1].raw;
    if (promoGap < 9) { const tmp = areScores[0]; areScores[0] = areScores[1]; areScores[1] = tmp; }
  }
  const { areIndex, nigeRate } = engine.calcAreIndex(d);
  let mode = engine.judgeMode(areIndex, nigeRate);
  const boat1Rank = areScores.findIndex(s => String(s.no) === '1');
  if (nigeRate < 30 && boat1Rank > 0 && boat1Rank < 5) mode = 'nigenashi';
  const isAxisBoat1 = String(areScores[0].no) === '1';
  const autoNige = (isAxisBoat1 && nigeRate >= 85) ? 'high' : (isAxisBoat1 && nigeRate >= 50) ? 'mid' : 'low';
  const gap = areScores[0].raw - areScores[1].raw;
  const isNarrowGap = (mode === 'normal' && autoNige !== 'high' && gap < CURRENT_GAP_THRESH);
  const stdev = engine.calcStdev(areScores);
  const venue = entry.venue || '不明';

  const pts = engine.decideProbabilisticPts([{ score: areScores[0].raw }, { score: areScores[1].raw }]);
  const ranking = areScores.map((s, i) => ({ rank: i + 1, boat: parseInt(s.no, 10), mark: MARKS[i] || '×', score: s.raw }));
  const bets = engine.buildBetsProbabilistic(ranking, pts);
  const betVals = bets.map(b => b.val);
  const hitIdx = betVals.indexOf(entry.chakuju);
  const hit = hitIdx >= 0;

  const oddsMap = entry.oddsMap || {};
  const amounts = allocateStakesEqualRet(betVals, oddsMap, SHIKIN);
  const stake = amounts.reduce((s, a) => s + a, 0);
  const payout = hit ? Math.round(amounts[hitIdx] / 100 * parsePayout100(entry.payout)) : 0;

  const goseiOdds = (entry.oddsMap && Object.keys(entry.oddsMap).length)
    ? (parseFloat(engine.calcGoseiOdds(betVals, oddsMap)) || null)
    : null;
  const estRoiNew = engine.estimateROI(mode, venue, stdev, goseiOdds);
  const judgeAt = (thresh) => isNarrowGap ? 'skip' : (estRoiNew >= thresh ? 'enter' : 'skip');

  return {
    date: entry.date, venue, racenum: entry.racenum, shimekiriMin: shimekiriMinutes(entry.shimekiri),
    hit, stake, payout, profit: payout - stake, estRoiNew, judgeAt,
  };
}

function loadAllRacesChronological(engine, files) {
  const races = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const dayRaces = [];
    for (const entry of data) {
      if (!(entry.resulted && entry.chakuju && Array.isArray(entry.boats) && entry.boats.length === 6)) continue;
      if (!entry.oddsMap || Object.keys(entry.oddsMap).length < 100) continue; // 加重配分にはオッズがほぼ揃っている必要がある
      if (String(entry.chakuju).split('-').length !== 3) continue;
      try { dayRaces.push(buildRaceRecord(engine, entry)); } catch (e) { /* skip */ }
    }
    dayRaces.sort((a, b) => a.shimekiriMin - b.shimekiriMin);
    races.push(...dayRaces);
  }
  return races;
}

function computeSeries(allRaces, threshold, nDays) {
  const entered = allRaces.filter(r => r.judgeAt(threshold) === 'enter');
  let cumProfit = 0, peak = 0, maxDrawdown = 0, curLossStreak = 0, maxLossStreak = 0, hits = 0, totalStake = 0, totalPayout = 0;
  for (const r of entered) {
    cumProfit += r.profit; totalStake += r.stake; totalPayout += r.payout;
    if (r.hit) { hits++; curLossStreak = 0; } else { curLossStreak++; maxLossStreak = Math.max(maxLossStreak, curLossStreak); }
    peak = Math.max(peak, cumProfit);
    maxDrawdown = Math.max(maxDrawdown, peak - cumProfit);
  }
  return {
    threshold, n: entered.length, perDay: nDays ? entered.length / nDays : null, hits,
    hitRate: entered.length ? hits / entered.length * 100 : null,
    totalStake, totalPayout, roi: totalStake ? totalPayout / totalStake * 100 : null,
    netProfit: totalPayout - totalStake, maxLossStreak, maxDrawdown,
  };
}
function fmt(s) {
  return `n=${s.n}(${s.perDay.toFixed(1)}/日)\t的中率${s.hitRate.toFixed(1)}%\t投資¥${s.totalStake.toLocaleString()}\t回収¥${s.totalPayout.toLocaleString()}\tROI${s.roi.toFixed(1)}%\t純損益${s.netProfit >= 0 ? '+' : ''}¥${s.netProfit.toLocaleString()}\t最大連敗${s.maxLossStreak}\t最大DD¥${s.maxDrawdown.toLocaleString()}`;
}

function main() {
  console.log(`sg_narutou.html からロジックを抽出中... (${HTML_PATH})`);
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan');

  const files = listArchiveFiles();
  const dates = files.map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1]);
  const mid = Math.ceil(files.length / 2);
  const tuningFiles = files.slice(0, mid), holdoutFiles = files.slice(mid);
  console.log(`対象: ${files.length}日分 (${dates[0]}〜${dates[dates.length - 1]})、オッズほぼ揃っているレースのみ`);
  console.log(`チューニング用: ${tuningFiles.length}日 / 確認用: ${holdoutFiles.length}日\n`);

  const allRaces = loadAllRacesChronological(engine, files);
  const tuningRaces = loadAllRacesChronological(engine, tuningFiles);
  const holdoutRaces = loadAllRacesChronological(engine, holdoutFiles);

  // ============================================================
  // 1. 現行閾値82・実際の3,000円均等回収配分での再計算
  // ============================================================
  console.log('='.repeat(90));
  console.log(`1. 現行閾値(${CURRENT_ROI_THRESH})・3,000円均等回収配分での収支(全期間 ${files.length}日)`);
  console.log('='.repeat(90));
  const currentWeighted = computeSeries(allRaces, CURRENT_ROI_THRESH, files.length);
  console.log(fmt(currentWeighted));
  console.log('\n(参考: 前回の1点100円均等シミュレーションでは同じ閾値82でROI83.1%・純損益¥-269,730でした)');

  // ============================================================
  // 2. ROI閾値86〜92の再探索(3,000円配分ベース、露出量制約なし)
  // ============================================================
  console.log('\n' + '='.repeat(90));
  console.log('2. ROI閾値スイープ(86〜92、3,000円均等回収配分ベース)');
  console.log('='.repeat(90));

  console.log('\n[全期間での特性把握]');
  const allSweep = ROI_SWEEP.map(t => computeSeries(allRaces, t, files.length));
  allSweep.forEach(s => console.log(`ROI閾値${s.threshold}: ${fmt(s)}`));

  console.log('\n[held-out] チューニング用データ(前半)でROI最大の閾値を探索:');
  const tuningSweep = ROI_SWEEP.map(t => computeSeries(tuningRaces, t, tuningFiles.length));
  tuningSweep.forEach(s => console.log(`ROI閾値${s.threshold}: ${fmt(s)}`));
  const bestTuning = tuningSweep.reduce((a, b) => (b.roi > a.roi ? b : a));
  console.log(`\n→ チューニング用データでの最良閾値: ROI閾値=${bestTuning.threshold} (ROI=${bestTuning.roi.toFixed(1)}%, 1日${bestTuning.perDay.toFixed(1)}件)`);

  console.log(`\n[held-out検証] 上記閾値(${bestTuning.threshold})を確認用データ(後半)で検証:`);
  const holdoutResult = computeSeries(holdoutRaces, bestTuning.threshold, holdoutFiles.length);
  console.log(fmt(holdoutResult));
  const currentHoldout = computeSeries(holdoutRaces, CURRENT_ROI_THRESH, holdoutFiles.length);
  console.log(`(比較: 確認用データでの現行閾値${CURRENT_ROI_THRESH}: ${fmt(currentHoldout)})`);

  console.log('\n' + '='.repeat(90));
  console.log('判定');
  console.log('='.repeat(90));
  if (holdoutResult.roi > 100) {
    console.log(`✅ 確認用データでROI${holdoutResult.roi.toFixed(1)}%となり黒字化しました。`);
  } else if (holdoutResult.roi > currentHoldout.roi) {
    console.log(`⚠️ 確認用データでROI${holdoutResult.roi.toFixed(1)}%(現行${currentHoldout.roi.toFixed(1)}%より改善)ですが、黒字化(100%超)までは届いていません。`);
  } else {
    console.log(`⚠️ 確認用データでは現行閾値を上回りませんでした(過学習の可能性)。`);
  }
  console.log(`1日あたり参戦件数: ${holdoutResult.perDay.toFixed(1)}件(目標15〜20件との比較)`);
}

main();
