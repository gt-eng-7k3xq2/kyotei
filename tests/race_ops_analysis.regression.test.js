'use strict';
// scripts/race_ops_analysis.js の回帰テスト(fixtureのみ、実結果取得・実通信は一切行わない)。
// 2026-09-14夜「GARON R07リアルタイム実践共有・明日運用MVP」の一部。
// 使い方: node tests/race_ops_analysis.regression.test.js

const {
  resolveLatestEnteredJudgments, resolveUserState, resolveUserStateDetail, resolveCurrentResult,
  computeVirtualNet, computeApproxActualNet, summarize, parsePayoutYen,
} = require('../scripts/race_ops_analysis');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

function judgment(overrides = {}) {
  return {
    eventType: 'judgment', eventId: 'j1', raceId: '2026-09-15|桐生|1', date: '2026-09-15',
    venue: '桐生', raceNumber: 1, entered: true, route: 'escape', evaluatedAt: '2026-09-15T00:10:00.000Z',
    selectedBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 400 }],
    totalInvestment: 1000,
    ...overrides,
  };
}

console.log('=== テスト1: 同一raceIdで複数judgmentがある場合、evaluatedAtが最新のものを採用する ===');
{
  const older = judgment({ eventId: 'jOld', evaluatedAt: '2026-09-15T00:05:00.000Z', totalInvestment: 500 });
  const newer = judgment({ eventId: 'jNew', evaluatedAt: '2026-09-15T00:10:00.000Z', totalInvestment: 1000 });
  const map = resolveLatestEnteredJudgments([older, newer]);
  check('最新のjudgmentが採用される', map.get('2026-09-15|桐生|1').eventId === 'jNew');
}

console.log('=== テスト2: entered=falseのjudgmentは全通知集計に含まれない ===');
{
  const notEntered = judgment({ eventId: 'jSkip', entered: false, raceId: '2026-09-15|桐生|2' });
  const map = resolveLatestEnteredJudgments([notEntered]);
  check('entered=falseは除外される', map.size === 0);
}

console.log('=== テスト3: resolveUserStateは最新の実践参入/見送りを解決する ===');
{
  const events = [
    { eventType: 'user_skip_recorded', judgmentEventId: 'j1', recordedAt: '2026-09-15T00:20:00.000Z', reason: '当初見送り' },
    { eventType: 'user_entry_recorded', judgmentEventId: 'j1', recordedAt: '2026-09-15T00:25:00.000Z', investmentAmount: 500 },
  ];
  check('後から記録した方(entry)が現在の状態として解決される', resolveUserState(events, 'j1') === 'entry');
  check('操作履歴が無いjudgmentEventIdはunconfirmed', resolveUserState(events, 'jNoAction') === 'unconfirmed');
  const detail = resolveUserStateDetail(events, 'j1');
  check('resolveUserStateDetailも最新イベントを返す', detail.investmentAmount === 500);
}

console.log('=== テスト4: resolveCurrentResultはresult_confirmedとresult_correctionのうち最新を採用する ===');
{
  const events = [
    { eventType: 'result_confirmed', raceId: 'r1', chakuju: '1-2-3', payout: '¥1,670', resultFetchedAt: '2026-09-15T22:00:00.000Z' },
    { eventType: 'result_correction', raceId: 'r1', chakuju: '1-3-2', payout: '¥2,340', correctedAt: '2026-09-16T09:00:00.000Z' },
  ];
  const result = resolveCurrentResult(events, 'r1');
  check('訂正イベントの方が新しければ訂正後の内容が採用される', result.chakuju === '1-3-2' && result.payout === '¥2,340');
}

console.log('=== テスト5: parsePayoutYenは"¥1,670"形式から数値1670を取り出す ===');
{
  check('カンマ・円マーク付きを正しく解析', parsePayoutYen('¥1,670') === 1670);
  check('nullは安全にnullを返す', parsePayoutYen(null) === null);
}

