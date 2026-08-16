'use strict';
// 「実際に運用していたらどうなっていたか」の時系列フル・シミュレーション。
// 2026-07-01〜08-08(結果入力済みの39日分。08-04〜08-08はPlaywright収集分だが
// scripts/backfill_official_results.jsで公式サイトから結果を紐付け済み)を
// 日付+締切時刻順に走査し、
//   新ロジック(SCORE_ENGINE_VERSION=6, 合成オッズ補正込み・閾値82)
//   旧ロジック(閾値74, 合成オッズ補正なし)
// それぞれで実際に参入したレースの的中・回収(1点100円均等)を積み上げて比較する。
// ロジックは一切変更しない(診断専用)。
//
// 使い方: node tests/full_backtest_simulation.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const ARCHIVE_DATE_MIN = '2026-07-01';
const ARCHIVE_DATE_MAX = '2026-08-08';

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
  const tmpDir = path.join(os.tmpdir(), 'garon-full-backtest');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `full_backtest.${Date.now()}.js`);
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
  if (!s) return 9999; // 締切不明は日内の最後扱い
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function parsePayout(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
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
  const isNarrowGap = (mode === 'normal' && autoNige !== 'high' && gap < 10);
  const stdev = engine.calcStdev(areScores);
  const venue = entry.venue || '不明';

  const pts = engine.decideProbabilisticPts([{ score: areScores[0].raw }, { score: areScores[1].raw }]);
  const ranking = areScores.map((s, i) => ({ rank: i + 1, boat: parseInt(s.no, 10), mark: MARKS[i] || '×', score: s.raw }));
  const bets = engine.buildBetsProbabilistic(ranking, pts);
  const hit = bets.some(b => b.val === entry.chakuju);
  const stake = bets.length * 100;
  const payout = hit ? parsePayout(entry.payout) : 0;

  const goseiOdds = (entry.oddsMap && Object.keys(entry.oddsMap).length)
    ? (parseFloat(engine.calcGoseiOdds(bets.map(b => b.val), entry.oddsMap)) || null)
    : null;

  const estRoiOld = engine.estimateROI(mode, venue, stdev);
  const estRoiNew = engine.estimateROI(mode, venue, stdev, goseiOdds);
  const judgeOld = isNarrowGap ? 'skip' : (estRoiOld >= 74 ? 'enter' : 'skip');
  const judgeNew = isNarrowGap ? 'skip' : (estRoiNew >= 82 ? 'enter' : 'skip');

  return {
    date: entry.date, venue, racenum: entry.racenum,
    shimekiriMin: shimekiriMinutes(entry.shimekiri),
    hit, stake, payout, profit: payout - stake,
    judgeOld, judgeNew,
  };
}

function loadAllRacesChronological(engine, files) {
  const races = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const dayRaces = [];
    for (const entry of data) {
      if (!(entry.resulted && entry.chakuju && Array.isArray(entry.boats) && entry.boats.length === 6)) continue;
      if (String(entry.chakuju).split('-').length !== 3) continue;
      try { dayRaces.push(buildRaceRecord(engine, entry)); } catch (e) { /* skip */ }
    }
    dayRaces.sort((a, b) => a.shimekiriMin - b.shimekiriMin); // 日内は締切時刻順(時系列)
    races.push(...dayRaces);
  }
  return races; // 全体は既にファイル名(日付)順→日内時刻順で時系列になっている
}

// 指定ルールで参入したレースだけを抽出し、時系列で累積収支・連敗・最大ドローダウン・週次推移を計算
function computeSeries(allRaces, judgeKey, label) {
  const entered = allRaces.filter(r => r[judgeKey] === 'enter');
  let cumProfit = 0, peak = 0, maxDrawdown = 0;
  let curLossStreak = 0, maxLossStreak = 0;
  let hits = 0, totalStake = 0, totalPayout = 0;
  const weekly = {}; // 週キー -> {n,hits,stake,payout,profit}
  const timeline = [];

  for (const r of entered) {
    cumProfit += r.profit;
    totalStake += r.stake;
    totalPayout += r.payout;
    if (r.hit) { hits++; curLossStreak = 0; } else { curLossStreak++; maxLossStreak = Math.max(maxLossStreak, curLossStreak); }
    peak = Math.max(peak, cumProfit);
    maxDrawdown = Math.max(maxDrawdown, peak - cumProfit);

    const weekIdx = weekBucket(r.date);
    if (!weekly[weekIdx]) weekly[weekIdx] = { n: 0, hits: 0, stake: 0, payout: 0 };
    weekly[weekIdx].n++;
    if (r.hit) weekly[weekIdx].hits++;
    weekly[weekIdx].stake += r.stake;
    weekly[weekIdx].payout += r.payout;

    timeline.push({ date: r.date, venue: r.venue, racenum: r.racenum, hit: r.hit, profit: r.profit, cumProfit });
  }

  return {
    label, n: entered.length, hits,
    hitRate: entered.length ? hits / entered.length * 100 : null,
    totalStake, totalPayout,
    roi: totalStake ? totalPayout / totalStake * 100 : null,
    netProfit: totalPayout - totalStake,
    maxLossStreak, maxDrawdown, weekly, timeline,
  };
}

