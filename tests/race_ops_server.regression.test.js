'use strict';
// scripts/race_ops_server.js の回帰テスト。127.0.0.1へのローカルループバックHTTPリクエストのみ
// (外部通信・実ntfy・実boatrace.jp・実AI呼出は一切行わない)。
// 2026-09-14夜実装、2026-09-15受入監査修正の一部(GET非破壊化・CSRF対策・judgmentEventId厳格照合・
// actualBets実額検証)。
//
// 使い方: node tests/race_ops_server.regression.test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { startServer, renderIndex } = require('../scripts/race_ops_server');
const { eventFilePath } = require('../scripts/lib/realtime_event_store');
const { raceOpsEventFilePath } = require('../scripts/lib/race_ops_event_store');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

const TEST_DATE = '2099-01-01'; // 実在しない未来日付。本番データと絶対に衝突しない
const TEST_RACE_ID = `${TEST_DATE}|桐生|1`;
const TEST_RACE_ID_NO_NOTIF = `${TEST_DATE}|桐生|2`;
const TEST_RACE_ID_RESULT = `${TEST_DATE}|桐生|3`; // 結果表示テスト専用(他テストの状態変化と混ざらないように分離)
function hexId(seed) { return crypto.createHash('sha256').update(seed).digest('hex'); }
const JUDGMENT_EVENT_ID = hexId('judgment-1');
const JUDGMENT_EVENT_ID_NO_NOTIF = hexId('judgment-2');
const JUDGMENT_EVENT_ID_RESULT = hexId('judgment-3');
const judgmentFilePath = eventFilePath(TEST_DATE);
const raceOpsFilePath = raceOpsEventFilePath(TEST_DATE);

