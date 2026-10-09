'use strict';
// WILD展開コメントの書き手(scripts/wild/comment_writer.js)のテスト(2026-10-08)。
// 実行: node tests/wild_comment_writer.test.js
// 1) サンプルカード全件で例外が出ない / 出力は矛盾検査に通っている(通らなければ null) / 同じ入力は同じ出力
// 2) Xは60字以内、noteは600字以内
// 3) わざと誤りを入れた文を、検査が不合格にする
// 4) 組み込み済みの garon_wild.html に書き手が埋め込まれている(ひな型を直さずに画面だけ直した事故の検知)
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'scripts', 'wild', 'wild_template.html'), 'utf8');
const src = html.split('/*LOGIC_START*/')[1].split('/*LOGIC_END*/')[0];
const L = new Function(src + '; return {garonSurname,boatLabel,autoPlan,mergeBlocks,marginals,upsetWords,hyokaFromBets,compressBets,killCandidates};')();
const { makeCommentWriter } = require(path.join(ROOT, 'scripts', 'wild', 'comment_writer.js'));
const CW = makeCommentWriter(L);
const len = (s) => Array.from(s).length;
let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message); process.exitCode = 1; } };

const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8'));
// 実カード(あれば直近の1日分。無ければサンプルだけ)
const cardDir = path.join(ROOT, 'logs', 'wild', 'cards'); let real = [];
try { const days = fs.readdirSync(cardDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); const day = days[days.length - 2] || days[days.length - 1]; if (day) real = fs.readdirSync(path.join(cardDir, day)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(cardDir, day, f), 'utf8')); } catch (e) { return null; } }).filter((d) => d && d.card && d.card.boats && d.card.scenarios).slice(0, 60); } catch (e) { /* 実カードが無い環境 */ }
const entries = samples.map((s) => ({ venue: s.venue, race: s.race, deadline: s.deadline, card: s.card })).concat(real.map((d) => ({ venue: d.venue, race: d.race, deadline: d.deadline, card: d.card })));

t('サンプルと実カードで例外が出ない(' + entries.length + '件)', () => { assert(entries.length >= 4); entries.forEach((e) => { const f = CW.buildFacts(e); CW.compose(f, e.venue + e.race); }); });
t('出力は矛盾検査に通っている(通らないものは null)', () => { entries.forEach((e) => { const f = CW.buildFacts(e); const r = CW.compose(f, e.venue + e.race); if (r.x) assert(CW.check(r.x, f, 'x').pass, e.venue + e.race + 'R X'); if (r.note) assert(CW.check(r.note, f, 'note').pass, e.venue + e.race + 'R note'); }); });
t('合格率が9割以上(同姓の選手2人などで null になるのは許す)', () => { let ok = 0; entries.forEach((e) => { const r = CW.compose(CW.buildFacts(e), e.venue + e.race); if (r.x && r.note) ok++; }); assert(ok / entries.length >= 0.9, `合格 ${ok}/${entries.length}`); });
t('同じ入力は同じ出力', () => { const e = entries[0]; const a = CW.compose(CW.buildFacts(e), 'k'), b = CW.compose(CW.buildFacts(e), 'k'); assert.deepStrictEqual([a.x, a.note, a.long], [b.x, b.note, b.long]); });
t('Xは60字以内、noteは600字以内、「逃げは捨てる」等の従来の定型を使わない', () => { entries.forEach((e) => { const r = CW.compose(CW.buildFacts(e), e.venue + e.race); if (r.x) { assert(len(r.x) <= 60, 'X長すぎ: ' + r.x); assert(!r.x.includes('逃げは捨てる')); } if (r.note) assert(len(r.note) <= 600); }); });
t('出力はレースごとに違う(X)', () => { const xs = entries.map((e) => CW.compose(CW.buildFacts(e), e.venue + e.race).x).filter(Boolean); assert(new Set(xs).size >= Math.floor(xs.length * 0.9), `種類 ${new Set(xs).size}/${xs.length}`); });
t('誤りを入れた文は不合格(買い目に無い艇を本線にする・エンジン確率を書く)', () => {
  const e = entries[0]; const f = CW.buildFacts(e); const r = CW.compose(f, 'k'); assert(r.x);
  const heads = new Set(f.heads); const notHead = [1, 2, 3, 4, 5, 6].find((n) => !heads.has(n) && n !== 1);
  if (notHead) assert(!CW.check(`${f.labelOf[notHead]}の差しが本線。`, f, 'x').pass, '頭に無い艇の本線を見逃した');
  assert(!CW.check(r.x + 'エンジンの1着確率は45%。', f, 'x').pass, 'エンジン確率の公開を見逃した');
});
t('組み込み済みの garon_wild.html に書き手が入っている', () => {
  const live = path.join(ROOT, 'garon_wild.html'); if (!fs.existsSync(live)) return;
  const h = fs.readFileSync(live, 'utf8'); assert(h.includes('function makeCommentWriter'), '書き手が埋め込まれていない(build_wild_html.js で再生成が必要)'); assert(h.includes('CW.compose('), '展開の初期値が新しい書き手を使っていない');
});