console.log('=== テスト6: computeVirtualNetは的中時に払戻・純損益を正しく計算する ===');
{
  const j = judgment(); // selectedBets: 1-2-3(600円)/1-3-2(400円)、totalInvestment=1000
  const resultHit = { chakuju: '1-2-3', payout: '¥1,670' }; // 100円あたり1,670円
  const net = computeVirtualNet(j, resultHit);
  // 600円分は600/100=6口 → 6 * 1670 = 10020円払戻
  check('的中時のhitフラグがtrue', net.hit === true);
  check('払戻額が正しい(600円分×1670円/100円)', net.returnYen === 10020);
  check('純損益 = 払戻 - 総投資', net.net === 10020 - 1000);
}

console.log('=== テスト7: computeVirtualNetは不的中時に投資額分の純損失になる ===');
{
  const j = judgment();
  const resultMiss = { chakuju: '4-5-6', payout: '¥3,000' };
  const net = computeVirtualNet(j, resultMiss);
  check('不的中時のhitフラグがfalse', net.hit === false);
  check('純損益は-totalInvestment', net.net === -1000);
}

console.log('=== テスト8: computeVirtualNetは結果未確定(null)の場合nullを返す(推測しない) ===');
{
  check('結果が無ければnullを返す', computeVirtualNet(judgment(), null) === null);
}

console.log('=== テスト9: computeApproxActualNetは実投資額を判定時の買い目比率で按分した近似値になる ===');
{
  const j = judgment(); // engine totalInvestment=1000, 1-2-3=600円分
  const resultHit = { chakuju: '1-2-3', payout: '¥1,670' };
  // 実投資額2000円(engineの2倍)なら、按分後は1-2-3が1200円分のはず → 1200/100*1670=20040円払戻
  const net = computeApproxActualNet(j, resultHit, 2000);
  check('近似フラグが立っている', net.approximate === true);
  check('按分後の払戻額が正しい', net.returnYen === 20040);
  check('純損益 = 按分後払戻 - 実投資額', net.net === 20040 - 2000);
}

console.log('=== テスト10: summarizeは的中率・ROIを正しく集計する(全通知virtualと実践参入を混同しない) ===');
{
  const nets = [
    { net: 500, hit: true, totalInvestment: 1000 },
    { net: -1000, hit: false, totalInvestment: 1000 },
    { net: null, hit: false, totalInvestment: 1000 }, // 結果未確定は集計から除外される
  ];
  const s = summarize(nets);
  check('結果未確定(net=null)は件数から除外される', s.raceCount === 2);
  check('的中数が正しい', s.hitCount === 1);
  check('的中率が正しい(1/2=50%)', s.hitRate === 50);
  check('総投資額が正しい(未確定分は含まない)', s.totalInvestment === 2000);
  check('純損益合計が正しい', s.totalNet === -500);
  check('ROIが正しい((2000-500)/2000*100=75%)', Math.abs(s.roi - 75) < 0.001);
}

console.log('=== テスト11: 全通知virtualと実践参入virtual/実践成績は別集計として独立に算出される(混同しない) ===');
{
  // 全通知3件(entry1件・skip1件・unconfirmed1件)を用意し、各区分の集計が独立していることを確認する
  const jEntry = judgment({ eventId: 'jE', raceId: '2026-09-15|桐生|1' });
  const jSkip = judgment({ eventId: 'jS', raceId: '2026-09-15|桐生|2' });
  const jUnconfirmed = judgment({ eventId: 'jU', raceId: '2026-09-15|桐生|3' });
  const judgmentEvents = [jEntry, jSkip, jUnconfirmed];
  const raceOpsEvents = [
    { eventType: 'user_entry_recorded', judgmentEventId: 'jE', recordedAt: 't1', investmentAmount: 1000 },
    { eventType: 'user_skip_recorded', judgmentEventId: 'jS', recordedAt: 't1' },
  ];
  const map = resolveLatestEnteredJudgments(judgmentEvents);
  check('全通知3件が正しく解決される', map.size === 3);
  check('entry区分の状態解決が正しい', resolveUserState(raceOpsEvents, 'jE') === 'entry');
  check('skip区分の状態解決が正しい', resolveUserState(raceOpsEvents, 'jS') === 'skip');
  check('未操作はunconfirmedとして分離される(見送りとして扱われない)', resolveUserState(raceOpsEvents, 'jU') === 'unconfirmed');
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
