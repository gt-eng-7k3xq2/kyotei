'use strict';
// M2の買い目への切替(scripts/lib/m2_apply.js)の試験(2026-11-03)。node tests/m2_apply.test.js
// 実カード(logs/wild/cards/2026-11-02)を使い、切替の内容・変えないもの・戻す条件・画面の買い目との一致・Mの判定が変わらないことを確認する。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'scripts', 'lib', 'm2_apply')), S = require(path.join(ROOT, 'scripts', 'lib', 'm2_shadow')), W = require(path.join(ROOT, 'scripts', 'lib', 'wild_live'));
let pass = 0, fail = 0; const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } };
const dir = path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-02');
const load = () => fs.readdirSync(dir).filter(f => f.endsWith('.json')).slice(0, 400).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(j => j.ok && j.card && j.card.combos && j.card.aiPick && (j.card.aiPick.lines13 || []).length >= 13);
const cards = load(), noDisable = path.join(os.tmpdir(), 'no-such-disable-flag'); const opts = { from: '2026-11-01', disableFile: noDisable };
const clone = (x) => JSON.parse(JSON.stringify(x));
const tmin = (j) => (Date.parse(`${j.card.raceDate}T${j.deadline}:00+09:00`) - Date.parse(j.capturedAt)) / 60000;
t('試験用のカードが十分にある', () => assert(cards.length >= 100, String(cards.length)));
// 画面側のautoPlan(wild_template.html から切り出し)
const html = fs.readFileSync(path.join(ROOT, 'scripts', 'wild', 'wild_template.html'), 'utf8');
const sliceFn = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const planSrc = sliceFn('function hasExcluded', '\n// ', 0) || '';
let autoPlan = null;
try {
  const i0 = html.indexOf('function hasExcluded'), i1 = html.indexOf('function planKey'), re = /\r?\n\}\r?\n/g;
  re.lastIndex = html.indexOf('function autoPlan'); const i2 = re.exec(html).index + 3;
  autoPlan = new Function('PLAN_POINTS', 'PLAN_HEAD_CAP', 'PLAN_ODDS_MIN', 'PLAN_VARIABLE', 'PLAN_EXCLUDE_SIX', 'X_POINTS', 'X_ODDS_MIN', 'variableK', html.slice(i0, i1) + html.slice(i1, i2) + '; return autoPlan;')(12, 8, 10, false, false, 12, 80, () => 12);
} catch (e) { console.log('画面のautoPlanを切り出せません:', e.message); }
t('切替: 適用され、12点・カードの他の判定は変わらない', () => {
  let ap = 0, notApplied = {}, changed = 0;
  for (const j0 of cards) {
    const j = clone(j0); const before = clone(j0.card); j.capturedAt = new Date(Date.parse(`${j.card.raceDate}T${j.deadline}:00+09:00`) - 8 * 60000).toISOString();
    const r = A.applyM2(j, opts), c = j.card;
    assert.deepStrictEqual(c.entry, before.entry, 'entry(S/A/B/Xの判定)が変わった'); assert.deepStrictEqual(c.aiPick.lines13, before.aiPick.lines13); assert.deepStrictEqual(c.aiPick.xLines, before.aiPick.xLines); assert.deepStrictEqual(c.overview, before.overview);
    for (const k of S.COMBOS) { assert.strictEqual(c.combos[k].enginePct, before.combos[k].enginePct, '画面に出す確率(enginePct)が変わった'); assert.strictEqual(c.combos[k].odds, before.combos[k].odds); }
    if (r.applied) { ap++; assert.strictEqual(c.aiPick.lines.length, 12); assert.deepStrictEqual(c.aiPick.linesCur, before.aiPick.lines); assert.strictEqual(c.aiPick.m2Applied, true); assert.strictEqual(c.aiPick.planSource, 'M2-v1'); assert(c.aiPick.lines.every(l => !l.combo.startsWith('1-') && l.odds >= 10)); const heads = {}; c.aiPick.lines.forEach(l => { heads[l.combo[0]] = (heads[l.combo[0]] || 0) + 1; }); assert(Object.values(heads).every(v => v <= 8)); if (c.aiPick.lines.map(l => l.combo).sort().join() !== before.aiPick.lines.map(l => l.combo).sort().join()) changed++; }
    else { notApplied[r.reason] = (notApplied[r.reason] || 0) + 1; assert.deepStrictEqual(c.aiPick.lines, before.aiPick.lines, '適用されないのに買い目が変わった'); assert.strictEqual(c.aiPick.linesCur, undefined); }
  }
  console.log(`   適用 ${ap}/${cards.length}、うち現行と12点が変わった ${changed}。適用されなかった理由: ${JSON.stringify(notApplied)}`); assert(ap > cards.length * 0.5); assert(changed > 0);
});
t('切替: 12点がシャドー(m2_shadow)のM2の12点と一致し、合成オッズが買い目から再計算されている', () => {
  let n = 0;
  for (const j0 of cards.slice(0, 150)) {
    const j = clone(j0); j.capturedAt = new Date(Date.parse(`${j.card.raceDate}T${j.deadline}:00+09:00`) - 8 * 60000).toISOString(); const r = A.applyM2(j, opts); if (!r.applied) continue;
    const sh = S.buildShadow(clone(j0), new Date(), S.loadParams()); const { P, O } = S.cardVectors(j.card); const f2 = S.raceFeatures(S.m2Prob(P, O, S.loadParams()), O);
    assert.deepStrictEqual(j.card.aiPick.lines.map(l => l.combo), f2.lines12); const g = 1 / j.card.aiPick.lines.reduce((a, l) => a + 1 / l.odds, 0); assert(Math.abs(j.card.aiPick.goseiOdds - Math.round(g * 100) / 100) < 1e-9); n++;
  }
  assert(n > 50);
});
t('切替: M(中配当)の判定と買い目は変わらない(wild_live.mInfo が切替前と同じ)', () => {
  let nM = 0, n = 0;
  for (const j0 of cards) {
    const j = clone(j0); j.capturedAt = new Date(Date.parse(`${j.card.raceDate}T${j.deadline}:00+09:00`) - 8 * 60000).toISOString();
    const before = W.mInfo(clone(j0.card)); A.applyM2(j, opts); const after = W.mInfo(j.card); assert.deepStrictEqual(after, before, 'Mの判定が変わった'); n++;
    if (before) { nM++; assert.strictEqual(j.card.aiPick.m2Applied, false); assert.strictEqual(j.card.aiPick.m2Reason, 'tier_M_keeps_current_lines'); assert.deepStrictEqual(j.card.aiPick.lines, j0.card.aiPick.lines); }
  }
  console.log(`   Mのレース ${nM}/${n}`);
});
t('切替: 画面のおまかせ案(autoPlan)が、カードの12点と同じ組になる(適用時)/ 現行と同じ(非適用時)', () => {
  if (!autoPlan) throw new Error('autoPlan未取得'); let nA = 0, nN = 0;
  for (const j0 of cards.slice(0, 200)) {
    const j = clone(j0); j.capturedAt = new Date(Date.parse(`${j.card.raceDate}T${j.deadline}:00+09:00`) - 8 * 60000).toISOString(); const r = A.applyM2(j, opts);
    const plan = autoPlan(j.card, null, []), got = plan.blocks.flatMap(b => b.combos).sort().join(), want = j.card.aiPick.lines.map(l => l.combo).sort().join();
    assert.strictEqual(got, want, `${j.venue}${j.race}R 画面とカードの12点が違う(適用=${r.applied})`); r.applied ? nA++ : nN++;
  }
  console.log(`   適用 ${nA} / 非適用 ${nN}`); assert(nA > 30);
});
t('戻す: 適用前の日付・停止フラグ・オッズ欠損・取得が古い/遅い・パラメータ不読 は、買い目が現行のまま', () => {
  const base = clone(cards[0]); base.capturedAt = new Date(Date.parse(`${base.card.raceDate}T${base.deadline}:00+09:00`) - 8 * 60000).toISOString();
  const same = (r, reason, over) => { const j = clone(base); if (over) over(j); const before = clone(j.card.aiPick.lines); const rr = A.applyM2(j, r); assert.strictEqual(rr.applied, false); assert(String(rr.reason).includes(reason), `${rr.reason} に ${reason} が無い`); assert.deepStrictEqual(j.card.aiPick.lines, before); return j; };
  const j0 = clone(base); A.applyM2(j0, { from: '2026-12-31', disableFile: noDisable }); assert.strictEqual(j0.card.aiPick.m2Applied, undefined, '適用前の日はカードに何も書かない');
  const flag = path.join(os.tmpdir(), 'm2-disable-' + process.pid); fs.writeFileSync(flag, 'x'); try { same({ from: '2026-11-01', disableFile: flag }, 'disabled'); } finally { fs.unlinkSync(flag); }
  same(opts, 'odds_missing', j => { j.card.combos['2-3-4'].odds = null; });
  same(opts, 'odds_stale_or_early', j => { j.capturedAt = new Date(Date.parse(`${j.card.raceDate}T${j.deadline}:00+09:00`) - 90 * 1000).toISOString(); });
  same(opts, 'odds_stale_or_early', j => { j.capturedAt = new Date(Date.parse(`${j.card.raceDate}T${j.deadline}:00+09:00`) - 20 * 60000).toISOString(); });
  same(opts, 'odds_sum_out_of_range', j => { for (const k of S.COMBOS) j.card.combos[k].odds *= 1.1; });
  same(Object.assign({ paramsFile: path.join(os.tmpdir(), 'none.json') }, opts), 'params_unavailable');
});
t('安全: どんな不正な入力でも例外を投げない', () => { for (const bad of [null, undefined, {}, { ok: true }, { ok: true, card: {} }, { ok: true, card: { raceDate: '2026-11-05', aiPick: {} } }, { ok: true, card: { raceDate: '2026-11-05', aiPick: { lines: [], lines13: [] }, combos: null } }]) assert.doesNotThrow(() => A.applyM2(bad, opts)); });
t('配線: wild_card.js が切替を呼び、失敗してもカード作成を止めない構造(try/catch)', () => { const s = fs.readFileSync(path.join(ROOT, 'scripts', 'wild_card.js'), 'utf8'); assert(/try \{ require\('\.\/lib\/m2_apply'\)\.applyM2\(out\); \} catch/.test(s)); assert(s.indexOf('applyM2(out)') > s.indexOf('card.combos = {}')); });
t('既定の適用開始日は2026-11-04、停止フラグの場所は logs/.m2_lines_disable', () => { assert.strictEqual(A.APPLY_FROM, '2026-11-04'); assert(A.DISABLE_FILE.replace(/\\/g, '/').endsWith('logs/.m2_lines_disable')); });
console.log(`\n${pass}件 通過 / ${fail}件 失敗`); process.exitCode = fail ? 1 : 0;
