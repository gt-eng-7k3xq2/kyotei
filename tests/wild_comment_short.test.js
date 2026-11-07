'use strict';
// WILD展開コメント「短い版」(scripts/wild/comment_short.js)のテスト(2026-11-07)
// 実行: node tests/wild_comment_short.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'scripts', 'wild', 'wild_template.html'), 'utf8');
const src = html.split('/*LOGIC_START*/')[1].split('/*LOGIC_END*/')[0];
const L = new Function(src + '; return {garonSurname,boatLabel,autoPlan,mergeBlocks,marginals,upsetWords,hyokaFromBets,compressBets,killCandidates};')();
const CW = require(path.join(ROOT, 'scripts', 'wild', 'comment_writer.js')).makeCommentWriter(L);
const SW = require(path.join(ROOT, 'scripts', 'wild', 'comment_short.js')).makeShortWriter(CW);
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS ', n); } catch (e) { fail++; console.log('FAIL ', n, '-', e.message.split('\n')[0]); } };
const samples = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8'));
const cardDir = path.join(ROOT, 'logs', 'wild', 'cards'); let real = [];
try { const days = fs.readdirSync(cardDir).filter(d => /^\d{4}-\d\d-\d\d$/.test(d)).sort(); const day = days[days.length - 2] || days[days.length - 1]; if (day) real = fs.readdirSync(path.join(cardDir, day)).filter(n => n.endsWith('.json')).slice(0, 60).map(n => JSON.parse(fs.readFileSync(path.join(cardDir, day, n), 'utf8'))); } catch (e) { /* 実カードが無くてもサンプルで行う */ }
const entries = samples.map(s => ({ venue: s.venue, race: s.race, deadline: s.deadline, card: s.card })).concat(real.filter(c => c.card && c.card.combos).map(c => ({ venue: c.venue, race: c.race, deadline: c.deadline, card: c.card })));
const factsOf = e => { const p = L.autoPlan(e.card, null, []); return CW.buildFacts(e, { blocks: p.blocks, attacker: p.attacker }); };
t('サンプルと実カードで例外が出ない(' + entries.length + '件)', () => { assert(entries.length >= 4); entries.forEach(e => SW.candidates(factsOf(e), e.venue + e.race, [], 5)); });
t('候補は、すべて検査(事実・禁止表現・数字・決まり手)を通る', () => { entries.forEach(e => { const f = factsOf(e); SW.candidates(f, e.venue + e.race, [], 5).forEach(c => assert(SW.okNote({ note: c.text, vals: SW.generate(f, e.venue + e.race + '#sh:' + c.idx).vals, claims: SW.generate(f, e.venue + e.race + '#sh:' + c.idx).claims }, f), '検査不合格: ' + c.text)); }); });
t('同じ入力・同じキーなら、同じ出力(決定論)', () => { entries.forEach(e => { const f = factsOf(e); assert.deepStrictEqual(SW.candidates(f, e.venue + e.race, [], 5), SW.candidates(f, e.venue + e.race, [], 5)); }); });
t('文字数は15〜110字(短い版)', () => { entries.forEach(e => SW.candidates(factsOf(e), e.venue + e.race, [], 5).forEach(c => { const n = Array.from(c.text).length; assert(n >= 15 && n <= 110, n + '字: ' + c.text); })); });
t('選手の表記は、丸数字+名字(❶田中)。丸数字だけ・名字だけの表記は無い', () => { entries.forEach(e => SW.candidates(factsOf(e), e.venue + e.race, [], 5).forEach(c => { assert(!/[①②③④⑤⑥]/.test(c.text)); assert(!/[❶-❻]\s*[、。は が の を]/.test(c.text)); })); });
t('今日投稿済みのコメントと被らない案を優先する(avoid)', () => { let better = 0, tot = 0; entries.forEach(e => { const f = factsOf(e), k = e.venue + e.race; const first = SW.candidates(f, k, [], 5)[0]; if (!first) return; const withAvoid = SW.candidates(f, k, [first.text], 5); tot++; if (withAvoid.every(c => SW.overlap(c.text, first.text) < 0.5)) better++; }); assert(better / tot >= 0.8, '被らない割合 ' + better + '/' + tot); });
t('5案は、互いに別の文(重複なし)', () => { entries.forEach(e => { const a = SW.candidates(factsOf(e), e.venue + e.race, [], 5).map(c => c.text); assert.strictEqual(new Set(a).size, a.length); }); });
t('組み込み済みの garon_wild.html に短い版の書き手が埋め込まれている', () => { const h = fs.readFileSync(path.join(ROOT, 'garon_wild.html'), 'utf8'); assert(h.includes('function makeShortWriter'), '埋め込みが無い(build_wild_html.js で再生成してください)'); assert(h.includes('const SW ='), '画面の接続が無い'); });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
