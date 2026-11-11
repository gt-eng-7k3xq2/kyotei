'use strict';
// 公式の直前情報ページから、プロペラ欄と展示STを読む(2026-11-11)。通知・判定の動作は変えない。
const fs = require('fs'), path = require('path'), assert = require('assert');
const o = require('../scripts/lib/official_entry');
let ok = 0, ng = 0; const t = (name, f) => { try { f(); ok++; console.log('PASS ' + name); } catch (e) { ng++; console.log('FAIL ' + name + ' : ' + e.message); } };
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'beforeinfo_sample_20261110_12_1.html'), 'utf8');
t('進入順とSTが従来どおり読める', () => { const p = o.parseBeforeInfo(html); assert.deepStrictEqual(p.order, [1, 2, 3, 4, 5, 6]); assert.strictEqual(p.st[1], 0.2); assert.strictEqual(p.st[6], 0.01); });
t('プロペラ欄は6艇分(交換なしは空欄)', () => { const pr = o.parsePropeller(html); assert.deepStrictEqual(Object.keys(pr).sort(), ['1', '2', '3', '4', '5', '6']); assert.ok(Object.values(pr).every((v) => v === '')); });
t('プロペラ欄に「新」等が入れば、その艇だけ読める', () => {
  const h2 = html.replace(/(<td class="is-boatColor3[^>]*rowspan="4">3<\/td>[\s\S]*?<td rowspan="4">-?\d+\.\d+<\/td>\s*<td rowspan="4">)&nbsp;(<\/td>)/, '$1新$2');
  assert.notStrictEqual(h2, html); const pr = o.parsePropeller(h2); assert.strictEqual(pr[3], '新'); assert.strictEqual(pr[1], '');
});
t('形が違うページでは、空のオブジェクト(進入の確認は続く)', () => { assert.deepStrictEqual(o.parsePropeller('<html></html>'), {}); assert.deepStrictEqual(o.parsePropeller(null), {}); });
t('既存の公開関数が残っている', () => { for (const k of ['parseBeforeInfo', 'judgeEntry', 'fetchExhibitionEntry']) assert.strictEqual(typeof o[k], 'function'); });
console.log(`\n${ok} 項目合格 / ${ng} 項目不合格`); process.exit(ng ? 1 : 0);
