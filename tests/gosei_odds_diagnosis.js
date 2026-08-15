'use strict';
// 参入判定の診断を、賭け金配分(1点いくら)から切り離し、合成オッズ(calcGoseiOdds)ベースで行う。
// calcGoseiOdds(betsArr, oddsMap) = 1 / Σ(1/oddsMap[bet]) は「各買い目にオッズの逆数で加重配分し、
// どれか1点が当たれば同額回収できるようにした場合の回収倍率」を表す。つまり
//   このレースのEV(期待値) = 的中なら合成オッズ、外れなら0
// を単純平均すれば、賭け金配分の仮定を置かずに「回収率」を計算できる(100円均等より現実に近い)。
//
// 1. 参入判定(isNarrowGap / estRoi>=74、ロジックは変更しない)を維持したまま、
//    アウトカム測定を「1点100円ROI」から「合成オッズベースのEV」に置き換えて再評価
// 2. 買い目点数(4/6/8/10/12)ごとの的中率・平均合成オッズを集計
// 3. 「点数を絞るほど合成オッズは上がるが的中率は下がる」トレードオフが、
//    期待値(的中率×合成オッズ)の観点で実際に有利かを検証
//
// oddsMapが不完全なレース(120通り揃っていない)は、点数を変えた時の比較が
// 不公平になるため除外する(3連単は6艇なら必ず120通り)。
//
// 使い方: node tests/gosei_odds_diagnosis.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const ARCHIVE_DATE_MIN = '2026-07-01';
const ARCHIVE_DATE_MAX = '2026-08-03';
const PTS_SWEEP = [4, 6, 8, 10, 12];
const FULL_ODDS_COMBOS = 120; // 6艇3連単の全組み合わせ数(6*5*4)

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

  const tmpDir = path.join(os.tmpdir(), 'garon-gosei-odds-extract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `gosei_odds.${Date.now()}.js`);
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

// 参入判定(sg_narutou.html:2280-2331相当)。entry_criteria_diagnosis.jsと同一ロジック、変更なし。
function evaluateEntry(engine, entry, areScores) {
  const d = { boats: entry.boats, venue: entry.venue, raceNum: entry.racenum };
  const { areIndex, nigeRate } = engine.calcAreIndex(d);
  let mode = engine.judgeMode(areIndex, nigeRate);
  const boat1Rank = areScores.findIndex(s => String(s.no) === '1');
  if (nigeRate < 30 && boat1Rank > 0 && boat1Rank < 5) mode = 'nigenashi';
  const isAxisBoat1 = String(areScores[0].no) === '1';
  const autoNige = (isAxisBoat1 && nigeRate >= 85) ? 'high' : (isAxisBoat1 && nigeRate >= 50) ? 'mid' : 'low';
  const gap = areScores[0].raw - areScores[1].raw;
  const isNarrowGap = (mode === 'normal' && autoNige !== 'high' && gap < 10);
  const stdev = engine.calcStdev(areScores);
  const estRoi = engine.estimateROI(mode, entry.venue || '不明', stdev);
  let judge;
  if (isNarrowGap) judge = 'skip_narrowgap';
  else if (estRoi >= 74) judge = 'enter';
  else judge = 'skip_lowroi';
  return { judge, gap, mode };
}

function computeAreScoresAndRanking(engine, entry) {
  const d = { boats: entry.boats, venue: entry.venue, raceNum: entry.racenum };
  const areScores = engine.calcAreScore(d);
  const b1RankBeforeFix = areScores.findIndex(s => String(s.no) === '1');
  if (b1RankBeforeFix === 1) {
    const promoGap = areScores[0].raw - areScores[1].raw;
    if (promoGap < 9) { const tmp = areScores[0]; areScores[0] = areScores[1]; areScores[1] = tmp; }
  }
  const ranking = areScores.map((s, i) => ({ rank: i + 1, boat: parseInt(s.no, 10), mark: MARKS[i] || '×', score: s.raw }));
  return { d, areScores, ranking };
}

function newBucket() { return { n: 0, hits: 0, evSum: 0, goseiSumOnHit: 0 }; }
function addTo(bucket, hit, gosei) {
  bucket.n++;
  if (hit) { bucket.hits++; bucket.evSum += gosei; bucket.goseiSumOnHit += gosei; }
}
function summarize(b) {
  return {
    n: b.n,
    hitRate: b.n ? (b.hits / b.n * 100) : null,
    ev: b.n ? (b.evSum / b.n * 100) : null, // 「回収率」(合成オッズベース、100%=収支トントン)
    avgGoseiOnHit: b.hits ? (b.goseiSumOnHit / b.hits) : null,
    hits: b.hits,
  };
}
function fmt(s) {
  return `n=${s.n}\t的中率=${s.hitRate !== null ? s.hitRate.toFixed(1) + '%' : 'N/A'}\t回収率(合成オッズEV)=${s.ev !== null ? s.ev.toFixed(1) + '%' : 'N/A'}\t的中時平均合成オッズ=${s.avgGoseiOnHit !== null ? s.avgGoseiOnHit.toFixed(2) + '倍' : 'N/A'}`;
}

function main() {
  console.log(`sg_narutou.html からロジックを抽出中... (${HTML_PATH})`);
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan');

  const files = listArchiveFiles();
  console.log(`対象データ: ${files.length}日分 (${ARCHIVE_DATE_MIN} 〜 ${ARCHIVE_DATE_MAX})、oddsMapが全120通り揃っているレースのみ使用`);

  // races[]に前計算結果をキャッシュ(pts別スイープで使い回すため)
  const races = [];
  for (const file of files) {
    for (const entry of loadRaces(file)) {
      const parts = String(entry.chakuju).split('-');
      if (parts.length !== 3) continue;
      let areScores, ranking;
      try {
        ({ areScores, ranking } = computeAreScoresAndRanking(engine, entry));
      } catch (e) { continue; }
      const entryJudge = evaluateEntry(engine, entry, areScores);
      races.push({ entry, ranking, entryJudge });
    }
  }
  console.log(`使用可能レース数: ${races.length}`);

  // ============================================================
  // 1. 参入判定の再評価(合成オッズEVベース)
  //    実運用の点数(decideProbabilisticPts)をそのまま使う
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('1. 参入判定の再評価(実運用点数、合成オッズEVベース)');
  console.log('='.repeat(70));
  const bAll = newBucket(), bEnter = newBucket(), bSkip = newBucket();
  const bSkipNarrow = newBucket(), bSkipLowRoi = newBucket();
  for (const { entry, ranking, entryJudge } of races) {
    const pts = engine.decideProbabilisticPts([{ score: ranking[0].score }, { score: ranking[1].score }]);
    const bets = engine.buildBetsProbabilistic(ranking, pts);
    const hit = bets.some(b => b.val === entry.chakuju);
    const gosei = parseFloat(engine.calcGoseiOdds(bets.map(b => b.val), entry.oddsMap)) || 0;
    addTo(bAll, hit, gosei);
    if (entryJudge.judge === 'enter') addTo(bEnter, hit, gosei);
    else {
      addTo(bSkip, hit, gosei);
      if (entryJudge.judge === 'skip_narrowgap') addTo(bSkipNarrow, hit, gosei);
      else addTo(bSkipLowRoi, hit, gosei);
    }
  }
  console.log(`全レース対象         : ${fmt(summarize(bAll))}`);
  console.log(`参入(◎参戦)のみ      : ${fmt(summarize(bEnter))}`);
  console.log(`見送り全体           : ${fmt(summarize(bSkip))}`);
  console.log(`  内訳: 僅差見送り    : ${fmt(summarize(bSkipNarrow))}`);
  console.log(`  内訳: 推定ROI不足   : ${fmt(summarize(bSkipLowRoi))}`);

  // ============================================================
  // 2&3. 買い目点数別の的中率・合成オッズ・EVスイープ
  // ============================================================
  function runPtsSweep(raceSubset, label) {
    console.log('\n' + '='.repeat(70));
    console.log(`2&3. 買い目点数別スイープ: ${label} (n=${raceSubset.length})`);
    console.log('='.repeat(70));
    console.log('点数\tn\t的中率\t的中時平均合成オッズ\t回収率(EV)');
    for (const pts of PTS_SWEEP) {
      const b = newBucket();
      for (const { entry, ranking } of raceSubset) {
        const bets = engine.buildBetsProbabilistic(ranking, pts);
        const hit = bets.some(x => x.val === entry.chakuju);
        const gosei = parseFloat(engine.calcGoseiOdds(bets.map(x => x.val), entry.oddsMap)) || 0;
        addTo(b, hit, gosei);
      }
      const s = summarize(b);
      console.log(`${pts}点\t${s.n}\t${s.hitRate.toFixed(1)}%\t${s.avgGoseiOnHit !== null ? s.avgGoseiOnHit.toFixed(2) + '倍' : 'N/A'}\t\t${s.ev.toFixed(1)}%`);
    }
  }

  runPtsSweep(races, '全レース');
  runPtsSweep(races.filter(r => r.entryJudge.judge === 'enter'), '参入判定レースのみ');

  console.log('\n' + '='.repeat(70));
  console.log('3. 「点数を絞るほど有利か」の検証');
  console.log('='.repeat(70));
  console.log('上記2つの表で、点数を4点側に絞るほどEV(回収率)が単調に上がっていれば');
  console.log('「絞った方が期待値上有利」を支持。横ばい/下がる場合は「点数を絞る効果は');
  console.log('的中率低下で相殺され、期待値上のメリットは無い(またはむしろ悪化する)」ことを示す。');
  console.log('個別の数値は上の表を直接確認してください(ロジック変更はしていないため、この場では断定しません)。');
}

main();
