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

// 2026-11-27(丸亀7Rで、頭が複数の行の頭が抜けて買い目が減った事故の再発防止): サマリー文を買い目に展開し直して、元の買い目と完全に一致するか(通常・配分つきの両方、ランダム3000組)。金額は、配分つきでは各買い目の表示額が groupByAmount と一致するか。
const expandTok = (tok) => {
  const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map(r => [x].concat(r)));
  if (/box$/.test(tok)) return perms(tok.replace('box', '').split('')).map(x => x.join('-'));
  const parts = tok.split('-'), out = [], ds = x => x.split(''), ok = (a, b, c) => a !== b && b !== c && a !== c;
  const okp = (a, b, c) => a !== b && b !== c && a !== c;
  if (parts.length === 2 && parts[0].includes('=') && !parts[1].includes('=')) { const [A, B] = parts[0].split('=').map(ds); A.forEach(a => B.forEach(b => ds(parts[1]).forEach(c => { if (okp(a, b, c)) { out.push(a + '-' + b + '-' + c); out.push(b + '-' + a + '-' + c); } }))); return out; }
  if (parts.length === 2 && parts[1].includes('=') && !parts[0].includes('=')) { const [A, B] = parts[1].split('=').map(ds); ds(parts[0]).forEach(h => A.forEach(a => B.forEach(b => { if (okp(h, a, b)) { out.push(h + '-' + a + '-' + b); out.push(h + '-' + b + '-' + a); } }))); return out; }
  if (parts.length !== 3) throw new Error('形式不明 ' + tok);
  const eq = parts.map(x => x.includes('='));
  if (!eq[0] && !eq[1] && !eq[2]) { ds(parts[0]).forEach(a => ds(parts[1]).forEach(b => ds(parts[2]).forEach(c => { if (ok(a, b, c)) out.push(a + '-' + b + '-' + c); }))); return out; }
  if (eq[0]) { const [A, B] = parts[0].split('=').map(ds); A.forEach(a => B.forEach(b => ds(parts[2]).forEach(c => { if (ok(a, b, c)) { out.push(a + '-' + b + '-' + c); out.push(b + '-' + a + '-' + c); } }))); return out; }
  if (eq[1]) { const [A, B] = parts[1].split('=').map(ds); ds(parts[0]).forEach(h => A.forEach(a => B.forEach(b => { if (ok(h, a, b)) { out.push(h + '-' + a + '-' + b); out.push(h + '-' + b + '-' + a); } }))); return out; }
  throw new Error('形式不明 ' + tok);
};
const parseSummary = (s) => { const got = {}; (s.split('参考買い目')[1] || '').split('\n').filter(l => /^\d/.test(l.trim())).forEach(line => line.split(' / ').forEach(seg => { const m = seg.trim().match(/^(\S+?)(?: ([\d,]+)円)?$/); if (!m) throw new Error('読めない ' + seg); expandTok(m[1]).forEach(c => { if (c in got) throw new Error('重複 ' + c); got[c] = m[2] ? Number(m[2].replace(/,/g, '')) : null; }); })); return got; };
t('サマリー: 文を展開すると元の買い目と完全一致(通常・配分つき、ランダム3000組)', () => {
  let bad = 0;
  for (let k = 0; k < 3000; k++) {
    const n = 6 + Math.floor(rnd() * 7), pool = combosAll.slice().sort(() => rnd() - 0.5);
    let cs = pool.slice(0, n);
    if (k % 3 === 0) { const h = 1 + Math.floor(rnd() * 6); cs = combosAll.filter(c => c[0] == h).sort(() => rnd() - 0.5).slice(0, n).concat(pool.slice(0, 3)).filter((c, i, a) => a.indexOf(c) === i); }   // 頭の偏り・複数頭にまたがる形を多めに
    const o = cs.map(() => 10 + rnd() * 250), p = cs.map(() => 0.005 + rnd() * 0.07), am = F.allocGuaranteeEV(p, o, 5000, 2).amounts, base = { venue: 'テスト', race: 1, deadline: '10:00', axisLabel: '1号艇', hyoka: '1', tenkai: 'x', combos: cs, axis: 1 };
    const plain = parseSummary(F.qSummary('note', base)), withAmt = parseSummary(F.qSummary('note', Object.assign({ amts: am }, base))), want = cs.slice().sort().join(',');
    if (Object.keys(plain).sort().join(',') !== want || Object.keys(withAmt).sort().join(',') !== want) { bad++; if (bad <= 3) console.log('  不一致 元:' + want + '\n   通常:' + Object.keys(plain).sort() + '\n   配分:' + Object.keys(withAmt).sort()); continue; }
    const gs = F.groupByAmount(cs, am), amt = {}; gs.forEach(g => g.combos.forEach(c => { amt[c] = g.amt; }));
    cs.forEach(c => { if (withAmt[c] !== amt[c]) { bad++; } });
  }
  assert.equal(bad, 0, '不一致 ' + bad + '件');
});
t('サマリー: Xの型(x)は買い目なしのまま(配分の影響を受けない)', () => {
  const cs = combosAll.slice(0, 12), s = F.qSummary('x', { venue: '多摩川', race: 7, deadline: '15:00', axisLabel: '2号艇', hyoka: '', tenkai: 'テスト', combos: cs, axis: 2, amts: cs.map(() => 400) });
  assert.ok(!s.includes('円') && s.includes('プロフィール'));
});
t('切替ボタンが画面にある・構文', () => { assert.ok(html.includes('id="btnSumAlloc"') && html.includes('配分つきに切替') && html.includes('S.sumAlloc = !S.sumAlloc')); });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
