'use strict';
// POST /api/gtools/sync の回帰テスト(ローカルループバックのみ。保存先は一時ファイルへ差し替え、本番ログには触れない)。
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtsync-')), 'practice.json');
process.env.GARON_GTOOL_PRACTICE_LOG_FILE = tmp;
const statusTmp = path.join(path.dirname(tmp), 'status.json');
process.env.GARON_ENGINE_STATUS_FILE = statusTmp;
const { startServer } = require('../scripts/race_ops_server');
let pass = 0, fail = 0;
const check = (n, c) => { if (c) { console.log('  PASS: ' + n); pass++; } else { console.log('  FAIL: ' + n); fail++; } };
const ORIGIN = 'https://gt-eng-7k3xq2.github.io';
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Length': data.length } : {}), ...headers } }, res => {
      let out = ''; res.on('data', d => { out += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    }); r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const J = { 'Content-Type': 'application/json', Origin: ORIGIN };
const entry = (over) => ({ id: 1001, date: '2026-09-24', venue: '桐生', raceNum: '5R', ver: 'sg-v1', shinkido: '通', maru: 1, pts: 2,
  bets: [{ val: '1-3-4', type: 'honsen', amount: 900 }, { val: '2-1-3', type: 'osaee', amount: 600 }], result: '', payout: '', miss: [], engineMode: 'GDB', ...over });
(async () => {
  const server = await startServer(0); const port = server.address().port;
  try {
    let r = await req(port, 'OPTIONS', '/api/gtools/sync', undefined, { Origin: ORIGIN, 'Access-Control-Request-Private-Network': 'true' });
    check('OPTIONS 204+PNA許可', r.status === 204 && r.headers['access-control-allow-private-network'] === 'true');
    r = await req(port, 'OPTIONS', '/api/gtools/sync', undefined, { Origin: 'https://evil.example' });
    check('OPTIONS 別Originは403', r.status === 403);
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry()] }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' });
    check('POST 別Originは403', r.status === 403);
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry()] }, { 'Content-Type': 'text/plain', Origin: ORIGIN });
    check('POST JSON以外は415', r.status === 415);
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry()] }, J);
    check('POST 正常200', r.status === 200 && JSON.parse(r.body).ok === true && JSON.parse(r.body).total === 1);
    let saved = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    check('金額・本線抑えが保存される', saved.entries['1001'].bets[0].amount === 900 && saved.entries['1001'].bets[0].type === 'honsen' && saved.entries['1001'].bets[1].type === 'osaee');
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry({ result: '1-3-4', payout: '¥970', miss: ['hit'] }), entry({ id: 1002, raceNum: '6R' })] }, J);
    saved = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    check('同じidは後勝ちで更新(重複しない)', Object.keys(saved.entries).length === 2 && saved.entries['1001'].result === '1-3-4' && saved.entries['1001'].miss[0] === 'hit');
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry({ bets: [{ val: 'x', type: 'honsen' }] })] }, J);
    check('買い目の形式が不正な行だけ飛ばし、正常な行は保存する', r.status === 422 && Object.keys(JSON.parse(fs.readFileSync(tmp, 'utf8')).entries).length === 2);
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry({ id: 1003, bets: [{ val: 'x', type: 'honsen' }] }), entry({ id: 1004, raceNum: '7R' })] }, J);
    check('一部不正でも全体は拒否されない(skipped=1)', r.status === 200 && JSON.parse(r.body).skipped === 1 && !!JSON.parse(fs.readFileSync(tmp, 'utf8')).entries['1004'] && !JSON.parse(fs.readFileSync(tmp, 'utf8')).entries['1003']);
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry({ date: 'abc' })] }, J);
    check('日付不正は422', r.status === 422);
    r = await req(port, 'POST', '/api/gtools/sync', { entries: 'x' }, J);
    check('entriesが配列でなければ422', r.status === 422);
    r = await req(port, 'POST', '/api/gtools/sync', { entries: [entry({ scores: [1, 2, 3], memo: 'secret', evil: 1 })] }, J);
    saved = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    check('許可項目以外(scores/memo等)は保存しない', !('scores' in saved.entries['1001']) && !('memo' in saved.entries['1001']) && !('evil' in saved.entries['1001']));
    r = await req(port, 'GET', '/api/status', undefined, { Origin: ORIGIN });
    check('/api/status: データが無いときは503', r.status === 503);
    fs.writeFileSync(statusTmp, JSON.stringify({ overall: 'ok', dispositions: { mine: { total: 2 }, rows: [{ venue: '桐生', race: 1, mine: 'hit' }] } }));
    r = await req(port, 'GET', '/api/status', undefined, { Origin: ORIGIN });
    check('/api/status: 許可Originには完全版(参入を含む)を返す', r.status === 200 && JSON.parse(r.body).dispositions.mine.total === 2 && r.headers['access-control-allow-origin'] === ORIGIN && r.headers['cache-control'] === 'no-store');
    r = await req(port, 'GET', '/api/status', undefined, { Origin: 'https://evil.example' });
    check('/api/status: 別Originは403', r.status === 403);
    r = await req(port, 'GET', '/api/status', undefined, {});
    check('/api/status: Origin無し(直接アクセス)も403', r.status === 403);
    r = await req(port, 'OPTIONS', '/api/status', undefined, { Origin: ORIGIN, 'Access-Control-Request-Private-Network': 'true' });
    check('/api/status: OPTIONSはPNA許可つき204', r.status === 204 && r.headers['access-control-allow-private-network'] === 'true');
    r = await req(port, 'POST', '/api/status', {}, J);
    check('/api/status: POSTは受け付けない', r.status !== 200);
    r = await req(port, 'GET', '/api/gtools/sync', undefined, {});
    check('GETでは書き込み・応答できない(404)', r.status === 404);
  } finally { server.close(); try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } try { fs.unlinkSync(statusTmp); } catch (e) { /* ignore */ } }
  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`); process.exit(fail ? 1 : 0);
})();
