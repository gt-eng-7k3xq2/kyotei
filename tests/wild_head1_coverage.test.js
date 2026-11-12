'use strict';
// 1号艇頭の2点の抜け検査(2026-11-12 新設。宮島4R「逃げがない」の再発防止)。
// 2026-11-12以降の全カードについて、S/A/B・X以外(対象外とM)の画面の買い目に、1号艇頭が必ず2点入っていること。
// Mは、補正後の12点(B方式)でも、補正できなかった従来の12点でも同じ。実カードを全件検査するので、新しい経路を足したときの抜けも検出できる。
globalThis.S = {};
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'comment_lab_20261008', 'lib', 'wild_logic'));
const W = require(path.join(ROOT, 'scripts', 'lib', 'wild_live.js'));
const FROM = process.env.HEAD1_COVERAGE_FROM || '2026-11-12';
const base = path.join(ROOT, 'logs', 'wild', 'cards');
let n = 0, bad = [];
for (const d of fs.readdirSync(base).filter(x => x >= FROM).sort()) {
  for (const f of fs.readdirSync(path.join(base, d)).filter(x => /_\d+R\.json$/.test(x))) {
    const j = JSON.parse(fs.readFileSync(path.join(base, d, f), 'utf8')), c = j.card;
    if (!j.ok || !c || !c.combos || !c.aiPick) continue;
    const e = c.entry || {}; if (e.rank || e.x) continue;
    const cand = Object.keys(c.combos).filter(k => k[0] === '1' && c.combos[k].odds >= 10 && c.combos[k].enginePct != null).length;
    if (cand < 2) continue;
    n++;
    const all = L.mergeBlocks(L.autoPlan(c).blocks), n1 = all.filter(k => k.startsWith('1-')).length;
    if (n1 !== 2 || all.length !== 12) bad.push(d + ' ' + f + ' 1号艇頭' + n1 + '点/計' + all.length + '点' + (W.mInfo(c) ? '(M)' : '(対象外)'));
  }
}
try { assert(n > 0, '検査対象のカードが無い'); assert.strictEqual(bad.length, 0, '1号艇頭が2点でないカード: ' + bad.slice(0, 8).join(' | ')); console.log('PASS  対象外・Mの全カードで1号艇頭が2点(' + n + '件)'); console.log('\n合格 1 / 失敗 0'); }
catch (err) { console.log('FAIL  ' + err.message); console.log('\n合格 0 / 失敗 1'); process.exit(1); }