function cleanup() {
  for (const f of [judgmentFilePath, raceOpsFilePath]) {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

function request(port, method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8') : null;
    const headers = Object.assign({}, extraHeaders);
    if (data && !('Content-Type' in headers) && !('content-type' in headers)) headers['Content-Type'] = 'application/json';
    if (data) headers['Content-Length'] = data.length;
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fixtureJudgment(overrides = {}) {
  return {
    schemaVersion: 1, eventType: 'judgment', eventId: JUDGMENT_EVENT_ID,
    raceId: TEST_RACE_ID, date: TEST_DATE, venue: '桐生', raceNumber: 1,
    engine: 'Q', engineSpecVersion: 'R07', qEngineVersion: 3,
    evaluatedAt: `${TEST_DATE}T00:10:00.000Z`, deadlineTime: '10:30',
    entered: true, route: 'escape', pEscape: 0.72, priorityEscape: false, judgeText: '逃げ',
    selectedBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 400 }],
    totalInvestment: 1000, inputHash: 'x'.repeat(64),
    ...overrides,
  };
}

async function main() {
  cleanup();

  const judgmentWithNotif = fixtureJudgment();
  const judgmentWithoutNotif = fixtureJudgment({
    eventId: JUDGMENT_EVENT_ID_NO_NOTIF, raceId: TEST_RACE_ID_NO_NOTIF, raceNumber: 2,
  });
  const judgmentForResult = fixtureJudgment({
    eventId: JUDGMENT_EVENT_ID_RESULT, raceId: TEST_RACE_ID_RESULT, raceNumber: 3,
  });
  const notificationSentEvent = {
    schemaVersion: 1, eventType: 'notification_sent', eventId: hexId('notif-1'),
    judgmentEventId: JUDGMENT_EVENT_ID, sentAt: `${TEST_DATE}T00:12:00.000Z`,
  };
  const notificationSentEventResult = {
    schemaVersion: 1, eventType: 'notification_sent', eventId: hexId('notif-3'),
    judgmentEventId: JUDGMENT_EVENT_ID_RESULT, sentAt: `${TEST_DATE}T00:12:00.000Z`,
  };
  fs.mkdirSync(path.dirname(judgmentFilePath), { recursive: true });
  fs.writeFileSync(judgmentFilePath, [judgmentWithNotif, judgmentWithoutNotif, judgmentForResult, notificationSentEvent, notificationSentEventResult].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const server = await startServer(0);
  const port = server.address().port;

  try {
    console.log('=== テスト1: GET /health ===');
    {
      const res = await request(port, 'GET', '/health');
      check('200を返す', res.status === 200);
      check('ok:trueを返す', JSON.parse(res.body).ok === true);
    }

    console.log('=== テスト2: GET / は200を返す(today基準のためこのfixtureの日付は載らない) ===');
    {
      const res = await request(port, 'GET', '/');
      check('200を返す', res.status === 200);
    }

    console.log('=== テスト2b: 一覧の各レース直下に参入/見送り操作を表示する ===');
    {
      const html = renderIndex(TEST_DATE, new Map([[JUDGMENT_EVENT_ID, fixtureJudgment()]]), []);
      check('参入ボタンが一覧へ存在する', html.includes('この内容で参入'));
      check('見送りボタンが一覧へ存在する', html.includes('>見送り</button>'));
      check('一覧からPOST /race/actionを呼ぶ', html.includes("fetch('/race/action'"));
    }

    console.log('=== テスト3(2026-09-15、受入監査指摘5): GET /race は一切書き込まない ===');
    {
      const before = fs.existsSync(raceOpsFilePath) ? fs.readFileSync(raceOpsFilePath, 'utf8') : '';
      const res = await request(port, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID)}&judgmentEventId=${JUDGMENT_EVENT_ID}`);
      check('200を返す', res.status === 200);
      check('買い目(1-2-3)がページに含まれる', res.body.includes('1-2-3'));
      check('締切時刻がページに含まれる', res.body.includes('10:30'));
      const after = fs.existsSync(raceOpsFilePath) ? fs.readFileSync(raceOpsFilePath, 'utf8') : '';
      check('GETの前後でrace_ops_eventsファイルの内容が一切変化しない(notification_openedが書かれない)', before === after);
      check('不要な開封操作ボタンは表示せず、参入/見送りを直接選べる', !res.body.includes('markOpened') && res.body.includes('この内容で参入') && res.body.includes('見送り'));
      check('保存済み金額の合計が自動表示される', res.body.includes('1,000円'));
    }

    console.log('=== テスト4: GET /race はjudgmentEventId未指定だと404 ===');
    {
      const res = await request(port, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID)}`);
      check('404を返す(judgmentEventId形式不正)', res.status === 404 || res.status === 400);
    }

    console.log('=== テスト5(2026-09-15、受入監査指摘2): judgmentEventIdとraceIdが一致しない場合は拒否される ===');
    {
      const res = await request(port, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID_NO_NOTIF)}&judgmentEventId=${JUDGMENT_EVENT_ID}`);
      check('400を返す(judgmentEventIdの実際のraceIdと不一致)', res.status === 400);
    }

    console.log('=== テスト6(2026-09-15、受入監査指摘2): notification_sentが無い判定は閲覧できない ===');
    {
      const res = await request(port, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID_NO_NOTIF)}&judgmentEventId=${JUDGMENT_EVENT_ID_NO_NOTIF}`);
      check('403を返す(notification_sent不在)', res.status === 403);
    }

    console.log('=== テスト7(2026-09-15、受入監査指摘5): POST /race/action はContent-Type: application/json以外を拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action',
        JSON.stringify({ raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID, action: 'skip' }),
        { 'Content-Type': 'text/plain' });
      check('415を返す', res.status === 415);
    }

    console.log('=== テスト8(2026-09-15、受入監査指摘5): POST /race/action は許可されないOriginを拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action',
        { raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID, action: 'skip' },
        { Origin: 'https://evil.example.com' });
      check('403を返す(異Origin)', res.status === 403);
    }

    console.log('=== テスト9(2026-09-15、受入監査指摘2): POST /race/action は存在しないjudgmentEventIdを拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action', { raceId: TEST_RACE_ID, judgmentEventId: hexId('does-not-exist'), action: 'skip' });
      check('404を返す', res.status === 404);
    }

    console.log('=== テスト10(2026-09-15、受入監査指摘2): POST /race/action はjudgmentEventIdとraceIdの不一致を拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action', { raceId: TEST_RACE_ID_NO_NOTIF, judgmentEventId: JUDGMENT_EVENT_ID, action: 'skip' });
      check('400を返す', res.status === 400);
    }

    console.log('=== テスト11(2026-09-15、受入監査指摘2): POST /race/action はnotification_sentが無い判定を拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action', { raceId: TEST_RACE_ID_NO_NOTIF, judgmentEventId: JUDGMENT_EVENT_ID_NO_NOTIF, action: 'skip' });
      check('403を返す', res.status === 403);
    }

    console.log('=== テスト12(2026-09-15、受入監査指摘3): POST /race/action の実践参入は買い目別の実購入額(actualBets)を必須にする ===');
    {
      const res = await request(port, 'POST', '/race/action', {
        raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID, action: 'entry',
        actualBets: [{ value: '1-2-3', amount: 600 }, { value: '1-3-2', amount: 0 }],
        reason: 'テスト参入',
      });
      check('200を返す', res.status === 200);
      const parsed = JSON.parse(res.body);
      check('ok:trueを返す', parsed.ok === true);
      const raceOpsRaw = fs.readFileSync(raceOpsFilePath, 'utf8');
      check('user_entry_recordedイベントが保存される', raceOpsRaw.includes('user_entry_recorded'));
      check('actualBetsが保存される', raceOpsRaw.includes('"actualBets"'));
      check('totalInvestmentがサーバー側の再計算値(600)で保存される', raceOpsRaw.includes('"totalInvestment":600'));
      check('investmentAmount(旧フィールド)は使われていない', !raceOpsRaw.includes('"investmentAmount"'));
    }

    console.log('=== テスト13(2026-09-15、受入監査指摘3): actualBetsが推奨買い目と過不足する場合は拒否される ===');
    {
      const res = await request(port, 'POST', '/race/action', {
        raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID, action: 'entry',
        actualBets: [{ value: '1-2-3', amount: 600 }], // 1-3-2が欠けている
      });
      check('400を返す', res.status === 400);
    }

    console.log('=== テスト14: POST /race/action は不正なaction値を拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action', { raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID, action: 'delete_r07_production' });
      check('400を返す(不正なactionは拒否される)', res.status === 400);
    }

    console.log('=== テスト15: POST /race/action は不正なraceId形式(Windowsパスのような値含む)を拒否する ===');
    {
      const res = await request(port, 'POST', '/race/action', { raceId: 'C:\\garon\\garon_q_engine.html', judgmentEventId: JUDGMENT_EVENT_ID, action: 'skip' });
      check('400を返す', res.status === 400);
    }

    console.log('=== テスト16: POST /race/action で見送り(skip)を記録できる ===');
    {
      const res = await request(port, 'POST', '/race/action', { raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID, action: 'skip', reason: 'テスト見送り' });
      check('200を返す', res.status === 200);
      const raceOpsRaw = fs.readFileSync(raceOpsFilePath, 'utf8');
      check('user_skip_recordedイベントが保存される', raceOpsRaw.includes('user_skip_recorded'));
    }

    console.log('=== テスト17(2026-09-15新規): POST /race/open は明示的に開封を記録する ===');
    {
      const res1 = await request(port, 'POST', '/race/open', { raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID });
      check('200を返す', res1.status === 200);
      const raceOpsRaw = fs.readFileSync(raceOpsFilePath, 'utf8');
      check('notification_openedイベントが保存される', raceOpsRaw.includes('notification_opened'));
      const res2 = await request(port, 'POST', '/race/open', { raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID });
      check('2回目は重複排除される(deduped:true)', JSON.parse(res2.body).deduped === true);
    }

    console.log('=== テスト18(2026-09-15新規): POST /race/open もnotification_sent必須・CSRF検証の対象になる ===');
    {
      const res = await request(port, 'POST', '/race/open', { raceId: TEST_RACE_ID_NO_NOTIF, judgmentEventId: JUDGMENT_EVENT_ID_NO_NOTIF });
      check('403を返す(notification_sent不在)', res.status === 403);
      const res2 = await request(port, 'POST', '/race/open',
        JSON.stringify({ raceId: TEST_RACE_ID, judgmentEventId: JUDGMENT_EVENT_ID }), { 'Content-Type': 'text/plain' });
      check('Content-Type不正は415', res2.status === 415);
    }

    console.log('=== テスト19: GET /summary は通知が1件も無い日付に対して案内文を返す(推測しない) ===');
    {
      // TEST_DATEはここまでのテストで判定・通知・実践参入等のデータが既に存在するため、
      // 「本当に何も無い日付」として別の未使用日付を使う。
      const res = await request(port, 'GET', '/summary?date=2098-12-31');
      check('200を返す', res.status === 200);
      check('未生成である旨が案内される', res.body.includes('まだ分析レポートが生成されていません'));
    }

    console.log('=== テスト20: 不明なエンドポイントは404 ===');
    {
      const res = await request(port, 'GET', '/nonexistent');
      check('404を返す', res.status === 404);
    }

    console.log('=== テスト23(2026-09-15新規、GARON RaceOps引継ぎP0対応): GET /export はAI検証用ブリーフをダウンロード可能な形で返す ===');
    {
      const before = fs.readFileSync(raceOpsFilePath, 'utf8');
      const res = await request(port, 'GET', `/export?date=${TEST_DATE}`);
      check('200を返す', res.status === 200);
      check('Content-Typeがapplication/json', (res.headers['content-type'] || '').includes('application/json'));
      check('Content-Dispositionでダウンロード用ファイル名が指定される', (res.headers['content-disposition'] || '').includes(`race_ops_ai_brief_${TEST_DATE}.json`));
      const brief = JSON.parse(res.body);
      check('schemaVersionを持つ', brief.schemaVersion === 1);
      const race = brief.races.find((r) => r.judgmentEventId === JUDGMENT_EVENT_ID);
      check('通知済みのテストレースがracesに含まれる', !!race);
      check('preDeadlineに推奨買い目(1-2-3)を含む', race.preDeadline.recommendedBets.some((b) => b.value === '1-2-3'));
      check('GETの前後でrace_ops_eventsファイルは一切変化しない(読み取り専用)', fs.readFileSync(raceOpsFilePath, 'utf8') === before);
    }

    console.log('=== テスト24(2026-09-15新規): GET /export はdate未指定でも(今日の日付で)例外なく空のブリーフを返す ===');
    {
      const res = await request(port, 'GET', '/export');
      check('200を返す', res.status === 200);
      const brief = JSON.parse(res.body);
      check('racesは配列(データが無ければ空配列)', Array.isArray(brief.races));
    }
  } finally {
    server.close();
  }

  console.log('=== テスト22(2026-09-15新規、受入監査再指摘「リアルタイム結果が画面に反映されていない」) ===');
  {
    const { createRaceOpsEventStore } = require('../scripts/lib/race_ops_event_store');
    const reportPath = path.join(__dirname, '..', 'reports', `race_ops_analysis_${TEST_DATE}.json`);
    const server3 = await startServer(0);
    const port3 = server3.address().port;
    try {
      console.log('  -- 22a: 結果未確定時は損失扱いせず「結果未確定」と表示される --');
      {
        const before = fs.readFileSync(raceOpsFilePath, 'utf8');
        const res = await request(port3, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID_RESULT)}&judgmentEventId=${JUDGMENT_EVENT_ID_RESULT}`);
        check('200を返す', res.status === 200);
        check('公式結果が「未確定」と表示される', res.body.includes('公式結果：未確定'));
        check('仮想成績も「結果未確定」と表示される(損失扱いにしない)', res.body.includes('仮想：結果未確定'));
        check('GETの前後でrace_ops_eventsファイルは一切変化しない', fs.readFileSync(raceOpsFilePath, 'utf8') === before);
      }

      console.log('  -- 22b: 実践参入を記録し、結果確定後に個別画面へ着順・配当・仮想損益・実践損益が表示される --');
      {
        const entryRes = await request(port3, 'POST', '/race/action', {
          raceId: TEST_RACE_ID_RESULT, judgmentEventId: JUDGMENT_EVENT_ID_RESULT, action: 'entry',
          actualBets: [{ value: '1-2-3', amount: 700 }, { value: '1-3-2', amount: 300 }],
        });
        check('実践参入の記録に成功する', entryRes.status === 200);

        // 結果イベントはscripts/race_ops_result_updater.js/race_ops_analysis.jsが記録するもので、
        // race_ops_server.js自体は一切結果を書き込まない。ここではその既存の記録経路(実在の
        // イベントストアAPI)を直接使ってfixtureとして結果を用意する(実サイト取得は行わない)。
        const store = createRaceOpsEventStore(TEST_DATE, () => {}, raceOpsFilePath);
        store.recordResultConfirmed({ raceId: TEST_RACE_ID_RESULT, judgmentEventId: JUDGMENT_EVENT_ID_RESULT, chakuju: '1-2-3', payout: '¥1,670' });

        const res = await request(port3, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID_RESULT)}&judgmentEventId=${JUDGMENT_EVENT_ID_RESULT}`);
        check('200を返す', res.status === 200);
        check('公式結果(着順・配当)が表示される', res.body.includes('公式結果：確定: 1-2-3 / ¥1,670'));
        check('仮想成績(的中・投資・払戻・純損益)が表示される', /仮想：的中 投資1,000円 \/ 払戻10,020円 \/ 純損益\+9,020円/.test(res.body));
        check('実践成績(実購入額ベースの的中・投資・払戻・純損益)が表示される', /実践：的中 投資1,000円 \/ 払戻[\d,]+円 \/ 純損益/.test(res.body));
      }

      console.log('  -- 22c: 古い夜間レポートファイルが残っていても、/summaryは最新イベントを反映する --');
      {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify({
          schemaVersion: 2, date: TEST_DATE, generatedAt: '2000-01-01T00:00:00.000Z', resultPendingCount: 999,
          virtual: {
            allNotified: { raceCount: 999, hitCount: 0, hitRate: 0, totalInvestment: 999000, totalNet: -999000, roi: 0, unresolvedCount: 0 },
            userEntry: { raceCount: 0, hitCount: 0, hitRate: null, totalInvestment: 0, totalNet: 0, roi: null, unresolvedCount: 0 },
            userSkip: { raceCount: 0, hitCount: 0, hitRate: null, totalInvestment: 0, totalNet: 0, roi: null, unresolvedCount: 0 },
            unconfirmed: { raceCount: 0, hitCount: 0, hitRate: null, totalInvestment: 0, totalNet: 0, roi: null, unresolvedCount: 0 },
          },
          actual: { userEntry: { raceCount: 0, hitCount: 0, hitRate: null, totalInvestment: 0, totalNet: 0, roi: null, unresolvedCount: 0 }, note: '古いダミーレポート(テスト用)' },
          derived: { lossAvoidedBySkip: 0, profitMissedBySkip: 0, roiDeltaEntryVsAll: null },
        }, null, 2));

        const res = await request(port3, 'GET', `/summary?date=${TEST_DATE}`);
        check('200を返す', res.status === 200);
        check('古いレポートのダミー値(999件)は表示されない', !res.body.includes('999件'));
        check('現在のイベントを反映した実践参入1件が表示される(見送りとして記録した1-桐生1Rとは別に、3-桐生3Rが実践参入としてカウントされる)', res.body.includes('実践参入: 1件'));

        try { fs.unlinkSync(reportPath); } catch (e) { /* ignore */ }
      }

      console.log('  -- 22d(受入監査再指摘「0円参入を拒否する」): POST /race/actionは全買い目0円のentryをHTTPレベルでも拒否する --');
      {
        const before = fs.readFileSync(raceOpsFilePath, 'utf8');
        const res = await request(port3, 'POST', '/race/action', {
          raceId: TEST_RACE_ID_RESULT, judgmentEventId: JUDGMENT_EVENT_ID_RESULT, action: 'entry',
          actualBets: [{ value: '1-2-3', amount: 0 }, { value: '1-3-2', amount: 0 }],
        });
        check('400を返す', res.status === 400);
        const parsed = JSON.parse(res.body);
        check('案内メッセージが返る', parsed.error === '購入額を入力するか、見送りを選択してください');
        check('拒否されたリクエストでrace_ops_eventsファイルは変化しない', fs.readFileSync(raceOpsFilePath, 'utf8') === before);
      }

      console.log('  -- 22e: GET /summary もイベントファイルへ一切書き込まない --');
      {
        const beforeJudgment = fs.readFileSync(judgmentFilePath, 'utf8');
        const beforeRaceOps = fs.readFileSync(raceOpsFilePath, 'utf8');
        await request(port3, 'GET', `/summary?date=${TEST_DATE}`);
        check('GET /summary の前後でjudgmentイベントファイルが変化しない', fs.readFileSync(judgmentFilePath, 'utf8') === beforeJudgment);
        check('GET /summary の前後でrace_opsイベントファイルが変化しない', fs.readFileSync(raceOpsFilePath, 'utf8') === beforeRaceOps);
      }
    } finally {
      server3.close();
      try { fs.unlinkSync(reportPath); } catch (e) { /* ignore */ }
    }
  }

  console.log('=== テスト21(2026-09-15新規、受入監査指摘8「再起動後も記録が保持される」) ===');
  {
    // ここまでのテスト(テスト12・16)で記録したentry/skipイベントがファイルに残っていることを前提に、
    // サーバープロセスを再起動したのと同じ状況(全く新しいhttp.Serverインスタンスを同じ設定で起動)を
    // 作り、GET /race で状態バッジが維持されていることを確認する(race_ops_server.js自体が
    // 毎リクエストでイベントファイルを読み直す設計のため、プロセスを跨いでも状態は永続化されている)。
    const beforeRestartRaw = fs.readFileSync(raceOpsFilePath, 'utf8');
    check('前提: 再起動前の時点でuser_skip_recordedイベントが記録済み', beforeRestartRaw.includes('user_skip_recorded'));

    const server2 = await startServer(0);
    const port2 = server2.address().port;
    try {
      const res = await request(port2, 'GET', `/race?id=${encodeURIComponent(TEST_RACE_ID)}&judgmentEventId=${JUDGMENT_EVENT_ID}`);
      check('新しいサーバーインスタンスでも200を返す', res.status === 200);
      check('再起動後も過去の記録状態(見送り済み)がページへ反映される', res.body.includes('見送り済み'));
    } finally {
      server2.close();
      cleanup();
    }
  }

  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('致命的エラー:', e);
  cleanup();
  process.exit(1);
});
