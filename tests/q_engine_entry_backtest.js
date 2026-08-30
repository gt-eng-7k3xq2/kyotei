'use strict';
// Qエンジン(garon_q_engine.html)の脳みそ(generateQBets)を、結果確定済みの過去データ全件に
// 適用し、的中率・ROIを集計するバックテスト。
//
// 背景: 2026-08-26夜のセッションで同種の分析が行われ「攻め手候補の逆転ケース(gap負)が
// 的中率を壊滅させている」という所見が出たが、そのスクリプト自体が保存されておらず失われた
// (project_q_engine_entry_backtest_reversal_findingメモリ参照)。本スクリプトはゼロから再構築し、
// 併せて「3つの切り口が同じレース集団の重複カウントではないか」という交絡・選択効果の疑いを
// クロス集計で検証する。
//
// 資金配分・ROI計算はtests/weighted_optimization_search.jsのallocateStakesEqualRet(sg_narutou.html
// recalcAlloc()の「均等回収」を移植したもの)をそのまま踏襲し、3,000円均等回収配分で統一する。

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;

function parsePayout100(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// tests/weighted_optimization_search.js:82-103 と同一ロジック
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

function loadAllRaces() {
  const files = fs.readdirSync(ROOT).filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const races = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const r of d) races.push(r);
  }
  return races;
}

function isUsable(r) {
  return r.resulted && r.oddsMap && Object.keys(r.oddsMap).length > 0 &&
    r.boats && r.boats.length === 6 && r.boats.every(b => !b.isJogai) && r.chakuju;
}

function hasFullData(r) {
  // evaluateBoatSupportのren系統(wakuStats.niren2)に実データがある艇が1艇でもいるか。
  return r.boats.some(b => b.wakuStats && b.wakuStats.niren2 &&
    Object.values(b.wakuStats.niren2).some(v => v && v.n >= 8));
}

function analyzeRace(engine, r) {
  const attackCands = engine.identifyAttackCandidates(r.boats);
  const bets = engine.generateQBets(r.boats, r.oddsMap);
  const finalAxes = bets.axes;
  const primaryAxes = finalAxes.filter(a => !a.narrow);
  const topAxis = finalAxes[0];
  const usedAttackTheory = topAxis && topAxis.reason === 'ST攻め手候補';

  // 2026-08-30: gapはgenerateQBets自身の返り値(bets.gap/bets.judge)をそのまま使う
  // (以前はここで独立に再計算していたが、本番〈generateQBets〉とバックテストが同じ式を
  // 別々の場所に書く=将来ズレるリスクがあったため、本番の計算結果を直接読む形に統一した)。
  const gap = bets.gap;
  const judge = bets.judge;

  // 買い目の点(全フォーメーションの合算、重複除去)
  const allPoints = new Set();
  bets.formations.forEach(f => f.points.forEach(p => allPoints.add(p)));
  const betVals = [...allPoints];

  const amounts = allocateStakesEqualRet(betVals, r.oddsMap, SHIKIN);
  const hitIdx = betVals.indexOf(r.chakuju);
  const hit = hitIdx >= 0;
  const stake = amounts.reduce((s, a) => s + a, 0);
  const payout = hit ? Math.round(amounts[hitIdx] / 100 * parsePayout100(r.payout)) : 0;

  return {
    venue: r.venue, racenum: r.racenum, date: r.date, chakuju: r.chakuju,
    axisBoat: topAxis.boat, axisCount: primaryAxes.length, usedAttackTheory, gap,
    entered: judge ? judge.entered : (gap >= 0), // judge未定義(旧エンジン)へのフォールバック
    maxGapAttack: attackCands.length ? Math.max(...attackCands.map(c => c.maxGap)) : null,
    betCount: betVals.length, hit, stake, payout, profit: payout - stake,
  };
}

function summarize(rows) {
  const n = rows.length;
  if (!n) return { n: 0, hitRate: null, roi: null, stake: 0, payout: 0, profit: 0 };
  const hits = rows.filter(r => r.hit).length;
  const stake = rows.reduce((s, r) => s + r.stake, 0);
  const payout = rows.reduce((s, r) => s + r.payout, 0);
  return {
    n, hits, hitRate: hits / n * 100, roi: stake ? payout / stake * 100 : null,
    stake, payout, profit: payout - stake,
  };
}

function fmt(s) {
  if (!s.n) return 'n=0';
  return `n=${s.n}\t的中率${s.hitRate.toFixed(1)}%\tROI${s.roi.toFixed(1)}%\t純損益${s.profit >= 0 ? '+' : ''}¥${s.profit.toLocaleString()}`;
}

