'use strict';
// estRoi(参入判定に使う推定ROI)の改良版を試作し、held-out方式で検証する診断ツール。
// ロジックは一切変更しない(診断専用)。
//
// 設計方針:
//   改良版 estRoi2(race) = estRoiOld(race) + goseiOddsDelta(その買い目の合成オッズ)
//   goseiOddsDeltaは「合成オッズ帯ごとに、実際のEVがestRoiOldの予測からどれだけズレていたか」を
//   チューニング用データ(前半)だけで学習し、確認用データ(後半)には一切触れさせない。
//   既存のstdevROIDelta(団子度による補正)と同じ「バケット別の実測差分」という設計に揃えている。
//
// 34日分ではなく33日分(07-31が欠落)を前半/後半で分割する(heldout_validation.jsと同じ扱い)。
//
// 使い方: node tests/estroi_v2_diagnosis.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const ARCHIVE_DATE_MIN = '2026-07-01';
const ARCHIVE_DATE_MAX = '2026-08-21';
const FULL_ODDS_COMBOS = 120;
const N_BUCKETS = 5; // 合成オッズを5分位(quintile)で分ける

const FUNCTION_NAMES = [
  'calcAreScore', 'calcNigeRate', 'calcAreIndex', 'judgeMode',
  'decideProbabilisticPts', '_plWinProbs', '_plConditionalProbs', '_selectWithPairCap',
  'buildBetsProbabilistic', 'calcStdev', 'estimateROI', 'stdevROIDelta', 'calcGoseiOdds',
  'goseiOddsDelta', // 2026-08-15にestimateROI内部から呼ばれるようになったが、この診断スクリプトの
                     // 抽出対象に追加されておらず「ReferenceError: goseiOddsDelta is not defined」が
                     // loadRaceSet()のtry/catchで握りつぶされ、全レースが0件スキップされていた(2026-08-23発見・修正)。
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
  const tmpDir = path.join(os.tmpdir(), 'garon-estroi-v2-extract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `estroi_v2.${Date.now()}.js`);
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
  const actualEV = hit ? goseiOdds * 100 : 0; // estRoiと同じ%スケール(100=収支トントン)

  return { entry, mode, autoNige, gap, stdev, venue, estRoiOld, goseiOdds, hit, actualEV };
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

// ---- 合成オッズの5分位バケット境界をチューニングセットから学習 ----
function fitQuantileBoundaries(values, nBuckets) {
  const sorted = [...values].sort((a, b) => a - b);
  const boundaries = [];
  for (let i = 1; i < nBuckets; i++) {
    boundaries.push(sorted[Math.floor(sorted.length * i / nBuckets)]);
  }
  return boundaries; // 長さ nBuckets-1
}
function bucketOf(value, boundaries) {
  for (let i = 0; i < boundaries.length; i++) if (value < boundaries[i]) return i;
  return boundaries.length;
}

// ---- goseiOddsDelta(合成オッズ帯ごとの補正値)をチューニングセットだけで学習 ----
function fitGoseiOddsDelta(tuningRaces) {
  const boundaries = fitQuantileBoundaries(tuningRaces.map(r => r.goseiOdds), N_BUCKETS);
  const buckets = Array.from({ length: N_BUCKETS }, () => ({ n: 0, residSum: 0, goseiMin: Infinity, goseiMax: -Infinity }));
  for (const r of tuningRaces) {
    const b = bucketOf(r.goseiOdds, boundaries);
    buckets[b].n++;
    buckets[b].residSum += (r.actualEV - r.estRoiOld);
    buckets[b].goseiMin = Math.min(buckets[b].goseiMin, r.goseiOdds);
    buckets[b].goseiMax = Math.max(buckets[b].goseiMax, r.goseiOdds);
  }
  const deltas = buckets.map(b => b.n ? b.residSum / b.n : 0);
  return {
    boundaries,
    deltas,
    buckets,
    fn(goseiOdds) { return deltas[bucketOf(goseiOdds, boundaries)]; },
  };
}

function pearson(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function summarizeEntry(races) {
  const n = races.length;
  const hits = races.filter(r => r.hit).length;
  const evSum = races.reduce((s, r) => s + r.actualEV, 0);
  return { n, hitRate: n ? hits / n * 100 : null, ev: n ? evSum / n : null };
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
  console.log(`対象: ${files.length}日分 (${dates[0]}〜${dates[dates.length - 1]})、oddsMap全120通り揃っているレースのみ`);
  console.log(`チューニング用(前半): ${tuningFiles.length}日 (${dates[0]}〜${dates[mid - 1]})`);
  console.log(`確認用(後半)　　　　: ${holdoutFiles.length}日 (${dates[mid]}〜${dates[dates.length - 1]})`);

  const tuningRaces = loadRaceSet(engine, tuningFiles);
  const holdoutRaces = loadRaceSet(engine, holdoutFiles);
  console.log(`チューニング用レース数: ${tuningRaces.length} / 確認用レース数: ${holdoutRaces.length}`);

  // ============================================================
  // 改良版estRoi2の学習(チューニング用データのみ使用)
  // ============================================================
  const goseiFit = fitGoseiOddsDelta(tuningRaces);
  console.log('\n' + '='.repeat(70));
  console.log('学習結果: 合成オッズ帯ごとの補正値(goseiOddsDelta、チューニング用データのみで学習)');
  console.log('='.repeat(70));
  goseiFit.buckets.forEach((b, i) => {
    console.log(`帯${i + 1} (合成オッズ ${b.goseiMin.toFixed(2)}〜${b.goseiMax.toFixed(2)}倍, n=${b.n}): delta=${goseiFit.deltas[i].toFixed(1)}pt`);
  });

  function estRoi2(r) { return r.estRoiOld + goseiFit.fn(r.goseiOdds); }

  // ============================================================
  // 2. 予測精度の比較(相関の強さ)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('2. 旧estRoi vs 改良版estRoi2 の予測精度比較(相関係数、1に近いほど良い予測)');
  console.log('='.repeat(70));
  function reportCorr(label, races) {
    const corrOldEV = pearson(races.map(r => [r.estRoiOld, r.actualEV]));
    const corrNewEV = pearson(races.map(r => [estRoi2(r), r.actualEV]));
    const corrOldHit = pearson(races.map(r => [r.estRoiOld, r.hit ? 1 : 0]));
    const corrNewHit = pearson(races.map(r => [estRoi2(r), r.hit ? 1 : 0]));
    console.log(`【${label}】(n=${races.length})`);
    console.log(`  対 実際のEV(ROI)  : 旧estRoi r=${corrOldEV.toFixed(3)}  →  estRoi2 r=${corrNewEV.toFixed(3)}`);
    console.log(`  対 的中(0/1)      : 旧estRoi r=${corrOldHit.toFixed(3)}  →  estRoi2 r=${corrNewHit.toFixed(3)}`);
  }
  reportCorr('チューニング用(参考: この上で学習しているため過大評価の可能性あり)', tuningRaces);
  reportCorr('確認用(held-out。こちらが実力の目安)', holdoutRaces);

  // ============================================================
  // 3. 閾値グリッドサーチ(チューニング用データで探索 → 確認用データで検証)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('3. 閾値グリッドサーチ(estRoi2使用。チューニング用で探索→確認用で検証)');
  console.log('='.repeat(70));

  const gapCandidates = [5, 8, 10, 12, 15];
  const roiCandidates = [65, 68, 71, 74, 78, 82, 86, 90];
  const MIN_N = 150; // n<30ルールより十分大きい最小サンプル数(チューニングセット全体の目安)

  function judgeWith(r, gapThresh, roiThresh) {
    const isNarrowGap = (r.mode === 'normal' && r.autoNige !== 'high' && r.gap < gapThresh);
    if (isNarrowGap) return 'skip';
    return estRoi2(r) >= roiThresh ? 'enter' : 'skip';
  }

  const candidates = [];
  for (const gapThresh of gapCandidates) {
    for (const roiThresh of roiCandidates) {
      const entered = tuningRaces.filter(r => judgeWith(r, gapThresh, roiThresh) === 'enter');
      if (entered.length < MIN_N) continue;
      const s = summarizeEntry(entered);
      candidates.push({ gapThresh, roiThresh, ...s });
    }
  }
  candidates.sort((a, b) => b.ev - a.ev);

  console.log(`\n[現行設定] gap閾値=10 / ROI閾値=74 (estRoi2使用)をチューニング用データで評価:`);
  const baseline = summarizeEntry(tuningRaces.filter(r => judgeWith(r, 10, 74) === 'enter'));
  console.log(`  n=${baseline.n}  的中率=${baseline.hitRate.toFixed(1)}%  EV=${baseline.ev.toFixed(1)}%`);

  console.log(`\n[グリッドサーチ上位5件](チューニング用データでのEV降順、n>=${MIN_N}):`);
  candidates.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. gap<${c.gapThresh} / ROI>=${c.roiThresh}  : n=${c.n}  的中率=${c.hitRate.toFixed(1)}%  EV=${c.ev.toFixed(1)}%`);
  });

  console.log(`\n[held-out検証] 上位候補を確認用データ(後半)にそのまま当てはめた結果:`);
  const top = candidates[0];
  function validateOn(label, races, gapThresh, roiThresh) {
    const entered = races.filter(r => judgeWith(r, gapThresh, roiThresh) === 'enter');
    const s = summarizeEntry(entered);
    console.log(`  ${label}: n=${s.n}  的中率=${s.n ? s.hitRate.toFixed(1) : 'N/A'}%  EV=${s.n ? s.ev.toFixed(1) : 'N/A'}%`);
    return s;
  }
  console.log(`  現行設定(gap<10/ROI>=74, estRoi2使用)を確認用データで評価:`);
  const baselineHoldout = validateOn('    確認用', holdoutRaces, 10, 74);
  if (top) {
    console.log(`  最良候補(gap<${top.gapThresh}/ROI>=${top.roiThresh})を確認用データで評価:`);
    const topHoldout = validateOn('    確認用', holdoutRaces, top.gapThresh, top.roiThresh);
    console.log(`\n  判定: `);
    if (topHoldout.n && baselineHoldout.n && topHoldout.ev > baselineHoldout.ev) {
      console.log(`  ✅ 最良候補は確認用データでも現行設定を上回った(EV ${topHoldout.ev.toFixed(1)}% > ${baselineHoldout.ev.toFixed(1)}%)。再現性あり。`);
    } else {
      console.log(`  ⚠️ 最良候補は確認用データでは現行設定を上回らなかった(EV ${topHoldout.n ? topHoldout.ev.toFixed(1) : 'N/A'}% vs ${baselineHoldout.n ? baselineHoldout.ev.toFixed(1) : 'N/A'}%)。チューニングデータへの過学習の可能性。`);
    }
  }
}

main();
