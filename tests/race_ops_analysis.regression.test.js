'use strict';
// scripts/race_ops_analysis.js の回帰テスト(fixtureのみ、実結果取得・実通信は一切行わない)。
// 2026-09-14夜実装、2026-09-15受入監査修正の一部。
// 使い方: node tests/race_ops_analysis.regression.test.js

const {
  resolveNotifiedJudgments, hasNotificationSent, findJudgmentByEventId,
  resolveUserState, resolveUserStateDetail, resolveCurrentResult, findFirstConfirmedAt,
  shouldRecheckConfirmedResult, computeVirtualNet, computeActualNetFromBets, summarize,
  parsePayoutYen, fetchAndRecordResult, buildAiBrief, buildAiBriefMarkdown, CORRECTION_RECHECK_WINDOW_MS,
} = require('../scripts/race_ops_analysis');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

function judgment(overrides = {}) {
  return {
    eventType: 'judgment', eventId: 'j1', raceId: '2026-09-15|桐生|1', date: '2026-09-15',
    venue: '桐生', raceNumber: 1, entered: true, route: 'escape', evaluatedAt: '2026-09-15T00:10:00.000Z',
    deadlineTime: '10:30',
    selectedBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 400 }],
    totalInvestment: 1000,
    ...overrides,
  };
}
function notificationSent(judgmentEventId) {
  return { eventType: 'notification_sent', judgmentEventId, sentAt: '2026-09-15T00:11:00.000Z' };
}

