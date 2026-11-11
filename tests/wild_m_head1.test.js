'use strict';
// B方式のMの買い目の末尾2点を1号艇頭にする変更(2026-11-11、CEO承認)の試験。保存済みカードを使い、実際の applyMCorrect(Python含む)も呼ぶ。保存カード本体は書き換えない。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'scripts', 'lib', 'm_correct_apply'));
const W = require(path.join(ROOT, 'scripts', 'lib', 'wild_live'));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + ': ' + String(e.message).split('\n')[0]); } };
const dir = path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-11');
const files = fs.readdirSync(dir).filter(f => /\.json$/.test(f)).slice(0, 400);
const cards = []; for (const f of files) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (j.card && j.card.aiPick && j.card.aiPick.mCorr && j.card.aiPick.mCorr.applied && (j.card.aiPick.mCorr.linesB || []).length >= 12) cards.push(j); } catch (e) { /* skip */ } }
t('試験用のカードがある', () => assert(cards.length >= 20, 'カード ' + cards.length));
const co = cards.length ? cards[0].card.combos : null;
t('addHead1: 先頭10点はそのまま・末尾2点が1号艇頭・12点・重複なし(全カード)', () => {
  let n = 0;
  for (const j of cards) {
    const lb = j.card.aiPick.mCorr.linesB, h = A.addHead1(lb, j.card.combos); if (!h) continue; n++;
    assert.strictEqual(h.lines.length, 12);
    assert.deepStrictEqual(h.lines.slice(0, 10).map(l => l.combo), lb.slice(0, 10).map(l => l.combo));
    assert(h.lines.slice(10).every(l => l.combo[0] === '1' && l.odds >= 10 && l.head1 === true));
    assert.strictEqual(new Set(h.lines.map(l => l.combo)).size, 12);
    assert.deepStrictEqual(h.added, h.lines.slice(10).map(l => l.combo));
    const cand = Object.keys(j.card.combos).filter(c => c[0] === '1' && j.card.combos[c].odds >= 10).sort((a, b) => j.card.combos[b].enginePct - j.card.combos[a].enginePct);
    assert.strictEqual(h.lines[10].combo, cand[0]);   // 1号艇頭のうち、エンジン確率が最も高い出目
    assert(j.card.combos[h.lines[11].combo].enginePct <= j.card.combos[h.lines[10].combo].enginePct);
  }
  assert(n >= 20, '適用できたカード ' + n);
});
t('addHead1: 12点未満・1号艇頭が混ざる入力・候補不足は null(元のまま)', () => {
  const j = cards[0]; const lb = j.card.aiPick.mCorr.linesB;
  assert.strictEqual(A.addHead1(lb.slice(0, 11), j.card.combos), null);
  assert.strictEqual(A.addHead1(null, j.card.combos), null);
  assert.strictEqual(A.addHead1([{ combo: '1-2-3', odds: 20 }].concat(lb.slice(1)), j.card.combos), null);
  assert.strictEqual(A.addHead1(lb, {}), null);
});
t('addHead1: 買い目の入力を書き換えない', () => { const j = cards[0]; const before = JSON.stringify(j.card.aiPick.mCorr.linesB); A.addHead1(j.card.aiPick.mCorr.linesB, j.card.combos); assert.strictEqual(JSON.stringify(j.card.aiPick.mCorr.linesB), before); });
// ---- applyMCorrect 全体(Pythonを呼ぶ。数枚だけ) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'head1_'));
const bEn = path.join(tmp, 'b_enable'), h1Dis = path.join(tmp, 'h1_disable'), mDis = path.join(tmp, 'm_disable'); fs.writeFileSync(bEn, '');
function rawCtx(j) {   // 実際のカード作成と同じ入力(生データの preRaceInfo.boats)
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'boatcast_migration', 'raw_collected', '2026-11-11', `${j.venue}_${j.race}R_${j.rawTs}.json`), 'utf8'));
  return { boats: ((raw.collected || {}).preRaceInfo || {}).boats || [] };
}
const sample = cards.slice(0, 3);
function run(j, o) { const copy = JSON.parse(JSON.stringify(j)); copy.ok = true; const r = A.applyMCorrect(copy, rawCtx(j), Object.assign({ bEnableFile: bEn, disableFile: mDis, head1DisableFile: h1Dis }, o || {})); return { copy, r }; }
for (const j of sample) {
  const lbBefore = j.card.aiPick.mCorr.linesB.map(l => l.combo);
  t(`applyMCorrect(${j.venue}${j.race}R): 適用開始日前は元の12点・linesBOrigなし`, () => { const { copy, r } = run(j, { head1From: '2099-01-01' }); assert(r.applied, '適用できず: ' + r.reason); assert.strictEqual(copy.card.aiPick.mCorr.head1Added, null); assert.strictEqual(copy.card.aiPick.mCorr.linesBOrig, null); assert.strictEqual(copy.card.aiPick.mCorr.linesB.length, 12); });
  t(`applyMCorrect(${j.venue}${j.race}R): 適用後は末尾2点が1号艇頭、元の12点が linesBOrig に残る`, () => { const { copy, r } = run(j, { head1From: '2000-01-01' }); assert(r.applied, '適用できず: ' + r.reason); const mc = copy.card.aiPick.mCorr; assert.strictEqual(mc.mode, 'B'); assert.strictEqual(mc.linesB.length, 12); assert.strictEqual(mc.head1Added.length, 2); assert.strictEqual(mc.linesBOrig.length, 12); assert.deepStrictEqual(mc.linesB.slice(0, 10).map(l => l.combo), mc.linesBOrig.slice(0, 10).map(l => l.combo)); assert(mc.linesB.slice(10).every(l => l.combo[0] === '1')); });
  t(`applyMCorrect(${j.venue}${j.race}R): 停止ファイルがあれば元の12点`, () => { fs.writeFileSync(h1Dis, ''); try { const { copy, r } = run(j, { head1From: '2000-01-01' }); assert(r.applied, '適用できず: ' + r.reason); assert.strictEqual(copy.card.aiPick.mCorr.head1Added, null); assert(copy.card.aiPick.mCorr.linesB.every(l => l.combo[0] !== '1')); } finally { fs.rmSync(h1Dis, { force: true }); } });
}
t('applyMCorrect: Bが有効でない(C方式)カードには足さない', () => { fs.rmSync(bEn, { force: true }); try { const { copy, r } = run(sample[0], { head1From: '2000-01-01' }); assert(r.applied, '適用できず: ' + r.reason); assert.strictEqual(copy.card.aiPick.mCorr.mode, 'C'); assert.strictEqual(copy.card.aiPick.mCorr.head1Added, null); } finally { fs.writeFileSync(bEn, ''); } });
// ---- 通知・画面の入口(mInfo): B方式のカードの買い目 = linesB(1号艇頭2点入り)、判定は従来のまま ----
t('mInfo: B方式の買い目は linesB の12点(1号艇頭2点入り)。判定の合成・確率合計は従来の12点のまま', () => {
  let n = 0;
  for (const j of cards) { const c = JSON.parse(JSON.stringify(j.card)); const h = A.addHead1(c.aiPick.mCorr.linesB, c.combos); if (!h) continue; c.aiPick.mCorr.linesB = h.lines; c.aiPick.mCorr.mode = 'B'; const m = W.mInfo(c); if (!m) continue; n++; assert.strictEqual(m.mode, 'B'); assert.strictEqual(m.lines.length, 12); assert.deepStrictEqual(m.lines.map(l => l.combo), h.lines.map(l => l.combo)); assert(m.judgeGosei != null); const orig = W.mInfo(j.card); assert.strictEqual(m.judgeGosei, orig.judgeGosei); }
  assert(n >= 3, 'M対象 ' + n);
});
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n合格 ${pass} / 失敗 ${fail}`); process.exit(fail ? 1 : 0);
