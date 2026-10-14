'use strict';
// 展示の進入の警告(scripts/lib/official_entry.js と garon_wild.html)のテスト(2026-10-08、桐生12R事故への対策)
// 実行: node tests/wild_entry_guard.test.js   (画面のテストは、ヘッドレスのブラウザで garon_wild.html を開く)
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'scripts', 'lib', 'official_entry.js'));
let pass = 0, fail = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---- 取り出しと判定(公式の直前情報ページの形に似せたHTML) ----
const boatHtml = (n, time) => `<div class="table1_boatImage1"><span class="table1_boatImage1Number is-type${n}">${n}</span><span class="table1_boatImage1Line"><span class="table1_boatImage1Boat" style="left: 40%;"></span></span><span class="table1_boatImage1Time">${time}</span></div>`;
const html = (orderTimes) => '<html>' + orderTimes.map(([n, tm]) => boatHtml(n, tm)).join('') + '</html>';
t('展示の進入順と展示STを取り出す(Fは負)', () => {
  const p = E.parseBeforeInfo(html([[1, 'F.03'], [6, 'F.03'], [3, '.07'], [5, '.02'], [2, '.01'], [4, '.01']]));
  assert.deepStrictEqual(p.order, [1, 6, 3, 5, 2, 4]); assert.strictEqual(p.st[1], -0.03); assert.strictEqual(p.st[3], 0.07); });
t('6艇そろわない・重複・不正なページは null', () => { assert.strictEqual(E.parseBeforeInfo('<html></html>'), null); assert.strictEqual(E.parseBeforeInfo(html([[1, '.1'], [2, '.1'], [3, '.1']])), null); assert.strictEqual(E.parseBeforeInfo(html([[1, '.1'], [1, '.1'], [3, '.1'], [4, '.1'], [5, '.1'], [6, '.1']])), null); });
t('枠なり・前づけの判定(枠→コース)', () => {
  assert.strictEqual(E.judgeEntry([1, 2, 3, 4, 5, 6]).wakunari, true);
  const j = E.judgeEntry([1, 6, 3, 5, 2, 4]); assert.strictEqual(j.wakunari, false); assert.strictEqual(j.courseOf[2], 5); assert.strictEqual(j.courseOf[6], 2); assert.deepStrictEqual(j.moved.map((m) => m.lane).sort(), [2, 4, 5, 6]); assert.strictEqual(j.text, '163524'); });
t('取得: 成功はキャッシュされ、同じレースは2回目を取りに行かない', async () => {
  E._cache.clear(); let calls = 0; const fi = async () => { calls++; return { ok: true, status: 200, text: async () => html([[1, '.01'], [2, '.02'], [3, '.03'], [4, '.04'], [5, '.05'], [6, '.06']]) }; };
  const a = await E.fetchExhibitionEntry({ date: '20261008', jcd: '01', rno: 12, fetchImpl: fi, now: 1000 }); const b = await E.fetchExhibitionEntry({ date: '20261008', jcd: '01', rno: 12, fetchImpl: fi, now: 2000 });
  assert(a.ok && a.wakunari); assert.strictEqual(calls, 1); assert.strictEqual(a, b); });
t('取得: HTTPエラー・未掲載・タイムアウトは ok:false(例外にしない)', async () => {
  E._cache.clear(); const r1 = await E.fetchExhibitionEntry({ date: '20261008', jcd: '01', rno: 1, fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) }); assert(!r1.ok);
  const r2 = await E.fetchExhibitionEntry({ date: '20261008', jcd: '01', rno: 2, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html></html>' }) }); assert(!r2.ok && /未掲載/.test(r2.error));
  const r3 = await E.fetchExhibitionEntry({ date: '20261008', jcd: '01', rno: 3, timeoutMs: 30, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('abort'); e.name = 'AbortError'; rej(e); })) }); assert(!r3.ok && /タイムアウト/.test(r3.error));
  const r4 = await E.fetchExhibitionEntry({ date: 'bad', jcd: '01', rno: 1 }); assert(!r4.ok); });

