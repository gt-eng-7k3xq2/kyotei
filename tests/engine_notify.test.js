'use strict';
// 独自エンジンの通知(boatcast_migration/scripts/lib/engine_notify.js)のテスト。実行: node tests/engine_notify.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const N = require('../boatcast_migration/scripts/lib/engine_notify');

let passed = 0; const failed = [];
function t(name, fn) { try { fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed.push(name); console.log('FAIL  ' + name + ': ' + e.message); } }

// 偽のエンジン結果: 1号艇が本命。120通りの確率は 1着確率 × 2着 × 3着 の積で作り、合計1に正規化する
function fakeEngine(boatWin, top1p) {
  const combos = [];
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) { if (b === a) continue; for (let c = 1; c <= 6; c++) { if (c === a || c === b) continue; combos.push([a, b, c]); } }
  const w = combos.map(([a, b, c]) => boatWin[a - 1] * boatWin[b - 1] * boatWin[c - 1]); const sum = w.reduce((x, y) => x + y, 0);
  const probs = w.map(x => x / sum);
  const order = probs.map((p, i) => i).sort((i, j) => probs[j] - probs[i]);
  const top = order.slice(0, 40).map(i => ({ combo: combos[i].join('-'), p: probs[i] }));
  const stat = (k, label, value, rank) => ({ k, label, value, note: '', rank, tone: rank <= 2 ? 'good' : 'flat' });
  const boats = [1, 2, 3, 4, 5, 6].map(no => ({ lane: no, name: '', p1: boatWin[no - 1], p2: 0.2, p3: 0.15, contrib: {}, comment: `1着確率${Math.round(boatWin[no - 1] * 100)}%。押し上げ: この枠での実績(+9pt)`,
    stats: [stat('lane180', 'この枠の勝率(直近半年)', '50%', no), stat('venueLane', 'この水面のこの枠の平均勝率', '40%', no), stat('st', 'この枠のスタート平均', '0.15秒', no), stat('form', '直近10走の平均着順', '3.2', no), stat('motor', 'モーター2連率(番組表)', '35.0%', no)] }));
  return { ok: true, engine: 'GARON-DB-3STAGE-V1', stateDay: '2026-09-18', top1p, cum10: top.slice(0, 10).reduce((s, x) => s + x.p, 0), cum12: top.slice(0, 12).reduce((s, x) => s + x.p, 0),
    boatWin, probs, top, explain: { groups: [], boats, race: ['1号艇が抜けた本命。', '2着に残りやすいのは2号艇。'] } };
}
const collected = { deadlineTime: '12:30', playerStats: { ok: true, boats: [1, 2, 3, 4, 5, 6].map(no => ({ waku: no, toban: `1${4000 + no}`, kyubetsu: 'A1', name: ['長尾　　章平', '船岡　洋一郎', '松山　　将吾', '安河内　　健', '石渡　翔一郎', '安河内　　将'][no - 1], subinfo: '山　口/山　口/41',
  nationalWinRate: '6.00', nationalNiren: '45.0', localWinRate: '5.50', localNiren: '42.0', motorNo: String(10 + no), motorNiren: '35.0', boatNo: String(20 + no), boatNiren: '33.0' })) },
  preRaceInfo: { ok: true, boats: [1, 2, 3, 4, 5, 6].map(no => ({ waku: no, weightAndAdjustRaw: `${50 + no}.0 0.0` })) } };
const meta = { venue: '多摩川', raceNumber: 1, deadlineTime: '12:30' };
const high = fakeEngine([0.55, 0.18, 0.12, 0.08, 0.05, 0.02], 0.13);

