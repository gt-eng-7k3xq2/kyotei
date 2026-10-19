'use strict';
// 点数8〜12点の可変(2026-10-14)。画面側(garon_wild.html の variableK)とサーバー側(race_card.py の variable_k)が、同じオッズ列に同じ点数を返すこと。
// あわせて、おまかせ案(画面)の実カード(サンプル)で、6号艇が2着・3着の出目を外していること、点数が8〜12点、合成オッズ3.5倍以上(届かなければ12点)であること。
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const html = fs.readFileSync(path.join(__dirname, '..', 'garon_wild.html'), 'utf8');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const grab = re => { const m = html.match(re); if (!m) throw new Error('抽出失敗 ' + re); return m[0]; };
const src = grab(/const PLAN_MIN_POINTS[\s\S]*?function variableK[\s\S]*?return n;\s*\}/);
ok(!!src, '画面に可変点数の関数が入っている');
const variableK = new Function(src + '; return variableK;')();
const cases = [[12,13,15,18,20,22,25,30,35,40,45,50,60], [40,45,50,60,70,80,90,100,110,120,130,140,150], Array(13).fill(10), Array(13).fill(200), [14,15,16,18,20,24,28,34,40,50,60,70,80], [10,11,12,13,14,15]];
const py = JSON.parse(execFileSync('python', ['-c', "import sys,json;sys.path.insert(0,'scripts/wild');import race_card as r;print(json.dumps([r.variable_k(o) for o in json.loads(sys.argv[1])]))", JSON.stringify(cases)], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
cases.forEach((o, i) => ok(variableK(o) === py[i], `画面とサーバーが一致: 先頭${o[0]}倍〜${o.length}点 → ${py[i]}点`));
ok(variableK(cases[1]) === 8, '合成が高ければ8点で止まる(下限8点)');
ok(variableK(cases[2]) === 12, '合成が届かなければ12点(上限12点)');
ok(variableK(cases[5]) === 6, '候補が6点しか無ければ6点');
const code = [grab(/const PLAN_POINTS[^\n]*\n/), src, grab(/function hasExcluded[^\n]*\n/), grab(/function autoPlan[\s\S]*?return \{ attacker, blocks \};\s*\}/), grab(/function syntheticOdds[^\n]*\n/), grab(/function mergeBlocks[\s\S]*?return out;\s*\}/), grab(/const SAMPLES = [^\n]*\n/)].join('\n');
const F = new Function(code + ';return {autoPlan,mergeBlocks,syntheticOdds,SAMPLES};')();
// 2026-10-14夜: CEO指示で13点に戻した(PLAN_VARIABLE=false)。おまかせ案は12点(2026-10-18、13点から変更)・6号艇の2/3着も除外しない。可変の規則(variableK)は残してあり、スイッチを true にすれば8〜12点に戻せる。
ok(/const PLAN_VARIABLE = false;/.test(html), '画面: 点数の可変は止めてある(13点)');
ok(/PLAN_VARIABLE = False/.test(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'race_card.py'), 'utf8')), 'サーバー: 点数の可変は止めてある(13点)');
F.SAMPLES.forEach(s => {
  const cs = F.mergeBlocks(F.autoPlan(s.card, null, []).blocks);
  ok(cs.length === 12, `${s.venue}${s.race}R: ${cs.length}点(12点)`);
});
// 安定枠(2026-10-14): 三連単8点(確率順、1号艇頭も含む)。画面の関数で、実カード(サンプル)から8点・合成オッズ・p8が作れること
const codeS = [grab(/const STABLE_BANDS[^\n]*\n/), grab(/function syntheticOdds[^\n]*\n/), grab(/function stablePlan[\s\S]*?\r?\n\}\r?\n/), grab(/const SAMPLES = [^\n]*\n/)].join('\n');
const FS = new Function(codeS + ';return {stablePlan,SAMPLES};')();
FS.SAMPLES.forEach(s => {
  const sp = FS.stablePlan(s.card);
  ok(sp && sp.lines.length === 8 && sp.p8 > 0 && sp.p8 < 1 && sp.syn > 1, `${s.venue}${s.race}R: 安定枠は8点(8点の確率合計${sp ? (sp.p8 * 100).toFixed(0) : '-'}%、合成${sp ? sp.syn.toFixed(1) : '-'}倍)`);
  ok(sp.lines.every((x, i, a) => i === 0 || a[i - 1].pct >= x.pct), `${s.venue}${s.race}R: 安定枠は確率の高い順`);
});
// 一覧(ライブ・見本の両方)で、サーバーのランクが画面の行に引き継がれていること(2026-10-14夜、引き継ぎ漏れで全レースが『ランク対象外』になった不具合の再発防止)
ok(/tier: x\.tier, rank: x\.rank \|\| null/.test(html), '一覧(ライブ): ランクが行に引き継がれている');
ok(/rank: \(s\.card\.entry && s\.card\.entry\.rank\) \|\| null/.test(html), '一覧(見本): ランクが行に引き継がれている');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
