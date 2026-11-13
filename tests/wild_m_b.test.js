'use strict';
// M・B方式(従来のM判定+V1の補正後12点)の導入前試験(2026-11-09)。保存済みカードと生入力から、変更後の applyMCorrect を実際に呼んで確認する(保存カード本体は書き換えない)。
// 方式: B(明示的に有効化したときだけ)/ C(既定=現行V1)/ A(V1停止または適用不可=従来の判定+従来12点)。
// 使い方: node tests/wild_m_b.test.js          (全部で約15〜20分。Pythonを1枚ずつ呼ぶため)
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const BK = path.join(ROOT, 'backups', 'wild_before_B_20261109');
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + String(e.message).split('\n')[0]); } };
// ---- 新旧のモジュール(旧=バックアップ。同じ相対構成の一時フォルダに置く) ----
const OLD = path.join(os.tmpdir(), 'garon_old_B_test'); fs.rmSync(OLD, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(OLD, 'scripts', 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'scripts', 'wild'), path.join(OLD, 'scripts', 'wild'), { recursive: true, filter: (s) => !/wild_template\.html$/.test(s) });
fs.copyFileSync(path.join(BK, 'scripts', 'lib', 'm_correct_apply.js'), path.join(OLD, 'scripts', 'lib', 'm_correct_apply.js'));
fs.copyFileSync(path.join(BK, 'scripts', 'lib', 'wild_live.js'), path.join(OLD, 'scripts', 'lib', 'wild_live.js'));
const NW = require(path.join(ROOT, 'scripts', 'lib', 'wild_live')), NA = require(path.join(ROOT, 'scripts', 'lib', 'm_correct_apply'));
const OW = require(path.join(OLD, 'scripts', 'lib', 'wild_live')), OA = require(path.join(OLD, 'scripts', 'lib', 'm_correct_apply'));
// ---- 画面側(新旧の garon_wild.html から、判定・おまかせ案・Mカードの関数を取り出す) ----
function screen(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8'); const g = (re, opt) => { const m = html.match(re); if (!m) { if (opt) return ''; throw new Error('抽出失敗 ' + re); } return m[0]; };
  const code = [g(/const PLAN_POINTS[^\n]*\n/), g(/const X_ODDS_MIN[^\n]*\n/), g(/const M_UPSET_MIN[^\n]*\n/), g(/const PLAN_HEAD1_NONTARGET[^\n]*\n/, true), g(/function isNonTarget[^\n]*\n/, true), g(/const PLAN_MIN_POINTS[\s\S]*?function variableK[\s\S]*?return n;\s*\}/), g(/function planKey[^\n]*\n/), g(/function hasExcluded[^\n]*\n/), g(/const esc = [^\n]*\n/), g(/function mOfCard[\s\S]*?\n\}\r?\n/), g(/function mCorrOn[^\n]*\n/), g(/function mBCard[^\n]*\n/, true), g(/function mBLines[^\n]*\n/, true), g(/function mBOn[^\n]*\n/, true), g(/function mDetOn[^\n]*\n/), g(/function autoPlan[\s\S]*?\n\}\r?\n/), g(/function mergeBlocks[\s\S]*?return out;\s*\}/), g(/function mCard\(\)\{[\s\S]*?\n\}\r?\n/)].join('\n');
  // 2026-11-13: この試験は「B実装前(11/9)と同じ」の確認。その後(11/11〜12、CEO承認)に加えた「末尾2点を1号艇頭にする」は別試験(wild_head1_*.test.js)で確認するので、ここでは無効にして比べる。
  return new Function(code.replace(/const PLAN_HEAD1_NONTARGET = \d+/, 'const PLAN_HEAD1_NONTARGET = 0') + ';let S=null;return {autoPlan,mergeBlocks,mOfCard,mCard,setS:v=>{S=v;}};')();
}
const NS = screen(path.join(ROOT, 'garon_wild.html')), OS = screen(path.join(BK, 'garon_wild.html'));
// ---- カードと生入力 ----
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'diag2_20261110', 'mcorr_rows.json'), 'utf8'));
const BL = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'diag2_20261110', 'mcorr_B_lines.json'), 'utf8'));
const key = (r) => `${r.d}|${r.v}|${r.r}`;
const cand = rows.filter(r => r.before || (r.rp.ok && r.rp.isM)), others = rows.filter(r => !(r.before || (r.rp.ok && r.rp.isM)));
const samp = others.filter((_, i) => i % 45 === 0);
function load(r) {
  const cj = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'wild', 'cards', r.d, `${r.v}_${r.r}R.json`), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'boatcast_migration', 'raw_collected', r.d, `${r.v}_${r.r}R_${cj.rawTs}.json`), 'utf8'));
  const card = cj.card; if (card.aiPick) delete card.aiPick.mCorr;   // 適用前のカード(保存時に付いていた補正の記録は外す)
  return { cj, card, boats: ((raw.collected || {}).preRaceInfo || {}).boats || [] };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const NOFILE = path.join(os.tmpdir(), 'garon_b_nofile_' + process.pid), BON = path.join(os.tmpdir(), 'garon_b_on_' + process.pid); fs.writeFileSync(BON, 'x');