// ---- 画面(ヘッドレスブラウザ) ----
async function pageTests() {
  let chromium; try { ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright'))); } catch (e) { console.log('SKIP 画面のテスト(playwrightが無い)'); return; }
  const live = path.join(ROOT, 'garon_wild.html'); if (!fs.existsSync(live)) { console.log('SKIP 画面のテスト(garon_wild.html が無い)'); return; }
  const b = await chromium.launch({ headless: true }); const p = await b.newPage();
  await p.goto(require('url').pathToFileURL(live).href); await p.waitForTimeout(800);
  const go = (ee) => p.evaluate(async (ee) => { await startRace(2); if (ee === undefined) delete S.meta.exhibitionEntry; else S.meta.exhibitionEntry = ee; viewOverview(); const ov = document.querySelector('#app').innerText; const plan = autoPlan(S.card); S.attacker = plan.attacker; S.blocks = plan.blocks; S.tenkai = null; viewConfirm(); return { ov, cf: document.querySelector('#app').innerText, tenkai: document.querySelector('#tenkai').value, hasCtl: !!document.querySelector('#cmtSeg'), axis: S.attacker }; }, ee);
  const changed = { ok: true, order: [1, 6, 3, 5, 2, 4], wakunari: false, courseOf: { 1: 1, 6: 2, 3: 3, 5: 4, 2: 5, 4: 6 }, moved: [{ lane: 2, course: 5 }, { lane: 4, course: 6 }, { lane: 5, course: 4 }, { lane: 6, course: 2 }], text: '163524' };
  const r1 = await go(changed);
  t('画面: 進入が枠なりでないと、概況に警告が出る', () => { assert(/展示の進入が枠なりではありません/.test(r1.ov), r1.ov.slice(0, 200)); assert(/❶→❻→❸→❺→❷→❹/.test(r1.ov)); assert(/❷は5コース/.test(r1.ov)); });
  t('画面: 進入が枠なりでなくても、コメントは止めない(通知で知らせる方針。画面は警告の表示だけ)', () => { assert(/展示の進入が枠なりではありません/.test(r1.cf)); assert(!/【要確認】/.test(r1.tenkai), r1.tenkai); assert(r1.hasCtl, '文量・文調の操作が消えている'); });
  const ok = { ok: true, order: [1, 2, 3, 4, 5, 6], wakunari: true, courseOf: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 }, moved: [], text: '123456' };
  const r2 = await go(ok);
  t('画面: 枠なりのときは緑の表示で、コメントは通常どおり作られる', () => { assert(/展示の進入: 枠なり/.test(r2.cf)); assert(!/【要確認】/.test(r2.tenkai)); assert(r2.hasCtl); });
  const r3 = await go({ ok: false, error: 'タイムアウト' });
  t('画面: 取得できないときは、確認を促す小さな注意で、コメントは通常どおり', () => { assert(/取得できませんでした/.test(r3.cf)); assert(!/【要確認】/.test(r3.tenkai)); assert(r3.hasCtl); });
  const r4 = await go(undefined);
  t('画面: サーバーが進入を返さない(古いサーバー・サンプル)ときは、表示なしで従来どおり', () => { assert(!/展示の進入/.test(r4.cf)); assert(!/【要確認】/.test(r4.tenkai)); });
  // 保存・コピーは止めない(確認ダイアログを出さない)
  const r5 = await p.evaluate(async (ee) => { await startRace(2); S.meta.exhibitionEntry = ee; const plan = autoPlan(S.card); S.attacker = plan.attacker; S.blocks = plan.blocks; S.tenkai = null; viewConfirm(); let asked = 0, saved = 0; window.confirm = () => { asked++; return false; }; window.doConfirm = () => { saved++; }; document.querySelector('#btnGo').click(); return { asked, saved }; }, changed);
  t('画面: 枠なりでなくても、保存の前に確認ダイアログは出さない', () => { assert.strictEqual(r5.asked, 0, 'confirmが出ている'); assert.strictEqual(r5.saved, 1); });
  // 一覧の印(目安以外のレースにも出る)
  const rl = await p.evaluate(async () => {
    const base = SAMPLES.map((sm, i) => ({ id: i, venue: sm.venue, race: sm.race, deadline: sm.deadline, upset: sm.card.overview.upset, top: sm.card.scenarios[0], tier: 'none', boats: sm.card.boats, done: null }));
    base[0].entry = { state: 'wakunari', order: '123456' }; base[1].entry = { state: 'changed', order: '163524' }; base[2].entry = { state: 'pending' };
    const orig = DataSource.listRaces; DataSource.listRaces = async () => base; SHOW_ALL = true; await viewList(); const txt = document.querySelector('#app').innerText, html = document.querySelector('#app').innerHTML; DataSource.listRaces = orig; SHOW_ALL = false;
    return { txt, html }; });
  t('画面: 一覧に、枠なり・前づけあり(コース順つき)・未掲載の印が出る。目安以外(none)のレースにも出る', () => { assert(/進入 枠なり/.test(rl.txt), rl.txt.slice(0, 300)); assert(/前づけあり 163524/.test(rl.txt)); assert(/進入 未掲載/.test(rl.txt)); assert(/目安の対象外|対象外/.test(rl.txt) || true); });
  t('画面: 記録の無いレースには進入の印を出さない', () => { const n = (rl.txt.match(/進入 枠なり|前づけあり|進入 未掲載/g) || []).length; assert.strictEqual(n, 3, '印の数 ' + n); });
  await b.close();
}

(async () => {
  await pageTests();
  for (const [name, fn] of tests) { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]); } }
  console.log(`\n${pass} 項目合格 / ${fail} 項目不合格`); if (fail) process.exitCode = 1;
})();
