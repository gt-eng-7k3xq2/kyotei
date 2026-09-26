'use strict';
// GARON-WILD 本番モード(サーバー側)の試験(2026-09-26)。一時フォルダだけに書き込む(logs/wild・本番の台帳には触れない)。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wildtest-'));
process.env.GARON_WILD_DIR = path.join(tmp, 'wild');
process.env.GARON_WILD_RAW_ROOT = path.join(tmp, 'raw');
process.env.GARON_WILD_SCAN = '0';
const W = require('../scripts/lib/wild_live');
const { todayDateStrJST } = require('../scripts/lib/jst_time');
const server = require('../scripts/race_ops_server');
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8'));

let pass = 0, fail = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const date = todayDateStrJST();
const sm = samples[0];   // 常滑4R
const rec = { ok: true, rawTs: 1, venue: sm.venue, race: sm.race, deadline: '12:02', card: sm.card };
W.writeJsonAtomic(W.cardFile(date, sm.venue, sm.race), rec);
const sm2 = samples[1]; W.writeJsonAtomic(W.cardFile(date, sm2.venue, sm2.race), { ok: true, rawTs: 1, venue: sm2.venue, race: sm2.race, deadline: '12:33', card: sm2.card });
const sm3 = samples[2]; W.writeJsonAtomic(W.cardFile(date, sm3.venue, sm3.race), { ok: true, rawTs: 1, venue: sm3.venue, race: sm3.race, deadline: '11:00', card: sm3.card });
W.writeJsonAtomic(W.indexFile(date), { date, generatedAt: 'x', races: [W.indexRow(rec)] });

let base, srv;
async function call(method, p, body, headers) {
  const opt = { method, headers: Object.assign({}, headers) };
  if (body !== undefined) { opt.body = typeof body === 'string' ? body : JSON.stringify(body); if (!('Content-Type' in opt.headers)) opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(base + p, opt); let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, j };
}
const info = sm.card.combos;
const goodLines = ['5-1-4', '5-1-2', '5-4-1'].map(c => ({ combo: c, amount: 1000 }));
const goodBody = () => ({ action: 'bet', venue: sm.venue, race: sm.race, step: 'confirm', elapsedSec: 42, lines: goodLines.map(l => Object.assign({ odds: 9999 }, l)), budget: 3000, axis: 5, excluded: [1], blocks: [{ winner: 5, tech: 'まくり差し', buildMode: 'pick', combos: ['5-1-4', '5-1-2'] }], aiCombos: ['5-1-4', '5-1-2', '5-1-3'], aiScenarios: ['5号艇まくり差し'], memo: 'テスト', tags: ['直感'], summaryX: 'x', summaryNote: 'n' });