// ---- 文量(30/70/150字)× 文調(言い切り/です・ます/体言止め)(2026-10-08) ----
const BAND = { 30: [20, 80], 70: [44, 90], 150: [75, 190] };
t('文量・文調ごとの出力が、字数の範囲に入り検査に通る(成功率9割以上)', () => {
  for (const size of [30, 70, 150]) for (const st of ['plain', 'polite', 'memo', 'auto']) {
    let ok = 0; entries.forEach((e) => { const f = CW.buildFacts(e); const r = CW.composeLen(f, e.venue + e.race, size, st, 0); if (!r) return; ok++; assert(r.len >= BAND[size][0] && r.len <= BAND[size][1], `${size}/${st} ${e.venue}${e.race}R ${r.len}字`); assert(CW.check(r.text, f, 'mid').pass, `${size}/${st} 検査`); });
    assert(ok / entries.length >= 0.9, `${size}/${st} 成功 ${ok}/${entries.length}`);
  } });
t('文調ごとに文末が違う(です・ます調は「です/ます」で終わる、言い切りは含まない)', () => {
  let pol = 0, plainEnd = 0; entries.forEach((e) => { const f = CW.buildFacts(e); const a = CW.composeLen(f, 'k', 70, 'polite', 0), b = CW.composeLen(f, 'k', 70, 'plain', 0); if (a && /(です|ます)。$/.test(a.text)) pol++; if (b && !/(です|ます)。/.test(b.text)) plainEnd++; });
  assert(pol >= entries.length * 0.8 && plainEnd >= entries.length * 0.8, `polite ${pol}, plain ${plainEnd}`); });
t('書き出しがレースごとに変わる(2026-10-09: 1号艇から・軸から・負け方から・根拠から。1つの型が6割を超えない)', () => {
  const op = {}; let n = 0; entries.forEach((e) => { const f = CW.buildFacts(e); const r = CW.composeLen(f, e.venue + e.race, 70, 'auto', 0); if (!r) return; n++; const k = r.text.startsWith(f.lane1.label) ? '1号艇' : /^インの負け/.test(r.text) ? '負け方' : /^(まずは|主役は|狙いは|崩すなら)?[❶-❻]/.test(r.text) || /^(まずは|主役は|狙いは|崩すなら)/.test(r.text) ? '軸' : 'その他'; op[k] = (op[k] || 0) + 1; });
  assert(n >= 8); assert(Math.max(...Object.values(op)) / n <= 0.6, '書き出しの型が偏っている ' + JSON.stringify(op)); assert(Object.keys(op).length >= 2, '書き出しが1種類だけ ' + JSON.stringify(op)); console.log('   (書き出し ' + JSON.stringify(op) + ')'); });
t('別の言い回し(variant)で文が変わり、同じ入力・同じvariantなら同じ', () => {
  let changed = 0; entries.forEach((e) => { const f = CW.buildFacts(e); const a = CW.composeLen(f, 'k', 70, 'plain', 0), b = CW.composeLen(f, 'k', 70, 'plain', 1), c = CW.composeLen(f, 'k', 70, 'plain', 0); if (a && c) assert.strictEqual(a.text, c.text); if (a && b && a.text !== b.text) changed++; });
  assert(changed >= entries.length * 0.5, `variantで変わった ${changed}/${entries.length}`); });
