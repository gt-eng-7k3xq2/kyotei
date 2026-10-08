'use strict';
// WILDの展示の進入(枠なり/前づけ)の記録が、サーバー(race_ops_server.js)の一覧・カードの応答に載ることの試験(2026-10-08)。
// 外部通信なし(公式サイトへの取得は差し替え)。一時フォルダだけに書く。127.0.0.1のループバックのみ。
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wildentrysrv-')); const WILD = path.join(tmp, 'wild'); fs.mkdirSync(WILD, { recursive: true });
process.env.GARON_WILD_DIR = WILD; process.env.GARON_WILD_SCAN = '0';   // 裏方(スキャン)は起動しない
// 公式への取得は差し替え(失敗として返す): サーバーは記録を使うはず
const OE = require('../scripts/lib/official_entry.js'); let liveCalls = 0; OE.fetchExhibitionEntry = async () => { liveCalls++; return { ok: false, error: 'stub' }; };
const { startServer } = require('../scripts/race_ops_server');
const W = require('../scripts/lib/wild_live'); const { todayDateStrJST } = require('../scripts/lib/jst_time'); const date = todayDateStrJST();
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8'));
const [a, b] = samples;
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + e.message.split('\n')[0]); } };
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(d) }); } catch (e) { rej(e); } }); }).on('error', rej));
(async () => {
  for (const sm of [a, b]) { const card = JSON.parse(JSON.stringify(sm.card)); W.writeJsonAtomic(W.cardFile(date, sm.venue, sm.race), { ok: true, rawTs: 9e15, venue: sm.venue, race: sm.race, deadline: '23:50', card }); }
  W.writeJsonAtomic(W.indexFile(date), { date, generatedAt: new Date().toISOString(), races: [a, b].map((sm) => W.indexRow(W.readJson(W.cardFile(date, sm.venue, sm.race), null))) });
  W.writeJsonAtomic(path.join(WILD, `entry_${date}.json`), { [a.venue + '_' + a.race]: { state: 'changed', order: '163524', moved: [{ lane: 2, course: 5 }], checkedAt: new Date().toISOString(), lastTryMs: Date.now() } });
  const server = await startServer(0); const port = server.address().port;
  await t('一覧: 記録のあるレースに entry(state, order)が付き、記録の無いレースには付かない', async () => {
    const r = await get(port, '/api/wild/races'); assert.strictEqual(r.status, 200);
    const ra = r.body.races.find((x) => x.venue === a.venue && x.race === a.race), rb = r.body.races.find((x) => x.venue === b.venue && x.race === b.race);
    assert.deepStrictEqual(ra.entry, { state: 'changed', order: '163524' }); assert.strictEqual(rb.entry, undefined); });
  await t('カード: 公式の取得に失敗しても、記録から exhibitionEntry(前づけあり・コース順)を返す', async () => {
    const r = await get(port, `/api/wild/card?venue=${encodeURIComponent(a.venue)}&race=${a.race}`); assert.strictEqual(r.status, 200);
    const ee = r.body.exhibitionEntry; assert(ee && ee.ok && ee.wakunari === false); assert.deepStrictEqual(ee.order, [1, 6, 3, 5, 2, 4]); assert.strictEqual(ee.courseOf['2'], 5); assert.strictEqual(ee.source, 'record'); });
  await t('カード: 記録も無く取得も失敗なら、exhibitionEntry は ok:false(カード自体は返す)', async () => {
    const r = await get(port, `/api/wild/card?venue=${encodeURIComponent(b.venue)}&race=${b.race}`); assert.strictEqual(r.status, 200); assert(r.body.ok); assert(r.body.exhibitionEntry && r.body.exhibitionEntry.ok === false); assert(r.body.card && r.body.card.boats); assert(liveCalls >= 2); });
  await new Promise((res) => server.close(res));
  console.log(`\n${pass} 項目合格 / ${fail} 項目不合格`); if (fail) process.exitCode = 1; process.exit(process.exitCode || 0);
})();