async function main() {

console.log('=== テスト1(2026-09-15新規、受入監査指摘2): 母集団はentered=trueだけでなくnotification_sentの実在も必須 ===');
{
  const withNotif = judgment({ eventId: 'jA', raceId: '2026-09-15|桐生|1' });
  const withoutNotif = judgment({ eventId: 'jB', raceId: '2026-09-15|桐生|2' });
  const judgmentEvents = [withNotif, withoutNotif, notificationSent('jA')];
  const notified = resolveNotifiedJudgments(judgmentEvents);
  check('notification_sentがある判定だけが母集団に含まれる', notified.size === 1 && notified.has('jA'));
  check('notification_sentが無い判定はentered=trueでも除外される', !notified.has('jB'));
  check('hasNotificationSentも同じ結果を返す', hasNotificationSent(judgmentEvents, 'jA') === true && hasNotificationSent(judgmentEvents, 'jB') === false);
}

console.log('=== テスト2: 母集団はjudgmentEventId単位(raceId単位に丸めない) ===');
{
  // 同一raceIdへの再判定・再通知が2件とも通知済みの場合、両方が独立して母集団に残る
  const first = judgment({ eventId: 'jOld', raceId: '2026-09-15|桐生|1', evaluatedAt: '2026-09-15T00:05:00.000Z' });
  const second = judgment({ eventId: 'jNew', raceId: '2026-09-15|桐生|1', evaluatedAt: '2026-09-15T00:10:00.000Z' });
  const judgmentEvents = [first, second, notificationSent('jOld'), notificationSent('jNew')];
  const notified = resolveNotifiedJudgments(judgmentEvents);
  check('両方の通知済み判定が個別に母集団へ残る(raceIdで丸めて片方だけにしない)', notified.size === 2 && notified.has('jOld') && notified.has('jNew'));
}

console.log('=== テスト3: entered=falseのjudgmentは通知があっても母集団に含まれない ===');
{
  const notEntered = judgment({ eventId: 'jSkip', entered: false, raceId: '2026-09-15|桐生|2' });
  const judgmentEvents = [notEntered, notificationSent('jSkip')];
  const notified = resolveNotifiedJudgments(judgmentEvents);
  check('entered=falseは除外される', notified.size === 0);
}

console.log('=== テスト4: findJudgmentByEventIdはjudgmentEventIdで判定本体を解決する ===');
{
  const j = judgment({ eventId: 'jX' });
  check('存在する場合は判定オブジェクトを返す', findJudgmentByEventId([j], 'jX') === j);
  check('存在しない場合はnullを返す', findJudgmentByEventId([j], 'jNotExist') === null);
}

console.log('=== テスト5: resolveUserStateは最新の実践参入/見送りを解決する ===');
{
  const events = [
    { eventType: 'user_skip_recorded', judgmentEventId: 'j1', recordedAt: '2026-09-15T00:20:00.000Z', reason: '当初見送り' },
    { eventType: 'user_entry_recorded', judgmentEventId: 'j1', recordedAt: '2026-09-15T00:25:00.000Z', actualBets: [{ value: '1-2-3', amount: 500 }], totalInvestment: 500 },
  ];
  check('後から記録した方(entry)が現在の状態として解決される', resolveUserState(events, 'j1') === 'entry');
  check('操作履歴が無いjudgmentEventIdはunconfirmed', resolveUserState(events, 'jNoAction') === 'unconfirmed');
  const detail = resolveUserStateDetail(events, 'j1');
  check('resolveUserStateDetailはactualBets/totalInvestmentを含む最新イベントを返す', detail.totalInvestment === 500);
}

console.log('=== テスト6: resolveCurrentResultはresult_confirmedとresult_correctionのうち最新を採用し、eventIdも返す ===');
{
  const events = [
    { eventType: 'result_confirmed', raceId: 'r1', chakuju: '1-2-3', payout: '¥1,670', resultFetchedAt: '2026-09-15T22:00:00.000Z', eventId: 'confirmedEv' },
    { eventType: 'result_correction', raceId: 'r1', chakuju: '1-3-2', payout: '¥2,340', correctedAt: '2026-09-16T09:00:00.000Z', eventId: 'correctionEv' },
  ];
  const result = resolveCurrentResult(events, 'r1');
  check('訂正イベントの方が新しければ訂正後の内容が採用される', result.chakuju === '1-3-2' && result.payout === '¥2,340');
  check('現在の結果イベントのeventIdも返される(訂正の追跡に使う)', result.eventId === 'correctionEv');
}

console.log('=== テスト7(2026-09-15新規、受入監査指摘6): 結果訂正の再チェック期間の判定 ===');
{
  const confirmedAt = '2026-09-15T12:00:00.000Z';
  const events = [{ eventType: 'result_confirmed', raceId: 'r1', resultFetchedAt: confirmedAt, eventId: 'e1', chakuju: '1-2-3', payout: '¥1,000' }];
  check('findFirstConfirmedAtが最初の確定時刻を返す', findFirstConfirmedAt(events, 'r1') === confirmedAt);
  const justAfter = new Date(confirmedAt).getTime() + 60 * 60 * 1000; // 1時間後
  const wayAfter = new Date(confirmedAt).getTime() + CORRECTION_RECHECK_WINDOW_MS + 60 * 60 * 1000; // 窓を過ぎた後
  check('確定直後は再チェック対象になる', shouldRecheckConfirmedResult(events, 'r1', justAfter) === true);
  check('再チェック期間(既定6時間)を過ぎたら対象外になる', shouldRecheckConfirmedResult(events, 'r1', wayAfter) === false);
  check('まだ一度も確定していないraceIdは再チェック対象にならない(初回取得は別経路)', shouldRecheckConfirmedResult([], 'r2', Date.now()) === false);
}

console.log('=== テスト8: parsePayoutYenは"¥1,670"形式から数値1670を取り出す ===');
{
  check('カンマ・円マーク付きを正しく解析', parsePayoutYen('¥1,670') === 1670);
  check('nullは安全にnullを返す', parsePayoutYen(null) === null);
}

console.log('=== テスト9: computeVirtualNetは的中時に払戻・純損益を正しく計算する ===');
{
  const j = judgment(); // selectedBets: 1-2-3(600円)/1-3-2(400円)、totalInvestment=1000
  const resultHit = { chakuju: '1-2-3', payout: '¥1,670' };
  const net = computeVirtualNet(j, resultHit);
  check('的中時のhitフラグがtrue', net.hit === true);
  check('払戻額が正しい(600円分×1670円/100円)', net.returnYen === 10020);
  check('純損益 = 払戻 - 総投資', net.net === 10020 - 1000);
  check('unresolvedはfalse', net.unresolved === false);
}

console.log('=== テスト10: computeVirtualNetは不的中時に投資額分の純損失になる ===');
{
  const j = judgment();
  const resultMiss = { chakuju: '4-5-6', payout: '¥3,000' };
  const net = computeVirtualNet(j, resultMiss);
  check('不的中時のhitフラグがfalse', net.hit === false);
  check('純損益は-totalInvestment', net.net === -1000);
}

console.log('=== テスト11: computeVirtualNetは結果未確定(null)の場合nullを返す(推測しない) ===');
{
  check('結果が無ければnullを返す', computeVirtualNet(judgment(), null) === null);
}

console.log('=== テスト12(2026-09-15新規、受入監査指摘4): 的中買い目があるのに払戻解析に失敗した場合は0円扱いではなく未解決になる ===');
{
  const j = judgment();
  const resultUnparsable = { chakuju: '1-2-3', payout: '払戻確定中' }; // 数字を含まない表記(パース失敗を模す)
  const net = computeVirtualNet(j, resultUnparsable);
  check('unresolvedがtrueになる', net.unresolved === true);
  check('netはnull(0円=不的中扱いにしない)', net.net === null);
  check('hitはtrueのまま(的中したこと自体は分かっている)', net.hit === true);
}

console.log('=== テスト13(2026-09-15新規、受入監査指摘3・4): computeActualNetFromBetsは実額(近似ではない)で計算する ===');
{
  const actualBets = [{ value: '1-2-3', amount: 700 }, { value: '1-3-2', amount: 300 }];
  const resultHit = { chakuju: '1-2-3', payout: '¥1,670' };
  const net = computeActualNetFromBets(actualBets, 1000, resultHit);
  check('的中買い目の実購入額(700円)から正しく払戻を計算する(近似・按分ではない)', net.returnYen === Math.round((1670 / 100) * 700));
  check('純損益 = 実払戻 - 実投資額', net.net === net.returnYen - 1000);
  check('hitはtrue', net.hit === true);
}

console.log('=== テスト14(2026-09-15新規): 的中買い目を推奨されていても実際には0円(未購入)なら的中扱いにしない ===');
{
  const actualBets = [{ value: '1-2-3', amount: 0 }, { value: '1-3-2', amount: 500 }];
  const resultHit = { chakuju: '1-2-3', payout: '¥1,670' }; // 当たったのは買っていない方
  const net = computeActualNetFromBets(actualBets, 500, resultHit);
  check('未購入(0円)の買い目が的中しても実践的中とは扱わない', net.hit === false);
  check('純損益は総投資額分のマイナス', net.net === -500);
}

console.log('=== テスト15(2026-09-15新規、受入監査指摘4): computeActualNetFromBetsも払戻解析失敗を未解決にする ===');
{
  const actualBets = [{ value: '1-2-3', amount: 700 }];
  const resultUnparsable = { chakuju: '1-2-3', payout: 'unknown' };
  const net = computeActualNetFromBets(actualBets, 700, resultUnparsable);
  check('unresolvedがtrue', net.unresolved === true);
  check('netはnull', net.net === null);
}

console.log('=== テスト16(2026-09-15更新): summarizeは未解決件数を除外しつつ件数として報告する ===');
{
  const nets = [
    { net: 500, hit: true, totalInvestment: 1000, unresolved: false },
    { net: -1000, hit: false, totalInvestment: 1000, unresolved: false },
    { net: null, hit: false, totalInvestment: 1000, unresolved: false }, // 結果未確定
    { net: null, hit: true, totalInvestment: 1000, unresolved: true }, // 払戻解析失敗
  ];
  const s = summarize(nets);
  check('結果未確定・未解決は件数から除外される', s.raceCount === 2);
  check('未解決件数は別途報告される', s.unresolvedCount === 1);
  check('的中数が正しい', s.hitCount === 1);
  check('総投資額が正しい(未確定・未解決分は含まない)', s.totalInvestment === 2000);
  check('純損益合計が正しい', s.totalNet === -500);
  check('ROIが正しい((2000-500)/2000*100=75%)', Math.abs(s.roi - 75) < 0.001);
}

console.log('=== テスト17(2026-09-15新規、受入監査指摘1・6): fetchAndRecordResultはfetchSingleRaceResultを差し替えて実ネットワーク無しで検証できる ===');
{
  async function run(fakeFetchResult, existingResultEvents) {
    const writes = [];
    const fakeStore = {
      recordResultConfirmed: (fields) => { writes.push({ type: 'confirmed', fields }); return { deduped: false, eventId: 'newEv' }; },
      recordResultCorrection: (fields) => { writes.push({ type: 'correction', fields }); return { deduped: false, eventId: 'correctionEv' }; },
      recordResultFetchFailed: (fields) => { writes.push({ type: 'fetch_failed', fields }); return { deduped: false }; },
    };
    const outcome = await fetchAndRecordResult(
      fakeStore, existingResultEvents,
      { raceId: 'r1', judgmentEventId: 'judg1', venue: '桐生', raceNumber: 1, dateStr: '2026-09-15', deadlineTime: '10:30', venueCodeMap: {}, nowMs: Date.now() },
      { fetchSingleRaceResult: async () => fakeFetchResult },
    );
    return { outcome, writes };
  }

  console.log('  -- 17a: 初回確定(既存結果なし) --');
  {
    const { outcome, writes } = await run({ kind: 'confirmed', chakuju: '1-2-3', payout: '¥1,670', url: 'http://x' }, []);
    check('kind=confirmedを返す', outcome.kind === 'confirmed');
    check('recordResultConfirmedが呼ばれる(recordResultCorrectionではない)', writes.length === 1 && writes[0].type === 'confirmed');
  }

  console.log('  -- 17b: 既存結果と内容が異なる場合は訂正として記録される --');
  {
    const existing = [{ eventType: 'result_confirmed', raceId: 'r1', chakuju: '1-2-3', payout: '¥1,000', resultFetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), eventId: 'oldEv' }];
    const { outcome, writes } = await run({ kind: 'confirmed', chakuju: '1-3-2', payout: '¥2,000', url: 'http://x' }, existing);
    check('kind=correctedを返す', outcome.kind === 'corrected');
    check('recordResultCorrectionが呼ばれる(recordResultConfirmedではない)', writes.length === 1 && writes[0].type === 'correction');
    check('correctsEventIdが旧イベントのeventIdを正しく参照する', writes[0].fields.correctsEventId === 'oldEv');
    check('新しいchakuju/payoutが渡される', writes[0].fields.chakuju === '1-3-2' && writes[0].fields.payout === '¥2,000');
  }

  console.log('  -- 17c: 既存結果と内容が同じ場合は何も書かれない(そもそも再取得しない設計だが、念のため一致時は訂正扱いしない) --');
  {
    const existing = [{ eventType: 'result_confirmed', raceId: 'r1', chakuju: '1-2-3', payout: '¥1,670', resultFetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), eventId: 'oldEv' }];
    const { outcome, writes } = await run({ kind: 'confirmed', chakuju: '1-2-3', payout: '¥1,670', url: 'http://x' }, existing);
    check('内容が同一ならkind=confirmedとして扱われる(recordResultConfirmedは冪等にdedupする設計)', outcome.kind === 'confirmed');
    check('recordResultCorrectionは呼ばれない', !writes.some((w) => w.type === 'correction'));
  }

  console.log('  -- 17d: 再チェック期間(6時間)を過ぎた既存結果は再取得自体を試みない --');
  {
    const oldConfirmedAt = new Date(Date.now() - (CORRECTION_RECHECK_WINDOW_MS + 60 * 60 * 1000)).toISOString();
    const existing = [{ eventType: 'result_confirmed', raceId: 'r1', chakuju: '1-2-3', payout: '¥1,670', resultFetchedAt: oldConfirmedAt, eventId: 'oldEv' }];
    const { outcome, writes } = await run({ kind: 'confirmed', chakuju: '9-9-9', payout: '¥9,999', url: 'http://x' }, existing);
    check('再チェック期間外はskipped_outside_recheck_windowを返す(fetchすら試みない)', outcome.kind === 'skipped_outside_recheck_window');
    check('書き込みは一切発生しない', writes.length === 0);
  }

  console.log('  -- 17e: 取得失敗はrecordResultFetchFailedに記録される --');
  {
    const { outcome, writes } = await run({ kind: 'fetch_failed', errorMessage: 'HTTP 503' }, []);
    check('kind=fetch_failedを返す', outcome.kind === 'fetch_failed');
    check('recordResultFetchFailedが呼ばれる', writes.length === 1 && writes[0].type === 'fetch_failed');
  }
}

