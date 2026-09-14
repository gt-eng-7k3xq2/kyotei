'use strict';
// scripts/race_ops_server.js の回帰テスト。127.0.0.1へのローカルループバックHTTPリクエストのみ
// (外部通信・実ntfy・実boatrace.jp・実AI呼出は一切行わない。CEO指示「実通信試験を行わない」に
// 抵触しない範囲=自プロセス内のlocalhostテストのみに限定する)。
//
// 実在の日付(logs/realtime_screening_events_*.jsonl等)を汚さないため、架空の未来日付
// (TEST_DATE)を使い、テスト用のjudgmentイベント行を一時的にlogs配下へ書いてから検証し、
// 終了時に必ず削除する。
//
// 使い方: node tests/race_ops_server.regression.test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { startServer } = require('../scripts/race_ops_server');
const { eventFilePath } = require('../scripts/lib/realtime_event_store');
const { raceOpsEventFilePath } = require('../scripts/lib/race_ops_event_store');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const TEST_DATE = '2099-01-01'; // 実在しない未来日付。本番データと絶対に衝突しない
const TEST_RACE_ID = `${TEST_DATE}|桐生|1`;
const TEST_JUDGMENT_EVENT_ID = 'test-judgment-event-id-race-ops-server';
const judgmentFilePath = eventFilePath(TEST_DATE);
const raceOpsFilePath = raceOpsEventFilePath(TEST_DATE);

function cleanup() {
  for (const f of [judgmentFilePath, raceOpsFilePath]) {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  cleanup(); // 前回の異常終了で残った可能性のあるテストファイルを念のため先に削除

  // テスト用judgmentイベント(実際の永続化フォーマットに準拠、fixture)を事前に書いておく
  fs.mkdirSync(path.dirname(judgmentFilePath), { recursive: true });
  const fixtureJudgment = {
    schemaVersion: 1, eventType: 'judgment', eventId: TEST_JUDGMENT_EVENT_ID,
    raceId: TEST_RACE_ID, date: TEST_DATE, venue: '桐生', raceNumber: 1,
    engine: 'Q', engineSpecVersion: 'R07', qEngineVersion: 3,
    evaluatedAt: `${TEST_DATE}T00:10:00.000Z`, deadlineTime: '10:30',
    entered: true, route: 'escape', pEscape: 0.72, priorityEscape: false, judgeText: '逃げ',
    selectedBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 400 }],
    totalInvestment: 1000, inputHash: 'x'.repeat(64),
  };
  fs.writeFileSync(judgmentFilePath, `${JSON.stringify(fixtureJudgment)}\n`);

  const server = await startServer(0); // ポート0=OS割り当ての空きポート(他プロセスと衝突しない)
  const port = server.address().port;

  try {
    console.log('=== テスト1: GET /health ===');
    {
      const res = await request(port, 'GET', '/health');
      check('200を返す', res.status === 200);
      check('ok:trueを返す', JSON.parse(res.body).ok === true);
    }

    console.log('=== テスト2: GET / (一覧、実在しない日付なので原則空だが、todayではないため空一覧になる想定) ===');
    {
      const res = await request(port, 'GET', '/');
      check('200を返す(index.htmlは常に今日日付で描画するため、TEST_DATEのfixtureは載らない)', res.status === 200);
    }

    console.log('=== テスト3: GET /race?id=<存在するraceId> は判定内容を表示しnotification_openedを記録する ===');
    {
      const res = await request(port, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID)}`);
      check('200を返す', res.status === 200);
      check('買い目(1-2-3)がページに含まれる', res.body.includes('1-2-3'));
      check('締切時刻がページに含まれる', res.body.includes('10:30'));
      const raceOpsRaw = fs.readFileSync(raceOpsFilePath, 'utf8');
      check('notification_openedイベントが保存される', raceOpsRaw.includes('notification_opened'));
    }

    console.log('=== テスト4: GET /race?id=<存在しないraceId> は404 ===');
    {
      const res = await request(port, 'GET', `/race?id=${encodeURIComponent(`${TEST_DATE}|存在しない場|9`)}`);
      check('404を返す', res.status === 404);
    }

    console.log('=== テスト5: POST /race/action で実践参入(entry)を記録できる ===');
    {
      const res = await request(port, 'POST', '/race/action', {
        raceId: TEST_RACE_ID, judgmentEventId: TEST_JUDGMENT_EVENT_ID, action: 'entry',
        investmentAmount: 1000, reason: 'テスト参入',
      });
      check('200を返す', res.status === 200);
      const parsed = JSON.parse(res.body);
      check('ok:trueを返す', parsed.ok === true);
      const raceOpsRaw = fs.readFileSync(raceOpsFilePath, 'utf8');
      check('user_entry_recordedイベントが保存される', raceOpsRaw.includes('user_entry_recorded'));
      check('投資額1000が保存される', raceOpsRaw.includes('"investmentAmount":1000'));
    }

    console.log('=== テスト6: POST /race/action は不正なaction値を拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action', {
        raceId: TEST_RACE_ID, judgmentEventId: TEST_JUDGMENT_EVENT_ID, action: 'delete_r07_production',
      });
      check('400を返す(不正なactionは拒否される)', res.status === 400);
    }

    console.log('=== テスト7: POST /race/action は不正なraceId形式を拒否する(パス的な値も含む) ===');
    {
      const res = await request(port, 'POST', '/race/action', {
        raceId: 'C:\\garon\\garon_q_engine.html', judgmentEventId: 'x', action: 'skip',
      });
      check('400を返す(Windowsパスのような値はraceId形式として拒否される)', res.status === 400);
    }

    console.log('=== テスト8: POST /race/action で見送り(skip)を記録できる ===');
    {
      const res = await request(port, 'POST', '/race/action', {
        raceId: TEST_RACE_ID, judgmentEventId: TEST_JUDGMENT_EVENT_ID, action: 'skip', reason: 'テスト見送り',
      });
      check('200を返す', res.status === 200);
      const raceOpsRaw = fs.readFileSync(raceOpsFilePath, 'utf8');
      check('user_skip_recordedイベントが保存される', raceOpsRaw.includes('user_skip_recorded'));
    }

    console.log('=== テスト9: GET /summary は未生成の日付に対して404ではなく案内文を返す(推測しない) ===');
    {
      const res = await request(port, 'GET', `/summary?date=${TEST_DATE}`);
      check('200を返す', res.status === 200);
      check('未生成である旨が案内される', res.body.includes('まだ分析レポートが生成されていません'));
    }

    console.log('=== テスト10: 不明なエンドポイントは404 ===');
    {
      const res = await request(port, 'GET', '/nonexistent');
      check('404を返す', res.status === 404);
    }
  } finally {
    server.close();
    cleanup();
  }

  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  cleanup();
  process.exit(1);
});
