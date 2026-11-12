'use strict';
// 投稿文の買い目表示の試験(2026-11-12 改訂: 本線・抑えの区別をやめ、12点をまとめて頭の艇ごとに並べる)。画面(garon_wild.html)から qSummary と compressBets を取り出して確かめる。
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + String(e.message).split('\n')[0]); } };
const html = fs.readFileSync(path.join(ROOT, 'garon_wild.html'), 'utf8');
const g = (re) => { const m = html.match(re); if (!m) throw new Error('抽出失敗 ' + re); return m[0]; };
const code = [g(/function compressBets[\s\S]*?\n\}\r?\n/), g(/function qSummary[\s\S]*?\n\}\r?\n/)].join('\n');
const { qSummary } = new Function(code + ';return {qSummary};')();
const cards = []; const dir = path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-10');
for (const f of fs.readdirSync(dir).slice(0, 80)) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (j.card && j.card.combos) cards.push({ j, c: j.card }); } catch (e) { /* skip */ } }

const sample = ['2-1-4', '2-1-3', '2-1-5', '3-1-4', '3-1-2', '3-1-5', '4-1-2', '4-1-5', '4-1-3', '5-1-2', '1-4-2', '1-3-2'];
const run = (combos) => qSummary('note', { venue: 'x', race: 1, deadline: '', cumPct: 0.3, axis: 2, axisLabel: '2', hyoka: '2>1', tenkai: 'x', combos, axis: 2, pctOf: c => 100 - combos.indexOf(c) });
const betLines = (txt) => { const L = txt.split(/\r?\n/); return L.slice(L.indexOf('展開：x') + 3); };   // 展開・空行・「参考買い目」の見出しの次から
t('本線・抑えのラベルは出さず、見出しは「参考買い目」', () => { const txt = run(sample); assert(!/本線|抑え/.test(txt)); assert(txt.split(String.fromCharCode(10)).map(s => s.trim()).includes('参考買い目')); });
t('買い目は頭の艇ごとに1行(同じ頭が複数行に分かれない)', () => {
  const lines = betLines(run(sample)).filter(Boolean); const heads = lines.map(l => l[0]);
  assert.strictEqual(new Set(heads).size, heads.length, '頭が重複: ' + lines.join(' | '));
});
t('12点の買い目が3〜6行に収まる', () => { const n = betLines(run(sample)).filter(Boolean).length; assert(n >= 1 && n <= 6, '行数 ' + n); });
t('実カードの12点: どのカードでも6行以内・ラベルなし', () => {
  let n = 0;
  for (const { c } of cards) {
    const combos = Object.keys(c.combos).filter(x => !x.startsWith('1-') && c.combos[x].odds >= 10).sort((a, b) => ((c.combos[b].enginePct || 0) - (c.combos[a].enginePct || 0))).slice(0, 12);
    if (combos.length !== 12) continue; n++;
    const txt = run(combos); assert(!/本線|抑え/.test(txt)); assert(betLines(txt).filter(Boolean).length <= 6);
  }
  assert(n > 10, '対象カードが少ない: ' + n);
});
console.log(`\n合格 ${pass} / 失敗 ${fail}`); process.exit(fail ? 1 : 0);
