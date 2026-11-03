'use strict';
// M2並行比較(シャドー)の試験(2026-11-03)。node tests/m2_shadow.test.js
// 一時ディレクトリで実行し、本番のlogsには書かない。Python照合は、評価基盤(research/eval_harness_20261103)とvenvが無ければ省略する。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'scripts', 'lib', 'm2_shadow')), L = require(path.join(ROOT, 'scripts', 'lib', 'decision_ledger'));
let pass = 0, fail = 0; const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } };
const params = S.loadParams();
const mkCard = (over = {}) => {   // 合成カード: 120通り、オッズはΣ(1/o)=1.336になるよう調整
  const raw = S.COMBOS.map((c, i) => 8 + ((i * 37) % 97) + (i % 7) * 3.1), s = raw.reduce((a, o) => a + 1 / o, 0), k = s / 1.336, O = raw.map(o => Math.round(o * k * 10) / 10);
  const e = S.COMBOS.map((c, i) => Math.exp(-i / 40)), es = e.reduce((a, b) => a + b, 0), cb = {}; S.COMBOS.forEach((c, i) => { cb[c] = { odds: O[i], enginePct: Math.round(e[i] / es * 10000) / 100 }; });
  const j = { rawTs: 1, ok: true, venue: '鳴門', race: 5, deadline: '10:22', capturedAt: '2026-11-04T01:14:00.000Z', engineFromJudgment: true, card: { raceDate: '2026-11-04', venueCode: 14, combos: cb, entry: {}, aiPick: { lines: [] } } };
  return Object.assign(j, over);
};
const dl = '2026-11-04T10:22:00+09:00', cap = '2026-11-04T01:14:00.000Z';   // 締切8分前
t('市場確率とM2確率は合計1で、M2は決定論的', () => {
  const j = mkCard(), { P, O } = S.cardVectors(j.card), q = S.marketProb(O), m = S.m2Prob(P, O, params), m2 = S.m2Prob(P, O, params);
  assert(Math.abs(q.reduce((a, b) => a + b, 0) - 1) < 1e-12); assert(Math.abs(m.reduce((a, b) => a + b, 0) - 1) < 1e-12); assert.deepStrictEqual(m, m2); assert(m.every(v => v > 0));
});
t('凍結パラメータ: M2-v1、重み、表示不可', () => { assert.strictEqual(params.version, 'M2-v1'); assert(Math.abs(params.a - 0.5711693646939235) < 1e-12 && Math.abs(params.b - 0.5568688963860039) < 1e-12); assert.strictEqual(params.displayAllowed, false); assert.strictEqual(params.evaluationStart, '2026-11-04'); });
t('正常なカード: 現行もM2も12点が作れ、戻さない', () => { const sh = S.buildShadow(mkCard(), new Date(), params); assert(sh.chk.ok); assert(sh.used); assert.strictEqual(sh.cur.lines12.length, 12); assert.strictEqual(sh.m2.lines12.length, 12); assert.deepStrictEqual(sh.fallbackReasons, []); });
const chk = (mut, expect, c = cap) => { const j = mkCard(); mut(j.card); const r = S.checkInputs(j.card, c, dl, params); assert(!r.ok, '戻すべき'); assert(r.reasons.includes(expect), `理由 ${expect} が無い: ${r.reasons}`); return r; };
t('戻す条件 O1: オッズがnull', () => chk(c => { c.combos['1-2-3'].odds = null; }, 'odds_missing'));
t('戻す条件 O1: オッズが0以下', () => chk(c => { c.combos['2-3-4'].odds = 0; }, 'odds_missing'));
t('戻す条件 O1: オッズがNaN', () => chk(c => { c.combos['2-3-4'].odds = NaN; }, 'odds_missing'));
t('戻す条件 O1: 組が欠けている', () => chk(c => { delete c.combos['6-5-4']; }, 'odds_missing'));
t('戻す条件 O2: Σ(1/オッズ)が範囲外(オッズを1割ずらす)', () => chk(c => { for (const k of S.COMBOS) c.combos[k].odds = c.combos[k].odds * 1.1; }, 'odds_sum_out_of_range'));
t('戻す条件 E1: エンジン確率が欠けている', () => chk(c => { c.combos['1-2-3'].enginePct = null; }, 'engine_missing'));
t('戻す条件 E2: Σ enginePctが範囲外', () => chk(c => { for (const k of S.COMBOS) c.combos[k].enginePct *= 1.05; }, 'engine_sum_out_of_range'));
t('戻す条件 T1: 取得時刻が無い', () => { const r = S.checkInputs(mkCard().card, undefined, dl, params); assert(r.reasons.includes('timestamp_missing')); });
t('戻す条件 T2: 締切1分前(遅すぎ)と16分前(早すぎ)は戻す。2分・15分ちょうどは使う', () => {
  const at = (min) => new Date(Date.parse(dl) - min * 60000).toISOString();
  assert(S.checkInputs(mkCard().card, at(1), dl, params).reasons.includes('odds_stale_or_early')); assert(S.checkInputs(mkCard().card, at(16), dl, params).reasons.includes('odds_stale_or_early'));
  assert(S.checkInputs(mkCard().card, at(2), dl, params).ok); assert(S.checkInputs(mkCard().card, at(15), dl, params).ok); assert(S.checkInputs(mkCard().card, at(-3), dl, params).reasons.includes('odds_stale_or_early'));
});
t('パラメータが読めない/不正なら戻す(params_unavailable)', () => { const r = S.checkInputs(mkCard().card, cap, dl, null); assert(!r.ok && r.reasons.includes('params_unavailable')); assert.throws(() => S.loadParams(path.join(os.tmpdir(), 'no-such-params.json'))); });
t('戻したとき、M2の列は現行と同じになる(buildShadow: used=false、m2=null)', () => { const j = mkCard(); j.card.combos['1-2-3'].odds = null; const sh = S.buildShadow(j, new Date(), params); assert(!sh.used); assert.strictEqual(sh.m2, null); assert(sh.fallbackReasons.includes('odds_missing')); assert.strictEqual(sh.cur, null); });
t('現行の再計算は、研究用のPython版と同じ買い目・ランク(合成カード)', () => { const sh = S.buildShadow(mkCard(), new Date(), params); assert(sh.cur.lines12.every(c => !c.startsWith('1-'))); const o = sh.O; assert(sh.cur.lines12.every(c => o[S.COMBOS.indexOf(c)] >= 10)); const heads = {}; sh.cur.lines13.forEach(c => { heads[c[0]] = (heads[c[0]] || 0) + 1; }); assert(Object.values(heads).every(v => v <= 8)); });
// ---- 実カードでのPython照合
const py = path.join(ROOT, 'research', '_venv_oof_sw_2026-09-05', 'Scripts', 'python.exe'), ref = path.join(ROOT, 'tests', 'lib', 'm2_parity_ref.py');
if (fs.existsSync(py) && fs.existsSync(path.join(ROOT, 'research', 'eval_harness_20261103', 'rules.py')) && fs.existsSync(path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-01'))) {
  t('実カード(11/1の最大700枚のうち、オッズが120通りそろうもの)で、JS版とPython版が一致(12点・ランク・p12・M2の確率・M/X)', () => {
    const out = JSON.parse(cp.execFileSync(py, [ref, '2026-11-01', '700'], { encoding: 'utf8', maxBuffer: 1 << 26 })); assert(out.length >= 150, '照合件数が少ない: ' + out.length);
    let n = 0, ordDiff = 0;
    for (const r of out) {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-01', r.file), 'utf8')); const { P, O } = S.cardVectors(j.card);
      const f0 = S.raceFeatures(P, O), pm = S.m2Prob(P, O, params), f2 = S.raceFeatures(pm, O);
      assert.deepStrictEqual([...f0.lines12].sort(), [...r.l0].sort(), r.file + ' 現行の12点'); assert.deepStrictEqual([...f2.lines12].sort(), [...r.l2].sort(), r.file + ' M2の12点');
      if (f0.lines12.join() !== r.l0.join() || f2.lines12.join() !== r.l2.join()) ordDiff++;
      assert.strictEqual(f0.rank, r.r0, r.file + ' 現行ランク'); assert.strictEqual(f2.rank, r.r2, r.file + ' M2ランク'); assert.strictEqual(f0.M, r.m0); assert.strictEqual(f2.M, r.m2); assert.strictEqual(f0.X, r.x0); assert.strictEqual(f2.X, r.x2);
      assert(Math.abs(f0.p12 - r.p12_0) < 1e-9 && Math.abs(f2.p12 - r.p12_2) < 1e-9, r.file + ' p12'); r.pm_head.forEach((v, i) => assert(Math.abs(v - pm[i]) < 1e-9, r.file + ' M2確率')); n++;
    }
    console.log(`   照合 ${n}件(並びだけ違う ${ordDiff}件=同率の順序)`);
  });
} else console.log('SKIP Python照合(評価基盤またはvenvが無い)');
// ---- 台帳
const mkBody = (over = {}) => L.decisionBody(Object.assign({
  raceKey: { date: '2026-11-04', venueCode: 14, venue: '鳴門', race: 5 }, deadlineJst: dl, capturedAtUtc: cap, oddsSource: { name: 'card', takenAtUtc: cap, odds120: S.COMBOS.map((c, i) => 10 + i / 10) },
  model: { engineSha256: 'e'.repeat(64), marketModel: { version: 'M2-v1' } }, prediction: { p120: S.COMBOS.map(() => 1 / 120), pM2_120: S.COMBOS.map(() => 1 / 120) }, bets: { current: { lines12: ['3-4-2'] }, m2: { lines12: ['3-4-2'] } },
  selection: { current: { rank: null, reasons: [{ rule: 'B', passed: false }] }, m2: { rank: null, reasons: [{ rule: 'B', passed: false }] }, fallback: { used: false, reasons: [] } } }, over));
t('台帳: 追記・冪等・検証・封印・改ざん検出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'led-')), d = '2026-11-04';
  assert(L.append(dir, d, 'decision', mkBody()).written); assert(!L.append(dir, d, 'decision', mkBody()).written); assert(L.verify(dir, d).ok);
  const f = path.join(dir, d + '.jsonl'), txt = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, txt.replace('"venue":"鳴門"', '"venue":"津"')); assert(!L.verify(dir, d).ok); fs.writeFileSync(f, txt); assert(L.verify(dir, d).ok);
  L.seal(dir, d); assert.throws(() => L.append(dir, d, 'result', { raceKey: {}, decisionId: 'x' }), /封印/);
});
t('台帳: 必須項目(判断用オッズ・取得時刻・モデルの版・選別理由)が欠けると拒否', () => {
  assert.throws(() => L.decisionBody({ raceKey: {} }), /必須/); const b = { raceKey: {}, deadlineJst: dl, capturedAtUtc: cap, oddsSource: { odds120: [] }, model: {}, prediction: {}, bets: {}, selection: {} };
  assert.throws(() => L.decisionBody(b), /オッズ/); b.oddsSource = { takenAtUtc: cap, odds120: [1] }; assert.throws(() => L.decisionBody(b), /モデルの版/); b.model = { engineSha256: 'x' }; assert.throws(() => L.decisionBody(b), /選別理由/);
});
// ---- 実行体の統合試験(一時ディレクトリ)
const node = process.execPath, run = (args) => cp.spawnSync(node, [path.join(ROOT, 'scripts', 'm2_shadow_run.js'), ...args], { encoding: 'utf8' });
t('実行体: 正常・オッズ欠損・壊れたJSONが混ざっても止まらず、台帳に正しく記録される。カードは変更されない', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm2run-')), cards = path.join(tmp, 'cards', '2026-11-04'); fs.mkdirSync(cards, { recursive: true });
  fs.writeFileSync(path.join(cards, '鳴門_5R.json'), JSON.stringify(mkCard())); const bad = mkCard(); bad.race = 6; bad.card.combos['1-2-3'].odds = null; fs.writeFileSync(path.join(cards, '鳴門_6R.json'), JSON.stringify(bad));
  fs.writeFileSync(path.join(cards, '鳴門_7R.json'), '{"card": {壊れた'); const late = mkCard(); late.race = 8; late.capturedAt = '2026-11-04T01:21:30.000Z'; fs.writeFileSync(path.join(cards, '鳴門_8R.json'), JSON.stringify(late));
  const old = new Date(Date.now() - 60000); for (const f of fs.readdirSync(cards)) fs.utimesSync(path.join(cards, f), old, old);   // 書き込み直後のスキップを避ける
  const before = fs.readdirSync(cards).map(f => f + fs.statSync(path.join(cards, f)).mtimeMs + fs.statSync(path.join(cards, f)).size).join('|');
  const args = ['--once', '--date=2026-11-04', '--dir=' + path.join(tmp, 'ledger'), '--cards=' + path.join(tmp, 'cards'), '--state=' + path.join(tmp, 'state.json')];
  const r = run(args); assert.strictEqual(r.status, 0, r.stderr); assert(/追記3 .*現行へ戻した2 失敗1/.test(r.stdout), r.stdout);
  const v = L.verify(path.join(tmp, 'ledger'), '2026-11-04'); assert(v.ok && v.count === 3, JSON.stringify(v));
  const rows = L.readAll(path.join(tmp, 'ledger', '2026-11-04.jsonl')).map(x => x.body), ok = rows.find(b => b.raceKey.race === 5), miss = rows.find(b => b.raceKey.race === 6), lt = rows.find(b => b.raceKey.race === 8);
  assert.strictEqual(ok.selection.fallback.used, false); assert.strictEqual(ok.model.displayAllowed, false); assert.strictEqual(ok.model.marketModel.version, 'M2-v1'); assert(ok.model.engineSha256 && ok.model.ruleVersion && ok.model.featureCodeVersion); assert.strictEqual(ok.prediction.pM2_120.length, 120);
  assert(ok.oddsSource.takenAtUtc && ok.oddsSource.oddsSha256 && ok.oddsSource.nullMask.length === 120 && ok.tMinusSec === 480); assert(ok.selection.current.reasons.length >= 4 && ok.selection.m2.reasons.length >= 4);
  assert.strictEqual(miss.selection.fallback.used, true); assert(miss.selection.fallback.reasons.includes('odds_missing')); assert.strictEqual(miss.prediction.pM2_120, null); assert.deepStrictEqual(miss.bets.m2.lines12, miss.bets.current.lines12); assert.strictEqual(miss.bets.m2.usedFallback, true);
  assert.strictEqual(lt.selection.fallback.used, true); assert(lt.selection.fallback.reasons.includes('odds_stale_or_early'));
  const r2 = run(args); assert(/追記0 重複0/.test(r2.stdout), '2回目は何も追記しない: ' + r2.stdout);   // 状態ファイルにより再処理しない
  fs.unlinkSync(path.join(tmp, 'state.json')); const r3 = run(args); assert(/追記0 重複3/.test(r3.stdout), '状態が消えても二重に記録されない(冪等): ' + r3.stdout);
  const after = fs.readdirSync(cards).map(f => f + fs.statSync(path.join(cards, f)).mtimeMs + fs.statSync(path.join(cards, f)).size).join('|'); assert.strictEqual(before, after, 'カードは変更されない');
});
t('実行体: 停止フラグがあれば何もせず終了', () => { const flag = path.join(ROOT, 'logs', '.m2_shadow_disable'); assert(!fs.existsSync(flag), '本番の停止フラグが存在するため試験できない'); fs.writeFileSync(flag, 'x'); try { const r = run(['--once', '--dry-run', '--date=2026-11-02']); assert.strictEqual(r.status, 0); assert(/停止フラグ/.test(r.stdout)); } finally { fs.unlinkSync(flag); } });
t('実行体: パラメータが読めないときは全て現行へ戻す(記録は続ける)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm2np-')), cards = path.join(tmp, 'cards', '2026-11-04'); fs.mkdirSync(cards, { recursive: true }); fs.writeFileSync(path.join(cards, '鳴門_5R.json'), JSON.stringify(mkCard())); const old = new Date(Date.now() - 60000); fs.utimesSync(path.join(cards, '鳴門_5R.json'), old, old);
  const r = run(['--once', '--date=2026-11-04', '--dir=' + path.join(tmp, 'l'), '--cards=' + path.join(tmp, 'cards'), '--state=' + path.join(tmp, 's.json'), '--params=' + path.join(tmp, 'none.json')]); assert.strictEqual(r.status, 0, r.stderr);
  const b = L.readAll(path.join(tmp, 'l', '2026-11-04.jsonl'))[0].body; assert.strictEqual(b.selection.fallback.used, true); assert(b.selection.fallback.reasons.includes('params_unavailable'));
});
// ---- 結果照合と集計(実カード・実結果で、一時台帳に)
t('結果照合と集計: 実カード40件を台帳に作り、結果と通知後オッズを追記し、集計が出る', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm2rec-')), ledger = path.join(tmp, 'ledger'), dateDir = path.join(ROOT, 'logs', 'wild', 'cards', '2026-11-01');
  if (!fs.existsSync(dateDir)) return;
  const cards = path.join(tmp, 'cards', '2026-11-01'); fs.mkdirSync(cards, { recursive: true }); const old = new Date(Date.now() - 60000);
  for (const f of fs.readdirSync(dateDir).slice(0, 60)) { fs.copyFileSync(path.join(dateDir, f), path.join(cards, f)); fs.utimesSync(path.join(cards, f), old, old); }
  const r = run(['--once', '--date=2026-11-01', '--dir=' + ledger, '--cards=' + path.join(tmp, 'cards'), '--state=' + path.join(tmp, 's.json')]); assert.strictEqual(r.status, 0, r.stderr);
  const rc = cp.spawnSync(node, [path.join(ROOT, 'scripts', 'm2_shadow_reconcile.js'), '--dir=' + ledger, '--no-seal'], { encoding: 'utf8' }); assert.strictEqual(rc.status, 0, rc.stderr); assert(/result [1-9]/.test(rc.stdout), rc.stdout);
  assert(L.verify(ledger, '2026-11-01').ok);
  const rp = cp.spawnSync(node, [path.join(ROOT, 'scripts', 'm2_shadow_report.js'), '--dir=' + ledger, '--from=2026-11-01', '--out=' + path.join(tmp, 'r.md')], { encoding: 'utf8' }); assert.strictEqual(rp.status, 0, rp.stderr);
  const md = fs.readFileSync(path.join(tmp, 'r.md'), 'utf8'); assert(/現行方式へ戻した判断/.test(md)); assert(/全レースAI12点の回収率/.test(md)); assert(/凍結した採用条件/.test(md));
});
// ---- 分離(通知処理への影響が無いこと)の静的確認
t('分離: 並行比較のコードは、通知・画面・カード作成のコードを読み込まず、書き込み先は台帳とログのみ', () => {
  const files = ['scripts/m2_shadow_run.js', 'scripts/lib/m2_shadow.js', 'scripts/m2_shadow_reconcile.js', 'scripts/m2_shadow_report.js', 'scripts/lib/decision_ledger.js'];
  for (const f of files) { const s = fs.readFileSync(path.join(ROOT, f), 'utf8'); assert(!/require\([^)]*(wild_scan|wild_live|notify|race_ops|realtime_screening|wild_status)/.test(s), f + ' が通知・カード作成系を読み込んでいる'); assert(!/ntfy|sendNtfy/i.test(s.replace(/\/\/.*$/gm, '')), f + ' に通知の呼び出しがある'); }
  const run_ = fs.readFileSync(path.join(ROOT, 'scripts/m2_shadow_run.js'), 'utf8'); assert(!/writeFileSync\([^)]*CARDS_DIR|writeFileSync\(fp/.test(run_), 'カードへ書き込んでいる');
  for (const f of ['scripts/wild_scan.js', 'scripts/lib/wild_live.js', 'scripts/wild/race_card.py', 'scripts/wild/wild_template.html']) assert(!/m2_shadow|decision_ledger/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f + ' がM2のコードを参照している(分離が崩れる)');
});
console.log(`\n${pass}件 通過 / ${fail}件 失敗`); process.exitCode = fail ? 1 : 0;
