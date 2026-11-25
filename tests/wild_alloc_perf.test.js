'use strict';
// 1レース5000円の平買い/配分の並列成績(scripts/lib/wild_alloc_perf.js)の試験。node tests/wild_alloc_perf.test.js
const assert = require('assert');
const fs = require('fs'), path = require('path');
const A = require('../scripts/lib/wild_alloc_perf');
const W = require('../scripts/lib/wild_live');
let n = 0; const t = (name, f) => { f(); n++; console.log('ok', name); };
const sum = a => a.reduce((x, y) => x + y, 0);
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

t('平買い: 1点100円×12点=1,200円(いまの運用と同じ)・配分は5000円', () => {
  assert.strictEqual(A.FLAT_UNIT, 100); assert.strictEqual(A.FLAT_TOTAL, 1200); assert.strictEqual(A.TOTAL, 5000);
  const a = A.allocFlat(12); assert.strictEqual(sum(a), 5000); assert.ok(a.every(v => v % 100 === 0));   // allocFlatは配分の保険(使えないとき5000円を均等)用
});
t('配分: 乱数1万レースで 合計=5000・100円単位・非負・保証(当たれば5000円以上)', () => {
  let guaranteed = 0;
  for (let i = 0; i < 10000; i++) {
    const o = [], p = []; for (let j = 0; j < 12; j++) { o.push(1.5 + rnd() * rnd() * 600); p.push(0.0005 + rnd() * 0.12); }
    const r = A.allocGuaranteeEV(p, o);
    assert.strictEqual(sum(r.amounts), 5000); assert.ok(r.amounts.every(v => Number.isInteger(v) && v >= 0 && v % 100 === 0), 'amount');
    if (r.mode === 'guarantee_ev') { guaranteed++; r.amounts.forEach((v, k) => assert.ok(v * o[k] >= 5000 - 1e-6, `保証 ${v}*${o[k]}`)); }
  }
  assert.ok(guaranteed > 9000, '通常は保証つき: ' + guaranteed);
});
t('配分: 同じ入力は同じ結果・点の順序を入れ替えても各点の金額差は100円以内', () => {
  const o = [12, 30, 45, 8.5, 77, 140, 22, 31, 60, 95, 18, 250], p = [.05, .04, .03, .09, .02, .01, .06, .04, .03, .02, .05, .006];
  const a = A.allocGuaranteeEV(p, o).amounts, b = A.allocGuaranteeEV(p, o).amounts; assert.deepStrictEqual(a, b);
  const idx = [11, 3, 7, 0, 5, 9, 1, 10, 2, 8, 6, 4], a2 = A.allocGuaranteeEV(idx.map(i => p[i]), idx.map(i => o[i])).amounts;
  idx.forEach((i, k) => assert.ok(Math.abs(a2[k] - a[i]) <= 100, `点${i}: ${a2[k]} vs ${a[i]}`));
});
t('配分: 保証しきれない(合成オッズ約1倍以下)ときは scaled で合計5000円を保つ', () => {
  const r = A.allocGuaranteeEV(new Array(12).fill(0.08), new Array(12).fill(1.1)); assert.strictEqual(r.mode, 'scaled'); assert.strictEqual(sum(r.amounts), 5000); assert.ok(r.amounts.every(v => v >= 0 && v % 100 === 0));
});
t('配分: 確率・オッズが使えない/長さ違いは平買いに戻る', () => {
  const o = new Array(12).fill(30), p = new Array(12).fill(0.03);
  for (const [pp, oo] of [[p.map((v, i) => i ? v : NaN), o], [p.map((v, i) => i ? v : 0), o], [p, o.map((v, i) => i ? v : 0)], [p, o.map((v, i) => i ? v : -3)], [p, o.map((v, i) => i ? v : Infinity)], [p.slice(0, 11), o]]) {
    const r = A.allocGuaranteeEV(pp, oo); assert.strictEqual(r.mode, 'flat_fallback'); assert.strictEqual(sum(r.amounts), sum(A.allocFlat(pp.length)));
  }
});
t('配分: 手計算の例(オッズ10×6点・50×6点、確率同じ)', () => {
  const o = [10, 10, 10, 10, 10, 10, 50, 50, 50, 50, 50, 50], p = new Array(12).fill(0.02);
  const r = A.allocGuaranteeEV(p, o);
  assert.strictEqual(sum(r.amounts), 5000); assert.ok(r.amounts.slice(0, 6).every(v => v >= 500 && v <= 600)); assert.ok(r.amounts.slice(6).every(v => v >= 300));
  assert.ok(r.amounts.every((v, k) => v * o[k] >= 5000));
});
t('evalLines: 的中の払戻を手計算と一致・11点や重複は対象外', () => {
  const combos = ['1-2-3', '1-2-4', '1-3-2', '1-3-4', '1-4-2', '1-4-3', '2-1-3', '2-1-4', '2-3-1', '3-1-2', '3-2-1', '4-1-2'];
  const od = [8, 9, 12, 15, 18, 22, 30, 35, 40, 55, 70, 90];
  const card = { combos: {} }; combos.forEach((c, i) => { card.combos[c] = { odds: od[i], enginePct: 4 }; });
  const lines = combos.map((c, i) => ({ combo: c, odds: od[i] }));
  const r = A.evalLines(card, lines, { chakuju: '1-2-4', payout: 910 });
  assert.ok(r.hit); assert.ok(Math.abs(r.flat.pay - 9.1 * 100) < 1e-9);
  assert.strictEqual(r.flat.inv, 1200); assert.strictEqual(r.alloc.inv, 5000);
  const al = A.allocGuaranteeEV(od.map(() => 0.04), od).amounts; assert.ok(Math.abs(r.alloc.pay - 9.1 * al[1]) < 1e-9);
  const miss = A.evalLines(card, lines, { chakuju: '5-6-1', payout: 4000 }); assert.ok(!miss.hit && miss.flat.pay === 0 && miss.alloc.pay === 0);
  assert.strictEqual(A.evalLines(card, lines.slice(0, 11), { chakuju: '1-2-3', payout: 500 }), null);   // 12点でない(システムの目安用)は対象外
  assert.ok(A.evalLines(card, lines.slice(0, 11), { chakuju: '1-2-3', payout: 500 }, { anyN: true }));   // 俺の買い目は点数が違ってもよい
  assert.strictEqual(A.evalLines(card, lines.map((l, i) => i ? l : lines[1]), { chakuju: '1-2-3', payout: 500 }), null);
});
t('実データ: 件数・投資額の整合(平買い=n×1,200円・配分=n×5000円。参入対象はKとM(edge)の和集合)', () => {
  const r = A.computeAllocPerf(); assert.ok(r && r.days > 30);
  for (const k of A.KEYS) { const x = r.tiers[k]; assert.strictEqual(x.flat.inv, x.n * 1200, k); assert.strictEqual(x.alloc.inv, x.n * 5000, k); assert.ok(x.hit <= x.n); assert.ok(x.flat.gami <= x.hit && x.alloc.gami <= x.hit); }
  const T = r.tiers; assert.ok(T['参入対象'].n <= T['K'].n + T['M(edge)'].n && T['参入対象'].n >= Math.max(T['K'].n, T['M(edge)'].n));
  assert.ok(T['M(edge)'].n <= T['M'].n);
  assert.strictEqual(r.daily.reduce((s, d) => s + d.entry.n, 0), T['参入対象'].n);
  assert.strictEqual(r.daily.reduce((s, d) => s + d.all.n, 0), T['全カード'].n);
});
t('俺の参入×配分: 台帳の買い目(最後の1件・live・bet のみ)で、平買い(1点100円)/配分(5000円)を手計算と一致して並べる', () => {
  const res = A.makeResultResolver(), days = fs.readdirSync(W.WILD_DIR).filter(f => /^index_\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(6, 16)).filter(d => d >= '2026-11-01').sort();
  let hitCase = null, missCase = null;
  for (const d of days) for (const f of fs.readdirSync(W.cardDir(d))) {
    const c = W.readJson(path.join(W.cardDir(d), f), null), card = c && c.card; if (!card || !card.combos || !c.venue) continue;
    const r = res(d, c.venue, c.race); if (!r || !(r.payout > 0)) continue;
    const co = Object.keys(card.combos).filter(k => card.combos[k].odds > 0 && card.combos[k].enginePct > 0); if (co.length < 120) continue;
    const others = co.filter(k => k !== r.chakuju).slice(0, 8);
    const hitLines = [r.chakuju].concat(others.slice(0, 5)), missLines = others.slice(0, 8);   // 的中する5+1点 / 外れる8点
    if (!hitCase) hitCase = { d, c, r, card, lines: hitLines }; else if (!missCase && c.race !== hitCase.c.race) missCase = { d, c, r, card, lines: missLines };
    if (hitCase && missCase) break;
  }
  assert.ok(hitCase && missCase);
  const mk = (x, lines, extra) => Object.assign({ mode: 'live', action: 'bet', raceDate: x.d, venue: x.c.venue, raceNo: x.c.race, lines: lines.map(cb => ({ combo: cb, amount: 100, odds: x.card.combos[cb].odds })) }, extra || {});
  const ledger = [mk(hitCase, hitCase.lines), mk(missCase, missCase.lines.slice(0, 3)), mk(missCase, missCase.lines),   // 同じレースは後の記録が優先(8点)
    mk(hitCase, ['1-2-3', '1-3-2'], { mode: 'test' }), mk(hitCase, ['1-2-3', '1-3-2'], { action: 'pass' })];
  const m = A.computeMineAlloc(ledger, { from: '2026-11-01' });
  assert.strictEqual(m.n, 2); assert.strictEqual(m.act.inv, 600 + missCase.lines.length * 100);
  const e1 = A.evalLines(hitCase.card, hitCase.lines.map(cb => ({ combo: cb, odds: hitCase.card.combos[cb].odds })), hitCase.r, { anyN: true });
  const e2 = A.evalLines(missCase.card, missCase.lines.map(cb => ({ combo: cb, odds: missCase.card.combos[cb].odds })), missCase.r, { anyN: true });
  assert.ok(e1.hit && !e2.hit);
  assert.strictEqual(missCase.lines.length, 8); assert.strictEqual(m.flat.inv, 600 + 800); assert.strictEqual(m.alloc.inv, 10000);                                     // 平買い=1点100円×点数、配分=5000円
  assert.ok(Math.abs(m.flat.pay - hitCase.r.payout) <= 1);                                                              // 的中=払戻×100円
  assert.ok(Math.abs(m.flat.pay - (e1.flat.pay + e2.flat.pay)) <= 1); assert.ok(Math.abs(m.alloc.pay - (e1.alloc.pay + e2.alloc.pay)) <= 1);
  assert.strictEqual(m.daily.reduce((s, d) => s + d.n, 0), 2);
  const real = A.computeMineAlloc(W.readLedger()); assert.ok(real.n > 100);
  assert.strictEqual(real.alloc.inv, real.n * 5000); assert.strictEqual(real.daily.reduce((s, d) => s + d.n, 0), real.n);
  // 11月以降は全点100円なので 平買い=実際
  const nov = A.computeMineAlloc(W.readLedger(), { from: '2026-11-01' }); assert.strictEqual(nov.flat.inv, nov.act.inv); assert.ok(Math.abs(nov.flat.pay - nov.act.pay) <= 1);
});
t('日別キャッシュ: あり/なし/破損/コード違い でも結果が完全に同じ・今日と昨日は保存しない', () => {
  const os = require('os'), cf = path.join(os.tmpdir(), 'alloc_cache_test_' + process.pid + '.json');
  try {
    const base = JSON.stringify(A.computeAllocPerf({ cache: false }));
    assert.strictEqual(JSON.stringify(A.computeAllocPerf({ cacheFile: cf })), base);   // 作成
    assert.strictEqual(JSON.stringify(A.computeAllocPerf({ cacheFile: cf })), base);   // 使用
    const st = JSON.parse(fs.readFileSync(cf, 'utf8')), today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), yest = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
    assert.ok(Object.keys(st.days).length > 30); assert.ok(!(today in st.days) && !(yest in st.days), '今日・昨日は保存しない');
    assert.ok(Object.values(st.days).every(x => x.pending === 0));
    fs.writeFileSync(cf, '{壊れた'); assert.strictEqual(JSON.stringify(A.computeAllocPerf({ cacheFile: cf })), base);   // 破損
    st.sig = 'x'; const d0 = Object.keys(st.days)[0]; st.days[d0].tot['全カード'].n += 999; fs.writeFileSync(cf, JSON.stringify(st));
    assert.strictEqual(JSON.stringify(A.computeAllocPerf({ cacheFile: cf })), base);   // コード違いの古い保存は使わない(改ざんしても影響なし)
    const st2 = JSON.parse(fs.readFileSync(cf, 'utf8')); const d1 = Object.keys(st2.days)[0]; st2.days[d1].at = Date.now() - 25 * 3600000; st2.days[d1].tot['全カード'].n += 7; fs.writeFileSync(cf, JSON.stringify(st2));
    assert.strictEqual(JSON.stringify(A.computeAllocPerf({ cacheFile: cf })), base);   // 24時間より古い保存は作り直す
  } finally { try { fs.unlinkSync(cf); } catch (e) { /* 無ければ良い */ } }
});
t('実データ: Kの平買い成績を、別の書き方(独立ループ)で再計算して一致', () => {
  const r = A.computeAllocPerf(), res = A.makeResultResolver();
  let n = 0, hit = 0, pay = 0;
  const days = fs.readdirSync(W.WILD_DIR).filter(f => /^index_\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(6, 16)).filter(d => d >= A.FROM).sort();
  for (const d of days) for (const f of fs.readdirSync(W.cardDir(d))) {
    const c = W.readJson(path.join(W.cardDir(d), f), null), card = c && c.card; if (!card || !card.aiPick || !c.venue || !W.kInfo(card)) continue;
    const x = res(d, c.venue, c.race); if (!x) continue;
    const ls = W.playLinesOf(card).slice(0, 12); if (ls.length < 12) continue;
    n++; const i = ls.findIndex(l => l.combo === x.chakuju); if (i >= 0) { hit++; pay += x.payout / 100 * 100; }
  }
  assert.strictEqual(r.tiers.K.n, n); assert.strictEqual(r.tiers.K.hit, hit); assert.ok(Math.abs(r.tiers.K.flat.pay - pay) <= 1, `${r.tiers.K.flat.pay} vs ${pay}`);
});
t('実データ: 全カードの回収率が、研究(live A+B)の 平買い75.4%・配分79.9%付近', () => {
  const x = A.computeAllocPerf().tiers['全カード']; assert.ok(Math.abs(x.flat.roi - 0.754) < 0.01, x.flat.roi); assert.ok(Math.abs(x.alloc.roi - 0.799) < 0.01, x.alloc.roi);
});
t('wild_status に allocPerf が入る(失敗しても稼働状況は止まらない書き方)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'wild_status.js'), 'utf8'); assert.ok(src.includes("st.allocPerf = require('./wild_alloc_perf').computeAllocPerf(); } catch (e) { st.allocPerf = null; }"));
  const S = require('../scripts/lib/wild_status'); const st = S.computeWildStatus(Date.now(), {}); assert.ok('allocPerf' in st); assert.ok(st.allocPerf && st.allocPerf.tiers);
});
t('分離: 本番の判定・買い目・通知のコードが、この集計を読み込んでいない', () => {
  const files = ['lib/wild_live.js', 'wild_card.js', 'wild_scan.js', 'lib/m_correct_apply.js', 'lib/m2_apply.js', 'lib/wild_tier_perf.js'];
  let checked = 0;
  for (const f of files) { const p = path.join(__dirname, '..', 'scripts', f); if (!fs.existsSync(p)) continue; checked++; assert.ok(!/wild_alloc_perf/.test(fs.readFileSync(p, 'utf8')), f + ' が wild_alloc_perf を読んでいる'); }
  assert.ok(checked >= 4);
});
console.log(`\n${n}項目 PASS`);
