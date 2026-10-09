'use strict';
// WILDの記録の取り消し(2026-10-09、CEO「WILDエンジンの記録も削除できるようにしたい」)の試験。
// 一時フォルダだけに書く。外部通信なし。127.0.0.1のループバックのみ。
// 確認: ①今日のレースの記録だけ取り消せる ②取り消す前の台帳のバックアップと、取り消した記録の履歴が残る ③手入力の結果が紐づいていれば外れる
//       ④今日以外・存在しない番号は拒否 ⑤サーバーの入口(JSON必須・取り消し後は同じレースを記録し直せる) ⑥画面にボタンと確認がある
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wildvoid-')); const WILD = path.join(tmp, 'wild'); fs.mkdirSync(WILD, { recursive: true });
process.env.GARON_WILD_DIR = WILD; process.env.GARON_WILD_SCAN = '0';
const W = require('../scripts/lib/wild_live'); const { startServer } = require('../scripts/race_ops_server'); const { todayDateStrJST } = require('../scripts/lib/jst_time');
const today = todayDateStrJST(), yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + e.message.split('\n')[0]); } };
const seed = () => { fs.rmSync(path.join(WILD, 'ledger.jsonl'), { force: true }); fs.rmSync(path.join(WILD, 'ledger_voided.jsonl'), { force: true });
  const mk = (raceDate, venue, raceNo, extra) => W.appendLedger(Object.assign({ mode: 'live', action: 'bet', raceDate, venue, raceNo, race: venue + raceNo + 'R', deadline: '17:27', pointCount: 13, total: 3000, lines: [{ combo: '1-2-3', amount: 3000 }] }, extra || {}));
  return { old: mk(yesterday, '桐生', 1), a: mk(today, '蒲郡', 6), b: mk(today, '鳴門', 6) }; };
const post = (port, p, body, ct) => new Promise((res, rej) => { const d = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': ct || 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (x) => { let s = ''; x.on('data', (c) => s += c); x.on('end', () => { try { res({ status: x.statusCode, body: JSON.parse(s) }); } catch (e) { res({ status: x.statusCode, body: s }); } }); }); r.on('error', rej); r.end(d); });
(async () => {
  await t('今日のレースの記録を取り消せる(ほかの記録は残る)', () => { const s = seed(); const r = W.voidLedgerEntry(s.a.seq, today); assert(r.ok); const led = W.readLedger(); assert.strictEqual(led.length, 2); assert(!led.find((e) => e.seq === s.a.seq)); assert(led.find((e) => e.seq === s.b.seq)); });
  await t('取り消す前の台帳のバックアップと、取り消した記録の履歴が残る', () => { const s = seed(); W.voidLedgerEntry(s.a.seq, today, Date.parse('2026-10-09T09:00:00Z'));
    const bak = fs.readFileSync(path.join(WILD, 'ledger.jsonl.before_void.bak'), 'utf8').split('\n').filter(Boolean); assert.strictEqual(bak.length, 3);
    const hist = fs.readFileSync(path.join(WILD, 'ledger_voided.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); assert.strictEqual(hist.length, 1); assert.strictEqual(hist[0].entry.seq, s.a.seq); assert.strictEqual(hist[0].voidedAt, '2026-10-09T09:00:00.000Z'); });
  await t('今日以外のレースの記録・存在しない番号は取り消せない(台帳は変わらない)', () => { const s = seed(); const before = fs.readFileSync(path.join(WILD, 'ledger.jsonl'), 'utf8');
    const r1 = W.voidLedgerEntry(s.old.seq, today); assert(!r1.ok && r1.status === 403); const r2 = W.voidLedgerEntry(9999, today); assert(!r2.ok && r2.status === 404);
    assert.strictEqual(fs.readFileSync(path.join(WILD, 'ledger.jsonl'), 'utf8'), before); assert(!fs.existsSync(path.join(WILD, 'ledger_voided.jsonl'))); });
  await t('そのレースに手入力した結果が紐づいていれば、あわせて外す(別の記録の結果は残る)', () => { const s = seed(); const mf = W.manualResultsFile(today);
    W.writeJsonAtomic(mf, { '蒲郡_6': { chakuju: '1-2-3', payout: '¥1,000', seq: s.a.seq }, '鳴門_6': { chakuju: '2-1-3', payout: '¥2,000', seq: s.b.seq } });
    W.voidLedgerEntry(s.a.seq, today); const m = W.readJson(mf, {}); assert(!m['蒲郡_6']); assert(m['鳴門_6']); });
  const server = await startServer(0); const port = server.address().port;
  await t('サーバー: JSONでなければ拒否(415)、番号が不正なら400', async () => { const s = seed(); const r1 = await post(port, '/api/wild/ledger/void', { seq: s.a.seq }, 'text/plain'); assert.strictEqual(r1.status, 415); const r2 = await post(port, '/api/wild/ledger/void', { seq: 'x' }); assert.strictEqual(r2.status, 400); assert.strictEqual(W.readLedger().length, 3); });
  await t('サーバー: 取り消しが通り、台帳APIにも出なくなる。今日以外は403、存在しない番号は404', async () => { const s = seed();
    const ok = await post(port, '/api/wild/ledger/void', { seq: s.a.seq }); assert.strictEqual(ok.status, 200); assert(ok.body.ok); assert.strictEqual(ok.body.voided.race, '蒲郡6R');
    const led = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/api/wild/ledger' }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d))); }));
    assert(!led.entries.find((e) => e.seq === s.a.seq)); assert((await post(port, '/api/wild/ledger/void', { seq: s.old.seq })).status === 403); assert((await post(port, '/api/wild/ledger/void', { seq: 9999 })).status === 404); });
  await new Promise((res) => server.close(res));
  await t('画面: 今日の記録の行に「取り消す」ボタンと確認があり、サーバーの取り消し窓口を呼ぶ(組み込み済みの garon_wild.html にも入っている)', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'wild_template.html'), 'utf8'); const live = path.join(__dirname, '..', 'garon_wild.html');
    for (const h of [tpl, fs.existsSync(live) ? fs.readFileSync(live, 'utf8') : tpl]) { assert(h.includes('data-void'), 'ボタンが無い'); assert(h.includes('/api/wild/ledger/void'), '取り消し窓口を呼んでいない'); assert(h.includes('記録を取り消します。よろしいですか'), '確認が無い'); } });
  console.log(`\n${pass} 項目合格 / ${fail} 項目不合格`); if (fail) process.exitCode = 1; process.exit(process.exitCode || 0);
})();
