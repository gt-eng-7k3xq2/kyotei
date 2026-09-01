'use strict';
// 展示欠損0秒問題の本番反映後の確認テスト(2026-09-01)。garon_q_engine.html自体が既に修正済み
// のため、比較対象は「本番(修正後)」vs「保存済みスナップショット
// garon_q_engine_pre_exhibit_fix_2026-09-01_SNAPSHOT.html(修正前)」とする。
// tests/exhibit_zero_missing.regression.test.jsと同じ13項目を、本番ファイルに対して直接検証する。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');

const ROOT = path.join(__dirname, '..');
const PRODUCTION_PATH = path.join(ROOT, 'garon_q_engine.html'); // 修正後(v2)
const SNAPSHOT_PATH = path.join(ROOT, 'garon_q_engine_pre_exhibit_fix_2026-09-01_SNAPSHOT.html'); // 修正前(v1)

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

function makeBoats(overrides = {}) {
  const base = [6.50, 6.60, 6.70, 6.80, 6.90, 6.95];
  return base.map((t, i) => ({
    no: i + 1, name: `選手${i + 1}`,
    tenji: t, syukai: 18 + i * 0.1, syukaiFoot: 4.5 + i * 0.05, chokusen: 7 + i * 0.05,
    konkiAvgST: 0.15, motor2ren: 35,
    ...(overrides[i + 1] || {}),
  }));
}

const production = loadQEngine(PRODUCTION_PATH);
const snapshot = loadQEngine(SNAPSHOT_PATH);
console.log('production Q_ENGINE_VERSION:', production.Q_ENGINE_VERSION, '(2のはず)');
console.log('snapshot Q_ENGINE_VERSION:', snapshot.Q_ENGINE_VERSION, '(1のはず)');
check('本番は修正後(v2)', production.Q_ENGINE_VERSION === 2);
check('スナップショットは修正前(v1)のまま', snapshot.Q_ENGINE_VERSION === 1);

console.log('\n=== テスト1: 正常値だけの入力ではスナップショット(修正前)と本番(修正後)が一致 ===');
{
  const boats = makeBoats();
  const sSnap = snapshot.evaluateBoatSupport(boats);
  const sProd = production.evaluateBoatSupport(boats);
  check('正常値のみなら修正前後でrawScoreが完全一致', sSnap.every((s, i) => s.rawScore === sProd[i].rawScore));
}

console.log('\n=== テスト2: 0秒(欠損)が実測の最速タイムとして加点されない ===');
{
  const boats = makeBoats({ 1: { tenji: 0, syukai: 19.9, syukaiFoot: 4.99, chokusen: 7.99 } });
  const sSnap = snapshot.evaluateBoatSupport(boats);
  const sProd = production.evaluateBoatSupport(boats);
  console.log(`  艇1の展示points: スナップショット(修正前)=${sSnap[0].detail.exhibit.points} 本番(修正後)=${sProd[0].detail.exhibit.points}`);
  check('本番(修正後)は展示pointsがスナップショット(修正前)より低い', sProd[0].detail.exhibit.points < sSnap[0].detail.exhibit.points);
}

console.log('\n=== テスト3: 全項目欠損の艇が最上位にならない(本番) ===');
{
  const boats = makeBoats({ 1: { tenji: 0, syukai: 0, syukaiFoot: 0, chokusen: 0 } });
  const support = production.evaluateBoatSupport(boats);
  check('全項目欠損の艇の展示rankはnull(除外)', support[0].detail.exhibit.rank == null);
  check('全項目欠損の艇の展示pointsは中立値3.5', support[0].detail.exhibit.points === 3.5);
}

console.log('\n=== テスト4: 一部項目だけ欠損した場合(本番) ===');
{
  const boats = makeBoats({ 1: { chokusen: 0 } });
  const support = production.evaluateBoatSupport(boats);
  check('一部項目だけ欠損でも展示rankがnullにならない', support[0].detail.exhibit.rank != null);
}

console.log('\n=== テスト5: 全艇で同一項目が欠損した場合(本番) ===');
{
  const boats = makeBoats().map(b => ({ ...b, chokusen: 0 }));
  let threw = false; let support;
  try { support = production.evaluateBoatSupport(boats); } catch (e) { threw = true; }
  check('全艇で同一項目欠損でも例外が発生しない', !threw);
  if (!threw) check('残り3項目による順位付けが機能する', support.every(s => s.detail.exhibit.rank != null));
}

console.log('\n=== テスト6: 全艇・全展示項目が欠損した場合(本番) ===');
{
  const boats = makeBoats().map(b => ({ ...b, tenji: 0, syukai: 0, syukaiFoot: 0, chokusen: 0 }));
  let threw = false; let support;
  try { support = production.evaluateBoatSupport(boats); } catch (e) { threw = true; }
  check('全艇・全展示項目欠損でも例外が発生しない', !threw);
  if (!threw) {
    check('全艇の展示rankがnull', support.every(s => s.detail.exhibit.rank == null));
    check('全艇の展示pointsが中立値3.5で統一', support.every(s => s.detail.exhibit.points === 3.5));
  }
}

console.log('\n=== テスト7: 同値順位と処理順序の安定性(本番) ===');
{
  const boats = makeBoats({ 1: { tenji: 6.60 }, 2: { tenji: 6.60 } });
  const s1 = production.evaluateBoatSupport(boats);
  const s2 = production.evaluateBoatSupport(boats);
  check('同値を含む入力でも複数回の実行結果が完全一致', s1.every((s, i) => s.rawScore === s2[i].rawScore && s.detail.exhibit.rank === s2[i].detail.exhibit.rank));
}

console.log('\n=== テスト8: 入力原本(boatsオブジェクト)が変更されない(本番) ===');
{
  const boats = makeBoats({ 1: { tenji: 0, syukai: 0, syukaiFoot: 0, chokusen: 0 } });
  const before = JSON.parse(JSON.stringify(boats));
  production.evaluateBoatSupport(boats);
  production.generateQBets(boats, {});
  check('呼び出し後もboats入力が不変', JSON.stringify(boats) === JSON.stringify(before));
}

console.log('\n=== テスト9: 実例(2026-07-01三国8R)で軸が変わることを本番で確認 ===');
{
  const backtest = require('./q_engine_entry_backtest.js');
  const all = backtest.loadAllRaces();
  const r = all.find(x => x.date === '2026-07-01' && x.venue === '三国' && String(x.racenum) === '8');
  if (r) {
    const betsSnap = snapshot.generateQBets(r.boats, r.oddsMap || {});
    const betsProd = production.generateQBets(r.boats, r.oddsMap || {});
    console.log(`  スナップショット(修正前)軸=${betsSnap.axes[0].boat} gap=${betsSnap.gap} / 本番(修正後)軸=${betsProd.axes[0].boat} gap=${betsProd.gap}`);
    check('実例レースで軸が1→3に変わる(修正の効果が本番で再現)', betsSnap.axes[0].boat === 1 && betsProd.axes[0].boat === 3);
  } else {
    console.log('  (該当レースがアーカイブに見つからずスキップ)');
  }
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
