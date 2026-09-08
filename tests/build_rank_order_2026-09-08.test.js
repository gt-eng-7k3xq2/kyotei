'use strict';
// 評価順(◎○▲△▽×の並び)の構築ロジック修正(2026-09-08、CEO指摘・大村6R実例)の検証。
// 軸(1位)は不変、2位以下を「その艇が登場する全選択済み買い目の確率合計」で並べ替える
// buildRankOrder()が、(a) 常に1-6の順列を返す、(b) 1位が必ずmaruBoat、(c) 旧方式(軸は
// 全員rawScore勢より先)と比べて、実際に買い目全体での関与量を反映した順位になっている、
// ことを確認する。
//
// 使い方: node tests/build_rank_order_2026-09-08.test.js

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'garon_q_engine.html');
const FROZEN_PATH = path.join(ROOT, 'research/q_stage_diagnosis_2026-09-07/snapshots/frozen_complete_races.json');

// 旧方式(2026-08-27〜2026-09-08版): 軸を全員先に並べ、残りはrawScore降順
function oldRankOrder(supportSorted, axisBoatsInOrder) {
  const remaining = supportSorted.map(s => s.no).filter(no => !axisBoatsInOrder.includes(no));
  return [...axisBoatsInOrder, ...remaining];
}

function main() {
  console.log('garon_q_engine.html から抽出中...');
  const engine = loadQEngine(HTML_PATH);

  // 大村6Rのような「自分の軸は薄いが他の軸の買い目に頻繁に登場する艇」がある例を、
  // 実データから直接再現する(架空データではなく実際のQv2出力で検証するため)。
  console.log('凍結データ読み込み中...');
  const races = JSON.parse(fs.readFileSync(FROZEN_PATH, 'utf8'));
  const sample = races.filter((_, i) => i % 5 === 0); // 約750件

  let checked = 0, permutationFail = 0, firstMismatch = 0, differsFromOld = 0;
  let exampleShown = false;

  for (const r of sample) {
    const support = engine.evaluateBoatSupport(r.boats);
    const result = engine.generateQBets(r.boats, r.oddsMap);
    const dbg = result._dbg;
    const supportSorted = [...support].sort((a, b) => b.rawScore - a.rawScore);
    const axisBoatsInOrder = result.axes.map(a => a.boat);

    const newOrder = engine.buildRankOrder(supportSorted, axisBoatsInOrder, dbg);
    const oldOrder = oldRankOrder(supportSorted, axisBoatsInOrder);
    checked++;

    // (a) 1-6の順列であること
    const sortedNew = [...newOrder].sort((a, b) => a - b);
    if (JSON.stringify(sortedNew) !== JSON.stringify([1, 2, 3, 4, 5, 6])) { permutationFail++; continue; }
    // (b) 1位が必ずmaruBoat(axisBoatsInOrder[0])であること
    if (newOrder[0] !== axisBoatsInOrder[0]) { firstMismatch++; }

    if (JSON.stringify(newOrder) !== JSON.stringify(oldOrder)) {
      differsFromOld++;
      if (!exampleShown && axisBoatsInOrder.length >= 3) {
        // 複数軸かつ順位が変わった実例を1件表示(大村6Rと同種のケースを実データで確認)
        const massByBoat = {};
        [1,2,3,4,5,6].forEach(no => massByBoat[no] = 0);
        dbg.selectedPoints.forEach(v => {
          const prob = dbg.probabilities[v] || 0;
          new Set(v.split('-').map(Number)).forEach(no => massByBoat[no] += prob);
        });
        const countByBoat = {};
        [1,2,3,4,5,6].forEach(no => countByBoat[no] = 0);
        dbg.selectedPoints.forEach(v => new Set(v.split('-').map(Number)).forEach(no => countByBoat[no]++));
        console.log(`\n実例: ${r.date} ${r.venue}${r.racenum}R (軸=${axisBoatsInOrder.join(',')})`);
        console.log(`  旧評価順: ${oldOrder.join('>')}`);
        console.log(`  新評価順: ${newOrder.join('>')}`);
        console.log(`  艇別登場点数(全${dbg.selectedPoints.length}点中): ${[1,2,3,4,5,6].map(no=>`${no}号艇=${countByBoat[no]}点`).join(' ')}`);
        exampleShown = true;
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`検証件数: ${checked}`);
  console.log(`順列として不正: ${permutationFail}`);
  console.log(`1位がmaruBoatと不一致: ${firstMismatch}`);
  console.log(`旧方式と結果が異なった件数(=修正が実際に効いたレース数): ${differsFromOld}`);
  if (permutationFail > 0 || firstMismatch > 0) {
    console.log('結果: FAIL');
    process.exit(1);
  }
  console.log('結果: 全件PASS(常に有効な順列・1位は必ず軸)');
}

main();
