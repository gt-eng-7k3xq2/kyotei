'use strict';
// R07リアルタイムスクリーニングの判定証拠即時永続化(2026-09-14、CEO指示「判定直後にクラッシュ耐性の
// ある形で保存する恒久修正」)の回帰テスト。
//
// 対象:
//   - scripts/lib/realtime_event_store.js (新規モジュール本体)
//   - scripts/realtime_screening.js の extractAndJudge() が実装した
//     「判定→保存→(保存成功時のみ)通知→(通知成功時のみ)notification_sent記録」の順序
//     (Playwright実サイト取得を伴うため、この一連の流れ自体はfixtureで再現して検証する。
//     実ntfy送信・実サイト取得・実AI呼び出しは一切行わない)
//
// 使い方: node tests/realtime_event_store.regression.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  canonicalStringify,
  computeInputHash,
  computeJudgmentEventId,
  computeNotificationEventId,
  loadExistingEvents,
  appendEventLine,
  createEventStore,
} = require('../scripts/lib/realtime_event_store');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'garon_realtime_event_store_test_'));
function tmpFile(name) { return path.join(TMP_DIR, name); }
function collectLogs() { const buf = []; return { logFn: (msg) => buf.push(msg), buf }; }

function sampleJudgmentFields(overrides = {}) {
  return {
    raceId: '2026-09-15|桐生|1',
    date: '2026-09-15',
    venue: '桐生',
    raceNumber: 1,
    engine: 'Q',
    engineSpecVersion: 'R07',
    qEngineVersion: 3,
    evaluatedAt: '2026-09-15T00:00:00.000Z',
    deadlineTime: '10:30',
    entered: true,
    route: 'escape',
    pEscape: 0.72,
    priorityEscape: false,
    judgeText: '逃げ',
    selectedBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 400 }],
    totalInvestment: 1000,
    inputHash: computeInputHash([{ no: 1 }], { '1-2-3': 5.0 }),
    ...overrides,
  };
}

console.log('=== テスト1: entered=trueの判定は買い目・資金配分・ルート等を含めて保存される ===');
{
  const filePath = tmpFile('test1.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  const fields = sampleJudgmentFields();
  const saved = store.recordJudgment(fields);
  check('保存時にdedupedがfalse(新規保存)', saved.deduped === false);
  const line = fs.readFileSync(filePath, 'utf8').trim();
  const parsed = JSON.parse(line);
  check('eventType=judgment', parsed.eventType === 'judgment');
  check('entered=trueが保存される', parsed.entered === true);
  check('route(逃げ/非逃げ/見送り)が保存される', parsed.route === 'escape');
  check('pEscapeが保存される', parsed.pEscape === 0.72);
  check('priorityEscapeが保存される', parsed.priorityEscape === false);
  check('judgeTextが保存される', parsed.judgeText === '逃げ');
  check('selectedBets(買い目)が保存される', Array.isArray(parsed.selectedBets) && parsed.selectedBets.length === 2);
  check('各買い目にvalue/amountが含まれる', parsed.selectedBets[0].value === '1-2-3' && parsed.selectedBets[0].amount === 600);
  check('totalInvestment(合計投資額)が保存される', parsed.totalInvestment === 1000);
  check('qEngineVersion/engineSpecVersionが保存される', parsed.qEngineVersion === 3 && parsed.engineSpecVersion === 'R07');
  check('inputHashが保存される', typeof parsed.inputHash === 'string' && parsed.inputHash.length === 64);
}

console.log('=== テスト2: entered=falseの判定(見送り)も保存される ===');
{
  const filePath = tmpFile('test2.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  const fields = sampleJudgmentFields({
    entered: false, route: 'hold', pEscape: 0.5, judgeText: '見送り',
    selectedBets: [], totalInvestment: 0,
  });
  const saved = store.recordJudgment(fields);
  check('entered=falseでも新規保存される', saved.deduped === false);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
  check('entered=falseが保存される', parsed.entered === false);
  check('routeがholdとして保存される', parsed.route === 'hold');
  check('買い目が生成されていない場合はselectedBetsが空配列で保存される(nullではない)', Array.isArray(parsed.selectedBets) && parsed.selectedBets.length === 0);
}

