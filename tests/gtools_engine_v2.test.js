'use strict';
// gtools.html の GARON-DB 対応(ログ行バッジ・エンジン成績カード)の検査。実行: node tests/gtools_engine_v2.test.js
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'gtools.html'), 'utf8').replace(/\r\n/g, '\n');
let p = 0, f = 0; const t = (n, fn) => { try { fn(); p++; console.log('PASS  ' + n); } catch (e) { f++; console.log('FAIL  ' + n + ': ' + e.message); } };
function fn(name) { const i = html.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let d = 0; for (let k = html.indexOf('{', i); k < html.length; k++) { if (html[k] === '{') d++; else if (html[k] === '}' && --d === 0) return html.slice(i, k + 1); } throw new Error('unbalanced'); }
const els = { 'engine-stats-card': { style: {} }, 'engine-stats': { innerHTML: '' } };
const sb = { document: { getElementById: i => els[i] } }; vm.createContext(sb);
vm.runInContext(fn('engineBadge') + fn('renderEngineStats') + ';this.b=engineBadge;this.r=renderEngineStats;', sb);
const L = (o) => ({ engineMode: 'GDB', enginePoints: ['1-2-3', '1-3-2'], engineCumHit: 0.4, engineConfidence: '高', engineAmounts: { '1-2-3': 1500, '1-3-2': 1500 }, miss: [], ...o });
t('GDB以外の記録にはバッジが出ない', () => assert.equal(sb.b({ engineMode: 'R07' }), ''));
t('GDBの記録には確信度と見込みのバッジが出る', () => { const b = sb.b(L({})); assert.ok(b.includes('GARON-DB 高') && b.includes('見込み40%')); });
t('GDBの記録が無いときはカードを隠す', () => { sb.r([{ engineMode: 'R07' }]); assert.equal(els['engine-stats-card'].style.display, 'none'); });
t('的中率・見込み・回収率を計算する(1的中 配当2000円/100円 x 1500円 = 30000円、投資は3000円x2)', () => {
  sb.r([L({ result: '1-2-3', payout: '¥2000' }), L({ result: '3-2-1' })]);
  const h = els['engine-stats'].innerHTML; assert.equal(els['engine-stats-card'].style.display, '');
  assert.ok(h.includes('50%'), '的中率50%'); assert.ok(h.includes('40%'), '見込み40%'); assert.ok(h.includes('500%'), '回収 30000/6000=500%');
});
t('結果未入力のレースは集計に入らない', () => { sb.r([L({ result: '' })]); assert.equal(els['engine-stats-card'].style.display,''); });
console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
