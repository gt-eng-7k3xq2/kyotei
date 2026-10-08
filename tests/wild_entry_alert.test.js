'use strict';
// 展示の進入が枠なりでないとき、WILDで通知したレースについて追加で通知する仕組みの試験(2026-10-08)。
// 公式サイトにも実際のntfyにも行かない(取得と送信を差し替える)。一時フォルダだけに書く。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), { spawnSync } = require('child_process');
const { entryAlertMessage } = require('../scripts/lib/wild_entry_alert');
const { recordFromEE, eeFromRecord, pickEntryTargets } = require('../scripts/lib/wild_entry_status');
let pass = 0, fail = 0; const t = (name, fn) => { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + e.message.split('\n')[0]); } };

// ---- 純粋な部品 ----
const changed = { ok: true, order: [1, 6, 3, 5, 2, 4], wakunari: false, courseOf: { 1: 1, 6: 2, 3: 3, 5: 4, 2: 5, 4: 6 }, moved: [{ lane: 2, course: 5 }, { lane: 4, course: 6 }, { lane: 5, course: 4 }, { lane: 6, course: 2 }], text: '163524' };
t('進入が枠なりでないとき、通知文にコース順・動いた艇・AIの第一候補のコースが入る', () => {
  const m = entryAlertMessage({ venue: '桐生', race: 12, deadline: '20:45', ee: changed, topWinner: 2, topTech: '差し' });
  assert(/【進入変更】桐生12R 締切20:45/.test(m.title)); assert(/❶→❻→❸→❺→❷→❹/.test(m.body)); assert(/❷は5コース/.test(m.body)); assert(/AIの第一候補の❷の差しは、5コースです/.test(m.body)); assert.strictEqual(m.priority, 4); });
t('第一候補が動いていないときは、優先度を下げ、第一候補の文を入れない', () => { const m = entryAlertMessage({ venue: '桐生', race: 12, deadline: '20:45', ee: changed, topWinner: 3, topTech: 'まくり' }); assert.strictEqual(m.priority, 3); assert(!/AIの第一候補/.test(m.body)); });
t('枠なり・取得失敗・未取得は通知しない(null)', () => {
  assert.strictEqual(entryAlertMessage({ venue: 'a', race: 1, deadline: '1:00', ee: { ok: true, wakunari: true, order: [1, 2, 3, 4, 5, 6] } }), null);
  assert.strictEqual(entryAlertMessage({ venue: 'a', race: 1, deadline: '1:00', ee: { ok: false, error: 'x' } }), null);
  assert.strictEqual(entryAlertMessage({ venue: 'a', race: 1, deadline: '1:00', ee: null }), null); });
t('記録: 取得結果から枠なり/前づけ/未掲載を作り、確定した記録は画面用の形に戻せる', () => {
  const rc = recordFromEE(changed, 1000); assert.strictEqual(rc.state, 'changed'); assert.strictEqual(rc.order, '163524');
  const back = eeFromRecord(rc); assert.deepStrictEqual(back.order, [1, 6, 3, 5, 2, 4]); assert.strictEqual(back.courseOf[2], 5); assert.strictEqual(back.wakunari, false);
  assert.strictEqual(recordFromEE({ ok: true, wakunari: true, text: '123456', moved: [] }, 1).state, 'wakunari');
  const pend = recordFromEE({ ok: false, error: 'x' }, 5); assert.strictEqual(pend.state, 'pending'); assert.strictEqual(eeFromRecord(pend), null); assert.strictEqual(eeFromRecord(null), null); });