t('おまかせは、レースごとに文調がばらける', () => { const sts = new Set(entries.map((e) => { const r = CW.composeLen(CW.buildFacts(e), e.venue + e.race, 70, 'auto', 0); return r && r.style; })); assert(sts.size >= 3, [...sts].join(',')); });
t('画面に文量・文調の操作が入っている', () => { const live = path.join(ROOT, 'garon_wild.html'); if (!fs.existsSync(live)) return; const h = fs.readFileSync(live, 'utf8'); assert(h.includes('data-cwlen') && h.includes('CW.composeLen('), '文量・文調の操作が画面に無い'); });


// ---- 2026-10-08 CEOの指摘(画面のスクリーンショット)への対策 ----
t('1号艇が堅い(逃げ55%以上)と書いたら、同じ文で「本線」と言わない(矛盾の防止)', () => {
  let n = 0; entries.forEach((e) => { const f = CW.buildFacts(e); if (!(f.lane1.nigePct >= 55)) return; n++;
    for (const size of [30, 70, 150]) for (const st of ['plain', 'polite', 'memo']) { const r = CW.composeLen(f, 'k', size, st, 0); if (r && /堅い|崩れない|崩れません/.test(r.text)) assert(!/本線/.test(r.text), `${e.venue}${e.race}R ${size}/${st}: ${r.text}`); }
    const r2 = CW.compose(f, 'k'); if (r2.x && /堅い/.test(r2.x)) assert(!/本線/.test(r2.x), 'X: ' + r2.x); });
  assert(n >= 1, '堅い1号艇のテストデータが無い'); });
t('会場の決まり手の割合は「◯◯では2コースの1着の38%がまくり差し」の形(意味の取りにくい「勝つときの」を使わない)', () => {
  let seen = 0; entries.forEach((e) => { const f = CW.buildFacts(e); [70, 150].forEach((n) => ['plain', 'polite', 'memo'].forEach((st) => { const r = CW.composeLen(f, 'k', n, st, 0); if (!r) return; assert(!/勝つときの/.test(r.text), r.text); if (/コースの1着の\d+%が/.test(r.text)) seen++; })); const r3 = CW.compose(f, 'k'); if (r3.note) assert(!/勝つときの/.test(r3.note)); });
  assert(seen > 0, '会場の決まり手の割合の文が1つも出ない'); });


t('全国勝率を根拠・形容に使わない(決め手にならないため。CEO指摘)', () => { entries.forEach((e) => { const f = CW.buildFacts(e); [30, 70, 150].forEach((n) => ['plain', 'polite', 'memo'].forEach((st) => { const r = CW.composeLen(f, 'k', n, st, 0); if (r) assert(!/全国勝率/.test(r.text), r.text); })); const c = CW.compose(f, 'k'); [c.x, c.note, c.long].forEach((tx) => { if (tx) assert(!/全国勝率/.test(tx), tx); }); }); });
t('「信じ切らず」など、堅いのに崩れると言う根拠の無い言い回しを使わない', () => { entries.forEach((e) => { const f = CW.buildFacts(e); const c = CW.compose(f, 'k'); [c.x, c.note, c.long].forEach((tx) => { if (tx) assert(!/信じ切らず/.test(tx), tx); }); [30, 70, 150].forEach((n) => { const r = CW.composeLen(f, 'k', n, 'plain', 0); if (r) assert(!/信じ切らず/.test(r.text)); }); }); });
t('堅い1号艇で理由を書くときは、狙いの決まり手で負けた割合(25%以上)に限る', () => { let seen = 0; entries.forEach((e) => { const f = CW.buildFacts(e); if (!(f.lane1.nigePct >= 55)) return; const ax = f.blocks.find((b) => b.winner === f.axis); if (!ax) return; const r = CW.composeLen(f, 'k', 150, 'plain', 0); if (!r) return; const m = r.text.match(/負けた(\d+)回のうち(.+?)(?:が最多の|で負けたのも)(\d+)回\((\d+)%\)/); if (m) { seen++; assert.strictEqual(m[2], ax.tech); assert(Number(m[4]) >= 25, r.text); } }); });


