'use strict';
// エンジンα: スコアリングを「0から」作る第一弾。
//
// Qエンジンの系統別順位(ST・決まり手・連対率・機力・展示、rankBoatsBySystem)を素材として
// 流用しつつ、「ST×2倍で単純合計」という決め打ちの重み付けをやめ、実際の過去の勝敗データ
// (1着になった艇=正解)から多項ロジット回帰(softmax regression、6艇のうち1艇が勝つ
// という構造をそのままモデル化)で重みを学習する。
//
// 検証方針(「アーカイブは良いが実践はダメ」を繰り返さないための必須事項):
//   - 前半(calibration)で重みを学習し、後半(held-out)では学習に一切使わず、そのまま適用する
//   - 較正(calibration、予測確率と実際の頻度が合っているか)と、賭けた場合のROIを両方見る
//   - フルデータ(n=6,000超、約2か月分)を使う。wakuStats.niren2が無いレースは中立値(0.5)で
//     埋まるが、艇ごとに偏らないことを確認済みなので学習データとして問題ない
//
// 使い方:
//   node tests/alpha_train_model.js

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { allocateStakesEqualRet, isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs, pickBetsByEV, pickBetsByEdge, summarize } = require('./engine_alpha_prototype.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;
const L2 = 0.01; // L2正則化係数(過学習防止、パラメータ数10個に対しては緩め)
const LR = 0.05;
const EPOCHS = 300;

function parsePayout100(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function softmax(scores) {
  const max = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / total);
}

// 1レース分の特徴量+実際の勝者indexを事前計算しておく(学習ループを速くするため)。
function prepareDataset(qEngine, races) {
  const dataset = [];
  for (const r of races) {
    let ranks;
    try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
    const features = buildFeatures(r.boats, ranks);
    const winnerBoat = parseInt(r.chakuju.split('-')[0], 10);
    const winnerIdx = r.boats.findIndex(b => b.no === winnerBoat);
    if (winnerIdx < 0) continue;
    dataset.push({ race: r, features, winnerIdx });
  }
  return dataset;
}

// 多項ロジット回帰(softmax regression)をミニバッチ無しのフルバッチ勾配降下で学習する。
function trainWeights(dataset, nFeatures) {
  let w = new Array(nFeatures).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = new Array(nFeatures).fill(0);
    let loss = 0;
    for (const { features, winnerIdx } of dataset) {
      const scores = features.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
      const probs = softmax(scores);
      loss += -Math.log(Math.max(probs[winnerIdx], 1e-9));
      for (let i = 0; i < features.length; i++) {
        const y = (i === winnerIdx) ? 1 : 0;
        const coef = probs[i] - y;
        for (let k = 0; k < nFeatures; k++) grad[k] += coef * features[i][k];
      }
    }
    for (let k = 0; k < nFeatures; k++) {
      grad[k] = grad[k] / dataset.length + L2 * w[k];
      w[k] -= LR * grad[k];
    }
    if (epoch % 50 === 0 || epoch === EPOCHS - 1) {
      console.log(`  epoch=${epoch} loss=${(loss / dataset.length).toFixed(4)}`);
    }
  }
  return w;
}

// 較正チェック: 予測確率を10分位に分け、各分位で「予測確率の平均」と「実際に勝った割合」を比較する。
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
  // 学習済みスコアは既にlog-strengthスケール(softmaxにそのまま入る想定)なのでT=1を使う。
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

  console.log('=== 前半データで多項ロジット回帰を学習 ===');
  const calibSet = prepareDataset(qEngine, calibRaces);
  const w = trainWeights(calibSet, FEATURE_NAMES.length);
  console.log('\n学習された重み:');
  FEATURE_NAMES.forEach((name, i) => console.log(`  ${name}: ${w[i].toFixed(3)}`));

  console.log('\n=== 較正チェック(前半、学習データそのもの) ===');
  calibrationCheck(calibSet, w);

  console.log('\n=== 較正チェック(後半、held-out) ===');
  const heldoutSet = prepareDataset(qEngine, heldoutRaces);
  calibrationCheck(heldoutSet, w);

  // ベッティング評価: EV方式・edge方式それぞれ、オッズ帯をいくつか試す
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
module.exports = { softmax, trainWeights, prepareDataset, analyzeRaceWithModel };