t('取りに行く対象: 締切40分以内・締切前・未確定だけ。締切が近い順で最大件数。未掲載は間隔を空ける', () => {
  const dls = { r1: 10 * 60e3, r2: 30 * 60e3, r3: 50 * 60e3, r4: -60e3, r5: 20 * 60e3, r6: 5 * 60e3 };   // 締切までの時間(ms、now=0)
  const rows = Object.keys(dls).map((k) => ({ venue: 'v', race: Number(k.slice(1)), deadline: k })); const dl = (d, k) => dls[k];
  const entries = { v_5: { state: 'wakunari' }, v_6: { state: 'pending', lastTryMs: -30e3 } };
  const got = pickEntryTargets({ rows, entries, nowMs: 0, deadlineMs: dl, date: 'd', max: 10 }).map((r) => r.race);
  assert.deepStrictEqual(got, [1, 2]);   // r3は40分より先、r4は締切後、r5は確定済み、r6は未掲載で30秒前に試した(90秒未満)
  assert.deepStrictEqual(pickEntryTargets({ rows, entries: { v_6: { state: 'pending', lastTryMs: -100e3 } }, nowMs: 0, deadlineMs: dl, date: 'd', max: 2 }).map((r) => r.race), [6, 1]);   // 90秒以上たてば再確認。近い順で最大2件
});

// ---- wild_scan.js を実際に動かす(取得と送信は差し替え) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wildentry-')); const WILD = path.join(tmp, 'wild'), RAW = path.join(tmp, 'raw'); fs.mkdirSync(RAW, { recursive: true });
process.env.GARON_WILD_DIR = WILD; process.env.GARON_WILD_RAW_ROOT = RAW; delete process.env.GARON_WILD_ENTRY_ALERT; process.env.GARON_WILD_ENTRY_RETRY_MS = '0';
const W = require('../scripts/lib/wild_live'); const { todayDateStrJST } = require('../scripts/lib/jst_time');
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8')); const date = todayDateStrJST();
const sentLog = path.join(tmp, 'sent.jsonl'), cfgFile = path.join(tmp, 'entry_cfg.json'), calls = path.join(tmp, 'calls.jsonl');
const stub = path.join(tmp, 'stub.js');
const q = (p) => JSON.stringify(p);
fs.writeFileSync(stub, [
  "const fs = require('fs');",
  `const n = require(${q(path.join(__dirname, '..', 'scripts', 'lib', 'notify.js'))});`,
  `n.sendNtfyNotification = async (topic, o) => { fs.appendFileSync(${q(sentLog)}, JSON.stringify({ title: o.title, body: o.body, priority: o.priority }) + String.fromCharCode(10)); };`,
  `const e = require(${q(path.join(__dirname, '..', 'scripts', 'lib', 'official_entry.js'))});`,
  `e.fetchExhibitionEntry = async (a) => { fs.appendFileSync(${q(calls)}, JSON.stringify(a) + String.fromCharCode(10)); const c = JSON.parse(fs.readFileSync(${q(cfgFile)}, 'utf8')); return c[a.jcd] || { ok: false, error: 'none' }; };`,
  `const cf = require(${q(path.join(__dirname, '..', 'scripts', 'lib', 'config.js'))}); const o = cf.loadConfig; cf.loadConfig = () => Object.assign({}, o(), { NTFY_TOPIC: 'test-topic', RACE_OPS_PUBLIC_BASE_URL: '' });`,
].join(String.fromCharCode(10)));
function jstHHMM(m) { const d = new Date(Date.now() + 9 * 3600e3 + m * 60e3); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
function putCard(sm, tier, dl) { const card = JSON.parse(JSON.stringify(sm.card)); card.entry = Object.assign({}, card.entry, { tier }); W.writeJsonAtomic(W.cardFile(date, sm.venue, sm.race), { ok: true, rawTs: 9e15, venue: sm.venue, race: sm.race, deadline: dl, card }); }
const scan = (extraEnv) => spawnSync(process.execPath, ['--require', stub, path.join(__dirname, '..', 'scripts', 'wild_scan.js')], { env: Object.assign({}, process.env, extraEnv || {}), encoding: 'utf8' });
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((x) => JSON.parse(x)) : []);
const sents = () => lines(sentLog), callLog = () => lines(calls);
const jcd = (sm) => String(sm.card.venueCode).padStart(2, '0');
const [a, b, c, d] = samples;
putCard(a, 'strong', jstHHMM(9)); putCard(b, 'a', jstHHMM(12)); putCard(c, 'none', jstHHMM(9)); putCard(d, 'strong', jstHHMM(2));
fs.writeFileSync(cfgFile, JSON.stringify({ [jcd(a)]: changed }));   // aは進入が変わった。bは未掲載
const r1 = scan();
t('WILDの通知(a・b)と、aの進入変更の通知が出る(bは未掲載で通知なし)', () => { const s = sents(); assert.strictEqual(r1.status, 0, r1.stderr); const titles = s.map((x) => x.title); assert.strictEqual(titles.filter((x) => /^【WILD/.test(x)).length, 2, titles.join(' | ')); const al = s.filter((x) => /【進入変更】/.test(x.title)); assert.strictEqual(al.length, 1, titles.join(' | ')); assert(al[0].title.includes(a.venue + a.race + 'R')); assert(/枠なりではありません/.test(al[0].body)); });
t('目安以外(none)や3分を切ったレースも、展示の進入を記録する(未掲載はpending)。通知は目安のレースだけ', () => {
  const en = JSON.parse(fs.readFileSync(path.join(WILD, `entry_${date}.json`), 'utf8'));
  assert.strictEqual(en[a.venue + '_' + a.race].state, 'changed'); assert(en[c.venue + '_' + c.race], '目安外のレースを記録していない'); assert.strictEqual(en[c.venue + '_' + c.race].state, 'pending'); assert(en[d.venue + '_' + d.race], '3分を切ったレースを記録していない');
  const al = JSON.parse(fs.readFileSync(path.join(WILD, `entry_alert_${date}.json`), 'utf8')); assert(al[a.venue + '_' + a.race]); assert(!al[c.venue + '_' + c.race], '目安外に通知の記録がある'); });