t('「機2連」の略語を使わず「モーター2連率」と書く', () => { entries.forEach((e) => { const f = CW.buildFacts(e); [30, 70, 150].forEach((n) => ['plain', 'polite', 'memo'].forEach((st) => { const r = CW.composeLen(f, 'k', n, st, 0); if (r) assert(!/機2連/.test(r.text), r.text); })); const c = CW.compose(f, 'k'); [c.x, c.note, c.long].forEach((tx) => { if (tx) assert(!/機2連/.test(tx), tx); }); }); });
t('負け方の数字は、買い目にある決まり手(軸または対抗)に関係するときだけ書く', () => {
  let seen = 0; entries.forEach((e) => { const f = CW.buildFacts(e); const techs = new Set(f.blocks.map((b) => b.tech));
    [70, 150].forEach((n) => ['plain', 'polite', 'memo'].forEach((st) => { const r = CW.composeLen(f, 'k', n, st, 0); if (!r) return; const re = /(?:負けた|インの負けは)(\d+)回のうち(まくり差し|まくり|差し|抜き|逃げ)/g; let m; while ((m = re.exec(r.text))) { seen++; assert(techs.has(m[2]), `${e.venue}${e.race}R 関係の無い負け方「${m[2]}」: ${r.text}`); } })); });
  assert(seen > 0, '負け方の文が1つも出ない'); });
t('展示の見立て(extra)を渡すと文末に足される(検査の対象外)', () => { const e = entries[0]; const f = CW.buildFacts(e); const ex = '展示では' + f.axisLabel + 'の周り足が良い。'; const a = CW.composeLen(f, 'k', 70, 'plain', 0), b = CW.composeLen(f, 'k', 70, 'plain', 0, ex); assert(a && b && b.text === a.text + ex); const n0 = CW.compose(f, 'k'), n1 = CW.compose(f, 'k', ex); assert(n1.note.includes(ex) && !n0.note.includes(ex)); });
t('画面に展示の見立てのボタンが入っている', () => { const live = path.join(ROOT, 'garon_wild.html'); if (!fs.existsSync(live)) return; const h = fs.readFileSync(live, 'utf8'); assert(h.includes('data-cs=') && h.includes('cwExtra'), '見立てのボタンが画面に無い'); });


t('決まり手の呼び方がコースに合っている(4コースのまくり=カドまくり、3=センターまくり、5=外まくり、6=大外まくり、5・6のまくり差し=外の/大外の)', () => {
  const must = { 'まくり': { 3: 'センターまくり', 4: 'カドまくり', 5: '外まくり', 6: '大外まくり' }, 'まくり差し': { 4: 'カドからのまくり差し', 5: '外のまくり差し', 6: '大外のまくり差し' } };
  let seen = 0; entries.forEach((e) => { const f = CW.buildFacts(e); const heads = f.blocks.filter((b) => b.winner !== 1);
    [70, 150].forEach((n) => ['plain', 'polite', 'memo'].forEach((st) => { const r = CW.composeLen(f, 'k', n, st, 0); if (!r) return;
      heads.forEach((b) => { const want = must[b.tech] && must[b.tech][b.winner]; if (!want) return; const plain = f.labelOf[b.winner] + 'の' + b.tech;
        assert(!r.text.includes(plain), `${e.venue}${e.race}R コースに合わない呼び方「${plain}」: ${r.text}`); if (r.text.includes(f.labelOf[b.winner] + 'の' + want) || r.text.includes('の' + want)) seen++; }); })); });
  assert(seen > 0, 'コースに合わせた呼び名が1つも出ない'); });

console.log(`\n${pass} 項目合格`);

// ---- 2026-10-09 追加: CEO指摘(文のおかしさ・数字の正確さ・言い回しの変化) ----
const BROKEN = [/、。/, /。。/, /、、/, /だが、。/, /そのうえ。/, /さらに。/, /なにより。/, /undefined|null|NaN|Infinity/, /頭を\d+点/, /直近\d+走/];
t('壊れた文(空の節・「、。」・「頭を3点」・「直近◯走」)が出ない', () => {
  entries.forEach((e) => { const f = CW.buildFacts(e); const r = CW.compose(f, e.venue + e.race); [r.x, r.note, r.long].filter(Boolean).forEach((s) => BROKEN.forEach((re) => assert(!re.test(s), `${e.venue}${e.race}R: ${re} → ${s.slice(0, 80)}`)));
    [30, 70, 150].forEach((size) => ['plain', 'polite', 'memo'].forEach((st) => { const q = CW.composeLen(f, e.venue + e.race, size, st, 0); if (q) BROKEN.forEach((re) => assert(!re.test(q.text), `${size}/${st} ${e.venue}${e.race}R: ${re}`)); })); }); });
