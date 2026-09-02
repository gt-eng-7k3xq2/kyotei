'use strict';
// 研究用エンジン最小仕様(比較基準: 市場オッズ昇順・帯内8点固定)の単体テスト。
// 合成データで、仕様(点数固定・欠損処理・締切順・同点処理・水増し禁止)を検証する。
// 本番Q・実データへの依存なし。GARON-20260901-003継続。

const assert = require('assert');
const { buildRecord, rankByOddsAscending, applyDailyCap, evaluate, POINTS_FIXED, FLAT_STAKE } = require('./research_engine_min_spec_baseline_2026-09-02.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

// ヘルパー: 全120通りのoddsMapを持つ合成レースを作る。bandOdds配列で帯内(50-150)の値を指定、残りは帯外(10倍)で埋める。
function makeRace({ date = '2026-09-02', venue = 'テスト', racenum = '1', shimekiri = '10:00', bandVals = [], chakuju = null, payout = null }) {
  const allCombos = [];
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) {
    if (a !== b && a !== c && b !== c) allCombos.push(`${a}-${b}-${c}`);
  }
  assert.strictEqual(allCombos.length, 120, 'テストヘルパー自体が120通り生成できていない');
  const oddsMap = {};
  allCombos.forEach((v, i) => { oddsMap[v] = 10; }); // デフォルト帯外(10倍)
  bandVals.forEach(([val, odds]) => { oddsMap[val] = odds; });
  return { date, venue, racenum, shimekiri, oddsMap, chakuju, payout };
}

console.log('=== 研究用エンジン最小仕様: 単体テスト ===\n');

// 1. 点数固定(8点)の検証: 帯内候補が十分あるレースは必ずちょうど8点
{
  const bandVals = Array.from({ length: 15 }, (_, i) => [`1-2-${(i % 4) + 3}`, 50 + i]); // ダミー、val重複を避けるため下で作り直す
  // 帯内候補を確実に15個用意する(軸1、2着2、3着さまざまに変えて15通り)
  const combos = [];
  const bandOddsList = [];
  let count = 0;
  outer:
  for (let b2 = 2; b2 <= 6; b2++) for (let b3 = 2; b3 <= 6; b3++) {
    if (b2 === b3) continue;
    combos.push(`1-${b2}-${b3}`);
    count++;
    if (count >= 15) break outer;
  }
  const r = makeRace({ bandVals: combos.map((v, i) => [v, 60 + i]) });
  const rec = buildRecord(r, rankByOddsAscending, POINTS_FIXED);
  check('帯内候補15点から選ぶと、pointsは必ず8点ちょうど', rec.points && rec.points.length === POINTS_FIXED);
}

// 2. 欠損処理: 全120通りが揃っていないレースはskip(incomplete_odds)
{
  const r = makeRace({ bandVals: [['1-2-3', 60]] });
  delete r.oddsMap['6-5-4']; // 1件欠損させる(119件に)
  const rec = buildRecord(r, rankByOddsAscending, POINTS_FIXED);
  check('全120通り未満のレースはincomplete_oddsでskipされる', rec.skip === 'incomplete_odds');
}

// 3. 帯内候補不足: 8点未満ならinsufficient_band_candidatesでskip(帯外補充しない)
{
  const r = makeRace({ bandVals: [['1-2-3', 60], ['1-2-4', 70], ['1-3-2', 80]] }); // 帯内3点のみ
  const rec = buildRecord(r, rankByOddsAscending, POINTS_FIXED);
  check('帯内候補が8点未満はinsufficient_band_candidatesでskipされる', rec.skip === 'insufficient_band_candidates');
  check('帯外の点で水増しされていない(points未定義)', rec.points === undefined);
}

// 4. 同点処理: オッズが完全に同値の場合、点表記の文字列昇順という結果と無関係な固定規則で並ぶ(実行のたびに同じ結果)
{
  const combos = ['1-3-2', '1-2-4', '1-4-3', '1-2-3', '1-4-2', '1-3-4', '1-5-2', '1-2-5', '1-5-3', '1-3-5'];
  const r = makeRace({ bandVals: combos.map(v => [v, 80]) }); // 全て同オッズ80倍
  const rec1 = buildRecord(r, rankByOddsAscending, POINTS_FIXED);
  const rec2 = buildRecord(r, rankByOddsAscending, POINTS_FIXED); // 再実行
  check('同点時、再実行しても同じ選出結果になる(決定論的)', JSON.stringify(rec1.points) === JSON.stringify(rec2.points));
  const sortedByString = combos.slice().sort().slice(0, POINTS_FIXED);
  check('同点時、点表記の文字列昇順で選ばれている(固定規則)', JSON.stringify(rec1.points) === JSON.stringify(sortedByString));
}

