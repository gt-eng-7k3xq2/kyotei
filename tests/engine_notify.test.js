'use strict';
function expandBetsText(text) {
  const out = [];
  String(text).split('/').filter(Boolean).forEach(tok => {
    const parts = tok.split('-');
    const add = (h, b, c) => { if (h !== b && b !== c && h !== c) out.push(h + '-' + b + '-' + c); };
    if (parts.length === 2 && parts[0].includes('=')) { const [a, b] = parts[0].split('='); for (const c of parts[1]) { add(a, b, c); add(b, a, c); } }
    else if (parts.length === 2 && parts[1].includes('=')) { const [b, c] = parts[1].split('='); for (const h of parts[0]) { add(h, b, c); add(h, c, b); } }
    else { const [H, B, C] = parts; for (const h of H) for (const b of B) for (const c of C) add(h, b, c); }
  });
  return out.sort();
}
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
  back.push(...expandBetsText(text));   // 2026-09-26: 頭・2着・3着の集まりと、入れ替え(a=b)の書き方を展開する
  assert.ok(text.split('/').length <= 3, text);
  assert.deepEqual(back.sort(), [...bets].sort());
});
t('展開の一文(買い目から自動): 3つの文体(短め・標準・詳しめ)。「壊れたら」は使わない。確率の数字は出さない', () => {
  const p = { '1-2-3': 10, '1-2-4': 8, '1-3-2': 6, '2-1-3': 5, '2-1-4': 3 };
  const lab = (n) => '<' + n + '>', bets = Object.keys(p), po = (c) => p[c];
  assert.equal(N.tenkaiFromBets(bets, po, 1, lab, 'S'), '<1>のイン逃げが本線。相手筆頭は<2>、次点<3>。');
  assert.equal(N.tenkaiFromBets(bets, po, 1, lab, 'M'), '<1>のイン逃げが本線。相手筆頭は<2>のマーク、次点<3>の差し残り。3着は❸❹。押さえは<2>の差し。2着は<1>。❺❻は切り。');
  assert.equal(N.tenkaiFromBets(bets, po, 1, lab, 'L'), '<1>のイン逃げが本線。相手筆頭は<2>のマーク、次点<3>の差し残り。3着は❸を厚く、❹は次点。❸が2着なら3着は❷。押さえは<2>の差し。2着は<1>。❺❻は切り。');
  assert.equal(N.tenkaiFromBets(bets, po, 1, lab), N.tenkaiFromBets(bets, po, 1, lab, 'M'), '省略時は標準');
  assert.equal(N.tenkaiFromBets(bets, po, 1, lab, 'X'), N.tenkaiFromBets(bets, po, 1, lab, 'M'), '不明な文体は標準');
  for (const st of ['S', 'M', 'L']) { const txt = N.tenkaiFromBets(bets, po, 1, lab, st); assert.ok(!txt.includes('壊れたら'), st); assert.ok(!/[0-9.%]/.test(txt.replace(/[23]着|❶|❷|❸|❹|❺|❻|<\d>/g, '')), st + ' 確率など数字を含まない'); }
  assert.ok(N.tenkaiFromBets(bets, po, 1, lab, 'S').length < N.tenkaiFromBets(bets, po, 1, lab, 'M').length && N.tenkaiFromBets(bets, po, 1, lab, 'M').length < N.tenkaiFromBets(bets, po, 1, lab, 'L').length, '短め<標準<詳しめ');
  // 頭が1号艇でないとき・理由(機力・ST・調子の上位2位まで)
  const f = { motor: { 1: 1, 2: 5 }, st: { 5: 2 }, form: {} };
  assert.equal(N.tenkaiFromBets(['5-1-2', '5-1-3', '5-4-1'], (c) => ({ '5-1-2': 4, '5-1-3': 3, '5-4-1': 2 }[c]), 5, lab, 'M', f), '狙うは<5>(ST上位)。外からのまくり差しが本線。逃げは捨てる。相手筆頭は<1>(機力上位)、次点<4>のカド。3着は❷❸。❻は切り。');
  assert.equal(N.tenkaiFromBets(['5-1-2'], () => 1, 5, lab, 'S', f), '狙うは<5>。外からのまくり差しが本線。', '短めは理由を入れない');
  assert.deepEqual(N.tenkaiFactsOf({ boats: [{ stats: [{ k: 'motor', rank: 1 }, { k: 'st', rank: '3' }, { k: 'x', rank: 1 }] }, { stats: [{ k: 'form', rank: 2 }] }] }), { motor: { 1: 1 }, st: { 1: 3 }, form: { 2: 2 } });
  assert.deepEqual(N.tenkaiFactsOf(null), { motor: {}, st: {}, form: {} });
  // 軸が先頭・空・不正な出目・買い目の中の艇だけ
  assert.ok(N.tenkaiFromBets(['2-1-3', '4-1-3'], (c) => ({ '2-1-3': 1, '4-1-3': 9 }[c]), 2, lab).startsWith('狙うは<2>。差し切りが本線。'));
  assert.equal(N.tenkaiFromBets([], () => 0, 1, lab), ''); assert.equal(N.tenkaiFromBets(['x', '1-1-2', '7-1-2'], () => 1, 1, lab), '');
  const bets2 = ['3-1-2', '3-1-4', '3-2-1']; const t3 = N.tenkaiFromBets(bets2, () => 1, 3, lab, 'L'); const named = [...t3.matchAll(/<(\d)>/g)].map(m => Number(m[1]));
  assert.ok(named.every(n => bets2.join('-').split('-').map(Number).includes(n)));
});
t('荒れ型の展開の一文(頭が1号艇以外。お見本の若松8R): 狙うは・差し切り・逃げは捨てる・壁・カド・1号艇は3着まで', () => {
  const nm = { 1: '杉本', 2: '永野', 3: '浜田', 4: '倉持', 5: '西条', 6: '宮内' }, lab = (n) => N.boatLabel(n, nm[n]);
  const bets = ['2-3-1', '2-3-4', '2-4-1', '2-4-3', '4-2-3'], p = { '2-3-1': 10, '2-3-4': 8, '2-4-1': 7, '2-4-3': 6, '4-2-3': 5 };
  assert.equal(N.tenkaiFromBets(bets, (c) => p[c], 2, lab, 'S'), '狙うは❷永野。差し切りでも、❹倉持のカドまくりから❷の差し残しでも軸。❸浜田は壁。');
  assert.equal(N.tenkaiFromBets(bets, (c) => p[c], 2, lab, 'M'), '狙うは❷永野。差し切りが本線。逃げは捨てる。相手筆頭は❸浜田の壁、次点❹倉持のカド。3着は❶❹。押さえは❹倉持のカドまくり。2着は❷永野。❺❻は切り。');
  assert.equal(N.tenkaiFromBets(bets, (c) => p[c], 2, lab, 'L'), '狙うは❷永野。差し切りが本線。逃げは捨てる。相手筆頭は❸浜田の壁、次点❹倉持のカド。3着は❶を厚く、❹は次点。❹が2着なら3着は❶❸。❶杉本は逃げ切れず3着まで。押さえは❹倉持のカドまくり。2着は❷永野。❺❻は切り。');
  for (const st of ['S', 'M', 'L']) { const txt = N.tenkaiFromBets(bets, (c) => p[c], 2, lab, st); assert.ok(!txt.includes('壊れたら'), st); }
  assert.equal(N.tenkaiFromBets(['3-1-2', '3-4-1'], () => 1, 3, lab, 'M'), '狙うは❸浜田。センター攻めが本線。逃げは捨てる。相手筆頭は❶杉本、次点❹倉持のカド。3着は❷。❺❻は切り。');
  assert.ok(!N.tenkaiFromBets(['2-1-3', '1-2-3'], () => 1, 2, lab, 'M').includes('逃げは捨てる'), '1号艇が頭の買い目もあるときは、逃げを捨てない');
});
t('展開の一文: 同じ艇を「相手筆頭」と「3着」で二重に出さない・頭が3号艇のとき壁と出ない・本線にいる艇を切りと書かない・短めに3着を書かない', () => {
  const nm = { 1: '杉本', 2: '永野', 3: '浜田', 4: '倉持', 5: '西条', 6: '宮内' }, lab = (n) => N.boatLabel(n, nm[n]), pf = () => 1;
  // 1) 頭が3号艇だけ: 壁と出ない(3号艇が頭のときはセンター攻め)
  for (const st of ['S', 'M', 'L']) { const t = N.tenkaiFromBets(['3-2-1', '3-2-4', '3-4-2', '3-1-2'], pf, 3, lab, st); assert.ok(!t.includes('壁'), st + ' ' + t); assert.ok(t.startsWith('狙うは❸浜田。センター攻め'), t); }
  // 2) 頭が1号艇と2号艇の混在: 逃げは捨てるを付けない
  for (const st of ['S', 'M', 'L']) assert.ok(!N.tenkaiFromBets(['1-2-3', '1-3-2', '2-1-3', '2-3-1'], pf, 1, lab, st).includes('逃げは捨てる'), st);
  // 3) 本線に5号艇がいる荒れ: 5・買い目の艇を切りに入れない
  for (const st of ['M', 'L']) { const t = N.tenkaiFromBets(['5-2-1', '5-2-3', '5-1-2', '2-5-1'], pf, 5, lab, st), cut = (t.match(/([❶-❻]+)は切り/) || [])[1] || ''; assert.ok(!cut.includes('❺') && !cut.includes('❷') && !cut.includes('❶') && !cut.includes('❸'), st + ' ' + t); }
  // 4) 短めは、2着と3着を並べない(相手筆頭の艇が、同じ文の3着に出ない)。標準・詳しめの3着は、相手筆頭以外
  const bets = ['2-3-1', '2-3-4', '2-4-1', '2-4-3', '4-2-3'], p = { '2-3-1': 10, '2-3-4': 8, '2-4-1': 7, '2-4-3': 6, '4-2-3': 5 };
  assert.ok(!N.tenkaiFromBets(bets, (c) => p[c], 2, lab, 'S').includes('3着'));
  for (const st of ['M', 'L']) { const t = N.tenkaiFromBets(bets, (c) => p[c], 2, lab, st), m = t.match(/3着は([❶-❻]+)/); assert.ok(m && !m[1].includes('❸'), st + ' ' + t); }
  // 括弧書きを使わない(通知・Qとも読みやすく)
  for (const st of ['S', 'M', 'L']) assert.ok(!/[()（）]/.test(N.tenkaiFromBets(bets, (c) => p[c], 2, lab, st).replace(/(機力上位)|(ST上位)|(調子上位)/g, '')), st);
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
t('Xサマリー: 既存の「X用」と同じ書式(G.RATE・軸・評価順・展開(買い目から自動)・note誘導・署名)。買い目は載せない', () => {
  const text = N.buildXSummary(high, meta, { 1: '長尾　　章平' });
  const lines = text.split('\n');
  assert.equal(lines[0], '【多摩川1R】 締切12:30'); assert.match(lines[2], /^G\.RATE \d+%$/); assert.equal(lines[4], '軸：❶長尾'); assert.ok(!/評価順/.test(text), '実際のX用コピーは評価順の行を除く');
  assert.ok(lines[6].startsWith('展開：') && lines[6] !== '展開：─' && lines[6].includes('が本線。'), lines[6]);   // 2026-09-26: 買い目から自動で作る assert.equal(lines[8], '最終予想・買い目はプロフィール（note）から。'); assert.equal(lines[lines.length - 1], 'G.');
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
