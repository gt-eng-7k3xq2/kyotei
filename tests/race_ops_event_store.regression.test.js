'use strict';
// レース運用イベントストア(scripts/lib/race_ops_event_store.js)の回帰テスト。
// 2026-09-14夜「GARON R07リアルタイム実践共有・明日運用MVP」/2026-09-15受入監査修正の一部。
// 使い方: node tests/race_ops_event_store.regression.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  normalizeReason, validateAndNormalizeActualBets, MAX_BET_AMOUNT_YEN, createRaceOpsEventStore,
} = require('../scripts/lib/race_ops_event_store');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'garon_race_ops_event_store_test_'));
function tmpFile(name) { return path.join(TMP_DIR, name); }

const SAMPLE_ALLOWED = ['1-2-3', '1-3-2'];

console.log('=== テスト1: notification_openedは同一judgmentEventIdの再訪問で重複しない ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t1.jsonl'));
  const a = store.recordNotificationOpened('judg1', { raceId: '2026-09-15|桐生|1' });
  const b = store.recordNotificationOpened('judg1', { raceId: '2026-09-15|桐生|1' });
  check('1回目は新規保存', a.deduped === false);
  check('2回目(再訪問)は重複排除される', b.deduped === true);
  check('eventIdは同一', a.eventId === b.eventId);
}

console.log('=== テスト2(2026-09-15更新): 実践参入(user_entry_recorded)は買い目別の実購入額を保存する ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t2.jsonl'));
  const r = store.recordUserEntry('judg1', {
    raceId: '2026-09-15|桐生|1',
    actualBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 0 }],
    allowedBetValues: SAMPLE_ALLOWED,
    reason: 'テスト理由',
  });
  check('新規保存される', r.deduped === false);
  check('eventType=user_entry_recorded', r.event.eventType === 'user_entry_recorded');
  check('actualBetsが保存される(value昇順に正規化)', JSON.stringify(r.event.actualBets) === JSON.stringify([{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 0 }]));
  check('totalInvestmentはサーバー側で買い目別金額の合計として再計算される', r.event.totalInvestment === 600);
  check('reasonが保存される', r.event.reason === 'テスト理由');
  check('recordedAtが保存される', typeof r.event.recordedAt === 'string');
  check('investmentAmount(旧スキーマ)フィールドはもう存在しない', !('investmentAmount' in r.event));
}

console.log('=== テスト3(2026-09-15更新): 実践参入の申告合計値は信用されず、常にactualBetsから再計算される ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t3.jsonl'));
  // クライアントが仮に合計値フィールドを送ってきても(ここでは呼び出し側に無いので無視されるのみ確認)
  const r = store.recordUserEntry('judg1', {
    actualBets: [{ value: '1-2-3', amount: 1000 }, { value: '1-3-2', amount: 500 }],
    allowedBetValues: SAMPLE_ALLOWED,
  });
  check('合計は買い目別金額の総和と一致する(1000+500=1500)', r.event.totalInvestment === 1500);
}

console.log('=== テスト3b(2026-09-15新規、受入監査再指摘「0円参入を拒否する」): recordUserEntry自体も全額0円を拒否する ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t3b.jsonl'));
  let threw = false, message = '';
  try {
    store.recordUserEntry('judg1', {
      raceId: '2026-09-15|桐生|1',
      actualBets: [{ value: '1-2-3', amount: 0 }, { value: '1-3-2', amount: 0 }],
      allowedBetValues: SAMPLE_ALLOWED,
    });
  } catch (e) { threw = true; message = e.message; }
  check('全買い目0円のentryはrecordUserEntryレベルでも拒否される', threw);
  check('案内メッセージが「購入額を入力するか、見送りを選択してください」になる', message === '購入額を入力するか、見送りを選択してください');
  check('拒否された場合はファイルに何も書き込まれない', store.readAll().length === 0);
}