t('一覧・カードが返る。不正な会場・レース番号は400、無いカードは404', async () => {
  const a = await call('GET', '/api/wild/races'); assert.equal(a.status, 200); assert.equal(a.j.races.length, 1); assert.equal(a.j.races[0].venue, '常滑'); assert.ok(a.j.serverNowMs > 0);
  const b = await call('GET', '/api/wild/card?venue=' + encodeURIComponent('常滑') + '&race=4'); assert.equal(b.status, 200); assert.equal(b.j.card.raceDate, sm.card.raceDate);
  assert.equal((await call('GET', '/api/wild/card?venue=xx&race=4')).status, 400);
  assert.equal((await call('GET', '/api/wild/card?venue=' + encodeURIComponent('常滑') + '&race=13')).status, 400);
  assert.equal((await call('GET', '/api/wild/card?venue=' + encodeURIComponent('津') + '&race=1')).status, 404);
});
t('記録: オッズはサーバーのカードの値を使い、合計もサーバーで計算する(申告は信用しない)', async () => {
  const r = await call('POST', '/api/wild/entry', goodBody()); assert.equal(r.status, 200, JSON.stringify(r.j));
  const e = r.j.entry; assert.equal(e.seq, 1); assert.ok(!('hash' in e) && !('prevHash' in e), 'ハッシュ連鎖は使わない'); assert.equal(e.total, 3000); assert.equal(e.pointCount, 3); assert.equal(e.mode, 'live');
  assert.equal(e.lines[0].odds, info['5-1-4'].odds); assert.notEqual(e.lines[0].odds, 9999);
  assert.deepEqual(e.aiCombos, ['5-1-4', '5-1-2', '5-1-3']); assert.deepEqual(e.excluded, [1]); assert.equal(typeof e.afterDeadline, 'boolean'); assert.ok(e.receivedAt);
});
t('同じレースの2回目は409(二重記録を防ぐ)', async () => { const r = await call('POST', '/api/wild/entry', goodBody()); assert.equal(r.status, 409); assert.equal(W.readLedger().length, 1); });
t('不正な内容は400で、台帳に何も足さない(金額・重複・形式・上限・点数)', async () => {
  const bad = [
    Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, lines: [{ combo: '5-1-4', amount: 150 }] }),
    Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, lines: [{ combo: '5-1-4', amount: 100 }, { combo: '5-1-4', amount: 100 }] }),
    Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, lines: [{ combo: '5-5-4', amount: 100 }] }),
    Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, lines: [{ combo: '2-1-3', amount: 6000 }, { combo: '2-1-4', amount: 6000 }] }),
    Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, lines: [] }),
    Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, action: 'buy' }),
    Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, lines: [{ combo: '2-1-3', amount: 0 }] }),
  ];
  for (const b of bad) { const r = await call('POST', '/api/wild/entry', b); assert.equal(r.status, 400, JSON.stringify(b.lines)); }
  assert.equal(W.readLedger().length, 1);
});
t('JSON以外・別オリジンは拒否(CSRF対策)', async () => {
  const b = Object.assign(goodBody(), { venue: sm2.venue, race: sm2.race, lines: [{ combo: '2-1-3', amount: 100 }] });
  assert.equal((await call('POST', '/api/wild/entry', JSON.stringify(b), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/api/wild/entry', b, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(W.readLedger().length, 1);
});
t('存在しないカード・会場は記録できない', async () => {
  assert.equal((await call('POST', '/api/wild/entry', Object.assign(goodBody(), { venue: '津', race: 1 }))).status, 404);
  assert.equal((await call('POST', '/api/wild/entry', Object.assign(goodBody(), { venue: 'ほげ', race: 1 }))).status, 400);
});
t('見送りの記録。ハッシュが前の記録につながる', async () => {
  const r = await call('POST', '/api/wild/entry', { action: 'pass', venue: sm2.venue, race: sm2.race, step: 'attacker', elapsedSec: 5 }); assert.equal(r.status, 200);
  assert.equal(r.j.entry.seq, 2); assert.equal(r.j.entry.action, 'pass');
  const l = await call('GET', '/api/wild/ledger'); assert.equal(l.j.entries[0].seq, 2);
});
t('結果との照合: あなたとAIの的中・回収を、実際の払戻で計算する', async () => {
  W.writeJsonAtomic(W.resultsFile(date), { '常滑_4': { kind: 'confirmed', chakuju: '5-1-2', payout: '¥3,300' } });
  const s = await call('GET', '/api/wild/summary'); assert.equal(s.status, 200);
  const a = s.j.tiers[sm.card.entry.tier]; assert.ok(a, 'tier'); assert.equal(a.races, 1); assert.equal(a.humanHits, 1);
  assert.equal(a.humanStake, 3000); assert.equal(a.humanReturn, 1000 * 3300 / 100);   // 5-1-2に1000円 × 33倍
  assert.equal(a.aiHits, 1); assert.ok(a.aiStake > 0 && a.aiStake <= 3000 && a.aiReturn > 0);
  assert.equal(s.j.tiers[sm2.card.entry.tier].passes, 1);
  const row = s.j.rows.find(x => x.action === 'bet'); assert.equal(row.status, 'done'); assert.equal(row.chakuju, '5-1-2');
});
t('結果の手入力: 検証・公式が確定済みなら拒否・手入力は「結果待ち」を確定にする', async () => {
  // 記録#1(常滑4R、購入)。自動の結果が無い状態
  fs.rmSync(W.resultsFile(date), { force: true });
  const bad = [{ seq: 1, first: 1, second: 1, third: 2, payout: 1000 }, { seq: 1, first: 1, second: 2, third: 7, payout: 1000 }, { seq: 1, first: 1, second: 2, third: 3, payout: 50 }, { seq: 1, first: 1, second: 2, third: 3, payout: 1234.5 }, { seq: 1, first: 1, second: 2, third: 3, payout: 1005 }, { seq: 2, first: 1, second: 2, third: 3, payout: 1000 }, { seq: 99, first: 1, second: 2, third: 3, payout: 1000 }];
  for (const b of bad) { const r = await call('POST', '/api/wild/result', b); assert.ok(r.status === 400 || r.status === 404, JSON.stringify(b) + ' ' + r.status); }
  assert.equal((await call('POST', '/api/wild/result', { seq: 1, first: 5, second: 1, third: 2, payout: 3300 }, { Origin: 'https://evil.example' })).status, 403);
  const ok1 = await call('POST', '/api/wild/result', { seq: 1, first: 5, second: 1, third: 2, payout: 3300 }); assert.equal(ok1.status, 200); assert.equal(ok1.j.chakuju, '5-1-2'); assert.equal(ok1.j.payout, '¥3,300');
  const s1 = await call('GET', '/api/wild/summary'); const a = s1.j.tiers[sm.card.entry.tier]; assert.equal(a.races, 1); assert.equal(a.humanReturn, 33000);
  const row = s1.j.rows.find(x => x.action === 'bet'); assert.equal(row.source, 'manual'); assert.ok(Array.isArray(row.lines) && row.lines.length === 3);
  // 公式が確定したら、公式が優先。以後の手入力は409
  W.writeJsonAtomic(W.resultsFile(date), { '常滑_4': { kind: 'confirmed', chakuju: '2-1-3', payout: '¥900' } });
  const s2 = await call('GET', '/api/wild/summary'); assert.equal(s2.j.rows.find(x => x.action === 'bet').chakuju, '2-1-3'); assert.equal(s2.j.rows.find(x => x.action === 'bet').source, 'official');
  assert.equal((await call('POST', '/api/wild/result', { seq: 1, first: 5, second: 1, third: 2, payout: 3300 })).status, 409);
  fs.rmSync(W.manualResultsFile(date), { force: true });
});
t('gtool連携: 購入記録をgtoolのログ形式で返す(本線/抑え・結果・分類)。許可したオリジンだけ、読み取り専用', async () => {
  // 記録#1: 常滑4R、軸5、買い目 5-1-4 / 5-1-2 / 5-4-1
  fs.rmSync(W.resultsFile(date), { force: true }); fs.rmSync(W.manualResultsFile(date), { force: true });
  assert.equal((await call('GET', '/api/wild/gtools-export')).status, 403);
  assert.equal((await call('GET', '/api/wild/gtools-export', undefined, { Origin: 'https://evil.example' })).status, 403);
  const ORIGIN = 'https://gt-eng-7k3xq2.github.io';
  const opt = await fetch(base + '/api/wild/gtools-export', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(opt.status, 204); assert.equal(opt.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(opt.headers.get('access-control-allow-private-network'), 'true');
  let r = await call('GET', '/api/wild/gtools-export', undefined, { Origin: ORIGIN }); assert.equal(r.status, 200);
  assert.equal(r.j.entries.length, 1);                       // 見送り(#2)は含めない
  let e = r.j.entries[0];
  assert.equal(e.id, 'wild-1'); assert.equal(e.date, date); assert.equal(e.venue, '常滑'); assert.equal(e.raceNum, '4R'); assert.equal(e.shinkido, '荒'); assert.equal(e.engineMode, 'WILD'); assert.equal(e.maru, 5); assert.equal(e.pts, 3);
  assert.deepEqual(e.bets.map(b => b.type), ['honsen', 'honsen', 'honsen']); assert.deepEqual(e.bets.map(b => b.amount), [1000, 1000, 1000]);
  assert.equal(e.result, ''); assert.equal(e.payout, ''); assert.deepEqual(e.miss, []); assert.ok(e.goseiOdds > 0); assert.ok(e.savedAt > 0);
  // 結果: 的中(5-1-2) → hit / 頭が外れ → ichaku / 頭も2着も合う → sankaku / 頭は合うが2着が違う → nichaku
  const set = (chakuju) => W.writeJsonAtomic(W.resultsFile(date), { '常滑_4': { kind: 'confirmed', chakuju, payout: '¥3,300' } });
  set('5-1-2'); e = (await call('GET', '/api/wild/gtools-export', undefined, { Origin: ORIGIN })).j.entries[0]; assert.equal(e.result, '5-1-2'); assert.equal(e.payout, '¥3,300'); assert.deepEqual(e.miss, ['hit']);
  set('2-3-4'); assert.deepEqual((await call('GET', '/api/wild/gtools-export', undefined, { Origin: ORIGIN })).j.entries[0].miss, ['ichaku']);
  set('5-1-6'); assert.deepEqual((await call('GET', '/api/wild/gtools-export', undefined, { Origin: ORIGIN })).j.entries[0].miss, ['sankaku']);
  set('5-3-1'); assert.deepEqual((await call('GET', '/api/wild/gtools-export', undefined, { Origin: ORIGIN })).j.entries[0].miss, ['nichaku']);
  assert.equal((await call('POST', '/api/wild/gtools-export', {}, { Origin: ORIGIN })).status, 404);   // 読み取り専用(POSTは無い)
  fs.rmSync(W.resultsFile(date), { force: true });
});
t('ntfy通知の判定: 強・候補だけ、締切3分前までなら送る。対象外・締切間際・締切後は送らない', async () => {
  const dl = W.deadlineMs('2026-09-26', '12:30');
  const row = (o) => Object.assign({ date: '2026-09-26', venue: '丸亀', race: 3, deadline: '12:30', upset: 0.744, tier: 'strong', top: { winner: 4, tech: 'まくり', scenarioPct: 21.3 } }, o);
  const n = W.wildNotificationFor(row(), dl - 9 * 60000);
  assert.ok(n); assert.equal(n.key, '丸亀_3'); assert.equal(n.priority, 4);
  assert.ok(n.title.includes('WILD 強') && n.title.includes('丸亀3R') && n.title.includes('12:30')); assert.ok(n.body.includes('74%') && n.body.includes('4号艇 まくり') && n.body.includes('約9分'));
  assert.equal(W.wildNotificationFor(row({ tier: 'a' }), dl - 9 * 60000).priority, 3);
  assert.ok(W.wildNotificationFor(row({ tier: 'a' }), dl - 9 * 60000).title.includes('候補'));
  assert.equal(W.wildNotificationFor(row({ tier: 'none' }), dl - 9 * 60000), null);
  assert.equal(W.wildNotificationFor(row(), dl - 179 * 1000), null);     // 3分を切った
  assert.ok(W.wildNotificationFor(row(), dl - 181 * 1000));               // ちょうど3分超
  assert.equal(W.wildNotificationFor(row(), dl + 1000), null);            // 締切後
  assert.equal(W.wildNotificationFor(row({ deadline: 'xx' }), dl), null);
  assert.equal(W.wildNotificationFor(null, dl), null);
});
t('結果が外れの場合は回収0、結果が未確定なら「結果待ち」', async () => {
  W.writeJsonAtomic(W.resultsFile(date), { '常滑_4': { kind: 'confirmed', chakuju: '2-3-4', payout: '¥12,000' } });
  let a = (await call('GET', '/api/wild/summary')).j.tiers[sm.card.entry.tier]; assert.equal(a.humanHits, 0); assert.equal(a.humanReturn, 0); assert.equal(a.aiHits, 0);
  W.writeJsonAtomic(W.resultsFile(date), { '常滑_4': { kind: 'pending' } });
  a = (await call('GET', '/api/wild/summary')).j.tiers[sm.card.entry.tier]; assert.equal(a.races, 0); assert.equal(a.waiting, 1);
});
t('台帳は、ただの追記。手で直した行があっても、追記は止まらない(過去のhash欄があっても無視する)', async () => {
  const f = W.ledgerFile(), orig = fs.readFileSync(f, 'utf8');
  const lines = orig.split('\n').filter(Boolean); const e0 = JSON.parse(lines[0]); e0.total = 999999; e0.hash = 'old'; lines[0] = JSON.stringify(e0);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const b = Object.assign(goodBody(), { venue: sm3.venue, race: sm3.race, lines: [{ combo: '2-1-3', amount: 100 }] });
  const r = await call('POST', '/api/wild/entry', b); assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.entry.seq, 3);
  const l = await call('GET', '/api/wild/ledger'); assert.ok(!('verify' in l.j)); assert.equal((await call('GET', '/api/wild/summary')).status, 200);
  fs.writeFileSync(f, orig);
});
t('締切の計算(JST固定)・生データの一覧は、会場×レースごとに最新の1件', async () => {
  assert.equal(W.deadlineMs('2026-09-26', '12:02'), Date.UTC(2026, 8, 26, 3, 2, 0));
  assert.equal(W.deadlineMs('2026-09-26', 'xx'), null);
  const d = path.join(tmp, 'raw', '2026-09-26'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['常滑_4R_100.json', '常滑_4R_300.json', '常滑_4R_200.json', '津_1R_50.json', 'memo.txt']) fs.writeFileSync(path.join(d, f), '{}');
  const l = W.listRaw('2026-09-26'); assert.equal(l.length, 2); assert.equal(l.find(x => x.venue === '常滑').ts, 300);
});
t('本番の台帳・logs/wild には書き込んでいない', async () => {
  assert.ok(W.WILD_DIR.startsWith(tmp));
});

(async () => {
  srv = await server.startServer(0); base = 'http://127.0.0.1:' + srv.address().port;
  for (const [name, fn] of tests) { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); } }
  srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