function weekBucket(dateStr) {
  const start = new Date('2026-07-01T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.floor((d - start) / 86400000);
  return Math.floor(diffDays / 7); // 0-indexed week number(07-01起点の7日区切り)
}
function weekLabel(idx) {
  const start = new Date('2026-07-01T00:00:00');
  const s = new Date(start); s.setDate(s.getDate() + idx * 7);
  const e = new Date(start); e.setDate(e.getDate() + idx * 7 + 6);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${fmt(s)}〜${fmt(e)}`;
}

function main() {
  console.log(`sg_narutou.html からロジックを抽出中... (${HTML_PATH})`);
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan');

  const files = listArchiveFiles();
  const dates = files.map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1]);
  console.log(`シミュレーション対象: ${files.length}日分 (${dates[0]} 〜 ${dates[dates.length - 1]})`);
  console.log('※ 2026-08-04〜08-08はPlaywright収集分だが、backfill_official_results.jsで公式サイトから結果を紐付け済み\n');

  const allRaces = loadAllRacesChronological(engine, files);
  console.log(`総レース数(時系列): ${allRaces.length}\n`);

  const oldSeries = computeSeries(allRaces, 'judgeOld', '旧ロジック(閾値74・合成オッズ補正なし)');
  const newSeries = computeSeries(allRaces, 'judgeNew', '新ロジック(閾値82・合成オッズ補正込み)');

  console.log('='.repeat(80));
  console.log('1&2. 総合サマリー(新旧比較)');
  console.log('='.repeat(80));
  [oldSeries, newSeries].forEach(s => {
    console.log(`\n【${s.label}】`);
    console.log(`  参戦件数: ${s.n}件 (1日あたり約${(s.n / files.length).toFixed(1)}件)`);
    console.log(`  的中率  : ${s.hitRate.toFixed(1)}% (${s.hits}/${s.n})`);
    console.log(`  総投資額: ¥${s.totalStake.toLocaleString()}`);
    console.log(`  総回収額: ¥${s.totalPayout.toLocaleString()}`);
    console.log(`  総回収率: ${s.roi.toFixed(1)}%`);
    console.log(`  純損益  : ${s.netProfit >= 0 ? '+' : ''}¥${s.netProfit.toLocaleString()}`);
    console.log(`  最大連敗: ${s.maxLossStreak}連敗`);
    console.log(`  最大ドローダウン(累積収支のピークからの最大下落幅): ¥${s.maxDrawdown.toLocaleString()}`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('3. 週単位の推移(07-01起点の7日区切り)');
  console.log('='.repeat(80));
  const allWeekIdx = [...new Set([...Object.keys(oldSeries.weekly), ...Object.keys(newSeries.weekly)].map(Number))].sort((a, b) => a - b);
  console.log('\n週               旧: n  的中率  週損益      累積損益  |  新: n  的中率  週損益      累積損益');
  let cumOld = 0, cumNew = 0;
  for (const wi of allWeekIdx) {
    const wo = oldSeries.weekly[wi] || { n: 0, hits: 0, stake: 0, payout: 0 };
    const wn = newSeries.weekly[wi] || { n: 0, hits: 0, stake: 0, payout: 0 };
    const profitOld = wo.payout - wo.stake; cumOld += profitOld;
    const profitNew = wn.payout - wn.stake; cumNew += profitNew;
    const hrOld = wo.n ? (wo.hits / wo.n * 100).toFixed(0) + '%' : '-';
    const hrNew = wn.n ? (wn.hits / wn.n * 100).toFixed(0) + '%' : '-';
    console.log(
      `${weekLabel(wi).padEnd(12)}  ${String(wo.n).padStart(3)}  ${hrOld.padStart(4)}  ${(profitOld >= 0 ? '+' : '') + profitOld}`.padEnd(52) +
      `${(cumOld >= 0 ? '+' : '') + cumOld}`.padStart(9) + '  |  ' +
      `${String(wn.n).padStart(3)}  ${hrNew.padStart(4)}  ${(profitNew >= 0 ? '+' : '') + profitNew}`.padEnd(20) +
      `${(cumNew >= 0 ? '+' : '') + cumNew}`.padStart(9)
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('4. 大きくマイナスに振れた期間の詳細(新ロジック、ドローダウン最大地点周辺)');
  console.log('='.repeat(80));
  function reportWorstDrawdownWindow(series) {
    let peak = 0, peakIdx = -1, worstDD = 0, worstIdx = -1, worstPeakIdx = -1;
    series.timeline.forEach((t, i) => {
      if (t.cumProfit > peak) { peak = t.cumProfit; peakIdx = i; }
      const dd = peak - t.cumProfit;
      if (dd > worstDD) { worstDD = dd; worstIdx = i; worstPeakIdx = peakIdx; }
    });
    if (worstIdx === -1) { console.log('  該当なし'); return; }
    const peakT = series.timeline[worstPeakIdx], troughT = series.timeline[worstIdx];
    console.log(`  ピーク: ${peakT.date} ${peakT.venue}${peakT.racenum}R時点で累積+¥${peakT.cumProfit.toLocaleString()}`);
    console.log(`  → 谷 : ${troughT.date} ${troughT.venue}${troughT.racenum}R時点で累積+¥${troughT.cumProfit.toLocaleString()} (下落幅 ¥${worstDD.toLocaleString()})`);
  }
  console.log('【旧ロジック】'); reportWorstDrawdownWindow(oldSeries);
  console.log('【新ロジック】'); reportWorstDrawdownWindow(newSeries);
}

main();
