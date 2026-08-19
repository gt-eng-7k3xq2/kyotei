'use strict';
// 2026-08-19: VENUE_ROI再計算(SCORE_ENGINE_VERSION=8)後の新しい母集団で、研究部隊の
// 仮説(gap15-20限定・motor2ren>=35追加フィルタ・場限定平和島津)の費用対効果を再計算する。
// CEOの「②③は費用対効果をしっかり明文化して」という指示への対応。ロジックは一切変更しない(診断専用)。
// 使い方: node tests/hypothesis_cost_benefit.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const SHIKIN = 3000;
const ROI_THRESH = 91;
const GAP_THRESH = 10;

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
  const tmpDir = path.join(os.tmpdir(), 'garon-cost-benefit');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `cb.${Date.now()}.js`);
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
  let axisBoatNo = areScores[0].no;
  const b1RankBeforeFix = areScores.findIndex(s => String(s.no) === '1');
  if (b1RankBeforeFix === 1) {
    const promoGap = areScores[0].raw - areScores[1].raw;
    if (promoGap < 9) { const tmp = areScores[0]; areScores[0] = areScores[1]; areScores[1] = tmp; axisBoatNo = areScores[0].no; }
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

  const axisBoat = (entry.boats || []).find(b => String(b.no) === String(axisBoatNo)) || {};
  const axisMotor2ren = typeof axisBoat.motor2ren === 'number' ? axisBoat.motor2ren : null;

  const entered = !isNarrowGap && estRoiNew >= ROI_THRESH;
  return { date: entry.date, venue, racenum: entry.racenum, hit, stake, payout, profit: payout - stake, gap, mode, axisMotor2ren, entered };
}

function summarize(label, races) {
  const days = new Set(races.map(r => r.date)).size;
  const n = races.length;
  const hits = races.filter(r => r.hit).length;
  const totalStake = races.reduce((s, r) => s + r.stake, 0);
  const totalPayout = races.reduce((s, r) => s + r.payout, 0);
  const netProfit = totalPayout - totalStake;
  let cum = 0, peak = 0, maxDD = 0, curLoss = 0, maxLoss = 0;
  for (const r of races) {
    cum += r.profit;
    if (r.hit) curLoss = 0; else { curLoss++; maxLoss = Math.max(maxLoss, curLoss); }
    peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
  }
  const roi = totalStake ? (totalPayout / totalStake * 100) : null;
  const hitRate = n ? (hits / n * 100) : null;
  console.log(`\n【${label}】`);
  console.log(`  n=${n}件 / ${days}日間 (${days ? (n / days).toFixed(1) : '-'}件/日)`);
  console.log(`  的中率=${hitRate !== null ? hitRate.toFixed(1) : '-'}% ROI=${roi !== null ? roi.toFixed(1) : '-'}%`);
  console.log(`  投資合計=¥${totalStake.toLocaleString()} 回収合計=¥${totalPayout.toLocaleString()} 純損益=${netProfit >= 0 ? '+' : ''}¥${netProfit.toLocaleString()}`);
  console.log(`  1日あたり純損益=${days ? (netProfit / days >= 0 ? '+' : '') + '¥' + Math.round(netProfit / days).toLocaleString() : '-'}`);
  console.log(`  最大連敗=${maxLoss} 最大ドローダウン=¥${maxDD.toLocaleString()}`);
  return { label, n, days, hitRate, roi, totalStake, totalPayout, netProfit, maxLoss, maxDD };
}

function main() {
  console.log(`sg_narutou.html からロジックを抽出中... SCORE_ENGINE_VERSION確認用`);
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

  const entered = allRaces.filter(r => r.entered);
  console.log('='.repeat(70));
  console.log(`対象: ${files.length}日分アーカイブ、全${allRaces.length}件中、新VENUE_ROIでの現行閾値通過=${entered.length}件`);
  console.log('='.repeat(70));

  const baseline = summarize('現行閾値のみ(ベースライン、新VENUE_ROI反映後)', entered);

  const gapRestricted = entered.filter(r => r.gap >= 15 && r.gap < 20);
  const gapResult = summarize('仮説①: gap15-20限定', gapRestricted);

  const motorRestricted = entered.filter(r => r.axisMotor2ren !== null && r.axisMotor2ren >= 35);
  const motorResult = summarize('仮説②: 軸艇motor2ren>=35追加フィルタ', motorRestricted);

  const venueRestricted = entered.filter(r => r.venue === '平和島' || r.venue === '津');
  const venueResult = summarize('仮説③: 場限定(平和島・津)', venueRestricted);

  console.log('\n' + '='.repeat(70));
  console.log('費用対効果サマリー(ベースライン比較)');
  console.log('='.repeat(70));
  [gapResult, motorResult, venueResult].forEach(r => {
    const volumeChangePct = baseline.n ? ((r.n / (baseline.days ? baseline.n / baseline.days * r.days : baseline.n)) * 100 - 100) : 0;
    const zeroEntryDaysEstimate = r.days && baseline.days ? Math.max(0, baseline.days - r.days) : null;
    console.log(`\n${r.label}:`);
    console.log(`  件数: ${baseline.n}件 → ${r.n}件 (${r.n - baseline.n >= 0 ? '+' : ''}${r.n - baseline.n}件、${((r.n / baseline.n - 1) * 100).toFixed(0)}%)`);
    console.log(`  1日あたり: ${(baseline.n / baseline.days).toFixed(1)}件/日 → ${r.days ? (r.n / r.days).toFixed(1) : '-'}件/日`);
    console.log(`  ROI: ${baseline.roi.toFixed(1)}% → ${r.roi !== null ? r.roi.toFixed(1) : '-'}% (${r.roi !== null ? (r.roi - baseline.roi >= 0 ? '+' : '') + (r.roi - baseline.roi).toFixed(1) : '-'}pt)`);
    console.log(`  最大DD: ¥${baseline.maxDD.toLocaleString()} → ¥${r.maxDD.toLocaleString()}`);
  });
}

main();
