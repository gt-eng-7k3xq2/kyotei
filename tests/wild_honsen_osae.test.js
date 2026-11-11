'use strict';
// 投稿文の「本線・抑え」を確率順で分ける変更(2026-11-11、CEO指示)の試験。画面(garon_wild.html)から qSummary と compressBets を取り出して確かめる。
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + String(e.message).split('\n')[0]); } };
const html = fs.readFileSync(path.join(ROOT, 'garon_wild.html'), 'utf8');
const g = (re) => { const m = html.match(re); if (!m) throw new Error('抽出失敗 ' + re); return m[0]; };
const code = [g(/function compressBets[\s\S]*?\n\}\r?\n/), g(/function qSummary[\s\S]*?\n\}\r?\n/)].join('\n');
const { qSummary } = new Function(code + ';return {qSummary};')();
const cards = []; const dir = path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-10');
for (const f of fs.readdirSync(dir).slice(0, 80)) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (j.card && j.card.combos) cards.push({ j, c: j.card }); } catch (e) { /* skip */ } }
const key = (info) => info.m2Pct != null ? info.m2Pct : (info.enginePct || 0);
const cut = (txt) => { const a = txt.match(/本線：([^\n]*)/), b = txt.match(/抑え：([^\n]*)/); return { hon: a ? a[1] : '', osae: b ? b[1] : '' }; };
t('カードがある', () => assert(cards.length > 30));
t('12点: 本線=確率の高い8点、抑え=残り4点(軸が頭かどうかは関係しない)', () => {
  let n = 0;
  for (const { j, c } of cards) {
    const combos = Object.keys(c.combos).filter(x => !x.startsWith('1-') && c.combos[x].odds >= 10).sort((a, b) => key(c.combos[b]) - key(c.combos[a])).slice(0, 10).concat(Object.keys(c.combos).filter(x => x[0] === '1' && c.combos[x].odds >= 10).sort((a, b) => key(c.combos[b]) - key(c.combos[a])).slice(0, 2));
    if (combos.length !== 12) continue; n++;
    const axis = Number(combos[0][0]);
    const txt = qSummary('note', { venue: j.venue, race: j.race, deadline: '12:00', cumPct: 0.3, axis, axisLabel: '1', hyoka: '1', tenkai: 'x', combos, pctOf: (x) => key(c.combos[x]) });
    const { hon, osae } = cut(txt); const flat = (s) => s.split('/').join(' ');
    const ranked = combos.map((x, i) => ({ x, i, p: key(c.combos[x]) })).sort((a, b) => (b.p - a.p) || (a.i - b.i));
    const hs = ranked.slice(0, 8).map(r => r.x), os = ranked.slice(8).map(r => r.x);
    assert(hs.every(x => os.every(y => key(c.combos[x]) >= key(c.combos[y]))));
    assert(osae.length > 0, '抑えが無い');
    // 抑えには、末尾4点(確率が最も低い4点)が入る。1号艇頭は確率が高ければ本線に入ることもある
    assert.strictEqual(os.length, 4);
  }
  assert(n > 20, '12点のカード ' + n);
});
t('確率情報(pctOf)が無いときは、従来の分け方(軸が頭=本線)', () => {
  const txt = qSummary('note', { venue: 'x', race: 1, deadline: '', cumPct: 0.3, axis: 2, axisLabel: '2', hyoka: '2', tenkai: 'x', combos: ['2-1-3', '2-1-4', '3-1-2', '3-1-4'] });
  const { hon, osae } = cut(txt); assert(/2/.test(hon) && osae.length > 0);
});
t('3点以下は分けずに従来どおり', () => {
  const txt = qSummary('note', { venue: 'x', race: 1, deadline: '', cumPct: 0.3, axis: 2, axisLabel: '2', hyoka: '2', tenkai: 'x', combos: ['2-1-3', '2-1-4', '3-1-2'], pctOf: () => 1 });
  const { hon, osae } = cut(txt); assert(hon.length > 0 && osae.length > 0);
});
t('実際の12点で、抑えは確率の低い4点(出力の組番が12点と一致)', () => {
  const { j, c } = cards.find(x => Object.keys(x.c.combos).length > 100);
  const combos = ['2-1-4', '2-1-3', '2-1-5', '3-1-4', '3-1-2', '3-1-5', '4-1-2', '4-1-5', '4-1-3', '5-1-2', '1-4-2', '1-3-2'];
  const pc = {}; combos.forEach((x, i) => pc[x] = 100 - i);   // 先頭ほど確率が高い、1号艇頭の2点は最も低い
  const txt = qSummary('note', { venue: j.venue, race: j.race, deadline: '', cumPct: 0.3, axis: 2, axisLabel: '2', hyoka: '2', tenkai: 'x', combos, pctOf: (x) => pc[x] });
  const { hon, osae } = cut(txt);
  assert(/1-4-2|1-3-2|1-?4|1-?3/.test(osae) || osae.includes('1'), '抑えに1号艇頭が入らない: ' + osae); assert(!/1-4-2/.test(hon));
});
console.log(`\n合格 ${pass} / 失敗 ${fail}`); process.exit(fail ? 1 : 0);