t('数字の照合: 負けた回数・決まり手別の回数・割合・会場の傾向が事実と違う文は不合格', () => {
  const e = entries.find((x) => { const f = CW.buildFacts(x); return f.lane1.lostN >= 6 && Object.keys(f.lane1.lostBy).length; }); assert(e, '対象のカードが無い');
  const f = CW.buildFacts(e), tech = Object.keys(f.lane1.lostBy).sort((a, b) => f.lane1.lostBy[b] - f.lane1.lostBy[a])[0], n = f.lane1.lostN, k = f.lane1.lostBy[tech], pct = Math.round(100 * k / n);
  const okS = `${f.lane1.label}は逃げ${f.lane1.nigePct}%。負けた${n}回のうち${tech}が最多の${k}回(${pct}%)。`;
  assert(CW.check(okS + `${f.axisLabel}の${f.blocks[0].tech}が本線。`, f, 'mid').violations.every((v) => v.rule !== '数字'), '正しい数字を誤って不合格にした');
  assert(CW.check(okS.replace(`${n}回のうち`, `${n + 1}回のうち`), f, 'mid').violations.some((v) => v.rule === '数字'), '負けた回数の誤りを見逃した');
  assert(CW.check(okS.replace(`最多の${k}回`, `最多の${k + 1}回`), f, 'mid').violations.some((v) => v.rule === '数字'), '決まり手別回数の誤りを見逃した');
  assert(CW.check(okS.replace(`(${pct}%)`, `(${pct + 5}%)`), f, 'mid').violations.some((v) => v.rule === '数字'), '割合の誤りを見逃した');
});
t('数字が整合しない・走数が少ない1号艇は、逃げ率と負け方を出さない', () => {
  const e = JSON.parse(JSON.stringify(entries[0])); e.card.lane1.stats.starts = 6; const f = CW.buildFacts(e);
  assert(f.lane1.nigePct == null && f.lane1.lostN == null && f.lane1.numbersWithheld, '走数6でも数字を出している');
  const e2 = JSON.parse(JSON.stringify(entries[0])); e2.card.lane1.vulnerability.lost = (e2.card.lane1.vulnerability.lost || 0) + 5; const f2 = CW.buildFacts(e2);
  assert(f2.lane1.numbersWithheld, '負けた回数が合わないのに数字を出している'); });
t('言い回しがレースごとに変わる(30字: 文頭の型が偏りすぎない・同一文が少ない)', () => {
  const outs = entries.map((e) => { const r = CW.composeLen(CW.buildFacts(e), e.venue + e.race, 30, 'auto', 0); return r && r.text; }).filter(Boolean);
  assert(outs.length >= 4); assert(new Set(outs).size >= Math.floor(outs.length * 0.9), '同じ文が多い'); });
t('同じレース・同じ案なら同じ出力(言い回しの乱数が固定)', () => {
  const e = entries[1], f = CW.buildFacts(e); const a = CW.composeLen(f, 'k', 30, 'auto', 0), b = CW.composeLen(f, 'k', 30, 'auto', 0); assert.strictEqual(a && a.text, b && b.text); });
