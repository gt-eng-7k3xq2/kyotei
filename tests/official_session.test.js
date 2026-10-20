'use strict';
// 公式の出走表ページの今節成績の読み取り(scripts/lib/official_session.js)。固定のHTML(津10R 2026-10-20)で検算する。
const fs = require('fs'), path = require('path'), assert = require('assert');
const { parseSessionResults, fetchSessionResults, _cache } = require('../scripts/lib/official_session');
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'racelist_tsu_10R_20261020.html'), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ' + name); pass++; } catch (e) { console.log('FAIL ' + name + ': ' + e.message); fail++; } };
const b = parseSessionResults(html);
t('6艇を読む', () => { assert.ok(b); assert.deepStrictEqual(b.map(x => x.lane), [1, 2, 3, 4, 5, 6]); });
t('1号艇の着順(公式の表示と同じ)', () => assert.strictEqual(b[0].results.map(r => r.chaku).join(' '), '3 5 1 2 2 1 4 5 3 3'));
t('6号艇に事故(沈)が含まれる', () => assert.strictEqual(b[5].results.map(r => r.chaku).join(' '), '2 1 1 5 沈 4 2 6 6 1'));
t('各艇10走(出走表の今節出走数と一致)', () => b.forEach(x => assert.strictEqual(x.results.length, 10)));
t('進入コース・STを読む', () => assert.deepStrictEqual(b[0].results[0], { day: 1, race: 6, course: 6, st: '.17', chaku: '3' }));
t('形式が違えば null', () => { assert.strictEqual(parseSessionResults('<html></html>'), null); assert.strictEqual(parseSessionResults(''), null); });
t('通信は成功をキャッシュする', async () => {});
(async () => {
  _cache.clear(); let n = 0;
  const fx = async () => { n++; return { ok: true, text: async () => html }; };
  const r1 = await fetchSessionResults({ date: '20261020', jcd: '10', rno: 10, fetchImpl: fx }), r2 = await fetchSessionResults({ date: '20261020', jcd: '10', rno: 10, fetchImpl: fx });
  t('取得成功・2回目はキャッシュ(1回しか通信しない)', () => { assert.ok(r1.ok && r2.ok); assert.strictEqual(n, 1); });
  const bad = await fetchSessionResults({ date: '20261020', jcd: '11', rno: 1, fetchImpl: async () => ({ ok: false, status: 503 }) });
  t('HTTPエラーは ok:false(例外にしない)', () => assert.strictEqual(bad.ok, false));
  const arg = await fetchSessionResults({ date: 'x', jcd: '10', rno: 1 });
  t('不正な引数は ok:false', () => assert.strictEqual(arg.ok, false));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