const n1 = sents().length; scan();
t('2回目の見回りで、同じ進入変更を二重に通知しない', () => { const al = sents().filter((x) => /【進入変更】/.test(x.title)); assert.strictEqual(al.length, 1); assert.strictEqual(sents().length, n1); });
fs.writeFileSync(cfgFile, JSON.stringify({ [jcd(a)]: changed, [jcd(b)]: { ok: true, order: [1, 2, 3, 4, 5, 6], wakunari: true, text: '123456', moved: [], courseOf: {} } }));
scan();
t('未掲載だったbは、掲載後の見回りで確認され(枠なりなので通知なし)、確認済みのa・bは以後取得しない', () => {
  const alerts = JSON.parse(fs.readFileSync(path.join(WILD, `entry_alert_${date}.json`), 'utf8')); assert.strictEqual(alerts[b.venue + '_' + b.race].state, 'ok'); assert.strictEqual(alerts[a.venue + '_' + a.race].state, 'changed');
  assert.strictEqual(sents().filter((x) => /【進入変更】/.test(x.title)).length, 1);
  const cnt = (j) => callLog().filter((x) => x.jcd === j).length; const ca = cnt(jcd(a)), cb = cnt(jcd(b)); scan(); assert.strictEqual(cnt(jcd(a)), ca, 'aを再取得している'); assert.strictEqual(cnt(jcd(b)), cb, 'bを再取得している'); });
t('GARON_WILD_ENTRY_ALERT=0 のときは、進入の取得も通知もしない', () => { fs.rmSync(path.join(WILD, `entry_alert_${date}.json`)); fs.rmSync(path.join(WILD, `entry_${date}.json`)); const before = callLog().length, ns = sents().length; scan({ GARON_WILD_ENTRY_ALERT: '0' }); assert.strictEqual(callLog().length, before); assert.strictEqual(sents().length, ns); assert(!fs.existsSync(path.join(WILD, `entry_${date}.json`))); });
console.log(`\n${pass} 項目合格 / ${fail} 項目不合格`); if (fail) process.exitCode = 1;
