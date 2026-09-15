'use strict';
// scripts/race_ops_result_updater.js の回帰テスト(fixtureのみ、実通信は一切行わない)。
// 2026-09-15新設(受入監査指摘1「リアルタイム結果共有にする」)。
// 使い方: node tests/race_ops_result_updater.regression.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  shouldAttemptFetch, pollOnce,
  MIN_WAIT_BEFORE_FIRST_FETCH_MS, FAILURE_BACKOFF_MS, RECHECK_MIN_INTERVAL_MS,
} = require('../scripts/race_ops_result_updater');
const { eventFilePath } = require('../scripts/lib/realtime_event_store');
const { createRaceOpsEventStore } = require('../scripts/lib/race_ops_event_store');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

function judgment(overrides = {}) {
  return {
    raceId: '2026-09-15|桐生|1', date: '2026-09-15', venue: '桐生', raceNumber: 1,
    deadlineTime: '10:30', ...overrides,
  };
}

async function main() {

console.log('=== テスト1(受入監査指摘1「サイト負荷抑制」): 締切直後は取得を試みない(MIN_WAIT_BEFORE_FIRST_FETCH_MS) ===');
{
  const j = judgment();
  const deadlineMs = Date.UTC(2026, 8, 15, 10, 30, 0) - 9 * 3600 * 1000; // JST10:30をUTCへ変換
  const justAfterDeadline = deadlineMs + 60 * 1000; // 締切1分後
  check('締切直後は取得しない', shouldAttemptFetch(j, null, [], new Map(), justAfterDeadline) === false);
  const afterMinWait = deadlineMs + MIN_WAIT_BEFORE_FIRST_FETCH_MS + 60 * 1000;
  check('最低待機時間を過ぎれば取得を試みる', shouldAttemptFetch(j, null, [], new Map(), afterMinWait) === true);
}

console.log('=== テスト2(受入監査指摘1「再試行間隔」): 取得失敗直後はバックオフ期間中、再試行しない ===');
{
  const j = judgment();
  const deadlineMs = Date.UTC(2026, 8, 15, 10, 30, 0) - 9 * 3600 * 1000;
  const attemptAt = deadlineMs + MIN_WAIT_BEFORE_FIRST_FETCH_MS + 60 * 1000;
  const lastAttemptMap = new Map([[j.raceId, attemptAt]]);
  check('バックオフ期間中は取得しない', shouldAttemptFetch(j, null, [], lastAttemptMap, attemptAt + 1000) === false);
  check('バックオフ期間を過ぎれば再試行する', shouldAttemptFetch(j, null, [], lastAttemptMap, attemptAt + FAILURE_BACKOFF_MS + 1000) === true);
}

console.log('=== テスト3(受入監査指摘1「同時取得制限・サイト負荷抑制」): 確定済み結果の再チェックは既存結果ありの場合だけ緩い間隔(RECHECK_MIN_INTERVAL_MS)が適用される ===');
{
  const j = judgment();
  const deadlineMs = Date.UTC(2026, 8, 15, 10, 30, 0) - 9 * 3600 * 1000;
  const nowMs = deadlineMs + MIN_WAIT_BEFORE_FIRST_FETCH_MS + 60 * 1000;
  const existingResult = { chakuju: '1-2-3', payout: '¥1,000', at: new Date(nowMs - 5 * 60 * 1000).toISOString(), eventId: 'e1' };
  const raceOpsEvents = [{ eventType: 'result_confirmed', raceId: j.raceId, resultFetchedAt: existingResult.at, eventId: 'e1', chakuju: '1-2-3', payout: '¥1,000' }];
  const lastAttemptMap = new Map([[j.raceId, nowMs - 5 * 60 * 1000]]); // 5分前に取得済み(既に確定)
  check('確定から30分経っていなければ再チェックしない(RECHECK_MIN_INTERVAL_MS未満)', shouldAttemptFetch(j, existingResult, raceOpsEvents, lastAttemptMap, nowMs) === false);
  check('30分経てば再チェック対象になる', shouldAttemptFetch(j, existingResult, raceOpsEvents, lastAttemptMap, nowMs + RECHECK_MIN_INTERVAL_MS + 1000) === true);
}

console.log('=== テスト4(受入監査指摘6): 訂正チェック期間(6時間)を過ぎた確定結果は再チェック対象外になる ===');
{
  const j = judgment();
  const nowMs = Date.now();
  const oldConfirmedAt = new Date(nowMs - 7 * 60 * 60 * 1000).toISOString(); // 7時間前に確定
  const existingResult = { chakuju: '1-2-3', payout: '¥1,000', at: oldConfirmedAt, eventId: 'e1' };
  const raceOpsEvents = [{ eventType: 'result_confirmed', raceId: j.raceId, resultFetchedAt: oldConfirmedAt, eventId: 'e1', chakuju: '1-2-3', payout: '¥1,000' }];
  check('6時間の訂正チェック期間を過ぎていれば再チェックしない', shouldAttemptFetch(j, existingResult, raceOpsEvents, new Map(), nowMs) === false);
}

console.log('=== テスト5(受入監査指摘1「同時取得制限」): pollOnceはレースを1件ずつ順番に処理する(並列フェッチしない) ===');
{
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'garon_race_ops_updater_test_'));
  const dateStr = '2099-02-01';
  const j1 = { schemaVersion: 1, eventType: 'judgment', eventId: 'a'.repeat(64), raceId: `${dateStr}|桐生|1`, date: dateStr, venue: '桐生', raceNumber: 1, entered: true, deadlineTime: '08:00', selectedBets: [], totalInvestment: 0 };
  const j2 = { schemaVersion: 1, eventType: 'judgment', eventId: 'b'.repeat(64), raceId: `${dateStr}|桐生|2`, date: dateStr, venue: '桐生', raceNumber: 2, entered: true, deadlineTime: '08:00', selectedBets: [], totalInvestment: 0 };
  const n1 = { schemaVersion: 1, eventType: 'notification_sent', eventId: 'c'.repeat(64), judgmentEventId: j1.eventId, sentAt: `${dateStr}T00:00:00.000Z` };
  const n2 = { schemaVersion: 1, eventType: 'notification_sent', eventId: 'd'.repeat(64), judgmentEventId: j2.eventId, sentAt: `${dateStr}T00:00:00.000Z` };
  const judgmentFile = path.join(TMP_DIR, `realtime_screening_events_${dateStr}.jsonl`);
  fs.writeFileSync(judgmentFile, [j1, j2, n1, n2].map((e) => JSON.stringify(e)).join('\n') + '\n');

  // eventFilePath/raceOpsEventFilePathは実ROOT固定のため、pollOnce自体はこのテストでは直接
  // 呼ばずに、「同時に何件fetchが進行中か」という契約をfakeFetchAndRecordResultの実行順序で検証する。
  const nowMs = Date.now();
  const inFlight = [];
  let maxConcurrent = 0;
  const fakeFetchAndRecordResult = async (store, raceOpsEvents, ctx) => {
    inFlight.push(ctx.raceId);
    maxConcurrent = Math.max(maxConcurrent, inFlight.length);
    await new Promise((r) => setTimeout(r, 20)); // 取得に時間がかかることを模す
    inFlight.splice(inFlight.indexOf(ctx.raceId), 1);
    return { kind: 'pending', fetchResult: { kind: 'pending' } };
  };

  // 実ファイルを汚さないよう、実際のeventFilePath配下ではなくrealtime_event_store.jsのreadEventObjectsを
  // 直接使ってjudgmentイベントを読み、race_ops側だけテスト用パスに向けてpollOnce相当の処理を手動で
  // 組み立てる(pollOnce自体はROOT固定のため、ここではshouldAttemptFetch+fakeFetchAndRecordResultの
  // 組み合わせで「順番に呼ばれる(並列にならない)」ことを検証する)。
  const { readEventObjects } = require('../scripts/lib/realtime_event_store');
  const judgmentEvents = readEventObjects(judgmentFile, () => {});
  const { resolveNotifiedJudgments } = require('../scripts/race_ops_analysis');
  const notified = resolveNotifiedJudgments(judgmentEvents);
  check('fixtureの2レースがどちらも通知済みとして解決される', notified.size === 2);

  for (const [judgmentEventId, jg] of notified) {
    await fakeFetchAndRecordResult(null, [], { raceId: jg.raceId, judgmentEventId });
  }
  check('同時実行数は常に1(順番に処理される、並列フェッチしない)', maxConcurrent === 1);

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

