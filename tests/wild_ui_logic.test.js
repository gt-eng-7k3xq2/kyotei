'use strict';
// GARON-WILD 画面の計算部分(LOGIC_START〜LOGIC_ENDの間)を取り出して検証する
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'wild_template.html'), 'utf8');
const src = html.split('/*LOGIC_START*/')[1].split('/*LOGIC_END*/')[0];
const L = new Function(src + '; return {allocateEqualReturn,syntheticOdds,payoutPosition,nagashiCombos,gapWords,vsMeWords,buildPool,pointStats,upsetWords,garonSurname,boatLabel,naturalGroupBets,hyokaOrder,qSummary,orderBlock,mergeBlocks,swapHeads,autoTenkai,autoPlan,hasExcluded,dropExcluded,compressBets,hyokaFromBets,boatsText,skillNotes,officialRaceListUrl,boatsRows,BOATS_IMG_HEAD,tierWords,entryChecks,sortByTier,planReasons,marginals,killCandidates,calLookup,TOP3_CAL,WIN_CAL};')();
const en = require('../boatcast_migration/scripts/lib/engine_notify');
function expandBets(text) {
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
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
(async () => {
  // 配分: 本体と同じ結果になる
  const cases = [[['1-2-3','1-3-2','1-4-2'], {'1-2-3':20,'1-3-2':35.5,'1-4-2':80}, 3000], [['2-1-3','2-3-1'], {'2-1-3':12.3,'2-3-1':50}, 1500], [['1-2-3','1-3-2'], {'1-2-3':20}, 1000], [['3-1-2','3-2-1','3-4-1','3-4-2','3-1-4','3-2-4'], {'3-1-2':15,'3-2-1':22,'3-4-1':44,'3-4-2':60,'3-1-4':90,'3-2-4':120}, 3000]];
  for (const [p, o, t] of cases) { const a = L.allocateEqualReturn(p, o, t); assert.deepStrictEqual(a, en.allocateEqualReturn(p, o, t)); ok(a.reduce((x, y) => x + y, 0) === t, '合計'); ok(a.every(v => v >= 100 && v % 100 === 0), '100円単位'); }
  ok(Math.abs(L.syntheticOdds([10, 10]) - 5) < 1e-9, '合成');
  ok(L.syntheticOdds([]) === null, '合成空');
  const sim = { p25: 20, median: 40, p75: 90, p90: 200 };
  ok(L.payoutPosition(10, sim) === '下位25%' && L.payoutPosition(50, sim) === '中央値〜上位25%' && L.payoutPosition(300, sim) === '上位10%' && L.payoutPosition(5, null) === null, '位置');
  ok(L.nagashiCombos(3, [1, 2, 4]).length === 6 && !L.nagashiCombos(3, [1, 2]).includes('3-1-1'), '流し');
  ok(L.gapWords(-0.03).includes('速い') && L.gapWords(0.02).includes('遅い') && L.gapWords(0).includes('ほぼ'), '言い回し');
  ok(L.vsMeWords(0.03).includes('凹み'), '凹み');
  const pool = L.buildPool([{ combo: '5-1-4', odds: 40, enginePct: 0.5 }], [{ combo: '5-1-2', odds: 20, enginePct: 2 }, { combo: '5-4-1', odds: 60, enginePct: 1 }, { combo: '5-2-1', odds: null, enginePct: 9 }, { combo: '5-1-4', odds: 40, enginePct: 0.5 }]);
  ok(pool.length === 3 && pool[0].combo === '5-1-4' && pool[0].must && pool[1].combo === '5-1-2', '候補の並び(本線が先頭・オッズ無しは除外・重複なし)');
  const ps = L.pointStats(pool, 2); ok(Math.abs(ps.syn - 1 / (1 / 40 + 1 / 20)) < 1e-9 && Math.abs(ps.hitPct - 2.5) < 1e-9 && Math.abs(ps.needPct - 100 / ps.syn) < 1e-9, '点数ごとの合成・確率');
  ok(L.upsetWords(0.7) === '荒れやすい' && L.upsetWords(0.5) === 'やや荒れ' && L.upsetWords(0.2) === '堅め', '荒れ度の言葉');
  // Qエンジン本体の関数と、同じ結果になること(サマリーは「Qと全く同じ」が要件)
  const q = fs.readFileSync(path.join(__dirname, '..', 'garon_q_engine.html'), 'utf8');
  const NL = String.fromCharCode(10);
  const cutSrc = (from, endMark) => { const a = q.indexOf(from); assert(a >= 0, from); const b = q.indexOf(endMark, a); assert(b >= 0, endMark); return q.slice(a, b + endMark.length); };
  const Q = new Function(cutSrc('const GARON_ONE_CHAR_SURNAMES', 'return name.slice(0,2);' + NL + '}') + NL + cutSrc('function garonBoatLabel', NL + '}') + NL + cutSrc('function garonNaturalGroupBets', '.map(r => r.text);' + NL + '}') + NL + cutSrc('function garonGdbHyoka', NL + '}') + NL + 'const GARON_LABEL_CIRCLED=["❶","❷","❸","❹","❺","❻"];return {garonSurname,garonBoatLabel,garonNaturalGroupBets,garonGdbHyoka};')();
  for (const nm of ['石田 政吾', '佐藤 太郎', '濱野谷憲吾', '林 一', '菅章哉', '田村隆信', '']) { ok(L.garonSurname(nm) === Q.garonSurname(nm), '苗字 ' + nm); ok(L.boatLabel(3, nm) === Q.garonBoatLabel(3, nm), 'ラベル ' + nm); }
  const vs = [['1-2-3', '1-2-4', '1-3-2', '4-1-2', '4-1-3', '4-6-1'], ['5-1-2'], [], ['2-1-3', '2-1-4', '2-3-1']];
  for (const v of vs) { assert.deepStrictEqual(L.compressBets(v), Q.garonNaturalGroupBets(v)); n++; }   // 買い目のまとめ方は、Q本体と同じ(2026-09-26から)
  for (const bw of [[0.5, 0.2, 0.1, 0.1, 0.05, 0.05], [0.3, 0.29, 0.2, 0.1, 0.06, 0.05], [0.7333, 0.0597, 0.0284, 0.0634, 0.1111, 0.0041]]) ok(L.hyokaOrder(bw) === Q.garonGdbHyoka(bw), '評価順');
  // サマリーの書式(Q本体 garonGdbXSummary と同じ並び)
  const inp = { venue: '常滑', race: 4, deadline: '12:02', cumPct: 0.4537, axis: 5, axisLabel: '❺佐藤', hyoka: '1>5>4>2>3>6', tenkai: '❺佐藤のまくり差しが本線。', combos: ['5-1-2', '5-1-3', '5-2-1', '1-5-2'] };
  assert.strictEqual(L.qSummary('x', inp), ['【常滑4R】 締切12:02', '', '軸：❺佐藤', '', '展開：❺佐藤のまくり差しが本線。', '', '最終予想・買い目はプロフィール（note）から。', '', 'G.'].join(NL)); n++;
  assert.strictEqual(L.qSummary('note', inp), ['【常滑4R】 締切12:02', '', '軸：❺佐藤', '評価順：1>5>4>2>3>6', '', '展開：❺佐藤のまくり差しが本線。', '', '本線：5-1=2/5-1-3', '', '抑え：1-5-2', '', 'G.'].join(NL)); n++;
  ok(L.qSummary('x', Object.assign({}, inp, { tenkai: '' })).includes('展開：─'), '展開が空なら ─');
  // 展開ブロック
  const info = { '1-2-3': { enginePct: 5 }, '1-3-2': { enginePct: 9 }, '4-1-2': { enginePct: 1 } };
  ok(L.orderBlock(['1-2-3', '4-1-2', '1-3-2'], info).join() === '1-3-2,1-2-3,4-1-2', '塊の並び');
  ok(L.mergeBlocks([{ combos: ['1-3-2', '1-2-3'], n: 2 }, { combos: ['1-2-3', '4-1-2'], n: 2 }]).join() === '1-3-2,1-2-3,4-1-2', '塊の合流(重複は1回)');
  ok(L.mergeBlocks([{ combos: ['1-3-2', '1-2-3'], n: 1 }]).join() === '1-3-2', '点数で削る');
  ok(L.swapHeads(['1-4-2', '2-1-3']).join() === '4-1-2,1-2-3', '頭の入れ替え');
  ok(L.autoTenkai([{ winner: 5, tech: 'まくり差し' }, { winner: 2, tech: '差し' }], (no) => '<' + no + '>') === '<5>のまくり差しが本線。押さえは<2>の差し。', '展開の一言');
  // おまかせ案(確率順13点・1つの頭は最大8点・1号艇は頭にしない・オッズ10倍以上): 4件の見本すべてで規則どおりになる
  const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8'));
  for (const sm of samples) {
    const p = L.autoPlan(sm.card), all = L.mergeBlocks(p.blocks), info = sm.card.combos;
    ok(all.length === 13, sm.venue + ' 点数 ' + all.length);
    ok(all.every(c => !c.startsWith('1-') && info[c].odds >= 10), sm.venue + ' 1号艇頭なし・オッズ10倍以上');
    ok(p.blocks.length >= 2 && new Set(p.blocks.map(b => b.winner)).size === p.blocks.length && p.blocks.every(b => b.combos.length <= 8), sm.venue + ' 頭は2艇以上で別々・1つの頭は最大8点 ' + p.blocks.map(b => b.winner + ':' + b.n).join());
    ok(p.attacker === p.blocks[0].winner, sm.venue + ' 先頭の展開が軸');
    // 確率の高い順: 選ばれなかった条件を満たす出目より、選ばれた出目の確率が低いことは、頭の上限による場合を除いてない
    const chosen = new Set(all); const minChosen = Math.min(...all.map(c => info[c].enginePct));
    const skipped = Object.keys(info).filter(c => !chosen.has(c) && !c.startsWith('1-') && info[c].odds >= 10 && info[c].enginePct > minChosen);
    ok(skipped.every(c => p.blocks.find(b => b.winner === Number(c[0])) && p.blocks.find(b => b.winner === Number(c[0])).combos.length >= 8), sm.venue + ' 取りこぼしは頭の上限だけ');
    const rs = L.planReasons(sm.card, p.blocks, (no) => '#' + no);
    ok(rs.length === p.blocks.length && rs.every(r => r.lines.length >= 3 && r.lines[0].startsWith('1着になる確率')), sm.venue + ' 根拠が付く');
    const m = L.marginals(sm.card);
    ok(Math.abs(m.win.reduce((a, x) => a + x, 0) - 1) < 0.02 && Math.abs(m.top3.reduce((a, x) => a + x, 0) - 3) < 0.05, sm.venue + ' 確率の合計');
    ok(L.killCandidates(sm.card).every(k => k.top3 < 0.10), sm.venue + ' 消し候補は3着以内10%未満');
  }
  ok(L.calLookup(L.TOP3_CAL, 0.03) === 0.024 && L.calLookup(L.TOP3_CAL, 0.06) === 0.054 && L.calLookup(L.WIN_CAL, 0.3) === 0.313 && L.calLookup(L.WIN_CAL, 0.9) === 0.501, '較正の表');
  // 消し艇: 選んだ艇は、どの展開・どの着順にも出てこない
  for (const sm of samples) for (const exs of [[1], [2, 3], [4]]) {
    const p = L.autoPlan(sm.card, null, exs), all = L.mergeBlocks(p.blocks);
    ok(all.length > 0 && all.every(c => !L.hasExcluded(c, exs)) && !exs.includes(p.attacker) && p.blocks.every(b => !exs.includes(b.winner)), sm.venue + ' 消し艇' + exs + ' 点数' + all.length);
  }
  const bl = [{ winner: 5, tech: 'x', combos: ['5-1-2', '5-2-3', '5-3-4'], n: 3 }, { winner: 2, tech: 'y', combos: ['2-1-3'], n: 1 }];
  ok(L.dropExcluded(bl, [1]).length === 1 && L.dropExcluded(bl, [1])[0].combos.join() === '5-2-3,5-3-4' && L.dropExcluded(bl, [1])[0].n === 2, '消し艇を塊から外す');
  ok(L.dropExcluded(bl, [5]).length === 1 && L.dropExcluded(bl, [5])[0].winner === 2, '頭が消しなら塊ごと消える');
  ok(L.autoTenkai([{ winner: 5, tech: 'a' }], (no) => '<' + no + '>', [2, 3]) === '<5>のaが本線。<2>・<3>は消し。', '展開の一言に消し艇');
  // 買い目のまとめ方(できるだけ少ない書き方、頭・2着・3着の集まり。a=b は入れ替え)。元の買い目へ戻すと、必ず同じ集合になる
  const expand = (strs) => expandBets(strs.join('/'));
  const eq = (v, arr) => { assert.deepStrictEqual(L.compressBets(v), arr); n++; };
  eq(['1-5-2', '1-5-3', '5-1-2', '5-1-3'], ['1=5-23']);
  eq(['4-1-2', '4-1-5', '4-5-1', '4-5-2'], ['4-15-125']);
  eq(['3-2-5', '3-5-2'], ['3-2=5']);
  eq(['1-2-3'], ['1-2-3']);
  assert.strictEqual(L.compressBets(['5-1-2', '5-1-3', '5-1-4', '5-4-1', '5-2-1']).length, 2); n++;
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const allc = []; for (let a2 = 1; a2 <= 6; a2++) for (let b2 = 1; b2 <= 6; b2++) for (let c2 = 1; c2 <= 6; c2++) if (a2 !== b2 && b2 !== c2 && a2 !== c2) allc.push(a2 + '-' + b2 + '-' + c2);
  let t0 = Date.now(), worst = 0;
  for (let k = 0; k < 300; k++) {
    const pick = allc.filter(() => rnd() < (k % 3 === 0 ? 0.06 : k % 3 === 1 ? 0.12 : 0.2)).slice(0, 20);
    const t1 = Date.now(); const cs = L.compressBets(pick); worst = Math.max(worst, Date.now() - t1);
    assert.deepStrictEqual(expand(cs), pick.slice().sort(), '復元 ' + pick.join());
    assert(new Set(expand(cs)).size === expand(cs).length, '同じ買い目を2度書かない');
    assert(cs.length <= L.naturalGroupBets(pick).length, '旧方式より少ない');
  }
  n += 900; assert(worst < 1500, '最悪でも1.5秒以内 ' + worst + 'ms'); n++;
  // 参入の目安: 見本4件の tier と、確認項目が一致する(サーバー側の計算どおり)
  for (const sm of samples) {
    const e = sm.card.entry, ck = L.entryChecks(e);
    ok(e && ['strong', 'a', 'none'].includes(e.tier), sm.venue + ' tier');
    ok(e.condA === (ck[0].ok && ck[1].ok && ck[2].ok), sm.venue + ' 条件Aと確認項目が一致');
    ok(e.tier === (e.condA ? (ck[3].ok ? 'strong' : 'a') : 'none'), sm.venue + ' 強め=条件A+ST差');
  }
  const srt = L.sortByTier([{ tier: 'none', upset: 0.9 }, { tier: 'a', upset: 0.5 }, { tier: 'strong', upset: 0.4 }, { tier: 'a', upset: 0.7 }]);
  ok(srt.map(x => x.tier + x.upset).join() === 'strong0.4,a0.7,a0.5,none0.9', '一覧は強→候補→対象外、同じなら荒れやすい順');
  ok(L.tierWords('strong').includes('強') && L.tierWords('none').includes('対象外'), '言葉');
  // 狙う艇を指定すると、その艇が頭の買い目になり、先頭の展開になる(2026-09-26 CEO指摘: 軸を変えても買い目が変わらなかった)
  for (const sm of samples) for (const lane of [2, 3, 4, 5, 6]) {
    const p = L.autoPlan(sm.card, lane, []), all = L.mergeBlocks(p.blocks);
    const avail = Object.keys(sm.card.combos).filter(c => c[0] === String(lane) && sm.card.combos[c].odds >= 10).length;
    if (avail === 0) continue;
    ok(p.attacker === lane && p.blocks[0].winner === lane, sm.venue + ' 軸' + lane + ' が先頭の展開');
    ok(all.filter(c => c[0] === String(lane)).length >= Math.min(6, avail) && all.length <= 13 && all.every(c => !c.startsWith('1-')), sm.venue + ' 軸' + lane + ' の買い目数');
    ok(p.blocks.every(b => b.combos.length <= 8), sm.venue + ' 軸' + lane + ' 1つの頭は最大8点');
  }
  // 評価順(WILD用): 軸が先頭、残りは買い目に入っている確率の大きい順、買い目に無い艇は最後
  const pctOf = (c) => ({ '6-1-2': 30, '6-4-3': 10, '4-6-1': 20, '3-1-6': 5 }[c] || 0);
  const hy = L.hyokaFromBets(6, ['6-1-2', '6-4-3', '4-6-1', '3-1-6'], pctOf);
  ok(hy.startsWith('6') && hy.replace(/>/g, '').length === 6 && hy.replace(/>/g, '').slice(-1) === '5', '評価順は軸が先頭、買い目に無い5号艇が最後 ' + hy);
  ok(L.hyokaFromBets(2, ['2-1-3'], () => 10).startsWith('2>'), '評価順の形');
  // 出走表のコピー用文章
  const bt = L.boatsText(samples[0].card, '常滑', 4, '12:02').split(String.fromCharCode(10));
  ok(bt.length === 7 && bt[0] === '【常滑4R】出走表 締切12:02' && bt[1].startsWith('1 ') && bt[1].includes('全国') && bt[6].startsWith('6 '), '出走表のテキスト');
  // 出走表の画像に載せる行
  const br = L.boatsRows(samples[0].card);
  ok(br.length === 6 && br.every((r, i) => r.lane === i + 1 && r.cells.length === L.BOATS_IMG_HEAD.length && r.name && r.cls), '画像の行は6艇・列数が見出しと一致');
  ok(br[0].cells[0] === '5.85' && br[0].cells[2].endsWith('%') && br[0].cells[4] === '0.129', '画像の数字の書式');
  ok(L.boatsRows({ boats: [{ lane: 1, name: 'x', cls: 'B1', natW: null, locW: null, motT2: null, exhibit: null, st: null }] })[0].cells.join() === '-,-,-%,-,-', '欠損は - を出す');
  // 公式出走表のURL(Qの openOfficialRaceList と同じ形)
  ok(L.officialRaceListUrl('常滑', 4, '2026-09-26') === 'https://www.boatrace.jp/owpc/pc/race/racelist?rno=4&jcd=08&hd=20260926', '公式出走表のURL');
  ok(L.officialRaceListUrl('大村', '12R', '2026-01-05') === 'https://www.boatrace.jp/owpc/pc/race/racelist?rno=12&jcd=24&hd=20260105', 'R付きの番号・24場');
  ok(L.officialRaceListUrl('ほげ', 4, '2026-09-26') === null && L.officialRaceListUrl('常滑', 4, '') === null && L.officialRaceListUrl('常滑', 'x', '2026-09-26') === null, '不正なものはnull');
  const qsrc = fs.readFileSync(path.join(__dirname, '..', 'garon_q_engine.html'), 'utf8'); const qm = qsrc.match(/const OFFICIAL_VENUE_CODE=\{([\s\S]*?)\};/)[1];
  const qmap = JSON.parse('{' + qm.replace(/\s+/g, '') + '}'); assert.deepStrictEqual(qmap, JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(qmap).map(k => [k, L.officialRaceListUrl(k, 1, '2026-01-01').match(/jcd=(\d+)/)[1]])))), '会場コードがQと同じ'); n++;
  // コース巧者: 全選手の平均との比。基準(1.8倍以上・走数10以上)と苦手(0.4倍以下)、買い目に入っているか
  const card0 = { skill: { 2: { n: 30, w: 0.14, t2: 0.387 }, 3: { n: 5, w: 0.30, t2: 0.8 }, 4: { n: 40, w: 0.10, t2: 0.60 }, 5: { n: 50, w: 0.02, t2: 0.05 }, 6: { n: 25, w: 0.12, t2: 0.20 } }, laneAvg: { w: [0.547, 0.140, 0.124, 0.101, 0.057, 0.030], t2: [0.722, 0.387, 0.338, 0.266, 0.176, 0.110] } };
  const sn = L.skillNotes(card0, ['6-1-2', '1-4-2'], (n) => '<' + n + '>');
  ok(sn.length === 3, '巧者・苦手の数 ' + sn.map(x => x.lane + x.kind).join());
  const by = Object.fromEntries(sn.map(x => [x.lane, x]));
  ok(by[6].kind === 'win' && Math.abs(by[6].lift - 4) < 1e-9 && by[6].inBets === true && by[6].text.includes('1着率 12.0%') && by[6].text.includes('全選手の平均 3.0%') && by[6].text.includes('4.0倍'), '6コース巧者(1着率12%、平均3.0%の4.0倍)');
  ok(by[4].kind === 't2' && by[4].inBets === true && by[4].text.includes('連対率 60.0%'), '4コース巧者(連対)');
  ok(by[5].kind === 'weak' && by[5].inBets === false, '5コースは苦手・買い目に入っていない');
  ok(!by[2] && !by[3], '平均並み(2コース)と、走数10未満(3コース)は出さない');
  ok(L.skillNotes({}, [], null).length === 0 && L.skillNotes({ skill: card0.skill }, [], null).length === 0, 'データが無ければ何も出さない');
  // 展開の一文(CEOのお見本の型): 本線 → 2着(筆頭・次点) → 3着まで → 押さえは → 切り。買い目と食い違わない
  const ctx = { info: { '5-1-2': { enginePct: 4 }, '5-1-3': { enginePct: 3 }, '5-4-1': { enginePct: 2 }, '2-1-5': { enginePct: 5 }, '2-4-1': { enginePct: 1 } }, card: null };
  const tb = [{ winner: 5, tech: 'まくり差し', combos: ['5-1-2', '5-1-3', '5-4-1'], n: 3 }, { winner: 2, tech: '差し', combos: ['2-1-5', '2-4-1'], n: 2 }];
  ok(L.autoTenkai(tb, (no) => '<' + no + '>', [], ctx) === '狙うは<5>。まくり差しが本線。逃げは捨てる。相手筆頭は<1>、次点<4>のカド。3着は❷❸。押さえは<2>の差し。2着は<1>。❻は切り。', '展開の一文 ' + L.autoTenkai(tb, (no) => '<' + no + '>', [], ctx));
  const tb2 = [{ winner: 6, tech: 'まくり', combos: ['6-1-2'], n: 1 }];
  const cardG = { attackers: [{ lane: 6, start: { gap: -0.052 } }] };
  ok(L.autoTenkai(tb2, (no) => '<' + no + '>', [], { info: { '6-1-2': { enginePct: 3 } }, card: cardG }).includes('スタートは内より0.05秒速い。'), '数字は1つ(内より速いスタート)');
  const cardS = { skill: { 6: { n: 25, w: 0.12, t2: 0.20 } }, laneAvg: { w: [0.547, 0.140, 0.124, 0.101, 0.057, 0.030], t2: [0.722, 0.387, 0.338, 0.266, 0.176, 0.110] } };
  ok(L.autoTenkai(tb2, (no) => '<' + no + '>', [], { info: { '6-1-2': { enginePct: 3 } }, card: cardS }).includes('6コース巧者(1着率12.0%)。'), 'スタートが無ければコース巧者を1つ');
  ok((L.autoTenkai(tb2, (no) => '<' + no + '>', [], { info: { '6-1-2': { enginePct: 3 } }, card: cardG }).match(/\d+\.\d+/g) || []).length === 1, '数字は1つだけ');
  // 買い目と食い違わない: 一文に出る艇(丸数字)は、買い目に入っている艇だけ(切りの艇を除く)
  for (const sm of samples) { const p = L.autoPlan(sm.card), txt = L.autoTenkai(p.blocks, (no) => '{' + no + '}', [], { info: sm.card.combos, card: sm.card }), used = new Set(L.mergeBlocks(p.blocks).join('-').split('-').map(Number));
    const named = [...txt.matchAll(/\{(\d)\}/g)].map(m => Number(m[1])); ok(named.every(n => used.has(n)), sm.venue + ' 一文に出る艇は買い目の中'); ok(txt.startsWith('狙うは{' + p.blocks[0].winner + '}。'), sm.venue + ' 先頭は本線の頭'); }
  console.log(`PASS ${n}項目`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
