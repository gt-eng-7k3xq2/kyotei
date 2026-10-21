'use strict';
// 2026-10-21 切り替え(CEO判断): 公式基準の仮想成績は、10/21以降のカードを『全点100円』、それ以前を従来の『1レース約3,000円の平買い』で数える。
const assert = require('assert');
const T = require('../scripts/lib/wild_tier_perf');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('PASS ' + name); pass++; } catch (e) { console.log('FAIL ' + name + ': ' + e.message); fail++; } };
const lines = n => Array.from({ length: n }, (_, i) => ({ combo: '2-3-' + (i % 4 + 4) + '-' + i }));
const card = (date, n) => ({ raceDate: date, aiPick: { lines: lines(n) } });
t('境界: 20261021 以降は全点100円', () => { const b = T.aiBets(card('20261021', 12)); assert.strictEqual(b.length, 12); assert.ok(b.every(x => x.a === 100)); assert.strictEqual(b.reduce((s, x) => s + x.a, 0), 1200); });
t('2026-10-21 の形式(ハイフン)でも同じ', () => assert.ok(T.isUnit100('2026-10-21') && !T.isUnit100('2026-10-20')));
t('10/20までは従来(12点で合計3,000円)', () => { const b = T.aiBets(card('20261020', 12)); assert.strictEqual(b.reduce((s, x) => s + x.a, 0), 3000); });
t('12点未満のカードは対象外(従来どおり null)', () => assert.strictEqual(T.aiBets(card('20261021', 8)), null));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