t('登録番号: toban は「級別1桁+4桁」で、下4桁が登録番号', () => {
  assert.equal(N.regnoOfToban('13617'), '3617'); assert.equal(N.regnoOfToban('24360'), '4360'); assert.equal(N.regnoOfToban('4264'), '4264'); assert.equal(N.regnoOfToban(null), '');
});
t('姓: 空白区切り(全角含む)は最初のかたまり、空白なしは推定規則', () => {
  assert.equal(N.surname('長尾　　章平'), '長尾'); assert.equal(N.surname('船岡 洋一郎'), '船岡'); assert.equal(N.surname('林太郎'), '林'); assert.equal(N.surname('濱野谷憲吾'), '濱野谷'); assert.equal(N.surname(''), '');
  assert.equal(N.boatLabel(3, '松山　　将吾'), '❸松山');
});
t('評価順: 差が大きいほど矢印が増える(15pt以上>>>、6pt以上>>、それ未満>)', () => {
  assert.equal(N.hyokaOrder([0.6, 0.15, 0.1, 0.08, 0.05, 0.02]), '1>>>2>3>4>5>6');
  assert.equal(N.hyokaOrder([0.30, 0.29, 0.2, 0.1, 0.06, 0.05]), '1>2>>3>>4>5>6');
});
t('確信度: top1p が 0.111 以上のときだけ「高」', () => {
  assert.equal(N.isHighConfidence({ ok: true, top1p: 0.111 }), true); assert.equal(N.isHighConfidence({ ok: true, top1p: 0.1109 }), false);
  assert.equal(N.isHighConfidence({ ok: false, top1p: 0.5 }), false); assert.equal(N.isHighConfidence(null), false);
});
t('買い目のまとめ表記は可逆(展開すると元の集合と1対1で一致する)', () => {
  const bets = ['1-2-3', '1-2-4', '2-1-3', '1-3-2', '2-1-5', '1-4-2'];
  const text = N.groupBets(bets); const back = [];
  for (const g of text.split('/')) { const [a, b, thirds] = g.split('-'); for (const c of thirds) back.push(`${a}-${b}-${c}`); }
  assert.deepEqual(back.sort(), [...bets].sort());
});
t('確信度が高くなければ通知は作らない', () => {
  assert.equal(N.buildEngineNotifications(fakeEngine([0.3, 0.2, 0.2, 0.1, 0.1, 0.1], 0.05), meta, collected), null);
  assert.equal(N.buildEngineNotifications({ ok: false }, meta, collected), null);
});
t('高確信度: ちょうど2通(①Xサマリー ②展開コメント用データ)、優先度4', () => {
  const msgs = N.buildEngineNotifications(high, meta, collected);
  assert.equal(msgs.length, 2); assert.match(msgs[0].title, /^📝 noteサマリー 多摩川1R\(\d+点\)$/); assert.match(msgs[1].title, /^🧩 展開コメント用データ 多摩川1R$/);
  assert.equal(msgs[0].priority, 4); assert.equal(msgs[1].priority, 4);
});
t('Xサマリー: 既存の「X用」と同じ書式(G.RATE・軸・評価順・展開は空欄・note誘導・署名)。買い目は載せない', () => {
  const text = N.buildXSummary(high, meta, { 1: '長尾　　章平' });
  const lines = text.split('\n');
  assert.equal(lines[0], '【多摩川1R】 締切12:30'); assert.match(lines[2], /^G\.RATE \d+%$/); assert.equal(lines[4], '軸：❶長尾'); assert.ok(!/評価順/.test(text), '実際のX用コピーは評価順の行を除く');
  assert.equal(lines[6], '展開：─'); assert.equal(lines[8], '最終予想・買い目はプロフィール（note）から。'); assert.equal(lines[lines.length - 1], 'G.');
  assert.ok(!/\d-\d-\d/.test(text), '買い目(三連単)を含んではいけない');
});
t('展開コメント用データ: 必要な節がそろい、買い目と分岐が一致する', () => {
  const msgs = N.buildEngineNotifications(high, meta, collected); const text = msgs[1].body;
  for (const sec of ['■軸', '■エンジンの評価', '■最終買い目('+N.selectBets(high, N.oddsMapOf(collected)).K+'点)', '■買い目順位', '■2着候補順位', '■買い目分岐', '■コメント用参考事実', '■レース全体の見立て', '→上記を踏まえて、展開コメントを作って']) assert.ok(text.includes(sec), sec);
  const ranked = [...text.matchAll(/^(\d+)位 (\d-\d-\d)$/gm)].map(m => m[2]);
  const KK = N.selectBets(high, N.oddsMapOf(collected)).K; assert.equal(ranked.length, KK); assert.deepEqual(ranked, high.top.slice(0, KK).map(x => x.combo));
  // 分岐に出てくる「1着→2着→3着」の組み合わせを全部展開すると、買い目12点と一致する
  const lab = { '❶': 1, '❷': 2, '❸': 3, '❹': 4, '❺': 5, '❻': 6 }; const section = text.split('■買い目分岐')[1].split('■コメント用')[0]; const back = []; let first = null;
  for (const line of section.split('\n')) {
    let m = line.match(/^([❶-❻])\S*1着$/); if (m) { first = lab[m[1]]; continue; }
    m = line.match(/^・2着([❶-❻])\S* → 3着(.+)$/); if (m) for (const t3 of m[2].split('・')) back.push(`${first}-${lab[m[1]]}-${lab[t3[0]]}`);
  }
  assert.deepEqual(back.sort(), high.top.slice(0, KK).map(x => x.combo).sort());
});
t('本文は ntfy の上限(4,000バイト)に収まる', () => {
  for (const m of N.buildEngineNotifications(high, meta, collected)) assert.ok(Buffer.byteLength(m.body, 'utf8') <= 3900, `${m.title} ${Buffer.byteLength(m.body, 'utf8')}バイト`);
  const long = fakeEngine([0.55, 0.18, 0.12, 0.08, 0.05, 0.02], 0.13); long.explain.boats.forEach(b => { b.comment = 'あ'.repeat(400); });
  for (const m of N.buildEngineNotifications(long, meta, collected)) assert.ok(Buffer.byteLength(m.body, 'utf8') <= 3900);
});
t('収集データ→エンジン入力: 登録番号・級別・成績・年齢・体重を正しく写す', () => {
  const inp = N.buildEngineInputFromCollected({ jo: '05', raceNumber: 1 }, collected, Date.parse('2026-09-21T03:00:00Z'));
  assert.equal(inp.raceDate, '2026-09-21'); assert.equal(inp.venueCode, 5); assert.equal(inp.raceNo, 1); assert.equal(inp.boats.length, 6);
  const b = inp.boats[0]; assert.equal(b.regno, '4001'); assert.equal(b.cls, 'A1'); assert.equal(b.natW, '6.00'); assert.equal(b.motT2, '35.0'); assert.equal(b.age, 41); assert.equal(b.weight, '51.0'); assert.equal(b.name, '長尾 章平');   // 姓と名の間は半角空白1つ(姓を確実に取れるように)
});
t('スクリーニング本体: 構文が正しく、BMデータ一覧・B01の通知は既定で停止している', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'boatcast_migration', 'scripts', 'realtime_screening_boatcast.js'), 'utf8');
  assert.match(src, /const BM_DATA_NOTIFY = process\.env\.GARON_BM_DATA_NOTIFY === '1';/); assert.match(src, /const B01_NOTIFY = process\.env\.GARON_B01_NOTIFY === '1';/);
  assert.match(src, /if \(!B01_NOTIFY\)/); assert.match(src, /maybeSendEngineNotifications\(venue, raceInfo, collected\)/); assert.match(src, /isNotificationsPaused\(\)/);
});
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