console.log('=== テスト4: validateAndNormalizeActualBetsの厳格検証(受入監査指摘5) ===');
{
  let threw;
  threw = false; try { validateAndNormalizeActualBets([{ value: '1-2-3', amount: 100 }], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('推奨買い目の一部が欠けている場合は拒否される(過不足チェック)', threw);

  threw = false; try { validateAndNormalizeActualBets([{ value: '1-2-3', amount: 100 }, { value: '1-3-2', amount: 0 }, { value: '4-5-6', amount: 0 }], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('推奨買い目に無い買い目を追加すると拒否される', threw);

  threw = false; try { validateAndNormalizeActualBets([{ value: '1-2-3', amount: 100 }, { value: '1-2-3', amount: 200 }], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('重複した買い目は拒否される', threw);

  threw = false; try { validateAndNormalizeActualBets([{ value: '1-2-3', amount: 150 }, { value: '1-3-2', amount: 0 }], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('100円単位でない金額は拒否される', threw);

  threw = false; try { validateAndNormalizeActualBets([{ value: '1-2-3', amount: -100 }, { value: '1-3-2', amount: 0 }], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('負の金額は拒否される', threw);

  threw = false; try { validateAndNormalizeActualBets([{ value: '1-2-3', amount: MAX_BET_AMOUNT_YEN + 100 }, { value: '1-3-2', amount: 0 }], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('上限を超える金額は拒否される', threw);

  threw = false; try { validateAndNormalizeActualBets([{ value: 'not-a-bet', amount: 0 }, { value: '1-3-2', amount: 0 }], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('買い目形式が不正な値は拒否される', threw);

  threw = false; try { validateAndNormalizeActualBets([], SAMPLE_ALLOWED); } catch (e) { threw = true; }
  check('空配列は拒否される', threw);

  const ok = validateAndNormalizeActualBets([{ value: '1-3-2', amount: 0 }, { value: '1-2-3', amount: 600 }], SAMPLE_ALLOWED);
  check('全額0円(未購入)を含む正しい入力は受理される', ok.totalInvestment === 600);
  check('送信順序に関わらずvalue昇順へ正規化される', ok.actualBets[0].value === '1-2-3' && ok.actualBets[1].value === '1-3-2');

  // 2026-09-15追加(受入監査再指摘「0円参入を拒否する」)
  threw = false; let threwMessage = ''; try { validateAndNormalizeActualBets([{ value: '1-2-3', amount: 0 }, { value: '1-3-2', amount: 0 }], SAMPLE_ALLOWED); } catch (e) { threw = true; threwMessage = e.message; }
  check('全買い目0円(合計0円)のactualBetsは拒否される', threw);
  check('拒否時のメッセージが案内文言と一致する', threwMessage === '購入額を入力するか、見送りを選択してください');

  const okMinimum = validateAndNormalizeActualBets([{ value: '1-2-3', amount: 100 }, { value: '1-3-2', amount: 0 }], SAMPLE_ALLOWED);
  check('合計100円(最低額)ちょうどは受理される', okMinimum.totalInvestment === 100);
}

console.log('=== テスト5: 明示的見送り(user_skip_recorded)は理由(任意)を保存する ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t5.jsonl'));
  const r1 = store.recordUserSkip('judg1', { raceId: '2026-09-15|桐生|1', reason: '僅差のため' });
  const r2 = store.recordUserSkip('judg2', {}); // 理由省略も許可される
  check('理由ありで保存される', r1.event.reason === '僅差のため');
  check('理由省略でも保存できる(nullになる)', r2.event.reason === null);
}

console.log('=== テスト6: 未操作(未確認)は実践参入・見送りいずれのイベントも書かない ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t6.jsonl'));
  check('何も操作していないレースにはイベントが1件も無い', store.readAll().length === 0);
}

console.log('=== テスト7: 買い目別金額が変われば別イベントとして記録される(同じ判定への上書きではない) ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t7.jsonl'));
  const first = store.recordUserSkip('judg1', { reason: '当初は見送り' });
  const changedMind = store.recordUserEntry('judg1', { actualBets: [{ value: '1-2-3', amount: 500 }, { value: '1-3-2', amount: 0 }], allowedBetValues: SAMPLE_ALLOWED, reason: 'やっぱり参入' });
  check('見送り記録と参入記録はeventIdが異なる(別イベントとして両方残る)', first.eventId !== changedMind.eventId);
  check('両方のイベントがファイルに残っている(過去の判断も削除されない)', store.readAll().length === 2);

  const amountChanged = store.recordUserEntry('judg1', { actualBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 0 }], allowedBetValues: SAMPLE_ALLOWED, reason: 'やっぱり参入' });
  check('金額を変えて再送すると新しいイベントとして記録される', amountChanged.eventId !== changedMind.eventId);
  check('3件とも履歴として残る', store.readAll().length === 3);
}

console.log('=== テスト8: 結果確定(result_confirmed)・不成立(result_void)・取得失敗(result_fetch_failed)は区別される ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t8.jsonl'));
  const confirmed = store.recordResultConfirmed({ raceId: '2026-09-15|桐生|1', judgmentEventId: 'judg1', chakuju: '1-2-3', payout: '¥1,670' });
  const voidEv = store.recordResultVoid({ raceId: '2026-09-15|桐生|2', judgmentEventId: 'judg2', reason: '締切から4時間経過も結果無し' });
  const failed = store.recordResultFetchFailed({ raceId: '2026-09-15|桐生|3', judgmentEventId: 'judg3', errorMessage: 'HTTP 503' });
  check('result_confirmedが保存される', confirmed.event.eventType === 'result_confirmed' && confirmed.event.chakuju === '1-2-3');
  check('result_voidが保存される', voidEv.event.eventType === 'result_void');
  check('result_fetch_failedが保存される', failed.event.eventType === 'result_fetch_failed');
  check('3種は互いに異なるeventId', new Set([confirmed.eventId, voidEv.eventId, failed.eventId]).size === 3);
}

console.log('=== テスト9: 結果訂正(result_correction)は旧イベントを書き換えず追記のみで行う ===');
{
  const store = createRaceOpsEventStore('2026-09-15', () => {}, tmpFile('t9.jsonl'));
  const confirmed = store.recordResultConfirmed({ raceId: '2026-09-15|桐生|1', judgmentEventId: 'judg1', chakuju: '1-2-3', payout: '¥1,670' });
  const beforeCorrection = store.readAll().find((e) => e.eventId === confirmed.eventId);
  const correction = store.recordResultCorrection({ raceId: '2026-09-15|桐生|1', correctsEventId: confirmed.eventId, chakuju: '1-3-2', payout: '¥2,340', reason: '公式サイト側の表示誤りを後日訂正' });
  const afterCorrection = store.readAll().find((e) => e.eventId === confirmed.eventId);
  check('訂正イベントが新規追加される', correction.deduped === false && correction.event.eventType === 'result_correction');
  check('訂正イベントは旧イベントのeventIdをcorrectsEventIdとして参照する', correction.event.correctsEventId === confirmed.eventId);
  check('旧イベント(result_confirmed)の内容は訂正後も一切変更されない', JSON.stringify(beforeCorrection) === JSON.stringify(afterCorrection));
  check('ファイルには元イベント+訂正イベントの2件が残る(削除されない)', store.readAll().length === 2);
}

console.log('=== テスト10: 理由欄は長すぎる場合に安全な長さへ切り詰められる(誤操作・貼り付け事故対策) ===');
{
  const longText = 'あ'.repeat(1000);
  const normalized = normalizeReason(longText);
  check('300文字以内に切り詰められる', normalized.length === 300);
  check('空文字・undefinedはnullになる', normalizeReason('') === null && normalizeReason(undefined) === null);
}

console.log('=== テスト11: 保存先ファイルはlogs/realtime_screening_events_*.jsonl(今日実装分)とは別ファイルである ===');
{
  const { raceOpsEventFilePath } = require('../scripts/lib/race_ops_event_store');
  const { eventFilePath } = require('../scripts/lib/realtime_event_store');
  check('ファイル名が異なる', raceOpsEventFilePath('2026-09-15') !== eventFilePath('2026-09-15'));
  check('race_ops_eventsという名前を含む', raceOpsEventFilePath('2026-09-15').includes('race_ops_events_'));
}

console.log('=== テスト12(2026-09-15新規、受入監査指摘8「再起動後も記録が保持される」) ===');
{
  const filePath = tmpFile('t12.jsonl');
  const store1 = createRaceOpsEventStore('2026-09-15', () => {}, filePath);
  const entry = store1.recordUserEntry('judg1', { raceId: '2026-09-15|桐生|1', actualBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 0 }], allowedBetValues: SAMPLE_ALLOWED, reason: '再起動前' });
  const skip = store1.recordUserSkip('judg2', { raceId: '2026-09-15|桐生|2', reason: '再起動前' });

  // プロセス再起動を模して、同じファイルを指す全く新しいストアインスタンスを作る
  // (実プロセスではrace_ops_server.jsが毎リクエストでcreateRaceOpsEventStoreを呼び直す設計のため、
  // これは実際の「再起動後の初回アクセス」と同じ状況を再現している)。
  const store2 = createRaceOpsEventStore('2026-09-15', () => {}, filePath);
  const restored = store2.readAll();
  check('再起動後もentry/skip両方のイベントが読み込める', restored.length === 2);
  check('entryイベントの内容が保持されている(actualBets/totalInvestment含む)', restored.some((e) => e.eventId === entry.eventId && e.totalInvestment === 600));
  check('skipイベントの内容も保持されている', restored.some((e) => e.eventId === skip.eventId));

  const dupeAttempt = store2.recordUserEntry('judg1', { raceId: '2026-09-15|桐生|1', actualBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 0 }], allowedBetValues: SAMPLE_ALLOWED, reason: '再起動前' });
  check('再起動後の新しいストアインスタンスでも同一内容の再送は重複排除される(dedupセットが正しく再構築されている)', dupeAttempt.deduped === true);
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
if (fail > 0) process.exit(1);