function gapBucket(gap) {
  if (gap < 0) return '負(逆転)';
  if (gap < 3) return '0-3';
  if (gap < 6) return '3-6';
  if (gap < 10) return '6-10';
  return '10+';
}

function main() {
  const engine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const allRaces = loadAllRaces();
  const usable = allRaces.filter(isUsable);
  const fullData = usable.filter(hasFullData);

  console.log(`全レース: ${allRaces.length} / 集計可能(結果確定・オッズ有・6艇・欠場無): ${usable.length} / うち個人×コース連対率データ有: ${fullData.length}`);
  console.log('');

  const rows = fullData.map(r => {
    try { return analyzeRace(engine, r); } catch (e) { console.error('ERROR', r.venue, r.racenum, r.date, e.message); return null; }
  }).filter(Boolean);

  console.log(`=== 解析対象 n=${rows.length}(個人×コース連対率データ有りのレースのみ) ===\n`);

  console.log('--- gap(軸のスコア − 軸外最高スコア)別 ---');
  ['負(逆転)', '0-3', '3-6', '6-10', '10+'].forEach(b => {
    console.log(`${b}\t${fmt(summarize(rows.filter(r => gapBucket(r.gap) === b)))}`);
  });

  // 2026-08-30: generateQBets自身のjudge(見送り/参戦)による集計。上の「負(逆転)」バケットと
  // 定義上完全に同一(entered=false ⟺ gap<0)になるはずなので、この2行が一致しない場合は
  // 本番ロジックとバックテストのgap計算がズレている(配線バグ)のサインとして扱うこと。
  console.log('\n--- 参入判定(generateQBets.judge)別 ---');
  console.log(`見送り(gap<0)\t${fmt(summarize(rows.filter(r => !r.entered)))}`);
  console.log(`参戦\t\t${fmt(summarize(rows.filter(r => r.entered)))}`);

  console.log('\n--- 軸の数別 ---');
  console.log(`1個\t${fmt(summarize(rows.filter(r => r.axisCount === 1)))}`);
  console.log(`2個\t${fmt(summarize(rows.filter(r => r.axisCount === 2)))}`);

  console.log('\n--- 攻め手候補理論の使用有無 ---');
  console.log(`使用\t${fmt(summarize(rows.filter(r => r.usedAttackTheory)))}`);
  console.log(`不使用\t${fmt(summarize(rows.filter(r => !r.usedAttackTheory)))}`);

  console.log('\n=== 交絡チェック: 3つの切り口はどれだけ重なっているか ===');
  const negGap = rows.filter(r => r.gap < 0);
  const axis1 = rows.filter(r => r.axisCount === 1);
  const usedTheory = rows.filter(r => r.usedAttackTheory);
  const overlapAll = rows.filter(r => r.gap < 0 && r.axisCount === 1 && r.usedAttackTheory);
  console.log(`gap負: n=${negGap.length} / 軸1個: n=${axis1.length} / 理論使用: n=${usedTheory.length}`);
  console.log(`3条件全て該当: n=${overlapAll.length}`);
  console.log(`gap負のうち軸1個の割合: ${(negGap.filter(r => r.axisCount === 1).length / negGap.length * 100).toFixed(1)}%`);
  console.log(`gap負のうち理論使用の割合: ${(negGap.filter(r => r.usedAttackTheory).length / negGap.length * 100).toFixed(1)}%`);
  console.log(`軸1個のうち理論使用の割合: ${(axis1.filter(r => r.usedAttackTheory).length / axis1.length * 100).toFixed(1)}%`);

  console.log('\n=== 選択効果チェック: 理論使用でもgapが負でない(逆転していない)場合 ===');
  console.log(`理論使用&gap>=0(素直に理論通り選ばれた)\t${fmt(summarize(rows.filter(r => r.usedAttackTheory && r.gap >= 0)))}`);
  console.log(`理論不使用(高得点艇を素直に軸)\t\t${fmt(summarize(rows.filter(r => !r.usedAttackTheory)))}`);
  console.log(`理論使用&gap<0(逆転)\t\t\t${fmt(summarize(rows.filter(r => r.usedAttackTheory && r.gap < 0)))}`);

  console.log('\n=== 全体(参考) ===');
  console.log(fmt(summarize(rows)));

  return rows;
}

if (require.main === module) main();
module.exports = { main, analyzeRace, isUsable, hasFullData, loadAllRaces, allocateStakesEqualRet, gapBucket };
