'use strict';
// 『対象外』のレースのおまかせ案の末尾2点を1号艇頭にする変更(2026-11-11、CEO承認)の試験。画面(garon_wild.html)から関数を取り出して、保存済みカードで確かめる。
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + String(e.message).split('\n')[0]); } };
function screen(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8'); const g = (re, opt) => { const m = html.match(re); if (!m) { if (opt) return ''; throw new Error('抽出失敗 ' + re); } return m[0]; };
  const code = [g(/const PLAN_POINTS[^\n]*\n/), g(/const X_ODDS_MIN[^\n]*\n/), g(/const M_UPSET_MIN[^\n]*\n/), g(/const PLAN_MIN_POINTS[\s\S]*?function variableK[\s\S]*?return n;\s*\}/), g(/function planKey[^\n]*\n/), g(/function hasExcluded[^\n]*\n/), g(/const esc = [^\n]*\n/), g(/function mOfCard[\s\S]*?\n\}\r?\n/), g(/function mCorrOn[^\n]*\n/), g(/function mBCard[^\n]*\n/, true), g(/function mBLines[^\n]*\n/, true), g(/function mBOn[^\n]*\n/, true), g(/function mDetOn[^\n]*\n/), g(/const PLAN_HEAD1_NONTARGET[^\n]*\n/, true) || 'const PLAN_HEAD1_NONTARGET = 0;', g(/function isNonTarget[^\n]*\n/, true) || 'function isNonTarget(){return false;}', g(/function autoPlan[\s\S]*?\n\}\r?\n/)].join('\n');
  return new Function(code + ';let S=null;return {autoPlan,mOfCard,isNonTarget,setS:v=>{S=v;}};')();
}
const NS = screen(path.join(ROOT, 'garon_wild.html')), OS = screen(path.join(ROOT, 'backups', 'm_head1_20261111', 'garon_wild.html'));
const dir = path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-10'); const cards = [];
for (const f of fs.readdirSync(dir)) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (j.card && j.card.combos && j.card.aiPick) cards.push(j.card); } catch (e) { /* skip */ } }
const all = (p) => p.blocks.flatMap(b => b.combos);
let nt = 0, other = 0;
t('カードがある', () => assert(cards.length > 50));
t('対象外: 12点・末尾2点が1号艇頭(10倍以上・エンジン確率の高い順)・先頭10点は従来と同じ・重複なし', () => {
  NS.setS({}); OS.setS({});
  for (const c of cards) { if (!NS.isNonTarget(c)) continue; const a = all(NS.autoPlan(c, null, [], undefined)), b = all(OS.autoPlan(c, null, [], undefined)); const info = c.combos;
    const c1 = Object.keys(info).filter(x => x[0] === '1' && info[x].odds >= 10 && info[x].enginePct != null).sort((x, y) => info[y].enginePct - info[x].enginePct);
    if (c1.length < 2) continue; nt++;
    assert.strictEqual(a.length, 12); assert.strictEqual(new Set(a).size, 12);
    assert.deepStrictEqual(a.filter(x => x[0] === "1").sort(), c1.slice(0, 2).sort(), JSON.stringify({a, c1: c1.slice(0, 3)}));
    const aNon = a.filter(x => x[0] !== '1'); assert.strictEqual(aNon.length, 10); assert(aNon.every(x => b.includes(x)), '先頭10点が従来の12点に含まれない'); }
  assert(nt > 50, '対象外 ' + nt);
});
t('S/A/B・M・Xのカードは従来と同じ買い目', () => {
  NS.setS({}); OS.setS({});
  let mFb = 0, mTwo = 0; for (const c of cards) { if (NS.mOfCard(c) && !NS.isNonTarget(c) && !(c.entry && (c.entry.rank || c.entry.x))) { mFb++; other++; const pl = NS.autoPlan(c, null, [], undefined), aa = all(pl); const n1 = aa.filter(x => x.startsWith('1-')).length; assert.strictEqual(n1, (pl.head1Added || []).length, 'Mで補正できなかったカードの1号艇頭は追加した点だけ'); assert(n1 <= 2); if (n1 === 2) mTwo++; assert(aa.length <= 12); continue; }   // 2026-11-12: Mで直前情報が取れず補正できなかったカードにも、1号艇頭2点を入れる
    if (NS.isNonTarget(c)) continue; other++; assert.deepStrictEqual(all(NS.autoPlan(c, null, [], undefined)), all(OS.autoPlan(c, null, [], undefined))); }
  assert(other > 5, '対象外以外 ' + other); assert(mFb > 0, 'Mのカードが見つからない');
});
t('狙う艇を指定・点数指定・安定枠/X表示のときは、従来と同じ', () => {
  for (const c of cards.filter(x => NS.isNonTarget(x)).slice(0, 40)) {
    NS.setS({}); OS.setS({});
    assert.deepStrictEqual(all(NS.autoPlan(c, 3, [], undefined)), all(OS.autoPlan(c, 3, [], undefined)));
    assert.deepStrictEqual(all(NS.autoPlan(c, null, [], 8)), all(OS.autoPlan(c, null, [], 8)));
    NS.setS({ smode: true }); OS.setS({ smode: true }); assert.deepStrictEqual(all(NS.autoPlan(c, null, [], undefined)), all(OS.autoPlan(c, null, [], undefined)));
  }
});
t('消した艇(1号艇を外す)の指定では、1号艇頭を入れず従来と同じ', () => {
  NS.setS({}); OS.setS({});
  for (const c of cards.filter(x => NS.isNonTarget(x)).slice(0, 40)) { const a = all(NS.autoPlan(c, null, [1], undefined)); assert(a.every(x => !x.includes('1')), '1号艇を含む'); assert.deepStrictEqual(a, all(OS.autoPlan(c, null, [1], undefined))); }
});
t('Mで補正できなかったカード(宮島4R 2026-11-12)は末尾2点が1号艇頭', () => {
  const f = path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-12', '宮島_4R.json'); if (!fs.existsSync(f)) return;
  const c = JSON.parse(fs.readFileSync(f, 'utf8')).card; NS.setS({}); const pl = NS.autoPlan(c, null, [], undefined);
  assert.strictEqual((pl.head1Added || []).length, 2); assert.strictEqual(all(pl).filter(x => x.startsWith('1-')).length, 2); assert.strictEqual(all(pl).length, 12);
});
console.log(`\n合格 ${pass} / 失敗 ${fail}(対象外 ${nt}、それ以外 ${other})`); process.exit(fail ? 1 : 0);
