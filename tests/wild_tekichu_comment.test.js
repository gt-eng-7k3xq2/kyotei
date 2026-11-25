'use strict';
// 的中コメント(結果の事実版)の試験。node tests/wild_tekichu_comment.test.js
const assert = require('assert');
const fs = require('fs'), path = require('path');
const G = require('../scripts/wild/tekichu_comment');
const F = require('../scripts/lib/official_race_facts');
let n = 0; const t = (name, f) => { f(); n++; console.log('ok', name); };
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tekichu_facts_fixture.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

// 公式の結果ページを模した最小のHTML(宮島4R 2026-11-25 の実物から必要な部分だけ)
const SAMPLE_HTML = `<table><thead><tr class="is-fs14"><th>スタート情報</th></tr></thead><tbody>
${[[1, '.34', ''], [2, '.31', 'まくり'], [3, '.25', ''], [4, '.15', ''], [6, '.12', ''], [5, '.17', '']].map(([b, st, m]) => `<tr><td><div class="table1_boatImage1 is-type1__3rdadd"><span class="table1_boatImage1Number is-type${b}">${b}</span><span class="table1_boatImage1Time"><span class="table1_boatImage1TimeInner ">${st} &nbsp; ${m}</span></span></div></td></tr>`).join('')}
</tbody></table><table><thead><tr><th>決まり手</th></tr></thead><tbody><tr><td class="is-fs16">まくり</td></tr></tbody></table>
<table><thead><tr><th>着</th><th>枠</th><th>ボートレーサー</th><th>レースタイム</th></tr></thead>
${[['１', 2, '4852', '川原　　祐明', '1\'49"6'], ['２', 1, '3000', '安田　　吉宏', '1\'52"3'], ['３', 6, '3001', '長岡　　良也', '1\'53"4'], ['４', 5, '3002', '近藤　雄一郎', '1\'53"5'], ['５', 3, '3003', '佐竹　　恒彦', '1\'54"4'], ['Ｆ', 4, '3004', '土屋　実沙希', '']].map(([p, b, no, nm, tm]) => `<tbody><tr><td class="is-fs14">${p}</td><td class="is-fs14 is-fBold is-boatColor${b}">${b}</td><td class="is-p10-0"><span class="is-fs12">${no}</span>　<span class="is-fs18 is-fBold is-lh24__3rdadd">${nm}</span></td><td>${tm}</td></tr></tbody>`).join('')}</table>`;