console.log('=== テスト18(2026-09-15新規、GARON RaceOps引継ぎP0対応): buildAiBriefは判定時点(preDeadline)と結果確定後(postResult)を分離する ===');
{
  const notifiedJudgment = judgment({ eventId: 'jNotified', raceId: '2026-09-15|桐生|1', raceNumber: 1, entered: true });
  const failedNotifJudgment = judgment({ eventId: 'jFailed', raceId: '2026-09-15|桐生|2', raceNumber: 2, entered: true });
  const skippedJudgment = judgment({ eventId: 'jSkipped', raceId: '2026-09-15|桐生|3', raceNumber: 3, entered: false, route: 'nonescape' });
  const judgmentEvents = [notifiedJudgment, failedNotifJudgment, skippedJudgment, notificationSent('jNotified')];
  const raceOpsEvents = [
    { eventType: 'user_entry_recorded', judgmentEventId: 'jNotified', raceId: '2026-09-15|桐生|1', actualBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 400 }], totalInvestment: 1000, recordedAt: '2026-09-15T00:12:00.000Z' },
    { eventType: 'result_confirmed', raceId: '2026-09-15|桐生|1', chakuju: '1-2-3', payout: '¥1,670', resultFetchedAt: '2026-09-15T00:40:00.000Z', eventId: 'resEv1' },
  ];
  const brief = buildAiBrief('2026-09-15', judgmentEvents, raceOpsEvents);

  check('schemaVersionを持つ', brief.schemaVersion === 1);
  check('全judgmentイベント3件が races に含まれる(通知失敗・見送りも含む)', brief.races.length === 3);

  const notifiedRace = brief.races.find((r) => r.judgmentEventId === 'jNotified');
  check('通知済みレースはnotified=trueかつpreDeadlineに推奨買い目を持つ', notifiedRace.preDeadline.notified === true && notifiedRace.preDeadline.recommendedBets.length === 2);
  check('参入記録があるレースはuserAction.state=entryかつ実購入額を持つ', notifiedRace.userAction.state === 'entry' && notifiedRace.userAction.actualTotalInvestment === 1000);
  check('結果確定後のpostResultに的中結果が入る', notifiedRace.postResult.result.chakuju === '1-2-3' && notifiedRace.postResult.virtualNet.hit === true);
  check('preDeadlineに結果(chakuju/payout)を含めない(後知恵混入防止)', !('result' in notifiedRace.preDeadline) && !('chakuju' in notifiedRace.preDeadline));

  const failedRace = brief.races.find((r) => r.judgmentEventId === 'jFailed');
  check('entered=trueだが通知が実在しないレースはnotified=falseになる', failedRace.preDeadline.entered === true && failedRace.preDeadline.notified === false);
  check('通知対象外のレースはuserActionがnull(ユーザー操作の意味が無いため)', failedRace.userAction === null);

  const skippedRace = brief.races.find((r) => r.judgmentEventId === 'jSkipped');
  check('entered=falseのレースもracesに含まれる(非通知対象として区別できる)', skippedRace.preDeadline.entered === false);

  check('summaryにcomputeLiveAnalysis相当の集計が入る', brief.summary && brief.summary.virtual && brief.summary.actual);
  check('engineVersionは先頭のjudgmentイベントから取得される', brief.engineVersion !== undefined);

  const md = buildAiBriefMarkdown(brief);
  check('Markdownにレース別詳細セクションがある', md.includes('## レース別詳細'));
  check('Markdownに各会場名が含まれる', md.includes('桐生1R') && md.includes('桐生2R') && md.includes('桐生3R'));
}

console.log('=== テスト19(2026-09-15新規): buildAiBriefは判定が1件も無い日でも安全に空配列を返す ===');
{
  const brief = buildAiBrief('2026-09-15', [], []);
  check('racesは空配列', Array.isArray(brief.races) && brief.races.length === 0);
  check('engineVersionはnull', brief.engineVersion === null);
  const md = buildAiBriefMarkdown(brief);
  check('Markdownが例外なく生成される', typeof md === 'string' && md.includes('本日の判定はまだありません'));
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