// 5. オッズ昇順ランキングの検証(タイなし、明確に順序がつくケース)
{
  const combos = ['1-2-3', '1-2-4', '1-2-5', '1-2-6', '1-3-2', '1-3-4', '1-3-5', '1-3-6', '1-4-2', '1-4-3'];
  const oddsVals = [140, 60, 100, 55, 130, 70, 110, 65, 150, 50]; // ランダムな順序
  const r = makeRace({ bandVals: combos.map((v, i) => [v, oddsVals[i]]) });
  const rec = buildRecord(r, rankByOddsAscending, POINTS_FIXED);
  const expectedOrder = combos.map((v, i) => ({ v, o: oddsVals[i] })).sort((a, b) => a.o - b.o).slice(0, POINTS_FIXED).map(x => x.v);
  check('オッズ昇順で上位8点が選ばれている', JSON.stringify(rec.points) === JSON.stringify(expectedOrder));
}

// 6. 締切順の日次上限: 同日内は締切時刻昇順、上限を超えた分は除外(順位や結果で並べ替えない)
{
  const combos = [];
  for (let b2 = 2; b2 <= 6; b2++) for (let b3 = 2; b3 <= 6; b3++) { if (b2 !== b3) combos.push(`1-${b2}-${b3}`); }
  const bandVals = combos.map((v, i) => [v, 60 + i]);
  const races = [];
  const shimekiris = ['12:00', '10:00', '11:00', '20:00', '09:00', '15:00', '13:00', '18:00', '08:32', '16:00', '19:00', '14:00'];
  shimekiris.forEach((sk, i) => {
    const rec = buildRecord(makeRace({ racenum: String(i + 1), shimekiri: sk, bandVals }), rankByOddsAscending, POINTS_FIXED);
    races.push(rec);
  });
  const cap = applyDailyCap(races);
  check('12レース中、1日上限10件のみ選出される', cap.selected.length === 10);
  const shimekiriMinsSelected = cap.selected.map(r => r.shimekiriMin);
  const sortedCheck = shimekiriMinsSelected.slice().sort((a, b) => a - b);
  check('選出されたレースは締切時刻の昇順に並んでいる', JSON.stringify(shimekiriMinsSelected) === JSON.stringify(sortedCheck));
  const excludedShimekiri = ['19:00', '20:00']; // 締切が遅い2件が上限で除外されるはず
  const selectedShimekiriStrs = cap.selected.map(r => r.shimekiriMin);
  const maxSelected = Math.max(...selectedShimekiriStrs);
  check('締切が最も遅い2件(19:00,20:00)が上限で除外されている', maxSelected < 19 * 60);
}

// 7. 水増し禁止: 候補が10件未満の日はそのまま少ない件数で発信(10件に足りない分を他日から補わない)
{
  const combos = [];
  for (let b2 = 2; b2 <= 6; b2++) for (let b3 = 2; b3 <= 6; b3++) { if (b2 !== b3) combos.push(`1-${b2}-${b3}`); }
  const bandVals = combos.map((v, i) => [v, 60 + i]);
  const day1 = [buildRecord(makeRace({ date: '2026-09-01', racenum: '1', shimekiri: '10:00', bandVals }), rankByOddsAscending, POINTS_FIXED),
    buildRecord(makeRace({ date: '2026-09-01', racenum: '2', shimekiri: '11:00', bandVals }), rankByOddsAscending, POINTS_FIXED)];
  const day2 = Array.from({ length: 12 }, (_, i) => buildRecord(makeRace({ date: '2026-09-02', racenum: String(i + 1), shimekiri: `0${9 + Math.floor(i / 4)}:${(i % 4) * 15}0`, bandVals }), rankByOddsAscending, POINTS_FIXED));
  const cap = applyDailyCap([...day1, ...day2]);
  check('候補2件の日は2件のまま(10件に水増しされない)', cap.perDay['2026-09-01'].selectedCount === 2);
  check('候補12件の日は上限10件で打ち切られる', cap.perDay['2026-09-02'].selectedCount === 10);
  check('全体の発信数は2+10=12件(他日からの補充なし)', cap.selected.length === 12);
}

// 8. 確定時に帯外へ動いた的中の分離: 的中したが確定payoutが帯外なら「全的中」には数えるが「帯内的中」には数えない
{
  const combos = [];
  for (let b2 = 2; b2 <= 6; b2++) for (let b3 = 2; b3 <= 6; b3++) { if (b2 !== b3) combos.push(`1-${b2}-${b3}`); }
  const bandVals = combos.map((v, i) => [v, 60 + i]);
  const rMigrated = buildRecord(makeRace({ bandVals, chakuju: combos[0], payout: '30000' }), rankByOddsAscending, POINTS_FIXED); // 300倍(帯外)
  const rInBand = buildRecord(makeRace({ bandVals, chakuju: combos[1], payout: '8000' }), rankByOddsAscending, POINTS_FIXED); // 80倍(帯内)
  const res = evaluate([rMigrated, rInBand]);
  check('的中2件・帯内的中1件・帯外移動1件に正しく分離される', res.hit === 2 && res.bandHit === 1 && res.migratedOutHit === 1);
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