t('公式ページの解析: 決まり手・コース別のスタート・着順と名前(失格などは数字にしない)', () => {
  const f = F.parse(SAMPLE_HTML);
  assert.strictEqual(f.kimarite, 'まくり');
  assert.deepStrictEqual(f.start.map(s => [s.course, s.boat, s.st]), [[1, 1, 0.34], [2, 2, 0.31], [3, 3, 0.25], [4, 4, 0.15], [5, 6, 0.12], [6, 5, 0.17]]);
  assert.strictEqual(f.start[1].mark, 'まくり');
  assert.deepStrictEqual(f.order.slice(0, 3).map(o => [o.pos, o.boat, o.name]), [[1, 2, '川原 祐明'], [2, 1, '安田 吉宏'], [3, 6, '長岡 良也']]);
  assert.strictEqual(f.order[5].boat, 4); assert.notStrictEqual(typeof f.order[5].pos, 'number');   // Ｆ(失格・フライング)は数字の着順にしない
  assert.deepStrictEqual(F.parse('<html>結果なし</html>'), { kimarite: null, start: [], order: [], weather: null });   // 取れないときは空(推測しない)
});
t('書き手: 実在の1レース(宮島4R)で、決まり手・1号艇のスタートが事実どおりに出る', () => {
  const facts = F.parse(SAMPLE_HTML); facts.order = facts.order.map(o => typeof o.pos === 'number' ? o : Object.assign({}, o, { pos: 6 }));   // 事故の欄(Ｆ)は、書き手の試験では普通の6着にする
  const entry = { venue: '宮島', racenum: 4, raceDate: '2026-11-25', chakuju: '2-1-6', payout: 960, boatNames: ['安田 吉宏', '川原 祐明', '佐竹 恒彦', '土屋 実沙希', '近藤 雄一郎', '長岡 良也'], axis: 2, facts };
  const r = G.build(entry); assert.ok(r); assert.ok(/❷川原/.test(r.text), r.text); assert.ok(/まくり|まくって/.test(r.text), r.text);
  assert.ok(/❶安田はスタート\.34と遅れて2着/.test(r.text), r.text);   // 1号艇は.34(遅れ)で2着
  assert.ok(G.verifyClaims(entry, r.claims).ok);
  const post = G.buildPost(entry); assert.ok(post.text.startsWith('【宮島4R】\n\n')); assert.ok(post.text.endsWith('2-1-6 / 9.6倍\n\n的中🎯'));
});
t('書き手: 事実が足りない・記録した結果と公式の着順が食い違うときは null(これまでの言い回しに戻す)', () => {
  const base = clone(fixture[0].entry);
  assert.ok(G.build(base));
  assert.strictEqual(G.build(Object.assign(clone(base), { facts: null })), null);
  assert.strictEqual(G.build(Object.assign(clone(base), { facts: { kimarite: '差し', start: [], order: [] } })), null);
  const mis = clone(base); const p = mis.chakuju.split('-'); mis.chakuju = [p[0], p[2], p[1]].join('-'); assert.strictEqual(G.build(mis), null);   // 2着と3着が入れ替わっていれば使わない
  assert.strictEqual(G.build(Object.assign(clone(base), { boatNames: [] })), null);
  assert.strictEqual(G.build(Object.assign(clone(base), { chakuju: '9-9-9' })), null);
});
t('実データ60件: 全件で生成でき、主張は事実から検算して全て正しい', () => {
  let bad = 0, nul = 0;
  fixture.forEach((x, i) => { const e = Object.assign(clone(x.entry), { seq: i }), r = G.build(e); if (!r) { nul++; return; } if (!G.verifyClaims(e, r.claims).ok) bad++; });
  assert.strictEqual(bad, 0); assert.ok(nul <= 2, '生成不能 ' + nul);
});
t('実データ60件: 検算は、わざと事実を書き換えた主張を見つける(検算器が働いている)', () => {
  let caught = 0, tried = 0;
  fixture.forEach((x, i) => {
    const e = Object.assign(clone(x.entry), { seq: i }), r = G.build(e); if (!r) return;
    const w = r.claims.find(c => c.t === 'winner'); if (w) { tried++; if (!G.verifyClaims(e, [{ t: 'winner', boat: w.boat === 6 ? 5 : w.boat + 1 }]).ok) caught++; }
    const k = r.claims.find(c => c.t === 'kimarite'); if (k) { tried++; if (!G.verifyClaims(e, [{ t: 'kimarite', v: k.v === '差し' ? 'まくり' : '差し' }]).ok) caught++; }
    const s = r.claims.find(c => c.t === 'st'); if (s) { tried++; if (!G.verifyClaims(e, [{ t: 'st', boat: s.boat, v: s.v + 0.01 }]).ok) caught++; }
  });
  assert.ok(tried > 60); assert.strictEqual(caught, tried);
});
t('実データ60件: 文の形(短い・括弧なし・禁止の言い方なし・「の1着」で終わらない・重複なし)', () => {
  const FORBID = /読み通り|狙い通り|予想通り|想定通り|拾えて何より|おいしい|[()（）「」『』]|1着$/;
  const texts = [];
  fixture.forEach((x, i) => { const r = G.build(Object.assign(clone(x.entry), { seq: i })); if (!r) return; texts.push(r.text);
    assert.ok(r.text.length >= 6 && r.text.length <= 45, r.text); assert.ok(!FORBID.test(r.text), r.text); assert.ok(!/。。|、、|\s/.test(r.text), r.text);
    const names = r.text.match(/[❶-❻][^はがのにをと。]+/g) || []; });
  const uniq = new Set(texts).size; assert.ok(uniq / texts.length >= 0.95, `重複 ${uniq}/${texts.length}`);
});
t('決定的: 同じ入力は同じ文。seqが違えば言い回しが変わりうる(直前の的中と同じ型を避ける)', () => {
  const e = clone(fixture[5].entry), a = G.build(e).text, b = G.build(clone(e)).text; assert.strictEqual(a, b);
  const variants = new Set(); for (let s = 0; s < 12; s++) variants.add(G.build(Object.assign(clone(e), { seq: s })).text); assert.ok(variants.size >= 2, '言い回しが変わらない');
});
t('万舟(払戻1万円以上)だけ「万舟。」が付く・それ以外は付かない', () => {
  const e = clone(fixture[2].entry); e.payout = 12000; assert.ok(G.build(e).text.startsWith('万舟。')); e.payout = 9990; assert.ok(!G.build(e).text.includes('万舟'));
});
t('軸には触れない(CEO指示): entry.axis があっても、「軸」の語は一切出ない・軸の有無で文が変わらない', () => {
  fixture.forEach((x, i) => { const e = Object.assign(clone(x.entry), { seq: i }), a = G.build(e); if (!a) return;
    assert.ok(!/軸/.test(a.text), a.text);
    const b = G.build(Object.assign(clone(e), { axis: null })), c = G.build(Object.assign(clone(e), { axis: 6 })); assert.strictEqual(a.text, b.text); assert.strictEqual(a.text, c.text);
    assert.ok(!a.claims.some(k => /axis/.test(k.t))); });
});
t('事故・失格: 既定では転覆などの事故は書かない・フライングなどは書く・incidentMode=all で事故も書く・検算できる', () => {
  const mk = (pos4) => { const e = clone(fixture[0].entry); const f = e.facts; const w = Number(e.chakuju.split('-')[0]); const other = [1, 2, 3, 4, 5, 6].find(b => b !== w && !e.chakuju.split('-').map(Number).includes(b)); f.order = f.order.map(o => o.boat === other ? Object.assign({}, o, { pos: pos4 }) : o); e.__other = other; return e; };
  const acc = mk('転'); assert.ok(!/転覆/.test(G.build(acc).text)); const all = Object.assign(clone(acc), { incidentMode: 'all' }); const ra = G.build(all); assert.ok(/は転覆/.test(ra.text), ra.text); assert.ok(G.verifyClaims(all, ra.claims).ok);
  const fl = mk('Ｆ'); const rf = G.build(fl); assert.ok(/はフライング/.test(rf.text), rf.text); assert.ok(G.verifyClaims(fl, rf.claims).ok);
  const bad = clone(fl); bad.facts.order = bad.facts.order.map(o => o.pos === 'Ｆ' ? Object.assign({}, o, { pos: 6 }) : o); assert.ok(!G.verifyClaims(bad, rf.claims).ok);   // 事実が違えば検算が落とす
});
t('分離: この書き手は、通知・判定・買い目のコードから読み込まれていない', () => {
  for (const f of ['lib/wild_live.js', 'wild_card.js', 'wild_scan.js', 'lib/m_correct_apply.js', 'lib/m2_apply.js']) { const p = path.join(__dirname, '..', 'scripts', f); if (fs.existsSync(p)) assert.ok(!/tekichu_comment/.test(fs.readFileSync(p, 'utf8')), f); }
});
const S = require('../scripts/lib/race_facts_store');
(async () => {
  const mk = (venue, raceNo, combos, extra) => Object.assign({ mode: 'live', action: 'bet', raceDate: '2026-11-25', venue, raceNo, lines: combos.map(c => ({ combo: c, amount: 100 })) }, extra || {});
  const ledger = [mk('A場', 1, ['1-2-3']), mk('B場', 2, ['1-2-3']), mk('C場', 3, ['1-2-3']), mk('D場', 4, ['9-9-9']), mk('E場', 5, ['1-2-3']), mk('F場', 6, ['1-2-3'], { mode: 'test' }), mk('A場', 1, ['1-2-3', '4-5-6'])];
  const confirmed = (c) => ({ kind: 'confirmed', chakuju: c, payout: '¥1,000' });
  const results = { 'A場_1': confirmed('1-2-3'), 'B場_2': confirmed('1-2-3'), 'C場_3': confirmed('1-2-3'), 'D場_4': confirmed('1-2-3'), 'E場_5': { kind: 'pending' }, 'F場_6': confirmed('1-2-3') };
  const calls = [], sleeps = [], good = { kimarite: '差し', start: [{ course: 1, boat: 1, st: 0.15 }], order: [{ pos: 1, boat: 1 }, { pos: 2, boat: 2 }, { pos: 3, boat: 3 }] };
  const fetchFn = async (a) => { calls.push(a.venue + a.raceNumber); return a.venue === 'B場' ? { ok: false, error: '通信エラー' } : { ok: true, facts: good }; };
  const sleepFn = async (ms) => { sleeps.push(ms); };
  const r1 = await S.collectFacts({ date: '2026-11-25', ledger, results, facts: {}, fetchFn, nowMs: 1000000, sleepFn });
  assert.deepStrictEqual(calls, ['A場1', 'B場2']);                                  // 的中したA・B・Cのうち、最大2件(D=外れ、E=結果待ち、F=試験の記録は取らない)
  assert.deepStrictEqual(sleeps, [3000]);                                           // 2件の間に3秒
  assert.ok(S.usable(r1.facts['A場_1'])); assert.ok(r1.facts['B場_2'].failedAt === 1000000); assert.strictEqual(r1.got, 1);
  calls.length = 0;
  const r2 = await S.collectFacts({ date: '2026-11-25', ledger, results, facts: r1.facts, fetchFn, nowMs: 1000000 + 5 * 60000, sleepFn });
  assert.deepStrictEqual(calls, ['C場3']);                                          // Aは取得済み、Bは失敗から5分(10分未満)なので待つ
  calls.length = 0;
  const r3 = await S.collectFacts({ date: '2026-11-25', ledger, results, facts: r2.facts, fetchFn, nowMs: 1000000 + 11 * 60000, sleepFn });
  assert.deepStrictEqual(calls, ['B場2']);                                          // Bは失敗から11分たったので再試行
  calls.length = 0;
  const r4 = await S.collectFacts({ date: '2026-11-25', ledger, results, facts: r3.facts, fetchFn, nowMs: 1000000 + 16 * 60000, sleepFn });
  assert.deepStrictEqual(calls, []); assert.strictEqual(r4.tried, 0);              // A・Cは取得済み、Bは直前の失敗から5分なので何も取らない
  n++; console.log('ok 事実の取得: 的中したレースだけ・1回最大2件・間隔3秒・取得済みは取らない・失敗は10分あけて再試行');
  console.log(`
${n}項目 PASS`);
})().catch(e => { console.error(e); process.exit(1); });