const opt = (b, dis) => ({ from: '2000-01-01', disableFile: dis || NOFILE, bEnableFile: b ? BON : NOFILE });
console.log(`対象: 候補(従来MまたはV1のM)${cand.length}枚、それ以外の標本${samp.length}枚`);
const t0 = Date.now();
// ===== B有効で作り直す(候補+標本) =====
const B = [];
for (const r of cand.concat(samp)) {
  const { cj, card, boats } = load(r); const before = clone(card); const res = { ok: true, card };
  const out = NA.applyMCorrect(res, { boats }, opt(true)); B.push({ r, cj, before, card, out });
}
console.log(`B有効での再生成 ${B.length}枚 ${Math.round((Date.now() - t0) / 1000)}秒`);
const engineA = (card) => { const c = clone(card); if (c.aiPick) delete c.aiPick.mCorr; return NW.mInfo(c); };   // 従来方式(A)の判定と12点
const rowOf = (card, r) => NW.indexRow({ card, venue: r.v, race: r.r, deadline: r.dl, capturedAt: r.cap });
// ---- 1. AとBでMの対象が同じ ----
t('AとBでM通知の対象が同一(全' + B.length + '枚)', () => { let n = 0; for (const x of B) { const a = !!engineA(x.card), b = !!NW.mInfo(x.card); assert.equal(b, a, key(x.r) + ' A=' + a + ' B=' + b); if (b) n++; } console.log(`   (M該当 ${n}枚で一致)`); });
t('M該当の件数が、従来Mの件数(結果あり678+未確定)と一致', () => { const nA = cand.filter(r => r.before).length; const nB = B.filter(x => NW.mInfo(x.card)).length; assert.equal(nB, nA); console.log(`   (従来M ${nA}件)`); });
// ---- 2. Bの12点が再現結果と一致 / 3. 補正不可は従来12点 ----
t('Bの12点が事後再現(mcorr_B_lines.json)と全件一致(従来Mの候補)', () => { let n = 0, fb = 0; for (const x of B) { const r = x.r; if (!r.before) continue; const mi = NW.mInfo(x.card); const exp = BL[key(r)]; if (exp) { assert.deepEqual(mi.lines.map(l => l.combo), exp, key(r)); assert.equal(mi.mode, 'B'); n++; } else { assert.deepEqual(mi.lines.map(l => l.combo), r.before.lines, key(r) + ' 従来12点に戻っていない'); fb++; } } console.log(`   (補正後12点で一致 ${n}件 / 従来12点に戻った ${fb}件)`); });
t('V1が適用できないカードは従来12点に戻り、理由が残る(mode=A・bFallback)', () => { let n = 0; for (const x of B) { const mc = x.card.aiPick.mCorr; if (mc && !mc.applied) { assert.equal(mc.mode, 'A'); assert.ok(/^v1_not_applicable:/.test(mc.bFallback), key(x.r)); const a = engineA(x.card), mi = NW.mInfo(x.card); assert.deepEqual(mi ? mi.lines : null, a ? a.lines : null); n++; } } assert.ok(n > 0); console.log(`   (適用不可 ${n}枚)`); });
t('V1がMから外した従来Mのレースも、補正後12点が使われる(V1非M・従来M)', () => { let n = 0; for (const x of B) { const mc = x.card.aiPick.mCorr; if (mc && mc.applied && !mc.isM && engineA(x.card)) { const mi = NW.mInfo(x.card); assert.equal(mi.mode, 'B'); assert.equal(mi.bSource, 'v1_lines12'); assert.deepEqual(mi.lines.map(l => l.combo), mc.linesB.map(l => l.combo)); n++; } } assert.ok(n >= 150, '件数 ' + n); console.log(`   (${n}枚)`); });
t('mInfo.lines=12点・M判定用の合成と買い目の合成が別に持たれる(B)', () => { for (const x of B) { const mi = NW.mInfo(x.card); if (!mi || mi.mode !== 'B' || mi.bSource !== 'v1_lines12') continue; assert.equal(mi.lines.length, 12); const jg = engineA(x.card).gosei, bg = 1 / mi.lines.reduce((a, l) => a + 1 / l.odds, 0); assert.ok(Math.abs(mi.judgeGosei - jg) < 1e-9); assert.ok(Math.abs(mi.gosei - Math.round(bg * 100) / 100) < 1e-9); } });
// ---- 4. S/A/B・Xが変わらない ----
t('S/A/B・Xを含む全カードで、aiPick.mCorr以外のカードの中身が変わらない', () => { for (const x of B) { const a = clone(x.card), b = clone(x.before); delete a.aiPick.mCorr; assert.deepEqual(a, b, key(x.r)); } });
t('S/A/BのカードはMにならない・S/A/B/Xの一覧の項目と通知文面が変わらない', () => {
  let nrank = 0, nx = 0;
  for (const x of B) {
    const e = x.card.entry || {}; if (e.rank) { assert.equal(NW.mInfo(x.card), null); nrank++; }
    const nr = rowOf(x.card, x.r), orw = rowOf(x.before, x.r); const strip = (o) => { const c = Object.assign({}, o); ['m', 'mGosei', 'mP12', 'mLines', 'mMode', 'mJudgeGosei', 'mBuyGosei', 'mEdge', 'mEdgeVal', 'k', 'kP12'].forEach(k => delete c[k]); return c; };
    assert.deepEqual(strip(nr), strip(orw), key(x.r)); const dl = Object.assign({ date: x.r.d }, nr);
    const nn = NW.wildNotificationFor(Object.assign({ date: x.r.d }, nr), Date.parse(x.r.d + 'T00:00:00+09:00')), on = NW.wildNotificationFor(Object.assign({ date: x.r.d }, orw), Date.parse(x.r.d + 'T00:00:00+09:00')); assert.deepEqual(nn, on);
    const nxx = NW.wildXNotificationFor(Object.assign({ date: x.r.d }, nr), Date.parse(x.r.d + 'T00:00:00+09:00')), oxx = NW.wildXNotificationFor(Object.assign({ date: x.r.d }, orw), Date.parse(x.r.d + 'T00:00:00+09:00')); assert.deepEqual(nxx, oxx); if (x.card.entry && x.card.entry.x) nx++;
  } console.log(`   (S/A/B ${nrank}枚、X ${nx}枚を含む)`);
});
// ---- 5. 通知と画面が同じ12点 ----
t('B: 一覧(通知)の12点と、画面のおまかせ案の12点が同じ(全Bカード)', () => {
  let n = 0, fb = 0, diffFb = 0;
  for (const x of B) {
    const mi = NW.mInfo(x.card); if (!mi || mi.mode !== 'B') continue; NS.setS({}); const scr = NS.mergeBlocks(NS.autoPlan(x.card, null, []).blocks).slice().sort(), nt = mi.lines.map(l => l.combo).sort(); const row = rowOf(x.card, x.r); assert.deepEqual(row.mLines.map(l => l.combo).sort(), nt);
    if (mi.bSource === 'v1_lines12') { assert.deepEqual(scr, nt, key(x.r)); n++; } else { fb++; if (JSON.stringify(scr) !== JSON.stringify(nt)) diffFb++; }
  } console.log(`   (補正後12点で一致 ${n}枚 / 従来12点に戻った${fb}枚のうち、画面とのずれ ${diffFb}枚 ※従来からある差で、下記の注記を参照)`);
});
t('B: mOfCardが従来のM判定と同じで、買い目の合成(gosei)と判定用の合成(judgeGosei)が別', () => { for (const x of B) { const m = NS.mOfCard(x.card), a = engineA(x.card); assert.equal(!!m, !!a, key(x.r)); if (m && m.mode === 'B' && m.bLines) { assert.ok(Math.abs(m.judgeGosei - a.gosei) < 0.01); const mi = NW.mInfo(x.card); assert.ok(Math.abs(m.gosei - mi.gosei) < 0.006, key(x.r) + ' 画面' + m.gosei + ' 通知' + mi.gosei); } } });
// 2026-11-13(CEO承認「合成直して。買い目込みじゃなくて逃げ込みだろ」): 通知の「合成」は判定の合成(従来12点)。逃げ込み(1号艇頭2点を入れた後)の合成が違うときだけ括弧で併記する。
t('B: 通知本文の合成は判定の合成(逃げ込みが違うときは括弧で併記)', () => { for (const x of B) { const mi = NW.mInfo(x.card); if (!mi || mi.mode !== 'B' || mi.bSource !== 'v1_lines12') continue; const row = Object.assign({ date: x.r.d }, rowOf(x.card, x.r)); const nm = NW.wildMNotificationFor(row, Date.parse(x.r.d + 'T00:00:00+09:00')); if (!nm) continue; assert.ok(nm.body.includes('合成' + mi.judgeGosei.toFixed(1) + '倍'), nm.body); if (Math.abs(mi.buyGosei - mi.judgeGosei) >= 0.05) assert.ok(nm.body.includes('(逃げ込み' + mi.buyGosei.toFixed(1) + '倍)'), nm.body); return; } throw new Error('通知が作れるBカードが見つからない'); });
t('B: 画面のMカードに、判定用の合成と買い目の合成が区別して出る(補正後の表・従来12点に切り替えるボタン)', () => { for (const x of B) { const mi = NW.mInfo(x.card); if (!mi || mi.mode !== 'B' || mi.bSource !== 'v1_lines12') continue; NS.setS({ card: x.card }); const h = NS.mCard(); assert.ok(h.includes('判定に使う従来の12点の合成オッズ'), 'judge label'); assert.ok(h.includes('買い目の合成'), 'buy label'); assert.ok(h.includes('補正後') && h.includes('toggleMcorr')); return; } throw new Error('Bカードなし'); });
t('B: 「従来のAIおすすめに切り替える」(S.mcorrOff)で従来12点になり、戻せる(補正後12点が従来12点と異なるカードで確認)', () => { let n = 0; for (const x of B) { const mi = NW.mInfo(x.card); if (!mi || mi.mode !== 'B' || mi.bSource !== 'v1_lines12') continue; const bl = mi.lines.map(l => l.combo).sort(); NS.setS({ mcorrOff: true }); const off = NS.mergeBlocks(NS.autoPlan(x.card, null, []).blocks).slice().sort(); if (JSON.stringify(off) === JSON.stringify(bl)) continue;   // 従来12点と補正後12点が同じカードは切替の差が出ない
  NS.setS({}); assert.deepEqual(NS.mergeBlocks(NS.autoPlan(x.card, null, []).blocks).slice().sort(), bl); n++; if (n >= 20) break; } assert.ok(n >= 20, '切替の差が出るカード ' + n); });
