'use strict';
// GARON-20260901-003 継続、CEO承認(2026-09-02): 条件付き着順モデル(1系列)の実装・学習・比較。
// v8/v9(木・PL流用)は不採用として区切り、次候補として具体化済みの設計をこの範囲で実装する。
// 方式選びのための別研究は増やさない。
//
// 【設計(実装前に固定)】
// score(i,j,k) = P1(i) × P2(j | 仮定した1着iを除いた残り5艇) × P3(k | 仮定した1・2着i,jを除いた残り4艇)
// P1・P2・P3はそれぞれ独立に学習した重み(1着モデルのスコアを2・3着へ使い回さない)。
// 学習では実際の1着・2着艇で条件付ける(実データから直接学習)。予測では全ての仮定上の
// (i,j,k)を120通り走査し、確定着順は一切参照しない(hit/chakujuはbuildModelRecordのスコア
// 計算部分に渡さない)。
//
// 【過去研究との違い】
// 過去にも市場を基準にした2・3着補正(GARON-20260901-002 seq07-09)は実施済みであり、
// 「2・3着を学ぶのが初めて」とは扱わない。今回の相違点: (a)順位化する前の生値とレース内差を
// 使う(v6/v8はrankBoatsBySystem由来の(7-順位)/6を使っていた) (b)締切前オッズが無い過去レース
// も、当時の選手情報が確認できれば着順学習に使う(v9のisTrainEligibleをそのまま再利用)
// (c)市場オッズは学習入力にせず、帯内候補選定と比較基準にのみ使う。
//
// 【モデル】正則化付き多項ロジット回帰(softmax、tests/alpha_train_model.jsのtrainWeights()を
// そのまま再利用、L2=0.05・LR=0.3・EPOCHS=500に固定・総当たりなし)を3段(1着・条件付き2着・
// 条件付き3着)独立に学習する。trainWeights()は候補数を固定しない汎用実装のため、5艇・4艇の
// 候補集合にもそのまま使える(コード変更不要)。
//
// 【入力(学習前に固定)】艇番ダミー5(boatNo2〜boatNo6、"course"と呼ばない。進入コースの実測
// 情報はアーカイブに存在しないため、艇番であることを明示する)+ST・決まり手・連対率・機力・展示の
// 5系統について、レース内平均からの差分(標準化後)+欠損フラグの10次元、計15次元。
// 展示等の会場差が大きい値も、レース内差分を使うことで絶対値の会場間比較を避ける。標準化の
// 係数(標準偏差)は学習データのみから計算し、評価データには適用のみ行う。市場オッズは
// 学習入力に一切使わない。後日更新情報・時点不明情報・確定結果も入力に混ぜない。
//
// 使い方: node tests/research_conditional_rank_model_v10_2026-09-02.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadAllRaces } = require('./q_engine_entry_backtest.js');
const { trainWeights } = require('./alpha_train_model.js');
const v9 = require('./research_tree_rank_model_v9_2026-09-02.js'); // isTrainEligible/classifyTimingFixedを再利用

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const DAILY_CAP = 10;
const TRAIN_HI_EXCLUSIVE = '2026-08-21';
const EVAL_LO = '2026-08-21', EVAL_HI = '2026-08-31';
const NFEAT = 15;
const FEATURE_LABELS = ['boatNo2', 'boatNo3', 'boatNo4', 'boatNo5', 'boatNo6', 'stDiff', 'stMissing', 'kimariteDiff', 'kimariteMissing', 'renDiff', 'renMissing', 'motorDiff', 'motorMissing', 'exhibitDiff', 'exhibitMissing'];

function hashObj(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function validOdds(r) { return Object.entries(r.oddsMap || {}).filter(([, v]) => parseFloat(v) > 0); }
function inRange(d, lo, hi) { return d >= lo && d <= hi; }
function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }

// ===== 生値の抽出(rankBoatsBySystemと同じ抽出規則、順位化はしない) =====
function _validExhibitTime(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? v : null; }
function extractRawPerSystem(qEngine, boats) {
  const st = boats.map(b => { const v = qEngine.calcAvgST(b); return (v != null && !isNaN(v)) ? v : null; }); // 小さいほど良い
  const kimarite = boats.map((b, idx) => {
    if (idx === 0) { const v = b.kimariteNige6m; return (v != null && !isNaN(v)) ? v : null; }
    const fields = [b.sashi6m, b.makuri6m, b.makurisashi6m];
    const present = fields.some(v => v != null && !isNaN(v));
    if (!present) return null;
    return Math.max(...fields.map(v => (v != null && !isNaN(v)) ? v : 0));
  }); // 大きいほど良い
  const ren = boats.map(b => {
    const periods = ['今期', '直近 6ヶ月', '直近 3ヶ月', '一般戦'];
    const rates = periods.map(p => b.wakuStats && b.wakuStats.niren2 && b.wakuStats.niren2[p]).filter(v => v && v.n >= 8);
    if (!rates.length) return null;
    return mean(rates.map(v => v.rate));
  }); // 大きいほど良い
  const motor = boats.map(b => (b.motor2ren != null && !isNaN(b.motor2ren)) ? b.motor2ren : null); // 大きいほど良い
  const exhibitMetrics = [b => _validExhibitTime(b.tenji), b => _validExhibitTime(b.syukai), b => _validExhibitTime(b.syukaiFoot), b => _validExhibitTime(b.chokusen)];
  const exhibit = boats.map((b) => {
    const vals = exhibitMetrics.map(f => f(b)).filter(v => v != null);
    return vals.length ? mean(vals) : null; // 小さいほど良い(時間)
  });
  return { st, kimarite, ren, motor, exhibit };
}

// レース内平均からの差分(符号調整: 正=良い方向)+欠損フラグ。標準化(std割り)は呼び出し側で行う。
function buildRawDiffFeatures(qEngine, boats) {
  const raw = extractRawPerSystem(qEngine, boats);
  function diffAndMissing(vals, higherIsBetter) {
    const valid = vals.filter(v => v != null);
    const m = valid.length ? mean(valid) : 0;
    return vals.map(v => {
      if (v == null) return { diff: 0, missing: 1 };
      const d = higherIsBetter ? (v - m) : (m - v);
      return { diff: d, missing: 0 };
    });
  }
  const stD = diffAndMissing(raw.st, false);
  const kimariteD = diffAndMissing(raw.kimarite, true);
  const renD = diffAndMissing(raw.ren, true);
  const motorD = diffAndMissing(raw.motor, true);
  const exhibitD = diffAndMissing(raw.exhibit, false);
  return boats.map((b, i) => {
    const boatNoDummies = [2, 3, 4, 5, 6].map(c => (b.no === c ? 1 : 0));
    return {
      boatNoDummies,
      stDiff: stD[i].diff, stMissing: stD[i].missing,
      kimariteDiff: kimariteD[i].diff, kimariteMissing: kimariteD[i].missing,
      renDiff: renD[i].diff, renMissing: renD[i].missing,
      motorDiff: motorD[i].diff, motorMissing: motorD[i].missing,
      exhibitDiff: exhibitD[i].diff, exhibitMissing: exhibitD[i].missing,
    };
  });
}
function toVector(f, scale) {
  return [
    ...f.boatNoDummies,
    f.stDiff / scale.st, f.stMissing,
    f.kimariteDiff / scale.kimarite, f.kimariteMissing,
    f.renDiff / scale.ren, f.renMissing,
    f.motorDiff / scale.motor, f.motorMissing,
    f.exhibitDiff / scale.exhibit, f.exhibitMissing,
  ];
}

// ===== 予測時: 全120通りを仮定上の着順で走査(確定着順は参照しない) =====
function softmaxOver(items, scoreMap) {
  const exps = items.map(no => Math.exp(scoreMap[no]));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = {};
  items.forEach((no, idx) => { probs[no] = sum > 0 ? exps[idx] / sum : 1 / items.length; });
  return probs;
}
function buildAllCombos(boatNos, score1, score2, score3) {
  const p1 = softmaxOver(boatNos, score1);
  const combos = [];
  for (const i of boatNos) {
    const rem5 = boatNos.filter(no => no !== i);
    const p2 = softmaxOver(rem5, score2);
    for (const j of rem5) {
      const rem4 = rem5.filter(no => no !== j);
      const p3 = softmaxOver(rem4, score3);
      for (const k of rem4) {
        combos.push({ val: `${i}-${j}-${k}`, p: p1[i] * p2[j] * p3[k] });
      }
    }
  }
  return combos;
}

