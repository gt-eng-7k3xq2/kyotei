'use strict';
// estRoi2(合成オッズ補正版)の閾値グリッドサーチに「露出量(1日あたり参戦件数)」の
// 制約を追加した診断ツール。前回(estroi_v2_diagnosis.js)はEVだけを最大化したため、
// 参戦件数が現行の約1/7まで激減する候補を選んでいた。今回はSNS運用上の最低参戦頻度を
// 守った上でのEV最大化を探る。ロジックは一切変更しない(診断専用)。
//
// 使い方: node tests/estroi_v2_exposure_search.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const ARCHIVE_DATE_MIN = '2026-07-01';
const ARCHIVE_DATE_MAX = '2026-08-03';
const FULL_ODDS_COMBOS = 120;
const N_BUCKETS = 5;
const ROI_SWEEP = [74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98];
const CURRENT_GAP_THRESH = 10; // gap閾値は現行のまま固定(前回の探索でROI閾値側の寄与が支配的だったため)
const EXPOSURE_FLOOR_RATIO = 0.5; // 現行ペースの何割までなら許容するか

const FUNCTION_NAMES = [
  'calcAreScore', 'calcNigeRate', 'calcAreIndex', 'judgeMode',
  'decideProbabilisticPts', '_plWinProbs', '_plConditionalProbs', '_selectWithPairCap',
  'buildBetsProbabilistic', 'calcStdev', 'estimateROI', 'stdevROIDelta', 'calcGoseiOdds',
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
  const tmpDir = path.join(os.tmpdir(), 'garon-estroi-v2-exposure');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `estroi_v2_exposure.${Date.now()}.js`);
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

function loadRaces(file) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return data.filter(e =>
    e.resulted && e.chakuju && Array.isArray(e.boats) && e.boats.length === 6 &&
    e.oddsMap && Object.keys(e.oddsMap).length === FULL_ODDS_COMBOS
  );
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
  const stdev = engine.calcStdev(areScores);
  const venue = entry.venue || '不明';
  const estRoiOld = engine.estimateROI(mode, venue, stdev);

  const pts = engine.decideProbabilisticPts([{ score: areScores[0].raw }, { score: areScores[1].raw }]);
  const ranking = areScores.map((s, i) => ({ rank: i + 1, boat: parseInt(s.no, 10), mark: MARKS[i] || '×', score: s.raw }));
  const bets = engine.buildBetsProbabilistic(ranking, pts);
  const hit = bets.some(b => b.val === entry.chakuju);
  const goseiOdds = parseFloat(engine.calcGoseiOdds(bets.map(b => b.val), entry.oddsMap)) || 0;
  const actualEV = hit ? goseiOdds * 100 : 0;

  const isNarrowGapOld = (mode === 'normal' && autoNige !== 'high' && gap < CURRENT_GAP_THRESH);
  const currentJudge = isNarrowGapOld ? 'skip' : (estRoiOld >= 74 ? 'enter' : 'skip');

  return { entry, date: entry.date, mode, autoNige, gap, stdev, venue, estRoiOld, goseiOdds, hit, actualEV, currentJudge };
}

function loadRaceSet(engine, files) {
  const races = [];
  for (const file of files) {
    for (const entry of loadRaces(file)) {
      const parts = String(entry.chakuju).split('-');
      if (parts.length !== 3) continue;
      try { races.push(buildRaceRecord(engine, entry)); } catch (e) { /* skip */ }
    }
  }
  return races;
}

function fitQuantileBoundaries(values, nBuckets) {
  const sorted = [...values].sort((a, b) => a - b);
  const boundaries = [];
  for (let i = 1; i < nBuckets; i++) boundaries.push(sorted[Math.floor(sorted.length * i / nBuckets)]);
  return boundaries;
}
function bucketOf(value, boundaries) {
  for (let i = 0; i < boundaries.length; i++) if (value < boundaries[i]) return i;
  return boundaries.length;
}
function fitGoseiOddsDelta(tuningRaces) {
  const boundaries = fitQuantileBoundaries(tuningRaces.map(r => r.goseiOdds), N_BUCKETS);
  const buckets = Array.from({ length: N_BUCKETS }, () => ({ n: 0, residSum: 0 }));
  for (const r of tuningRaces) {
    const b = bucketOf(r.goseiOdds, boundaries);
    buckets[b].n++;
    buckets[b].residSum += (r.actualEV - r.estRoiOld);
  }
  const deltas = buckets.map(b => b.n ? b.residSum / b.n : 0);
  return { boundaries, fn(goseiOdds) { return deltas[bucketOf(goseiOdds, boundaries)]; } };
}

