'use strict';
// GARON-WILD の ntfy通知(裏方 wild_scan.js)の試験(2026-09-26)。実際のntfyには送らない(送信関数を差し替える)。一時フォルダだけに書く。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wildnotify-'));
const WILD = path.join(tmp, 'wild'), RAW = path.join(tmp, 'raw'); fs.mkdirSync(RAW, { recursive: true });
process.env.GARON_WILD_DIR = WILD; process.env.GARON_WILD_RAW_ROOT = RAW;
process.env.GARON_WILD_ENTRY_ALERT = '0';   // 2026-10-08: 展示の進入の通知(公式サイトへ取りに行く)は、この試験では切る。別の試験(wild_entry_alert.test.js)で確かめる
const W = require('../scripts/lib/wild_live');
const { todayDateStrJST } = require('../scripts/lib/jst_time');
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8'));
const date = todayDateStrJST();

// 送信関数の差し替え(記録だけ)。FAILが立っているあいだは失敗させる
const stub = path.join(tmp, 'stub.js'), sentLog = path.join(tmp, 'sent.jsonl'), failFlag = path.join(tmp, 'FAIL');
fs.writeFileSync(stub, `const n=require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'lib', 'notify.js'))});const fs=require('fs');
n.sendNtfyNotification=async(topic,o)=>{ if(fs.existsSync(${JSON.stringify(failFlag)})) throw new Error('offline'); fs.appendFileSync(${JSON.stringify(sentLog)},JSON.stringify({topic:!!topic,title:o.title,body:o.body,priority:o.priority,click:o.click||null})+'\\n'); return true; };`);
function jstHHMM(offsetMin) { const d = new Date(Date.now() + 9 * 3600e3 + offsetMin * 60e3); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
function putCard(sm, tier, deadline) {
  const card = JSON.parse(JSON.stringify(sm.card)); card.entry = Object.assign({}, card.entry, { tier, rank: tier === 'strong' ? 'S' : tier === 'a' ? 'A' : null });
  W.writeJsonAtomic(W.cardFile(date, sm.venue, sm.race), { ok: true, rawTs: 9e15, venue: sm.venue, race: sm.race, deadline, card });
}
function scan() { return spawnSync(process.execPath, ['--require', stub, path.join(__dirname, '..', 'scripts', 'wild_scan.js')], { env: process.env, encoding: 'utf8' }); }
const sent = () => (fs.existsSync(sentLog) ? fs.readFileSync(sentLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

let pass = 0, fail = 0; const t = (name, fn) => { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + e.message.split('\n')[0]); } };
const [a, b, c, d] = samples;
putCard(a, 'strong', jstHHMM(9));      // 9分後、強 → 送る
putCard(b, 'a', jstHHMM(12));          // 12分後、候補 → 送る
putCard(c, 'none', jstHHMM(9));        // 対象外 → 送らない
putCard(d, 'strong', jstHHMM(2));      // 2分後(3分を切っている) → 送らない

t('ランクS・A・Bだけ通知する(対象外・締切3分前を切ったものは送らない)', () => {
  const r = scan(); assert.equal(r.status, 0, r.stderr);
  const s = sent(); assert.equal(s.length, 2, JSON.stringify(s.map(x => x.title)));
  const strong = s.find(x => x.title.includes('WILD S')), cand = s.find(x => x.title.includes('WILD A'));
  assert.ok(strong && strong.title.includes(a.venue + a.race + 'R') && strong.priority === 4);
  assert.ok(cand && cand.title.includes(b.venue + b.race + 'R') && cand.priority === 3);
  assert.ok(s.every(x => x.topic === true));
  assert.ok(s.every(x => x.click === null || /\/wild$/.test(x.click)), 'タップ先は /wild');
});
t('同じレースは、2回目以降の実行で再送しない(二重送信防止)', () => {
  scan(); scan(); assert.equal(sent().length, 2);
  const n = W.readJson(W.notifiedFile(date), {}); assert.equal(Object.keys(n).length, 2);
});
t('送信に失敗したときは、記録せず、次の回で再試行する。カード作成・索引は止まらない', () => {
  putCard(samples[2], 'strong', jstHHMM(8)); fs.writeFileSync(failFlag, '1');
  const r = scan(); assert.equal(r.status, 0, r.stderr); assert.ok(/通知の送信に失敗/.test(r.stdout));
  assert.equal(sent().length, 2);                                    // 増えていない
  assert.ok(!W.readJson(W.notifiedFile(date), {})[samples[2].venue + '_' + samples[2].race]);   // 記録もされない
  assert.ok(W.readJson(W.indexFile(date), null));                    // 索引は更新されている
  fs.rmSync(failFlag); scan(); assert.equal(sent().length, 3);       // 復旧したら送る
});
t('環境変数で通知を止められる(GARON_WILD_NOTIFY=0)', () => {
  putCard(samples[3], 'strong', jstHHMM(8));
  const r = spawnSync(process.execPath, ['--require', stub, path.join(__dirname, '..', 'scripts', 'wild_scan.js')], { env: Object.assign({}, process.env, { GARON_WILD_NOTIFY: '0' }), encoding: 'utf8' });
  assert.equal(r.status, 0); assert.equal(sent().length, 3);
});
// ---- 通知X(2026-10-19): ランクとは別に、card.entry.x が立ったレースを【WILD X】で通知する(12点、1日の上限あり、締切3分前を切ったら送らない) ----
function putCardX(sm, deadline, on) {
  const card = JSON.parse(JSON.stringify(sm.card)); card.entry = Object.assign({}, card.entry, { tier: 'none', rank: null, x: on, xP12: 0.16 });
  card.aiPick = Object.assign({}, card.aiPick, { xLines: Array.from({ length: 12 }, (_, i) => ({ combo: '2-3-' + (4 + (i % 3)), odds: 101 + i, enginePct: 1.3 })) });
  W.writeJsonAtomic(W.cardFile(date, sm.venue, sm.race), { ok: true, rawTs: 9e15, venue: sm.venue, race: sm.race, deadline, card });
}
t('通知X: 基準以上(x)のレースを【WILD X】で1回だけ通知する(ランクS・A・Bと同じ文言)', () => {
  const before = sent().length; putCardX(samples[3], jstHHMM(9), true);
  const r = scan(); assert.equal(r.status, 0, r.stderr);
  const xs = sent().filter(x => x.title.includes('【WILD X】')); assert.equal(xs.length, 1, JSON.stringify(sent().map(x => x.title)));
  assert.ok(xs[0].title.includes(samples[3].venue + samples[3].race + 'R') && xs[0].priority === 3);
  assert.equal(sent().length, before + 1);
  scan(); assert.equal(sent().filter(x => x.title.includes('【WILD X】')).length, 1, '2回目は再送しない');
  assert.ok(W.readJson(W.notifiedFile(date), {})['X_' + samples[3].venue + '_' + samples[3].race], '通知済みの記録(X_キー)');
});
t('通知X: xが立っていない・締切3分前を切った場合は送らない(1日の上限は無し)', () => {
  const n0 = sent().filter(x => x.title.includes('【WILD X】')).length;
  putCardX(samples[2], jstHHMM(9), false); scan(); assert.equal(sent().filter(x => x.title.includes('【WILD X】')).length, n0, 'xなしは送らない');
  putCardX(samples[2], jstHHMM(2), true); scan(); assert.equal(sent().filter(x => x.title.includes('【WILD X】')).length, n0, '締切3分前を切ったら送らない');
  const nf = W.readJson(W.notifiedFile(date), {}); for (let i = 0; i < 12; i++) nf['X_dummy_' + i] = { at: 'x' }; W.writeJsonAtomic(W.notifiedFile(date), nf);
  putCardX(samples[2], jstHHMM(9), true); scan(); assert.equal(sent().filter(x => x.title.includes('【WILD X】')).length, n0 + 1, '1日の上限は無い: 通知済みが12本あっても、条件に当てはまれば送る');
});
t('本番の logs/wild には書き込んでいない', () => { assert.ok(W.WILD_DIR.startsWith(tmp)); });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
