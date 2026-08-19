'use strict';
// 2026-08-19: CEOの「1日15〜20件は欲しい」という要望を受け、新VENUE_ROI(SCORE_ENGINE_VERSION=8)
// 適用後の母集団でROI閾値を70〜91の範囲でスイープし、どの閾値で目標件数に届くか、
// その時の的中率・ROI・収支がどうなるかを可視化する。ロジックは一切変更しない(診断専用)。
// 使い方: node tests/roi_threshold_sweep_volume.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const SHIKIN = 3000;
const GAP_THRESH = 10;
const THRESH_SWEEP = [91, 88, 85, 82, 79, 76, 73, 70, 65, 60];

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
    "'use strict';", "let selectedRaceType = 'ippan';",
    ...constSources.map((s, i) => `const ${CONST_NAMES[i]} = ${s.replace(/^const\s+\w+\s*=\s*/, '')}`),
    ...funcSources,
    'module.exports = {', '  setRaceType(v) { selectedRaceType = v; },',
    ...FUNCTION_NAMES.map(name => `  ${name},`), '};',
  ].join('\n\n');
  const tmpDir = path.join(os.tmpdir(), 'garon-thresh-sweep');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `sweep.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);
  const engine = require(tmpFile);
  engine.version = version;
  return engine;
}
function listArchiveFiles() {
  return fs.readdirSync(ROOT).filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
}
function parsePayout100(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function allocateStakesEqualRet(betVals, oddsMap, shikin) {
  const odds = betVals.map(v => parseFloat(oddsMap[v]) || 0);
  const anyOdds = odds.some(o => o > 0);
  let weights;
  if (anyOdds) {
    const validOdds = odds.filter(o => o > 0);
    const avgOdds = validOdds.reduce((s, o) => s + o, 0) / Math.max(1, validOdds.length);
    weights = odds.map(o => 1 / (o > 0 ? o : avgOdds));
  } else { weights = odds.map(() => 1); }
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
  const isNarrowGap = (mode === 'normal' && autoNige !== 'high' && gap < GAP_THRESH);
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
  const goseiOdds = (Object.keys(oddsMap).length) ? (parseFloat(engine.calcGoseiOdds(betVals, oddsMap)) || null) : null;
  const estRoiNew = engine.estimateROI(mode, venue, stdev, goseiOdds);
  return { date: entry.date, hit, stake, payout, profit: payout - stake, isNarrowGap, estRoiNew };
}

function main() {
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}\n`);
  engine.setRaceType('ippan');
  const files = listArchiveFiles();
  const allRaces = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const entry of data) {
      if (!(entry.resulted && entry.chakuju && Array.isArray(entry.boats) && entry.boats.length === 6)) continue;
      if (!entry.oddsMap || Object.keys(entry.oddsMap).length < 100) continue;
      if (String(entry.chakuju).split('-').length !== 3) continue;
      try { allRaces.push(buildRaceRecord(engine, entry)); } catch (e) { /* skip */ }
    }
  }
  const days = new Set(allRaces.map(r => r.date)).size;
  console.log(`対象: ${files.length}日分アーカイブ、実開催${days}日、全${allRaces.length}件\n`);
  console.log('ROI閾値\t件数\t1日あたり\t的中率\tROI\t純損益\t1日あたり純損益\t最大DD');
  for (const thresh of THRESH_SWEEP) {
    const entered = allRaces.filter(r => !r.isNarrowGap && r.estRoiNew >= thresh);
    const n = entered.length;
    const hits = entered.filter(r => r.hit).length;
    const totalStake = entered.reduce((s, r) => s + r.stake, 0);
    const totalPayout = entered.reduce((s, r) => s + r.payout, 0);
    const netProfit = totalPayout - totalStake;
    let cum = 0, peak = 0, maxDD = 0;
    for (const r of entered) { cum += r.profit; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
    const roi = totalStake ? (totalPayout / totalStake * 100) : null;
    const hitRate = n ? (hits / n * 100) : null;
    console.log(`${thresh}\t${n}\t${(n / days).toFixed(1)}件/日\t${hitRate !== null ? hitRate.toFixed(1) : '-'}%\t${roi !== null ? roi.toFixed(1) : '-'}%\t${netProfit >= 0 ? '+' : ''}¥${netProfit.toLocaleString()}\t${netProfit >= 0 ? '+' : ''}¥${Math.round(netProfit / days).toLocaleString()}\t¥${maxDD.toLocaleString()}`);
  }
}
main();