function summarize(races, days) {
  const n = races.length;
  const hits = races.filter(r => r.hit).length;
  const evSum = races.reduce((s, r) => s + r.actualEV, 0);
  return {
    n, days,
    perDay: days ? n / days : null,
    hitRate: n ? hits / n * 100 : null,
    ev: n ? evSum / n : null,
  };
}
function fmtRow(label, s) {
  return `${label}\tn=${s.n}\t1日あたり${s.perDay !== null ? s.perDay.toFixed(1) : 'N/A'}件\t的中率${s.hitRate !== null ? s.hitRate.toFixed(1) : 'N/A'}%\tEV${s.ev !== null ? s.ev.toFixed(1) : 'N/A'}%`;
}

function main() {
  console.log(`sg_narutou.html からロジックを抽出中... (${HTML_PATH})`);
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan');

  const files = listArchiveFiles();
  const dates = files.map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1]);
  const mid = Math.ceil(files.length / 2);
  const tuningFiles = files.slice(0, mid);
  const holdoutFiles = files.slice(mid);
  const totalDays = files.length; // 実データがある日数(33日。07-31欠落のため34ではない)

  console.log(`対象: ${totalDays}日分 (${dates[0]}〜${dates[dates.length - 1]})。ご依頼の「34日間」ですが07-31分のアーカイブが欠落しているため、実際は${totalDays}日で計算します(件数÷${totalDays}が正しい1日あたり平均)`);

  const allRaces = loadRaceSet(engine, files);
  const tuningRaces = loadRaceSet(engine, tuningFiles);
  const holdoutRaces = loadRaceSet(engine, holdoutFiles);
  const tuningDays = tuningFiles.length, holdoutDays = holdoutFiles.length;

  // ============================================================
  // 3. 現行運用ペースの基準値(本番と同じ gap<10 & 旧estRoi>=74)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('3. 現行設定(gap<10 / 旧estRoi>=74、本番と同じ判定式)での運用ペース基準値');
  console.log('='.repeat(70));
  const currentAll = summarize(allRaces.filter(r => r.currentJudge === 'enter'), totalDays);
  console.log(fmtRow('全期間(基準値)', currentAll));
  const exposureFloor = currentAll.perDay * EXPOSURE_FLOOR_RATIO;
  console.log(`\n→ 基準値: 1日あたり約${currentAll.perDay.toFixed(1)}件。露出量の下限ライン(半分)は 1日あたり${exposureFloor.toFixed(1)}件 とします。`);

  // ============================================================
  // estRoi2の学習(チューニング用データのみ)
  // ============================================================
  const goseiFit = fitGoseiOddsDelta(tuningRaces);
  function estRoi2(r) { return r.estRoiOld + goseiFit.fn(r.goseiOdds); }

  // ============================================================
  // 1&2. ROI閾値スイープ(gap閾値は現行10で固定、estRoi2使用)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log(`1&2. estRoi2 閾値スイープ(gap<${CURRENT_GAP_THRESH}固定、全${totalDays}日で集計)`);
  console.log('='.repeat(70));
  console.log('ROI閾値\tn\t1日あたり件数\t的中率\tEV\t露出量条件');
  function judgeWith(r, roiThresh) {
    const isNarrowGap = (r.mode === 'normal' && r.autoNige !== 'high' && r.gap < CURRENT_GAP_THRESH);
    if (isNarrowGap) return 'skip';
    return estRoi2(r) >= roiThresh ? 'enter' : 'skip';
  }
  const sweepAll = [];
  for (const roiThresh of ROI_SWEEP) {
    const entered = allRaces.filter(r => judgeWith(r, roiThresh) === 'enter');
    const s = summarize(entered, totalDays);
    const ok = s.perDay !== null && s.perDay >= exposureFloor;
    sweepAll.push({ roiThresh, ...s, ok });
    console.log(`${roiThresh}\t${s.n}\t${s.perDay !== null ? s.perDay.toFixed(1) : 'N/A'}\t${s.hitRate !== null ? s.hitRate.toFixed(1) + '%' : 'N/A'}\t${s.ev !== null ? s.ev.toFixed(1) + '%' : 'N/A'}\t${ok ? '✅ 条件内' : '❌ 下限割れ'}`);
  }

  // ============================================================
  // 4. 露出量制約下でのEV最大化候補
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log(`4. 露出量制約(1日あたり${exposureFloor.toFixed(1)}件以上)を満たす中でEV最大の閾値`);
  console.log('='.repeat(70));
  const eligible = sweepAll.filter(s => s.ok);
  if (!eligible.length) {
    console.log('⚠️ 露出量条件を満たす候補がありませんでした(下限を緩めるか、探索範囲を見直してください)。');
  } else {
    const best = eligible.reduce((a, b) => (b.ev > a.ev ? b : a));
    console.log(`最良候補: ROI閾値=${best.roiThresh}  n=${best.n}  1日あたり${best.perDay.toFixed(1)}件  的中率${best.hitRate.toFixed(1)}%  EV${best.ev.toFixed(1)}%`);
    console.log(`(現行基準値: 1日あたり${currentAll.perDay.toFixed(1)}件・的中率${currentAll.hitRate.toFixed(1)}%・EV${currentAll.ev.toFixed(1)}% との比較)`);
    console.log(`  EV差: ${(best.ev - currentAll.ev).toFixed(1)}pt / 参戦件数比: ${(best.perDay / currentAll.perDay * 100).toFixed(0)}%`);

    // held-out検証: チューニング用データで同じ露出量条件・最良ROI閾値を探し、確認用データで検証
    console.log('\n[参考: held-out検証] チューニング用(前半)で同じ手順を再現し、確認用(後半)で裏付けを取る:');
    const currentTuning = summarize(tuningRaces.filter(r => r.currentJudge === 'enter'), tuningDays);
    const tuningFloor = currentTuning.perDay * EXPOSURE_FLOOR_RATIO;
    const tuningSweep = ROI_SWEEP.map(roiThresh => {
      const entered = tuningRaces.filter(r => judgeWith(r, roiThresh) === 'enter');
      const s = summarize(entered, tuningDays);
      return { roiThresh, ...s, ok: s.perDay !== null && s.perDay >= tuningFloor };
    }).filter(s => s.ok);
    if (tuningSweep.length) {
      const bestTuning = tuningSweep.reduce((a, b) => (b.ev > a.ev ? b : a));
      console.log(`  チューニング用で選ばれた閾値: ROI>=${bestTuning.roiThresh} (n=${bestTuning.n}, 1日${bestTuning.perDay.toFixed(1)}件, EV${bestTuning.ev.toFixed(1)}%)`);
      const holdoutEntered = holdoutRaces.filter(r => judgeWith(r, bestTuning.roiThresh) === 'enter');
      const holdoutResult = summarize(holdoutEntered, holdoutDays);
      const currentHoldout = summarize(holdoutRaces.filter(r => r.currentJudge === 'enter'), holdoutDays);
      console.log(`  確認用データでの実績: ${fmtRow('  ', holdoutResult)}`);
      console.log(`  確認用データでの現行基準: ${fmtRow('  ', currentHoldout)}`);
      if (holdoutResult.ev !== null && currentHoldout.ev !== null && holdoutResult.ev > currentHoldout.ev) {
        console.log('  ✅ held-outでも現行設定を上回り、再現性あり。');
      } else {
        console.log('  ⚠️ held-outでは現行設定を上回らなかった。過学習の可能性に注意。');
      }
    } else {
      console.log('  ⚠️ チューニング用データで露出量条件を満たす候補がありませんでした。');
    }
  }
}

main();
