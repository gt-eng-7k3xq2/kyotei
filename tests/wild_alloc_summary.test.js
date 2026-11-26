'use strict';
// 2026-11-26: WILD画面の「配分つきサマリー」。(1)画面側の配分計算が wild_alloc_perf.js と同じ (2)近い金額のまとめ方 (3)サマリー文 (4)切替ボタン
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'garon_wild.html'), 'utf8');
const g = re => { const m = html.match(re); if (!m) throw new Error('抽出失敗 ' + re); return m[0]; };
const code = [g(/function distributeUnits[\s\S]*?\n\}\r?\n/), g(/function allocGuaranteeEV[\s\S]*?\n\}\r?\n/), g(/function groupByAmount[\s\S]*?\n\}\r?\n/), g(/function compressBets[\s\S]*?\n\}\r?\n/), g(/function qSummary[\s\S]*?\n\}\r?\n/)].join('\n');
const F = new Function(code + ';return {allocGuaranteeEV,groupByAmount,qSummary};')();
const L = require('../scripts/lib/wild_alloc_perf.js');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + e.message.split('\n')[0]); } };
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const combosAll = []; for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) if (a !== b && b !== c && a !== c) combosAll.push(a + '-' + b + '-' + c);
t('配分計算が lib と同じ(ランダム500件、不正値・低オッズ含む)', () => {
  for (let k = 0; k < 500; k++) {
    const n = 12, p = [], o = [];
    for (let i = 0; i < n; i++) { p.push(rnd() < 0.03 ? NaN : 0.002 + rnd() * 0.08); o.push(rnd() < 0.03 ? 0 : (k % 5 === 0 ? 1.2 + rnd() * 6 : 8 + rnd() * 300)); }
    const a = F.allocGuaranteeEV(p, o, 5000, 2), b = L.allocGuaranteeEV(p, o, 5000, 2);
    assert.deepEqual(a.amounts, b.amounts); assert.equal(a.mode, b.mode);
  }
});
t('配分の合計は5000円(不正値なしなら)・100円単位', () => {
  const p = Array.from({ length: 12 }, () => 0.01 + rnd() * 0.05), o = Array.from({ length: 12 }, () => 15 + rnd() * 200), r = F.allocGuaranteeEV(p, o, 5000, 2);
  assert.equal(r.amounts.reduce((x, y) => x + y, 0), 5000); assert.ok(r.amounts.every(v => v % 100 === 0 && v >= 100 - 100));
});
t('まとめ: 全買い目が1回ずつ入り、合計は元の5000円に近く、金額の多い順', () => {
  for (let k = 0; k < 200; k++) {
    const cs = combosAll.slice(k % 20, (k % 20) + 12), o = cs.map(() => 15 + rnd() * 250), p = cs.map(() => 0.005 + rnd() * 0.07);
    const am = F.allocGuaranteeEV(p, o, 5000, 2).amounts, gs = F.groupByAmount(cs, am);
    assert.deepEqual(gs.flatMap(x => x.combos).sort(), cs.slice().sort());
    const tot = gs.reduce((x, y) => x + y.amt * y.combos.length, 0); assert.ok(Math.abs(tot - 5000) <= 300, 'total ' + tot);
    gs.forEach(x => assert.ok(x.amt >= 100 && x.amt % 100 === 0));
    for (let i = 1; i < gs.length; i++) assert.ok(gs[i - 1].amt >= gs[i].amt);
  }
});
t('まとめ: 同額は必ず同じグループ', () => { const gs = F.groupByAmount(['1-2-3', '2-1-3', '3-1-2'], [400, 400, 400]); assert.equal(gs.length, 1); });
t('サマリー: 配分なしは従来と同じ(参考買い目・金額なし)', () => {
  const cs = combosAll.slice(0, 12), s = F.qSummary('note', { venue: '多摩川', race: 7, deadline: '15:00', axisLabel: '2号艇', hyoka: '2-1', tenkai: 'テスト', combos: cs, axis: 2 });
  assert.ok(s.includes('参考買い目') && !s.includes('（配分）') && !s.includes('円'));
});
t('サマリー: 配分つきは金額と合計が入り、全買い目が入っている', () => {
  const cs = combosAll.slice(0, 12), o = cs.map((_, i) => 20 + i * 15), p = cs.map((_, i) => 0.06 - i * 0.003), am = F.allocGuaranteeEV(p, o, 5000, 2).amounts;
  const s = F.qSummary('note', { venue: '多摩川', race: 7, deadline: '15:00', axisLabel: '2号艇', hyoka: '2-1', tenkai: 'テスト', combos: cs, axis: 2, amts: am });
  const plain = F.qSummary('note', { venue: '多摩川', race: 7, deadline: '15:00', axisLabel: '2号艇', hyoka: '2-1', tenkai: 'テスト', combos: cs, axis: 2 }), rowsOf = x => x.split('\n').filter(l => /^\d/.test(l)).length;
  assert.ok(s.includes('参考買い目') && !s.includes('（配分）') && !s.includes('合計') && /\d円/.test(s) && rowsOf(s) === rowsOf(plain)); console.log(s.split('\n').slice(-5).join('\n'));
  const body = s.split('参考買い目')[1]; cs.forEach(c => { const [a, b, d] = c.split('-'); assert.ok(body.includes(a)); });
});
t('サマリー: Xの型(x)は買い目なしのまま(配分の影響を受けない)', () => {
  const cs = combosAll.slice(0, 12), s = F.qSummary('x', { venue: '多摩川', race: 7, deadline: '15:00', axisLabel: '2号艇', hyoka: '', tenkai: 'テスト', combos: cs, axis: 2, amts: cs.map(() => 400) });
  assert.ok(!s.includes('円') && s.includes('プロフィール'));
});
t('切替ボタンが画面にある・構文', () => { assert.ok(html.includes('id="btnSumAlloc"') && html.includes('配分つきに切替') && html.includes('S.sumAlloc = !S.sumAlloc')); });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