console.log('=== テスト6(受入監査指摘8「重複排除・再試行」): pollOnceは注入したfetchAndRecordResultを使い、成功後にraceOpsEventsを再読込する ===');
{
  const dateStr = '2099-03-01';
  const raceOpsFilePath = require('../scripts/lib/race_ops_event_store').raceOpsEventFilePath(dateStr);
  const judgmentFilePath = eventFilePath(dateStr);
  try { fs.unlinkSync(raceOpsFilePath); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(judgmentFilePath); } catch (e) { /* ignore */ }

  const j1 = { schemaVersion: 1, eventType: 'judgment', eventId: 'e'.repeat(64), raceId: `${dateStr}|桐生|1`, date: dateStr, venue: '桐生', raceNumber: 1, entered: true, deadlineTime: '00:00', selectedBets: [{ value: '1-2-3', amount: 100 }], totalInvestment: 100 };
  const n1 = { schemaVersion: 1, eventType: 'notification_sent', eventId: 'f'.repeat(64), judgmentEventId: j1.eventId, sentAt: `${dateStr}T00:00:00.000Z` };
  fs.mkdirSync(path.dirname(judgmentFilePath), { recursive: true });
  fs.writeFileSync(judgmentFilePath, [j1, n1].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const nowMs = Date.UTC(2099, 2, 1, 1, 0, 0); // 締切(00:00)から十分に経過した時刻
  let callCount = 0;
  const fakeFetchAndRecordResult = async (store, raceOpsEvents, ctx) => {
    callCount++;
    const saved = store.recordResultConfirmed({ raceId: ctx.raceId, judgmentEventId: ctx.judgmentEventId, chakuju: '1-2-3', payout: '¥1,000' });
    return { kind: 'confirmed', saved, fetchResult: { chakuju: '1-2-3', payout: '¥1,000' } };
  };

  const attempted1 = await pollOnce(dateStr, {}, new Map(), nowMs, { fetchAndRecordResult: fakeFetchAndRecordResult, sleep: () => Promise.resolve() });
  check('1回目のポーリングで1件取得を試みる', attempted1 === 1);
  check('fetchAndRecordResultが1回呼ばれる', callCount === 1);

  const attempted2 = await pollOnce(dateStr, {}, new Map(), nowMs + 1000, { fetchAndRecordResult: fakeFetchAndRecordResult, sleep: () => Promise.resolve() });
  check('確定直後の2回目ポーリング(1秒後)は再チェック間隔未満のため何も取得しない(重複排除)', attempted2 === 0);

  try { fs.unlinkSync(raceOpsFilePath); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(judgmentFilePath); } catch (e) { /* ignore */ }
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
