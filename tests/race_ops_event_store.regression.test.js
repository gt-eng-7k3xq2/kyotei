'use strict';
// レース運用イベントストア(scripts/lib/race_ops_event_store.js)の回帰テスト。
// 2026-09-14夜「GARON R07リアルタイム実践共有・明日運用MVP」の一部。
// 使い方: node tests/race_ops_event_store.regression.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  normalizeReason, computeUserEntryEventId, computeUserSkipEventId,
  computeResultConfirmedEventId, createRaceOpsEventStore,
} = require('../scripts/lib/race_ops_event_store');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'garon_race_ops_event_store_test_'));
function tmpFile(name) { return path.join(TMP_DIR, name); }

console.log('=== テスト1: notification_openedは同一judgmentEventIdの再訪問で重複しない ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t1.jsonl'));
  const a = store.recordNotificationOpened('judg1', { raceId: '2026-09-15|桐生|1' });
  const b = store.recordNotificationOpened('judg1', { raceId: '2026-09-15|桐生|1' });
  check('1回目は新規保存', a.deduped === false);
  check('2回目(再訪問)は重複排除される', b.deduped === true);
  check('eventIdは同一', a.eventId === b.eventId);
}

console.log('=== テスト2: 実践参入(user_entry_recorded)は投資額・理由を保存する ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t2.jsonl'));
  const r = store.recordUserEntry('judg1', { raceId: '2026-09-15|桐生|1', investmentAmount: 1000, reason: 'テスト理由' });
  check('新規保存される', r.deduped === false);
  check('eventType=user_entry_recorded', r.event.eventType === 'user_entry_recorded');
  check('investmentAmountが保存される', r.event.investmentAmount === 1000);
  check('reasonが保存される', r.event.reason === 'テスト理由');
  check('recordedAtが保存される', typeof r.event.recordedAt === 'string');
}

console.log('=== テスト3: 実践参入は投資額が負・非数値だと拒否される ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t3.jsonl'));
  let threwNegative = false, threwNaN = false;
  try { store.recordUserEntry('judg1', { investmentAmount: -100 }); } catch (e) { threwNegative = true; }
  try { store.recordUserEntry('judg1', { investmentAmount: 'abc' }); } catch (e) { threwNaN = true; }
  check('負の投資額は拒否される', threwNegative);
  check('非数値の投資額は拒否される', threwNaN);
}

console.log('=== テスト4: 明示的見送り(user_skip_recorded)は理由(任意)を保存する ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t4.jsonl'));
  const r1 = store.recordUserSkip('judg1', { raceId: '2026-09-15|桐生|1', reason: '僅差のため' });
  const r2 = store.recordUserSkip('judg2', {}); // 理由省略も許可される
  check('理由ありで保存される', r1.event.reason === '僅差のため');
  check('理由省略でも保存できる(nullになる)', r2.event.reason === null);
}

console.log('=== テスト5: 未操作(未確認)は実践参入・見送りいずれのイベントも書かない ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t5.jsonl'));
  // 何も記録しない状態で readAll() が空であることを確認(=未確認は「イベントが無い」で表現される)
  check('何も操作していないレースにはイベントが1件も無い', store.readAll().length === 0);
}

console.log('=== テスト6: entry/skipの内容が変われば別イベントとして記録される(同じ判定への上書きではない) ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t6.jsonl'));
  const first = store.recordUserSkip('judg1', { reason: '当初は見送り' });
  const changedMind = store.recordUserEntry('judg1', { investmentAmount: 500, reason: 'やっぱり参入' });
  check('見送り記録と参入記録はeventIdが異なる(別イベントとして両方残る)', first.eventId !== changedMind.eventId);
  check('両方のイベントがファイルに残っている(過去の判断も削除されない)', store.readAll().length === 2);
}

console.log('=== テスト7: 結果確定(result_confirmed)・不成立(result_void)・取得失敗(result_fetch_failed)は区別される ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t7.jsonl'));
  const confirmed = store.recordResultConfirmed({ raceId: '2026-09-15|桐生|1', judgmentEventId: 'judg1', chakuju: '1-2-3', payout: '¥1,670' });
  const voidEv = store.recordResultVoid({ raceId: '2026-09-15|桐生|2', judgmentEventId: 'judg2', reason: '締切から4時間経過も結果無し' });
  const failed = store.recordResultFetchFailed({ raceId: '2026-09-15|桐生|3', judgmentEventId: 'judg3', errorMessage: 'HTTP 503' });
  check('result_confirmedが保存される', confirmed.event.eventType === 'result_confirmed' && confirmed.event.chakuju === '1-2-3');
  check('result_voidが保存される', voidEv.event.eventType === 'result_void');
  check('result_fetch_failedが保存される', failed.event.eventType === 'result_fetch_failed');
  check('3種は互いに異なるeventId', new Set([confirmed.eventId, voidEv.eventId, failed.eventId]).size === 3);
}

console.log('=== テスト8: 結果訂正(result_correction)は旧イベントを書き換えず追記のみで行う ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t8.jsonl'));
  const confirmed = store.recordResultConfirmed({ raceId: '2026-09-15|桐生|1', judgmentEventId: 'judg1', chakuju: '1-2-3', payout: '¥1,670' });
  const beforeCorrection = store.readAll().find((e) => e.eventId === confirmed.eventId);
  const correction = store.recordResultCorrection({ raceId: '2026-09-15|桐生|1', correctsEventId: confirmed.eventId, chakuju: '1-3-2', payout: '¥2,340', reason: '公式サイト側の表示誤りを後日訂正' });
  const afterCorrection = store.readAll().find((e) => e.eventId === confirmed.eventId);
  check('訂正イベントが新規追加される', correction.deduped === false && correction.event.eventType === 'result_correction');
  check('訂正イベントは旧イベントのeventIdをcorrectsEventIdとして参照する', correction.event.correctsEventId === confirmed.eventId);
  check('旧イベント(result_confirmed)の内容は訂正後も一切変更されない', JSON.stringify(beforeCorrection) === JSON.stringify(afterCorrection));
  check('ファイルには元イベント+訂正イベントの2件が残る(削除されない)', store.readAll().length === 2);
}

console.log('=== テスト9: 理由欄は長すぎる場合に安全な長さへ切り詰められる(誤操作・貼り付け事故対策) ===');
{
  const longText = 'あ'.repeat(1000);
  const normalized = normalizeReason(longText);
  check('300文字以内に切り詰められる', normalized.length === 300);
  check('空文字・undefinedはnullになる', normalizeReason('') === null && normalizeReason(undefined) === null);
}

console.log('=== テスト10: 保存先ファイルはlogs/realtime_screening_events_*.jsonl(今日実装分)とは別ファイルである ===');
{
  const { raceOpsEventFilePath } = require('../scripts/lib/race_ops_event_store');
  const { eventFilePath } = require('../scripts/lib/realtime_event_store');
  check('ファイル名が異なる', raceOpsEventFilePath('2026-09-15') !== eventFilePath('2026-09-15'));
  check('race_ops_eventsという名前を含む', raceOpsEventFilePath('2026-09-15').includes('race_ops_events_'));
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
if (fail > 0) process.exit(1);
