'use strict';
// VENUE_ROI/VENUE_HITRATE/OVERALL_AVG_ROI/OVERALL_AVG_HITRATEの再計算(2026-08-19)。
// 監査部隊・反証部隊の指摘(三国=107.2が2026-07-28時点n=3146の一度きりの計算値のまま
// 3週間以上再計算されていない)を受けたCEO承認による再計算。
// 手法はkyotei_backtest.htmlのコメントに記載された原手法(daikibo_archive全件検証、
// n>=40の会場のみ採用、新エンジン適用後の実測ROI)をそのまま踏襲し、対象データを
// 2026-07-01〜08-15の全アーカイブ(41ファイル)に拡大しただけ。ロジックは一切変更しない(診断専用)。
//
// 使い方: node tests/recalc_venue_roi.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const SHIKIN = 3000;
const MIN_N = 40;

const FUNCTION_NAMES = [
  'calcAreScore', 'calcNigeRate', 'calcAreIndex', 'judgeMode',
  'decideProbabilisticPts', '_plWinProbs', '_plConditionalProbs', '_selectWithPairCap',
  'buildBetsProbabilistic', 'calcStdev', 'calcGoseiOdds',
];

function loadEngine(htmlPath) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const version = extractScoreEngineVersion(source);
  const funcSources = FUNCTION_NAMES.map(name => extractFunctionSource(source, name));
  const moduleSource = [
    "'use strict';",
    "let selectedRaceType = 'ippan';",
    ...funcSources,
    'module.exports = {',
    '  setRaceType(v) { selectedRaceType = v; },',
    ...FUNCTION_NAMES.map(name => `  ${name},`),
    '};',
  ].join('\n\n');
  const tmpDir = path.join(os.tmpdir(), 'garon-venue-recalc');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `venue_recalc.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);
  const engine = require(tmpFile);
  engine.version = version;
  return engine;
}

function listArchiveFiles() {
  return fs.readdirSync(ROOT)
    .filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function parsePayout100(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// sg_narutou.html:recalcAlloc()の「均等回収(equalret)」を忠実に移植(weighted_optimization_search.jsと同一)。
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

// 全件検証(estimateROIによる閾値フィルタなし。「もしこの会場で毎回賭けたら」の実測値)
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

  return { venue, hit, stake, payout };
}

function main() {
  console.log(`sg_narutou.html からロジックを抽出中... (${HTML_PATH})`);
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan');

  const files = listArchiveFiles();
  console.log(`対象アーカイブ: ${files.length}ファイル\n`);

  const byVenue = {};
  let totalStake = 0, totalPayout = 0, totalN = 0, totalHits = 0;
  let skipped = 0;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const entry of data) {
      if (!(entry.resulted && entry.chakuju && Array.isArray(entry.boats) && entry.boats.length === 6)) { skipped++; continue; }
      if (!entry.oddsMap || Object.keys(entry.oddsMap).length < 100) { skipped++; continue; }
      if (String(entry.chakuju).split('-').length !== 3) { skipped++; continue; }
      let rec;
      try { rec = buildRaceRecord(engine, entry); } catch (e) { skipped++; continue; }

      const v = rec.venue;
      if (!byVenue[v]) byVenue[v] = { n: 0, hits: 0, stake: 0, payout: 0 };
      byVenue[v].n++;
      if (rec.hit) byVenue[v].hits++;
      byVenue[v].stake += rec.stake;
      byVenue[v].payout += rec.payout;

      totalN++; totalStake += rec.stake; totalPayout += rec.payout;
      if (rec.hit) totalHits++;
    }
  }

  const overallRoi = totalStake ? (totalPayout / totalStake * 100) : 0;
  const overallHitRate = totalN ? (totalHits / totalN * 100) : 0;

  console.log(`全件数: ${totalN}(スキップ${skipped}件) OVERALL_AVG_ROI=${overallRoi.toFixed(1)} OVERALL_AVG_HITRATE=${overallHitRate.toFixed(1)}\n`);

  const venues = Object.keys(byVenue).sort((a, b) => byVenue[b].n - byVenue[a].n);
  const newVenueRoi = {};
  const newVenueHitrate = {};
  const excluded = [];

  console.log('会場別実測(全件、n順):');
  console.log('会場\tn\tROI%\t的中率%');
  for (const v of venues) {
    const s = byVenue[v];
    const roi = s.stake ? (s.payout / s.stake * 100) : 0;
    const hitRate = s.n ? (s.hits / s.n * 100) : 0;
    console.log(`${v}\t${s.n}\t${roi.toFixed(1)}\t${hitRate.toFixed(1)}`);
    if (s.n >= MIN_N) {
      newVenueRoi[v] = Math.round(roi * 10) / 10;
      newVenueHitrate[v] = Math.round(hitRate * 10) / 10;
    } else {
      excluded.push(`${v}(n=${s.n})`);
    }
  }

  console.log(`\nn<${MIN_N}のため除外: ${excluded.join(', ') || 'なし'}`);

  console.log('\n===== 新VENUE_ROI(そのままコードに貼り付け可能) =====');
  console.log(`const VENUE_ROI={${Object.entries(newVenueRoi).map(([k, v]) => `'${k}':${v}`).join(',')}}`);
  console.log('\n===== 新VENUE_HITRATE =====');
  console.log(`const VENUE_HITRATE={${Object.entries(newVenueHitrate).map(([k, v]) => `'${k}':${v}`).join(',')}}`);
  console.log(`\nconst OVERALL_AVG_ROI=${Math.round(overallRoi * 10) / 10};`);
  console.log(`const OVERALL_AVG_HITRATE=${Math.round(overallHitRate * 10) / 10};`);

  console.log('\n===== 旧値との比較(主要会場) =====');
  const OLD_VENUE_ROI = {'戸田':46.1,'多摩川':80.5,'浜名湖':61.5,'蒲郡':67.6,'常滑':74.6,'三国':107.2,'びわこ':94.5,'児島':79.3,'宮島':48.8,'下関':73.2,'若松':68.1,'福岡':71.4,'唐津':71.2,'大村':69.6,'平和島':97.3,'芦屋':76.6,'津':100.9,'住之江':90.0,'尼崎':72.5,'桐生':84.0,'徳山':66.4,'鳴門':84.3,'丸亀':67.6,'江戸川':81.7};
  for (const v of venues) {
    if (newVenueRoi[v] === undefined) continue;
    const old = OLD_VENUE_ROI[v];
    const diff = old !== undefined ? (newVenueRoi[v] - old).toFixed(1) : 'N/A';
    console.log(`${v}: 旧${old} → 新${newVenueRoi[v]} (差分${diff}, n=${byVenue[v].n})`);
  }
}

main();
