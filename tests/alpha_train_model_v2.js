'use strict';
// エンジンα v2: alpha_train_model.js(順位ベース)を、z-score(magnitude)ベースの特徴量に差し替えた版。
// 学習ロジック(多項ロジット回帰・勾配降下)・検証方式(前半学習/後半held-out)はv1と同じ。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeaturesV2, FEATURE_NAMES_V2 } = require('./lib/alpha-features-v2.js');
const { allocateStakesEqualRet, isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs, pickBetsByEV, pickBetsByEdge, summarize } = require('./engine_alpha_prototype.js');
const { softmax, trainWeights } = require('./alpha_train_model.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;

function parsePayout100(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function prepareDatasetV2(qEngine, races) {
  const dataset = [];
  for (const r of races) {
    let features;
    try { features = buildFeaturesV2(r.boats, qEngine.calcAvgST); } catch (e) { continue; }
    const winnerBoat = parseInt(r.chakuju.split('-')[0], 10);
    const winnerIdx = r.boats.findIndex(b => b.no === winnerBoat);
    if (winnerIdx < 0) continue;
    dataset.push({ race: r, features, winnerIdx });
  }
  return dataset;
}

function calibrationCheck(dataset, w) {
  const rows = [];
  for (const { features, winnerIdx } of dataset) {
    const scores = features.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
    const probs = softmax(scores);
    features.forEach((_, i) => rows.push({ p: probs[i], won: i === winnerIdx ? 1 : 0 }));
  }
  rows.sort((a, b) => a.p - b.p);
  const bins = 10;
  const binSize = Math.ceil(rows.length / bins);
  console.log('  予測確率帯\tn\t平均予測確率\t実際の勝率');
  for (let b = 0; b < bins; b++) {
    const slice = rows.slice(b * binSize, (b + 1) * binSize);
    if (!slice.length) continue;
    const avgP = slice.reduce((s, r) => s + r.p, 0) / slice.length;
    const actualRate = slice.reduce((s, r) => s + r.won, 0) / slice.length;
    console.log(`  ${b + 1}/${bins}\t${slice.length}\t${(avgP * 100).toFixed(1)}%\t${(actualRate * 100).toFixed(1)}%`);
  }
}

function analyzeRaceWithModel(plEngine, features, boats, r, w, oddsMin, oddsMax, pointCount, method) {
  const scoreMap = {};
  boats.forEach((b, i) => {
    scoreMap[String(b.no)] = features[i].reduce((s, v, k) => s + v * w[k], 0);
  });
  const comboProbs = computeAllComboProbs(plEngine, scoreMap, 1);
  const betVals = method === 'edge'
    ? pickBetsByEdge(comboProbs, r.oddsMap, oddsMin, oddsMax, pointCount)
    : pickBetsByEV(comboProbs, r.oddsMap, oddsMin, oddsMax, pointCount);
  if (!betVals.length) return { hit: false, stake: 0, payout: 0 };

  const amounts = allocateStakesEqualRet(betVals, r.oddsMap, SHIKIN);
  const hitIdx = betVals.indexOf(r.chakuju);
  const hit = hitIdx >= 0;
  const stake = amounts.reduce((s, a) => s + a, 0);
  const payout = hit ? Math.round(amounts[hitIdx] / 100 * parsePayout100(r.payout)) : 0;
  return { hit, stake, payout };
}

function fmt(s) {
  if (!s.n) return 'n=0';
  return `n=${s.n}\t的中率${s.hitRate.toFixed(1)}%\tROI${s.roi.toFixed(1)}%\t純損益${s.profit >= 0 ? '+' : ''}¥${s.profit.toLocaleString()}`;
}

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

  const allRaces = loadAllRaces();
  const races = allRaces.filter(isUsable);
  races.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));

  const mid = Math.floor(races.length / 2);
  const calibRaces = races.slice(0, mid);
  const heldoutRaces = races.slice(mid);
  console.log(`対象n=${races.length}(前半n=${calibRaces.length} / 後半n=${heldoutRaces.length})\n`);

  console.log('=== v2(z-score/magnitude特徴量)で多項ロジット回帰を学習 ===');
  const calibSet = prepareDatasetV2(qEngine, calibRaces);
  const w = trainWeights(calibSet, FEATURE_NAMES_V2.length);
  console.log('\n学習された重み:');
  FEATURE_NAMES_V2.forEach((name, i) => console.log(`  ${name}: ${w[i].toFixed(3)}`));

  console.log('\n=== 較正チェック(前半) ===');
  calibrationCheck(calibSet, w);
  console.log('\n=== 較正チェック(後半、held-out) ===');
  const heldoutSet = prepareDatasetV2(qEngine, heldoutRaces);
  calibrationCheck(heldoutSet, w);

  console.log('\n=== ベッティング評価(前半 vs 後半、点数13固定) ===');
  const ODDS_BANDS = [
    { label: '全帯', min: 0, max: 100000 },
    { label: '10倍以上', min: 10, max: 100000 },
    { label: '10-100倍(中穴)', min: 10, max: 100 },
    { label: '20倍以上', min: 20, max: 100000 },
  ];
  for (const method of ['ev', 'edge']) {
    for (const band of ODDS_BANDS) {
      const calibRows = calibSet.map(d => analyzeRaceWithModel(plEngine, d.features, d.race.boats, d.race, w, band.min, band.max, 13, method));
      const heldoutRows = heldoutSet.map(d => analyzeRaceWithModel(plEngine, d.features, d.race.boats, d.race, w, band.min, band.max, 13, method));
      const cs = summarize(calibRows), hs = summarize(heldoutRows);
      console.log(`[${method}] ${band.label}`);
      console.log(`  前半: ${fmt(cs)}`);
      console.log(`  後半: ${fmt(hs)}`);
    }
  }
}

if (require.main === module) main();