t('会場の傾向は、全国より8ポイント以上高いときだけ書き、全国の割合を添える(2コースのまくり30%のような全国並みの数字は理由にしない)', () => {
  let seen = 0;
  entries.forEach((e) => { const f = CW.buildFacts(e); [30, 70, 150].forEach((size) => ['plain', 'polite', 'memo'].forEach((st) => { const q = CW.composeLen(f, e.venue + e.race, size, st, 0); if (!q) return;
    for (const m of q.text.matchAll(/では([1-6])コースの1着の(\d+)%が(まくり差し|まくり|差し|抜き)\(全国は(\d+)%\)/g)) { seen++; assert(Number(m[2]) >= Number(m[4]) + 8, `${e.venue}${e.race}R: ${m[0]}`); }
    assert(!/では[1-6]コースの1着の\d+%が(まくり差し|まくり|差し|抜き)(?!差し|\(全国は)/.test(q.text), `${e.venue}${e.race}R: 全国の割合が無い`); })); });
  console.log('   (会場の傾向の記載 ' + seen + ' 件を確認)'); });
t('スタートが2位との差0.02秒未満なら「スタート最速」と書かない(0.008秒差を強みにしない)', () => {
  const e = JSON.parse(JSON.stringify(entries[0])); assert(e.card.boats.every((b) => b.st != null), '前提');
  e.card.boats.forEach((b, i) => { b.st = 0.17 + i * 0.001; });
  const f = CW.buildFacts(e); const s = CW.composeLen(f, 'k', 70, 'plain', 0); if (s) assert(!/スタート最速/.test(s.text), 'わずかな差を最速と書いた'); });
t('同じ苗字の選手が2人いるレース(常滑4Rの❷松下・❻松下)でも、新しい書き手が文を作る(古い文に戻らない)', () => {
  const e = JSON.parse(JSON.stringify(entries[0])); e.card.boats[5].name = e.card.boats[1].name;   // ❻を❷と同じ名前にする
  const f = CW.buildFacts(e); assert.strictEqual(f.boats[1].surname, f.boats[5].surname);
  const r = CW.compose(f, 'same'); const q = CW.composeLen(f, 'same', 70, 'plain', 0); assert(r.x || (q && q.text), '同姓で文が作れない'); });
t('F持ち: カードにFの記録が無いのに「F持ち」と書いた文は不合格、記録があれば使える', () => {
  const e = JSON.parse(JSON.stringify(entries[0])); e.card.boats.forEach((b) => { b.fl = null; }); const f = CW.buildFacts(e);
  assert(CW.check(`${f.lane1.label}はF持ちで、逃げは${f.lane1.nigePct}%。${f.axisLabel}の${f.blocks[0].tech}が本線。`, f, 'mid').violations.some((v) => v.msg.includes('F持ち')), 'F持ちの誤りを見逃した');
  e.card.boats[0].fl = 'F2'; const f2 = CW.buildFacts(e); assert(!CW.check(`${f2.lane1.label}はF持ちで、逃げは${f2.lane1.nigePct}%。${f2.axisLabel}の${f2.blocks[0].tech}が本線。`, f2, 'mid').violations.some((v) => v.msg.includes('F持ち')), 'F持ちの記録があるのに不合格にした'); });
t('根拠の材料が毎回同じにならない(70字: 材料の組み合わせが10種類以上、最多の組み合わせが4割以下)', () => {
  const types = [/負けた\d+回|の負けは\d+回/, /では[2-6]コースの1着/, /過去1年の[2-6]コース/, /平均スタート/, /モーター2連率|機力/, /展示/, /当地勝率/, /条件が近い/, /配当|旨み|三連単は/, /気配/, /展開。?$|展開です/, /F持ち/, /展開が向けば|流れ|展開次第|崩れた(時の)?形/];
  const sig = {}; let n = 0; entries.forEach((e) => { const f = CW.buildFacts(e); const r = CW.composeLen(f, e.venue + e.race, 70, 'auto', 0); if (!r) return; n++; const k = types.map((re, i) => re.test(r.text) ? i : -1).filter((i) => i >= 0).join('+'); sig[k] = (sig[k] || 0) + 1; });
  assert(Object.keys(sig).length >= 10, '材料の組み合わせが少ない ' + Object.keys(sig).length); assert(Math.max(...Object.values(sig)) / n <= 0.4, '最多の組み合わせが4割を超えた'); console.log('   (組み合わせ ' + Object.keys(sig).length + ' 種類 / ' + n + ' 件)'); });
t('「◯◯は…は」「根拠は平均スタートは」のような、助詞の重なりが出ない', () => {
  entries.forEach((e) => { const f = CW.buildFacts(e); [70, 150].forEach((n) => ['plain', 'polite', 'memo'].forEach((st) => { const r = CW.composeLen(f, e.venue + e.race, n, st, 0); if (r) assert(!/(根拠は|裏付けは|決め手は)平均スタートは/.test(r.text) && !/[❶-❻][^。、]{1,4}は(インが負けた|平均スタートは|1号艇)/.test(r.text), `${e.venue}${e.race}R: ${r.text.slice(0, 50)}`); })); }); });
console.log('\n' + pass + ' 項目合格');