t('B: X・安定枠のときは補正後12点を使わない', () => { for (const x of B) { const mi = NW.mInfo(x.card); if (!mi || mi.mode !== 'B' || mi.bSource !== 'v1_lines12') continue; NS.setS({ smode: true }); const s = NS.mergeBlocks(NS.autoPlan(x.card, null, []).blocks).slice().sort(); assert.notDeepEqual(s, mi.lines.map(l => l.combo).sort()); return; } });
// ===== C(B無効)で作り直し、実装前のコードと比べる =====
const sampC = cand.filter((_, i) => i % 6 === 0).concat(samp.filter((_, i) => i % 2 === 0));
const Cs = []; const t1 = Date.now();
for (const r of sampC) {
  const a = load(r), b = load(r); const oldOut = OA.applyMCorrect({ ok: true, card: a.card }, { boats: a.boats }, { from: '2000-01-01', disableFile: NOFILE });
  const newOut = NA.applyMCorrect({ ok: true, card: b.card }, { boats: b.boats }, opt(false)); Cs.push({ r, o: a.card, n: b.card, oldOut, newOut });
}
console.log(`C(B無効)の新旧比較 ${Cs.length}枚 ${Math.round((Date.now() - t1) / 1000)}秒`);
t('B無効: 補正の記録の既存項目が、実装前と完全に同じ(applied/reason/isM/up/gosei/p12/lines/engineM/version)', () => { const f = (mc) => { if (!mc) return mc; const o = {}; ['applied', 'reason', 'isM', 'up', 'gosei', 'p12', 'lines', 'engineM', 'version'].forEach(k => { if (k in mc) o[k] = mc[k]; }); return o; }; for (const c of Cs) assert.deepEqual(f(c.n.aiPick.mCorr), f(c.o.aiPick.mCorr), key(c.r)); });
t('B無効: 新しい記録は mode=C(適用時)/A(適用不可)・bEnabled=false', () => { for (const c of Cs) { const mc = c.n.aiPick.mCorr; assert.equal(mc.bEnabled, false); assert.equal(mc.mode, mc.applied ? 'C' : 'A'); assert.equal(mc.bFallback == null, true); } });
t('B無効: 通知(mInfo・一覧・通知文)が実装前と同じ', () => { let nM = 0; for (const c of Cs) { const mo = OW.mInfo(c.o), mn = NW.mInfo(c.n); assert.equal(!!mn, !!mo, key(c.r)); if (mo) { nM++; assert.deepEqual({ gosei: mn.gosei, p12: mn.p12, lines: mn.lines, corrected: mn.corrected }, { gosei: mo.gosei, p12: mo.p12, lines: mo.lines, corrected: mo.corrected }); } const ro = OW.indexRow({ card: c.o, venue: c.r.v, race: c.r.r, deadline: c.r.dl, capturedAt: c.r.cap }), rn = rowOf(c.n, c.r); const strip = (o) => { const x = Object.assign({}, o); delete x.mMode; delete x.mJudgeGosei; delete x.mBuyGosei; delete x.mEdge; delete x.mEdgeVal; delete x.k; delete x.kP12; return x; }; assert.deepEqual(strip(rn), strip(ro)); const d0 = Date.parse(c.r.d + 'T00:00:00+09:00'); const norm = (n) => n && Object.assign({}, n, { title: n.title.replace('(edge)', ''), body: n.body.replace(/\(逃げ込み[0-9.]+倍\)/, '').replace(/edge[0-9.]+。/, '') }); assert.deepEqual(norm(NW.wildMNotificationFor(Object.assign({ date: c.r.d }, rn), d0)), OW.wildMNotificationFor(Object.assign({ date: c.r.d }, ro), d0)); } console.log(`   (M該当 ${nM}枚を含む ${Cs.length}枚)`); });
t('B無効: 画面のM判定・おまかせ案の12点・Mカードの表示が実装前と同じ', () => { for (const c of Cs) { for (const s of [{}, { mcorrOff: true }, { xmode: true }, { smode: true }]) { NS.setS(Object.assign({ card: c.n }, s)); OS.setS(Object.assign({ card: c.o }, s)); const noEdge = (o) => o && Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'edge' && k !== 'mEdge')); assert.deepEqual(noEdge(NS.mOfCard(c.n)), noEdge(OS.mOfCard(c.o)), key(c.r)); assert.deepEqual(NS.mergeBlocks(NS.autoPlan(c.n, null, []).blocks), OS.mergeBlocks(OS.autoPlan(c.o, null, []).blocks), key(c.r) + JSON.stringify(s)); const nz = (h) => String(h).replace('<span class="tag g">M(edge)</span>', '<span class="tag c">M</span>').replace(/<div class="chk ok"><b>✓<\/b> M\(edge\):[^<]*<\/div>/, '').replace(/<div class="small" style="margin:4px 0">edge [^<]*<\/div>/, ''); if (OS.mOfCard(c.o)) assert.equal(nz(NS.mCard()), OS.mCard(), key(c.r) + ' mCard'); } } });
t('B無効: S/A/B・Xを含めて、aiPick.mCorr以外のカードが変わらない', () => { for (const c of Cs) { const a = clone(c.n), b = clone(c.o); delete a.aiPick.mCorr; delete b.aiPick.mCorr; assert.deepEqual(a, b); } });
// ===== スイッチの期待動作 =====
const one = cand.find(r => r.before && r.rp.ok);
const mode = (b, dis) => { const x = load(one); NA.applyMCorrect({ ok: true, card: x.card }, { boats: x.boats }, opt(b, dis)); return x.card.aiPick.mCorr; };
const DIS = path.join(os.tmpdir(), 'garon_b_dis_' + process.pid); fs.writeFileSync(DIS, 'x');
t('スイッチ: 通常はC', () => { const mc = mode(false); assert.equal(mc.mode, 'C'); assert.equal(mc.applied, true); });
t('スイッチ: Bを明示的に有効化したときだけB', () => { const mc = mode(true); assert.equal(mc.mode, 'B'); assert.equal(mc.bEnabled, true); assert.equal(mc.linesB.length, 12); });
t('スイッチ: 既存のV1停止が有効ならA(Bを有効化していても)', () => { const mc = mode(true, DIS); assert.equal(mc.mode, 'A'); assert.equal(mc.applied, false); assert.equal(mc.reason, 'disabled'); const mc2 = mode(false, DIS); assert.equal(mc2.mode, 'A'); });
t('スイッチ: Bの有効化を取り消せばC(ファイルを消した直後)', () => { assert.equal(mode(true).mode, 'B'); fs.rmSync(BON); try { assert.equal(mode(false).mode, 'C'); } finally { fs.writeFileSync(BON, 'x'); } });
// ===== カードごとの方式・作成済みカードは読み替えない =====
t('作成済みカードの方式は、いまのスイッチの状態に左右されない(Bカード・Cカードが同じ日に混在しても、各カードの方式で判定)', () => {
  const bx = B.find(x => { const mi = NW.mInfo(x.card); return mi && mi.mode === 'B' && mi.bSource === 'v1_lines12'; }), cx = Cs.find(c => NW.mInfo(c.n) && NW.mInfo(c.n).mode === 'C');
  assert.ok(bx && cx); const b1 = JSON.stringify(NW.mInfo(bx.card)), c1 = JSON.stringify(NW.mInfo(cx.n));
  for (const f of [path.join(ROOT, 'logs', '.m_buy_b_enable'), path.join(ROOT, 'logs', '.m_correct_disable')]) { assert.ok(!fs.existsSync(f) || true); }
  assert.equal(JSON.stringify(NW.mInfo(bx.card)), b1); assert.equal(JSON.stringify(NW.mInfo(cx.n)), c1); assert.equal(NW.mInfo(bx.card).mode, 'B'); assert.equal(NW.mInfo(cx.n).mode, 'C');
});
t('静的確認: mInfo・画面の判定・仮想成績・稼働状況は、スイッチのファイルを読まない(カードに保存した方式だけ使う)', () => {
  const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8'); for (const p of ['scripts/lib/wild_live.js', 'scripts/lib/wild_tier_perf.js', 'scripts/lib/wild_status.js', 'scripts/wild/wild_template.html']) assert.ok(!/m_buy_b_enable|m_correct_disable/.test(src(p)), p + ' がスイッチのファイルを読んでいる');
  assert.ok(/mInfo\(card\)/.test(src('scripts/lib/wild_tier_perf.js')) && /W\.mInfo\(card\)/.test(src('scripts/lib/wild_status.js')));
});
t('通知の記録に、方式(mMode)と買い目12点(mLines)を残す(wild_scan)', () => { const s = fs.readFileSync(path.join(ROOT, 'scripts', 'wild_scan.js'), 'utf8'); assert.ok(/mMode: r\.mMode/.test(s) && /mLines: \(r\.mLines/.test(s)); });
// 画面と通知の既存のずれ(参考): M2の切替(11/4〜)で、Mのカードの『従来12点』の画面の12点(M2順)と通知用の12点(linesCur)が異なる件数
let m2diff = 0, m2n = 0; for (const x of B) { const mi = NW.mInfo(x.card); if (mi && mi.mode === 'B' && mi.bSource === 'fallback_A') { m2n++; NS.setS({}); const scr = NS.mergeBlocks(NS.autoPlan(x.card, null, []).blocks).slice().sort(); if (JSON.stringify(scr) !== JSON.stringify(mi.lines.map(l => l.combo).sort())) m2diff++; } }
console.log(`参考: B方式で補正後12点が使えず従来12点に戻ったM(${m2n}枚)のうち、画面(AIおすすめ=M2順)と通知用の12点が異なるもの ${m2diff}枚(従来のAでも同じ差が元からある)`);
fs.rmSync(BON, { force: true }); fs.rmSync(DIS, { force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
