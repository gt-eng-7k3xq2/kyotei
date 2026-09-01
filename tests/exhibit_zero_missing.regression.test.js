'use strict';
// 展示欠損0秒問題(2026-09-01発見)の回帰テスト。修正前に失敗し、修正後に通ることを確認する。
// tests/lib/fixed-q-engine.js の loadFixedQEngine() を使い、本番ファイルは一切変更しない。
// 使い方: node tests/exhibit_zero_missing.regression.test.js

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadFixedQEngine } = require('./lib/fixed-q-engine.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

function makeBoats(overrides = {}) {
  // 6艇、通常は全て有効な展示値(異なる値、艇1が最速=6.50〜艇6が最遅=6.95)を持つ
  const base = [6.50, 6.60, 6.70, 6.80, 6.90, 6.95];
  return base.map((t, i) => ({
    no: i + 1, name: `選手${i + 1}`,
    tenji: t, syukai: 18 + i * 0.1, syukaiFoot: 4.5 + i * 0.05, chokusen: 7 + i * 0.05,
    konkiAvgST: 0.15, motor2ren: 35,
    ...(overrides[i + 1] || {}),
  }));
}

console.log('=== テスト1: 正常値だけの入力では従来結果(原本)と一致 ===');
{
  const original = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats();
  const sOrig = original.evaluateBoatSupport(boats);
  const sFixed = fixed.evaluateBoatSupport(boats);
  const same = sOrig.every((s, i) => s.rawScore === sFixed[i].rawScore);
  check('正常値のみなら修正前後でrawScoreが完全一致', same);
}

console.log('=== テスト2: 0秒(欠損)が実測の最速タイムとして加点されない ===');
{
  // 艇1: 4項目とも他艇より明確に悪い値(最下位級)にした上で、tenjiだけ0(欠損)にする。
  // 修正前(バグ)はtenji=0を「最速(rank1)」と誤認し、艇1の展示pointsを実力以上に押し上げる。
  // 修正後は該当項目を除外し、残り3項目(いずれも最下位級)だけで評価するため、
  // 展示pointsは修正前より低くなるはず(=欠損を実測の最速タイムとして加点していない)。
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const original = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats({ 1: { tenji: 0, syukai: 19.9, syukaiFoot: 4.99, chokusen: 7.99 } });
  const supportOrig = original.evaluateBoatSupport(boats);
  const supportFixed = fixed.evaluateBoatSupport(boats);
  console.log(`  (参考)艇1の展示points: 修正前=${supportOrig[0].detail.exhibit.points} 修正後=${supportFixed[0].detail.exhibit.points}`);
  check('修正後は艇1の展示pointsが修正前より低い(欠損項目が加点に使われない、これが本質的な回帰確認)', supportFixed[0].detail.exhibit.points < supportOrig[0].detail.exhibit.points);
}

console.log('=== テスト3: 全項目欠損の艇が最上位にならない ===');
{
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats({ 1: { tenji: 0, syukai: 0, syukaiFoot: 0, chokusen: 0 } });
  const support = fixed.evaluateBoatSupport(boats);
  check('全項目欠損の艇の展示rankはnull(除外)', support[0].detail.exhibit.rank == null);
  check('全項目欠損の艇の展示pointsは中立値3.5(0でも最大でもない)', support[0].detail.exhibit.points === 3.5);
}

console.log('=== テスト4: 一部項目だけ欠損した場合 ===');
{
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats({ 1: { chokusen: 0 } }); // 艇1のchokusenだけ欠損、他3項目は正常
  const support = fixed.evaluateBoatSupport(boats);
  // 艇1は依然として最速のtenji等を持つため、残り3項目の平均で妥当な順位になるはず(nullにはならない)
  check('一部項目だけ欠損でも展示rankがnullにならない(残り項目で評価継続)', support[0].detail.exhibit.rank != null);
}

console.log('=== テスト5: 全艇で同一項目が欠損した場合 ===');
{
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats().map(b => ({ ...b, chokusen: 0 })); // 全艇chokusen欠損
  let threw = false;
  let support;
  try { support = fixed.evaluateBoatSupport(boats); } catch (e) { threw = true; }
  check('全艇で同一項目欠損でも例外が発生しない', !threw);
  if (!threw) check('残り3項目(tenji/syukai/syukaiFoot)による順位付けが機能する', support.every(s => s.detail.exhibit.rank != null));
}

console.log('=== テスト6: 全艇・全展示項目が欠損した場合 ===');
{
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats().map(b => ({ ...b, tenji: 0, syukai: 0, syukaiFoot: 0, chokusen: 0 }));
  let threw = false; let support;
  try { support = fixed.evaluateBoatSupport(boats); } catch (e) { threw = true; }
  check('全艇・全展示項目欠損でも例外が発生しない', !threw);
  if (!threw) {
    check('全艇の展示rankがnull', support.every(s => s.detail.exhibit.rank == null));
    check('全艇の展示pointsが中立値3.5で統一(誰も有利不利にならない)', support.every(s => s.detail.exhibit.points === 3.5));
  }
}

console.log('=== テスト7: 同値順位と処理順序の安定性 ===');
{
  const fixed1 = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const fixed2 = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats({ 1: { tenji: 6.60 }, 2: { tenji: 6.60 } }); // 艇1・2が同値
  const s1 = fixed1.evaluateBoatSupport(boats);
  const s2 = fixed2.evaluateBoatSupport(boats);
  const same = s1.every((s, i) => s.rawScore === s2[i].rawScore && s.detail.exhibit.rank === s2[i].detail.exhibit.rank);
  check('同値を含む入力でも複数回の実行結果が完全一致(安定)', same);
}

console.log('=== テスト8: 入力原本(boatsオブジェクト)が変更されない ===');
{
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats({ 1: { tenji: 0, syukai: 0, syukaiFoot: 0, chokusen: 0 } });
  const before = JSON.parse(JSON.stringify(boats));
  fixed.evaluateBoatSupport(boats);
  fixed.generateQBets(boats, {});
  check('evaluateBoatSupport/generateQBets呼び出し後もboats入力が不変', JSON.stringify(boats) === JSON.stringify(before));
}

console.log('=== テスト9: 修正前(原本)では実際にバグが再現すること(退行確認) ===');
{
  const original = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const boats = makeBoats({ 1: { tenji: 0, syukai: 0, syukaiFoot: 0, chokusen: 0 } });
  const support = original.evaluateBoatSupport(boats);
  check('修正前(原本)は全項目欠損の艇が展示rank=1になる(バグを再現、原本は無変更のまま検証)', support[0].detail.exhibit.rank === 1);
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