console.log('=== テスト3: 同一内容の再判定はファイルに重複追記されない(eventId重複排除) ===');
{
  const filePath = tmpFile('test3.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  const fields = sampleJudgmentFields();
  const first = store.recordJudgment(fields);
  const second = store.recordJudgment(fields); // 全く同じ内容で再実行(再起動直後の再検出等を想定)
  check('1回目は新規保存', first.deduped === false);
  check('2回目は重複排除される(deduped=true)', second.deduped === true);
  check('2回目もeventIdは1回目と同一', second.eventId === first.eventId);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
  check('ファイルには1行しか追記されていない', lines.length === 1);
}

console.log('=== テスト4: 入力(オッズ等)が変わればeventIdが変わり、別イベントとして保存される ===');
{
  const filePath = tmpFile('test4.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  const fields1 = sampleJudgmentFields();
  const fields2 = sampleJudgmentFields({ inputHash: computeInputHash([{ no: 1 }], { '1-2-3': 9.9 }) }); // オッズだけ変化
  const r1 = store.recordJudgment(fields1);
  const r2 = store.recordJudgment(fields2);
  check('入力ハッシュが変わればeventIdも変わる', r1.eventId !== r2.eventId);
  check('2件とも新規保存される(重複排除されない)', r1.deduped === false && r2.deduped === false);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
  check('ファイルに2行保存されている', lines.length === 2);
}

console.log('=== テスト4b: 買い目の内容が変わればeventIdが変わる ===');
{
  const filePath = tmpFile('test4b.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  const fields1 = sampleJudgmentFields();
  const fields2 = sampleJudgmentFields({ selectedBets: [{ value: '1-2-3', amount: 1000 }], totalInvestment: 1000 });
  const r1 = store.recordJudgment(fields1);
  const r2 = store.recordJudgment(fields2);
  check('買い目内容が変わればeventIdも変わる', r1.eventId !== r2.eventId);
}

console.log('=== テスト4c: eventIdは現在時刻だけを根拠にしない(同一内容なら呼び出し時刻が違っても同じ) ===');
{
  const fields = sampleJudgmentFields();
  const id1 = computeJudgmentEventId(fields);
  // わずかに待ってから同一内容で再計算(時刻が根拠に含まれていればここで値が変わってしまう)
  const id2 = computeJudgmentEventId({ ...fields });
  check('同一内容なら計算時刻が違ってもeventIdは同一', id1 === id2);
}

console.log('=== テスト5: notification_sentイベントは対応するjudgmentEventIdを参照して保存される ===');
{
  const filePath = tmpFile('test5.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  const judgment = store.recordJudgment(sampleJudgmentFields());
  const notif = store.recordNotificationSent(judgment.eventId);
  check('notification_sentも新規保存される', notif.deduped === false);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  const notifLine = lines.find((l) => l.eventType === 'notification_sent');
  check('notification_sent行が保存されている', !!notifLine);
  check('judgmentEventIdが正しく参照されている', notifLine.judgmentEventId === judgment.eventId);
  check('sentAtが保存されている', typeof notifLine.sentAt === 'string' && notifLine.sentAt.length > 0);
}

console.log('=== テスト5b: 同じ判定への通知送信記録を2回試みても重複しない ===');
{
  const filePath = tmpFile('test5b.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  const judgment = store.recordJudgment(sampleJudgmentFields());
  const n1 = store.recordNotificationSent(judgment.eventId);
  const n2 = store.recordNotificationSent(judgment.eventId);
  check('1回目は新規保存', n1.deduped === false);
  check('2回目は重複排除される', n2.deduped === true);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
  check('notification_sentは1行しか保存されない(judgment 1行+notification_sent 1行=計2行)', lines.length === 2);
}

console.log('=== テスト6: 末尾が改行で終わっていない不完全な行は無視され、既存の完了済み行は保持される ===');
{
  const filePath = tmpFile('test6.jsonl');
  const store1 = createEventStore('2026-09-15', () => {}, filePath);
  const fields1 = sampleJudgmentFields();
  const r1 = store1.recordJudgment(fields1); // 1行目: 完全な行
  const afterFirstWrite = fs.readFileSync(filePath, 'utf8');

  // クラッシュを模して、改行なしの不完全な行(JSONとしても壊れている)を直接追記する
  const incompleteChunk = '{"schemaVersion":1,"eventType":"judgment","eventId":"deadbeef","raceId":"2026-09-15|桐生|2","incomplete...';
  fs.appendFileSync(filePath, incompleteChunk);

  const { logFn, buf } = collectLogs();
  const store2 = createEventStore('2026-09-15', logFn, filePath); // 再起動を模した再読込
  check('起動時エラーとして末尾不完全行の無視がログされる', buf.some((m) => m.includes('末尾行') && m.includes('無視')));

  const beforeAppend = fs.readFileSync(filePath, 'utf8');
  check('再読込しただけではファイルは一切書き換わらない(読み取り専用)', beforeAppend === afterFirstWrite + incompleteChunk);

  const fields2 = sampleJudgmentFields({ raceNumber: 2, raceId: '2026-09-15|桐生|2', inputHash: computeInputHash([{ no: 2 }], {}) });
  const r2 = store2.recordJudgment(fields2);
  check('再読込後も新しい判定は正常に保存できる', r2.deduped === false);

  const finalRaw = fs.readFileSync(filePath, 'utf8');
  check('壊れていた不完全行のバイト列自体は書き換えられず、そのまま残っている(過去データの破壊が無い)', finalRaw.includes(incompleteChunk));
  check('新しい行は不完全行と連結されず、改行で区切られた独立の行として追記される(通し番号のズレ防止)', finalRaw.endsWith(`\n${JSON.stringify({ schemaVersion: 1, eventType: 'judgment', eventId: r2.eventId, ...fields2 })}\n`));

  const { logFn: logFn3, buf: buf3 } = collectLogs();
  const known3 = loadExistingEvents(filePath, logFn3);
  check('3回目の再読込では、1行目(正常)・3行目(新規、正常)のeventIdが両方回収される', known3.has(r1.eventId) && known3.has(r2.eventId));
  check('壊れた1行(2行目、今はもう末尾ではない)は解析エラーとしてログされ、内容としては回収されない', buf3.some((m) => m.includes('解析できない')) && !known3.has('deadbeef'));
}

console.log('=== テスト6b: 既存ファイルの途中行がJSONとして壊れている場合もエラーログを残して無視する ===');
{
  const filePath = tmpFile('test6b.jsonl');
  const validEvent = { schemaVersion: 1, eventType: 'judgment', eventId: 'valid-id-1', raceId: 'x' };
  fs.writeFileSync(filePath, `${JSON.stringify(validEvent)}\nthis is not json\n{"schemaVersion":1,"eventType":"judgment","eventId":"valid-id-2","raceId":"y"}\n`);
  const { logFn, buf } = collectLogs();
  const known = loadExistingEvents(filePath, logFn);
  check('壊れた行についてエラーログが残る', buf.some((m) => m.includes('解析できない')));
  check('壊れた行を挟んでも前後の正常行のeventIdは両方回収される', known.has('valid-id-1') && known.has('valid-id-2'));
  check('ファイル自体は一切書き換えられない', fs.readFileSync(filePath, 'utf8').includes('this is not json'));
}

console.log('=== テスト7: JSONLファイルはUTF-8・BOM無しで、日本語(判定理由等)を含む行も1行1JSONになる ===');
{
  const filePath = tmpFile('test7.jsonl');
  const store = createEventStore('2026-09-15', () => {}, filePath);
  store.recordJudgment(sampleJudgmentFields({ judgeText: '非逃げ(合成オッズ1.8倍が2.0倍未満のため見送り)' }));
  const buf = fs.readFileSync(filePath);
  const hasBOM = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  check('BOM無し', !hasBOM);
  const text = buf.toString('utf8');
  check('末尾が改行で終わっている(追記専用フォーマットとして次回書き込みと連結しない)', text.endsWith('\n'));
  const lines = text.split('\n').filter((l) => l.length > 0);
  check('1行=1個の完全なJSONとしてパースできる', lines.length === 1 && (() => { try { JSON.parse(lines[0]); return true; } catch (e) { return false; } })());
  const parsed = JSON.parse(lines[0]);
  check('日本語(判定理由)がUTF-8のまま正しく保存・復元される', parsed.judgeText === '非逃げ(合成オッズ1.8倍が2.0倍未満のため見送り)');
}

console.log('=== テスト8: canonicalStringifyはキー順序に依存しない(同じ内容なら同じ文字列になる) ===');
{
  const a = canonicalStringify({ b: 1, a: 2, c: [3, 1, 2] });
  const b = canonicalStringify({ a: 2, c: [3, 1, 2], b: 1 });
  check('キー順序が違っても同じ正規化文字列になる', a === b);
  const c = canonicalStringify({ a: 2, c: [1, 2, 3], b: 1 }); // 配列の順序は意味を持つため変えると異なる
  check('配列の要素順序が変わると異なる文字列になる(配列順は保持される)', a !== c);
}

console.log('=== テスト9(統合シナリオ): extractAndJudge()が実装した「保存→通知→notification_sent」の順序をfixtureで再現 ===');
{
  // scripts/realtime_screening.js の extractAndJudge() 内で実際に行われている手順
  // (1)judgement確定 → (2)selectedBets/totalInvestment算出 → (3)recordJudgment(保存) →
  // (4)保存成功時のみ通知本文をselectedBetsから生成してntfy送信 → (5)ntfy送信成功時のみrecordNotificationSent
  // を、実ntfy送信をスタブに置き換えて再現する。
  function simulateExtractAndJudgeFlow(store, judgement, sendNtfyStub) {
    const finalPointsForSave = judgement.finalPoints || [];
    const amountsForSave = judgement.amounts || [];
    const selectedBets = finalPointsForSave.map((value, i) => ({
      value, amount: (amountsForSave[i] !== undefined && amountsForSave[i] !== null) ? amountsForSave[i] : null,
    }));
    const hasCompleteAmounts = finalPointsForSave.length > 0
      && amountsForSave.length === finalPointsForSave.length
      && amountsForSave.every((a) => a !== undefined && a !== null);
    const totalInvestment = finalPointsForSave.length === 0 ? 0 : (hasCompleteAmounts ? amountsForSave.reduce((s, a) => s + a, 0) : null);

    let judgmentEventId = null;
    let saveFailed = false;
    try {
      const saved = store.recordJudgment({
        raceId: '2026-09-15|桐生|3', date: '2026-09-15', venue: '桐生', raceNumber: 3,
        engine: 'Q', engineSpecVersion: 'R07', qEngineVersion: judgement.qEngineVersion,
        evaluatedAt: '2026-09-15T00:00:00.000Z', deadlineTime: '10:40',
        entered: judgement.entered, route: judgement.route, pEscape: judgement.pEscape,
        priorityEscape: judgement.priorityEscape, judgeText: judgement.route,
        selectedBets, totalInvestment, inputHash: computeInputHash([], {}),
      });
      judgmentEventId = saved.eventId;
    } catch (e) {
      saveFailed = true;
    }

    let notifySent = false, notificationSentRecorded = false, notifySkippedForSaveFailure = false;
    if (judgement.entered) {
      if (judgmentEventId === null) {
        notifySkippedForSaveFailure = true;
      } else {
        const betValsForBody = selectedBets.map((b) => b.value);
        try {
          sendNtfyStub({ bets: betValsForBody });
          notifySent = true;
          try {
            store.recordNotificationSent(judgmentEventId);
            notificationSentRecorded = true;
          } catch (e3) { /* ログのみ、既存の設計通り送信成功自体は覆さない */ }
        } catch (e) {
          notifySent = false;
        }
      }
    }
    return { selectedBets, totalInvestment, judgmentEventId, saveFailed, notifySent, notificationSentRecorded, notifySkippedForSaveFailure };
  }

  console.log('  -- 9a: 保存成功→通知成功のケース --');
  {
    const filePath = tmpFile('test9a.jsonl');
    const store = createEventStore('2026-09-15', () => {}, filePath);
    const judgement = { entered: true, route: 'escape', pEscape: 0.7, priorityEscape: false, qEngineVersion: 3, finalPoints: ['1-2-3', '1-3-2'], amounts: [600, 400] };
    let sentBody = null;
    const result = simulateExtractAndJudgeFlow(store, judgement, (body) => { sentBody = body; });
    check('保存が先に完了してから通知が送られる(judgmentEventIdが確定している)', result.judgmentEventId !== null);
    check('通知が送信される', result.notifySent === true);
    check('通知成功後にnotification_sentが記録される', result.notificationSentRecorded === true);
    check('通知本文の買い目は保存されたselectedBetsと完全一致する', JSON.stringify(sentBody.bets) === JSON.stringify(result.selectedBets.map((b) => b.value)));
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    check('judgment・notification_sentの2イベントがこの順で保存されている', lines.length === 2 && lines[0].eventType === 'judgment' && lines[1].eventType === 'notification_sent');
  }

  console.log('  -- 9b: ntfy送信失敗のケース(notification_sentを記録しない) --');
  {
    const filePath = tmpFile('test9b.jsonl');
    const store = createEventStore('2026-09-15', () => {}, filePath);
    const judgement = { entered: true, route: 'escape', pEscape: 0.7, priorityEscape: false, qEngineVersion: 3, finalPoints: ['1-2-3'], amounts: [1000] };
    const result = simulateExtractAndJudgeFlow(store, judgement, () => { throw new Error('ntfy送信失敗(fixture)'); });
    check('判定証拠自体は保存されている', result.judgmentEventId !== null);
    check('送信は失敗として扱われる', result.notifySent === false);
    check('notification_sentイベントは記録されない', result.notificationSentRecorded === false);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    check('judgmentイベントのみ保存され、notification_sentは無い(送信失敗を成功として記録していない)', lines.length === 1 && lines[0].eventType === 'judgment');
  }

  console.log('  -- 9c: 判定証拠の永続化自体に失敗した場合、通知そのものを送らない --');
  {
    const brokenStore = {
      recordJudgment: () => { throw new Error('保存失敗(fixture、例: ディスク書き込みエラー)'); },
      recordNotificationSent: () => { throw new Error('呼ばれないはず'); },
    };
    const judgement = { entered: true, route: 'escape', pEscape: 0.7, priorityEscape: false, qEngineVersion: 3, finalPoints: ['1-2-3'], amounts: [1000] };
    let notifyAttempted = false;
    const result = simulateExtractAndJudgeFlow(brokenStore, judgement, () => { notifyAttempted = true; });
    check('保存失敗が検知される', result.saveFailed === true);
    check('通知は保存失敗のため見送られる(notifySkippedForSaveFailure=true)', result.notifySkippedForSaveFailure === true);
    check('実際にntfy送信は一度も呼ばれない(証拠を失ったまま通知だけ進めない)', notifyAttempted === false);
  }

  console.log('  -- 9d: entered=falseのケースでは判定は保存されるが通知は最初から発生しない --');
  {
    const filePath = tmpFile('test9d.jsonl');
    const store = createEventStore('2026-09-15', () => {}, filePath);
    const judgement = { entered: false, route: 'hold', pEscape: 0.5, priorityEscape: false, qEngineVersion: 3, finalPoints: [], amounts: [] };
    let notifyAttempted = false;
    const result = simulateExtractAndJudgeFlow(store, judgement, () => { notifyAttempted = true; });
    check('entered=falseでも判定証拠は保存される', result.judgmentEventId !== null);
    check('entered=falseなら通知は試みられない', notifyAttempted === false);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    check('保存されたのはjudgmentイベント1件のみ', lines.length === 1 && lines[0].entered === false);
  }
}

console.log('=== テスト10: realtime_screening.js側の配線が既存の日次ログ・二重送信防止の仕組みを壊していないことをソースコードで確認 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'realtime_screening.js'), 'utf8');
  check('dayJudgments.pushは既存のまま残っている(race_judgments_*.json用の構造化ログ)', src.includes('dayJudgments.push({'));
  check('saveJudgmentsLog()の定義自体は変更されていない(1日1回書き出しの既存仕組み)', /function saveJudgmentsLog\(\) \{\n  const dir = path\.join\(ROOT, 'logs'\);/.test(src));
  check('markNotified(...)は引き続きntfy送信成功後に呼ばれている(二重送信防止の既存動作を維持)', /await sendNtfyNotification\(ntfyTopic, \{ title, body, priority: 4, tags: \['boat'\][\s\S]{0,40}\}\);[\s\S]{0,200}markNotified\(dateStr, raceKeyStr, 'Q'\)/.test(src));
  check('isAlreadyNotified(...)による二重送信防止チェックは変更されていない', src.includes("isAlreadyNotified(dateStr, raceKeyStr)"));
  check('永続化失敗時は通知をスキップする分岐が追加されている', src.includes('judgmentEventId === null'));
  check('notification_sentはntfy送信成功ブロックの内側でのみ記録される', /markNotified\(dateStr, raceKeyStr, 'Q'\);[\s\S]{0,300}recordNotificationSent\(judgmentEventId\)/.test(src));
}

console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);

// クリーンアップ(一時ディレクトリを削除。本番logs/配下には一切書き込んでいない)
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

if (fail > 0) process.exit(1);