// ===== 単体テスト(全120通り・非負・合計1・重複なし・列挙順非依存)。「合計1」を較正済みとは呼ばない =====
function runComboStructureTests(boatNos, score1, score2, score3) {
  console.log('=== 全120通り構造テスト ===');
  const combos = buildAllCombos(boatNos, score1, score2, score3);
  const uniqueVals = new Set(combos.map(c => c.val));
  const total = combos.reduce((s, c) => s + c.p, 0);
  const allNonNeg = combos.every(c => c.p >= 0);
  console.log('  件数=120:', combos.length === 120);
  console.log('  重複なし:', uniqueVals.size === combos.length);
  console.log('  全て非負:', allNonNeg);
  console.log('  合計=1(誤差1e-9以内、※「較正済み」を意味しない、あくまで確率分布としての正規化構造テスト):', Math.abs(total - 1) < 1e-9, `(実測合計=${total.toFixed(12)})`);
  const reversedBoatNos = boatNos.slice().reverse();
  const combosReversed = buildAllCombos(reversedBoatNos, score1, score2, score3);
  const mapNormal = new Map(combos.map(c => [c.val, c.p]));
  const mapReversed = new Map(combosReversed.map(c => [c.val, c.p]));
  const orderIndependent = [...mapNormal.keys()].every(k => Math.abs(mapNormal.get(k) - mapReversed.get(k)) < 1e-12);
  console.log('  候補列挙順に依存しない(艇番配列を逆順にしても同一スコア):', orderIndependent);
  return { count: combos.length, uniqueCount: uniqueVals.size, total, allNonNeg, orderIndependent };
}

function buildMarketRecord(r) {
  const entries = validOdds(r);
  if (entries.length !== 120) return { skip: 'INCOMPLETE_ODDS_120' };
  const band = entries.filter(([, v]) => v >= 50 && v <= 150).map(([val, v]) => ({ val, odds: v }));
  if (band.length < POINTS_FIXED) return { skip: 'INSUFFICIENT_BAND_CANDIDATES' };
  const sorted = band.slice().sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  return { skip: null, points: sorted.slice(0, POINTS_FIXED).map(p => p.val) };
}
function buildModelRecord(qEngine, w1, w2, w3, scale, r) {
  const feats = buildRawDiffFeatures(qEngine, r.boats);
  const vecs = feats.map(f => toVector(f, scale));
  const score1 = {}, score2 = {}, score3 = {};
  r.boats.forEach((b, i) => {
    score1[b.no] = vecs[i].reduce((s, v, k) => s + v * w1[k], 0);
    score2[b.no] = vecs[i].reduce((s, v, k) => s + v * w2[k], 0);
    score3[b.no] = vecs[i].reduce((s, v, k) => s + v * w3[k], 0);
  });
  const boatNos = r.boats.map(b => b.no);
  const combos = buildAllCombos(boatNos, score1, score2, score3); // 確定着順は未使用(スコア計算に一切登場しない)
  const entries = validOdds(r);
  if (entries.length !== 120) return { skip: 'INCOMPLETE_ODDS_120' };
  const oddsOf = {}; entries.forEach(([val, v]) => { oddsOf[val] = v; });
  const band = combos.filter(c => oddsOf[c.val] != null && oddsOf[c.val] >= 50 && oddsOf[c.val] <= 150);
  if (band.length < POINTS_FIXED) return { skip: 'INSUFFICIENT_BAND_CANDIDATES' };
  const sortedBand = band.slice().sort((a, b) => (b.p - a.p) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  return { skip: null, points: sortedBand.slice(0, POINTS_FIXED).map(c => c.val) };
}

function evalFlat(pool, pointsField) {
  let hit = 0, bandHit = 0, migratedOutHit = 0, stake = 0, payout = 0;
  const dayHitMap = {}; const seq = [];
  for (const r of pool) {
    const pts = r[pointsField];
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isBandHit = isHit && isResultBand;
    stake += pts.length * FLAT_STAKE;
    if (isHit) payout += Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    if (isHit) hit++;
    if (isBandHit) { bandHit++; dayHitMap[r.date] = true; }
    if (isHit && !isResultBand) migratedOutHit++;
    seq.push(isBandHit ? 1 : 0);
  }
  const n = pool.length;
  let maxStreak = 0, cur = 0;
  for (const s of seq) { if (s === 0) { cur++; maxStreak = Math.max(maxStreak, cur); } else cur = 0; }
  return { n, hit, bandHit, migratedOutHit, stake, payout, roi: stake ? payout / stake * 100 : null, dayHitMap, maxStreak };
}
function applyDailyCap(pool) {
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  const dates = Object.keys(byDate).sort();
  const selected = []; const perDay = {};
  for (const date of dates) {
    const dayRaces = byDate[date].slice().sort((a, b) => (a.shimekiriMs ?? 0) - (b.shimekiriMs ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP);
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates };
}

function main() {
  console.log('=== v10: 条件付き着順モデル(1着×条件付き2着×条件付き3着、生値+レース内差分)(2026-09-02) ===\n');

  const loadedAt = new Date().toISOString();
  const all = loadAllRaces();
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  console.log('データ読込完了(loadedAt=' + loadedAt + ')、以降このスナップショットのみ使用。総数=', all.length);

  // v9のisTrainEligible/classifyTimingFixedをそのまま再利用(母集団定義は継続、特徴量抽出のみ新規)
  const trainRaces = all.filter(r => v9.isTrainEligible(r) && r.date < TRAIN_HI_EXCLUSIVE);
  const evalRacesBase = all.filter(r => inRange(r.date, EVAL_LO, EVAL_HI) && require('./q_engine_entry_backtest.js').isUsable(r));
  const evalRaces = evalRacesBase.filter(r => v9.classifyTimingFixed(r).cls === 'true');
  console.log('\n=== 1. データの使い分け(v9の母集団定義を再利用、特徴量は新規抽出) ===');
  console.log('学習(isTrainEligible、date<' + TRAIN_HI_EXCLUSIVE + ') n=', trainRaces.length);
  console.log('買い目評価(classifyTimingFixed=true) n=', evalRaces.length);
  const evalDates = [...new Set(evalRaces.map(r => r.date))].sort();
  console.log('評価日付・件数:', evalDates.map(d => d + ':' + evalRaces.filter(r => r.date === d).length).join(' '));

  // ===== 2. 特徴量抽出・標準化係数(学習データのみから算出) =====
  console.log('\n=== 2. 特徴量抽出・標準化(学習データのみからstd算出、評価データには適用のみ) ===');
  const trainRawByRace = trainRaces.map(r => ({ r, feats: buildRawDiffFeatures(qEngine, r.boats) }));
  function stdOf(vals) { const m = mean(vals); return Math.sqrt(mean(vals.map(v => (v - m) ** 2))) || 1; }
  const allTrainFeats = trainRawByRace.flatMap(x => x.feats);
  const scale = {
    st: stdOf(allTrainFeats.map(f => f.stDiff)), kimarite: stdOf(allTrainFeats.map(f => f.kimariteDiff)),
    ren: stdOf(allTrainFeats.map(f => f.renDiff)), motor: stdOf(allTrainFeats.map(f => f.motorDiff)),
    exhibit: stdOf(allTrainFeats.map(f => f.exhibitDiff)),
  };
  console.log('標準化スケール(学習データの標準偏差):', JSON.stringify(scale));

  // ===== 3. データセット構築(1着=6艇, 条件付き2着=勝者を除く5艇, 条件付き3着=1・2着を除く4艇) =====
  console.log('\n=== 3. データセット構築(実際の先着艇で条件付け、学習用) ===');
  const ds1 = [], ds2 = [], ds3 = [];
  let skippedNoChakuju = 0;
  for (const { r, feats } of trainRawByRace) {
    if (!r.chakuju) { skippedNoChakuju++; continue; }
    const parts = r.chakuju.split('-').map(Number);
    const [w, s, t] = parts;
    const vecs = feats.map(f => toVector(f, scale));
    const winIdx = r.boats.findIndex(b => b.no === w);
    if (winIdx < 0) continue;
    ds1.push({ features: vecs, winnerIdx: winIdx });

    const idx5 = r.boats.map((b, i) => i).filter(i => r.boats[i].no !== w);
    const secIdxIn5 = idx5.findIndex(i => r.boats[i].no === s);
    if (secIdxIn5 >= 0) ds2.push({ features: idx5.map(i => vecs[i]), winnerIdx: secIdxIn5 });

    const idx4 = idx5.filter(i => r.boats[i].no !== s);
    const thirdIdxIn4 = idx4.findIndex(i => r.boats[i].no === t);
    if (thirdIdxIn4 >= 0) ds3.push({ features: idx4.map(i => vecs[i]), winnerIdx: thirdIdxIn4 });
  }
  console.log('1着データセット n=', ds1.length, ' 条件付き2着データセット n=', ds2.length, ' 条件付き3着データセット n=', ds3.length, ' (chakuju欠落で除外=', skippedNoChakuju, ')');

  console.log('\n=== 4. 学習(3段独立、多項ロジット回帰、L2=0.05・LR=0.3・EPOCHS=500固定・総当たりなし) ===');
  console.log('-- 1着モデル --'); const w1 = trainWeights(ds1, NFEAT);
  console.log('-- 条件付き2着モデル --'); const w2 = trainWeights(ds2, NFEAT);
  console.log('-- 条件付き3着モデル --'); const w3 = trainWeights(ds3, NFEAT);
  console.log('\n係数一覧:');
  FEATURE_LABELS.forEach((name, i) => console.log(`  ${name}: 1着=${w1[i].toFixed(3)} 2着=${w2[i].toFixed(3)} 3着=${w3[i].toFixed(3)}`));

  // ===== 5. 全120通り構造テスト(サンプルレースで実施) =====
  console.log('\n');
  {
    const sample = evalRaces[0];
    const feats = buildRawDiffFeatures(qEngine, sample.boats);
    const vecs = feats.map(f => toVector(f, scale));
    const score1 = {}, score2 = {}, score3 = {};
    sample.boats.forEach((b, i) => {
      score1[b.no] = vecs[i].reduce((s, v, k) => s + v * w1[k], 0);
      score2[b.no] = vecs[i].reduce((s, v, k) => s + v * w2[k], 0);
      score3[b.no] = vecs[i].reduce((s, v, k) => s + v * w3[k], 0);
    });
    runComboStructureTests(sample.boats.map(b => b.no), score1, score2, score3);
  }

  // ===== 6. 予測性能(1着・条件付き2着・条件付き3着、評価データ、実際の先着艇で条件付け) =====
  console.log('\n=== 6. 予測性能(評価データ、真の条件付けを使った標準的な検証) ===');
  function buildEvalDataset(wStage, stageNum) {
    const ds = [];
    for (const r of evalRaces) {
      if (!r.chakuju) continue;
      const parts = r.chakuju.split('-').map(Number);
      const [w, s, t] = parts;
      const feats = buildRawDiffFeatures(qEngine, r.boats);
      const vecs = feats.map(f => toVector(f, scale));
      if (stageNum === 1) {
        const winIdx = r.boats.findIndex(b => b.no === w);
        if (winIdx >= 0) ds.push({ features: vecs, winnerIdx: winIdx });
      } else if (stageNum === 2) {
        const idx5 = r.boats.map((b, i) => i).filter(i => r.boats[i].no !== w);
        const secIdxIn5 = idx5.findIndex(i => r.boats[i].no === s);
        if (secIdxIn5 >= 0) ds.push({ features: idx5.map(i => vecs[i]), winnerIdx: secIdxIn5 });
      } else if (stageNum === 3) {
        const idx5 = r.boats.map((b, i) => i).filter(i => r.boats[i].no !== w);
        const idx4 = idx5.filter(i => r.boats[i].no !== s);
        const thirdIdxIn4 = idx4.findIndex(i => r.boats[i].no === t);
        if (thirdIdxIn4 >= 0) ds.push({ features: idx4.map(i => vecs[i]), winnerIdx: thirdIdxIn4 });
      }
    }
    return ds;
  }
  function scoreDataset(dataset, w) {
    let correct = 0, logLossSum = 0;
    for (const { features, winnerIdx } of dataset) {
      const scores = features.map(x => x.reduce((s, v, k) => s + v * w[k], 0));
      const maxS = Math.max(...scores);
      const exps = scores.map(s => Math.exp(s - maxS));
      const total = exps.reduce((a, b) => a + b, 0);
      const probs = exps.map(e => e / total);
      if (probs.indexOf(Math.max(...probs)) === winnerIdx) correct++;
      logLossSum += -Math.log(Math.max(probs[winnerIdx], 1e-9));
    }
    const n = dataset.length;
    return { n, accuracy: n ? correct / n : null, logLoss: n ? logLossSum / n : null };
  }
  const eval1 = scoreDataset(buildEvalDataset(w1, 1), w1);
  const eval2 = scoreDataset(buildEvalDataset(w2, 2), w2);
  const eval3 = scoreDataset(buildEvalDataset(w3, 3), w3);
  console.log(`1着モデル: n=${eval1.n} 的中率=${(eval1.accuracy * 100).toFixed(1)}% logLoss=${eval1.logLoss.toFixed(3)}(ベースライン1/6=16.7%)`);
  console.log(`条件付き2着モデル: n=${eval2.n} 的中率=${(eval2.accuracy * 100).toFixed(1)}% logLoss=${eval2.logLoss.toFixed(3)}(ベースライン1/5=20.0%)`);
  console.log(`条件付き3着モデル: n=${eval3.n} 的中率=${(eval3.accuracy * 100).toFixed(1)}% logLoss=${eval3.logLoss.toFixed(3)}(ベースライン1/4=25.0%)`);

  // ===== 7. A/B比較(市場基準 vs 新モデル、同一評価集合、帯内8点・100円固定、選別なし→締切順10件上限) =====
  console.log('\n=== 7. A/B比較 ===');
  const records = [];
  for (const r of evalRaces) {
    const market = buildMarketRecord(r);
    const model = buildModelRecord(qEngine, w1, w2, w3, scale, r);
    records.push({
      date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMs: v9.shimekiriMsFixed(r.date, r.shimekiri),
      chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
      marketSkip: market.skip, marketPoints: market.points,
      modelSkip: model.skip, modelPoints: model.points,
    });
  }
  const both = records.filter(r => !r.marketSkip && !r.modelSkip);
  console.log('評価対象 n=', evalRaces.length, ' 両方式構成可能(積集合) n=', both.length);
  const pureA = evalFlat(both, 'marketPoints');
  const pureB = evalFlat(both, 'modelPoints');
  console.log(`選別なし: 市場 帯内的中${pureA.bandHit}/${pureA.n}=${(pureA.bandHit / pureA.n * 100).toFixed(2)}% ROI${pureA.roi.toFixed(1)}%`);
  console.log(`選別なし: 木モデル→今回は条件付きモデル 帯内的中${pureB.bandHit}/${pureB.n}=${(pureB.bandHit / pureB.n * 100).toFixed(2)}% ROI${pureB.roi.toFixed(1)}%`);
  let onlyModelPure = 0, onlyMarketPure = 0, bothPure = 0;
  for (const r of both) {
    const hm = r.chakuju && r.modelPoints.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
    const hk = r.chakuju && r.marketPoints.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
    if (hm && hk) bothPure++; else if (hm) onlyModelPure++; else if (hk) onlyMarketPure++;
  }

  const marketPool = records.filter(r => !r.marketSkip);
  const modelPool = records.filter(r => !r.modelSkip);
  const capA = applyDailyCap(marketPool);
  const capB = applyDailyCap(modelPool);
  const resA = evalFlat(capA.selected, 'marketPoints');
  const resB = evalFlat(capB.selected, 'modelPoints');
  console.log(`\nA(市場基準、締切順1日10件上限後): n=${resA.n} 日数=${capA.dates.length} 1日平均=${(resA.n / capA.dates.length).toFixed(1)}`);
  console.log(`  帯内的中率=${(resA.bandHit / resA.n * 100).toFixed(2)}%(${resA.bandHit}件) 全的中率=${(resA.hit / resA.n * 100).toFixed(2)}% ROI=${resA.roi.toFixed(1)}% 無的中日=${capA.dates.filter(d => !resA.dayHitMap[d]).length}/${capA.dates.length} 最大連敗=${resA.maxStreak}`);
  console.log(`\nB(条件付きモデル、締切順1日10件上限後): n=${resB.n} 日数=${capB.dates.length} 1日平均=${(resB.n / capB.dates.length).toFixed(1)}`);
  console.log(`  帯内的中率=${(resB.bandHit / resB.n * 100).toFixed(2)}%(${resB.bandHit}件) 全的中率=${(resB.hit / resB.n * 100).toFixed(2)}% ROI=${resB.roi.toFixed(1)}% 無的中日=${capB.dates.filter(d => !resB.dayHitMap[d]).length}/${capB.dates.length} 最大連敗=${resB.maxStreak}`);

  const aKeys = new Map(capA.selected.map(r => [`${r.date}_${r.venue}_${r.racenum}`, r]));
  const bKeys = new Map(capB.selected.map(r => [`${r.date}_${r.venue}_${r.racenum}`, r]));
  let onlyA = 0, onlyB = 0, bothHit = 0;
  const allKeys = new Set([...aKeys.keys(), ...bKeys.keys()]);
  for (const k of allKeys) {
    const ra = aKeys.get(k), rb = bKeys.get(k);
    const hitA = ra && ra.chakuju && ra.marketPoints.includes(ra.chakuju) && ra.payoutMul >= 50 && ra.payoutMul <= 150;
    const hitB = rb && rb.chakuju && rb.modelPoints.includes(rb.chakuju) && rb.payoutMul >= 50 && rb.payoutMul <= 150;
    if (hitA && hitB) bothHit++; else if (hitA) onlyA++; else if (hitB) onlyB++;
  }
  console.log(`\nAだけ的中=${onlyA} Bだけ的中=${onlyB} 両方的中=${bothHit}(上限適用後)`);

  console.log('\n=== 目標(10本前後・帯内的中率20%)との差 ===');
  console.log(`A: 1日平均${(resA.n / capA.dates.length).toFixed(1)}本 帯内的中率${(resA.bandHit / resA.n * 100).toFixed(2)}%(差${(20 - resA.bandHit / resA.n * 100).toFixed(1)}pt)`);
  console.log(`B: 1日平均${(resB.n / capB.dates.length).toFixed(1)}本 帯内的中率${(resB.bandHit / resB.n * 100).toFixed(2)}%(差${(20 - resB.bandHit / resB.n * 100).toFixed(1)}pt)`);

  // ===== 新規凍結入力(v9のfrozenは上書きしない、生値ベースの別ファイル) =====
  const trainContentHash = hashObj(ds1.map(d => ({ f: d.features, w: d.winnerIdx })));
  const evalContentForFreeze = evalRaces.map(r => ({ key: `${r.date}_${r.venue}_${r.racenum}`, boats: r.boats, oddsMap: r.oddsMap, chakuju: r.chakuju, payout: r.payout, shimekiri: r.shimekiri, archivedAt: r.archivedAt }));
  const evalContentHash = hashObj(evalContentForFreeze);
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_conditional_rank_model_v10_frozen_train_2026-09-02.json'), JSON.stringify({ generatedAt: loadedAt, note: 'v9のisTrainEligible母集団を再利用、特徴量は生値+レース内差分で新規抽出(v9のframeとは別ファイル、v9側は上書きしていない)', contentHash: trainContentHash, scale, ds1Count: ds1.length, ds2Count: ds2.length, ds3Count: ds3.length }));
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_conditional_rank_model_v10_saved_weights_2026-09-02.json'), JSON.stringify({ generatedAt: loadedAt, featureLabels: FEATURE_LABELS, scale, w1, w2, w3 }));

  const manifest = {
    generatedAt: loadedAt,
    scopeNote: '既存データのみ使用(開発用、既に分析済みの期間、探索的評価)。v9のisTrainEligible/classifyTimingFixed母集団定義を再利用、特徴量は生値+レース内差分で新規抽出。市場オッズは学習入力に不使用。',
    dataUsage: { trainCount: trainRaces.length, evalCount: evalRaces.length, ds1Count: ds1.length, ds2Count: ds2.length, ds3Count: ds3.length },
    featureLabels: FEATURE_LABELS, scale,
    stagePerformance: { stage1: eval1, stage2: eval2, stage3: eval3 },
    pureRanking: { n: both.length, market: pureA, model: pureB, onlyModel: onlyModelPure, onlyMarket: onlyMarketPure, both: bothPure },
    afterDailyCap: { A: { ...resA, dayHitMap: undefined, days: capA.dates.length }, B: { ...resB, dayHitMap: undefined, days: capB.dates.length }, onlyA, onlyB, both: bothHit },
    trainContentHash, evalContentHash,
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_conditional_rank_model_v10_2026-09-02.json'), JSON.stringify(manifest, null, 2));
  console.log('\n結果を logs/research_conditional_rank_model_v10_2026-09-02.json へ保存しました。');
}

if (require.main === module) main();
module.exports = { main, buildRawDiffFeatures, toVector, buildAllCombos, softmaxOver, runComboStructureTests, FEATURE_LABELS };
