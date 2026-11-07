'use strict';
// 参入ポイントの統計: 全カード(目安なしも含む)に、AIおすすめ12点×100円を当てた成績を、条件別に比べる。読み取り専用。
const fs = require('fs'), path = require('path');
const W = path.join(__dirname, '..', 'logs', 'wild');
const rows = [];
for (const d of fs.readdirSync(path.join(W, 'cards')).filter(x => /^\d{4}-\d\d-\d\d$/.test(x)).sort()) {
  let R = {}; try { R = JSON.parse(fs.readFileSync(path.join(W, `results_${d}.json`), 'utf8')); } catch (e) { continue; }
  for (const f of fs.readdirSync(path.join(W, 'cards', d))) {
    let w; try { w = JSON.parse(fs.readFileSync(path.join(W, 'cards', d, f), 'utf8')); } catch (e) { continue; }
    const c = w.card; if (!c || !c.aiPick || !Array.isArray(c.aiPick.lines)) continue;
    const res = R[w.venue + '_' + w.race]; if (!res || res.kind !== 'confirmed' || !res.chakuju) continue;
    const lines = c.aiPick.lines.map(l => l.combo); if (lines.length !== 12) continue;
    const hit = lines.includes(res.chakuju), pay = hit ? parseInt(String(res.payout).replace(/\D/g, ''), 10) / 100 : 0;
    const e = c.entry || {}, fav = (c.lane1 && c.lane1.nigePct) || null;
    rows.push({ d, venue: w.venue, rn: Number(w.race), hit, pay, rank: e.rank || 'なし', upset: e.upset, gosei: c.aiPick.goseiOdds, p13: e.p13, escape1: e.escape1, gap: e.gap, natW1: e.natW1, axis: (lines[0] || '0').split('-')[0] });
  }
}
const q = (a, p) => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const stat = (rs) => { const n = rs.length, h = rs.filter(r => r.hit).length, pay = rs.reduce((m, r) => m + r.pay, 0); const p = h / n, se = Math.sqrt(p * (1 - p) / n); return { n, hit: p, roi: pay / (n * 12), lo: p - 1.96 * se, hi: p + 1.96 * se }; };
const fmt = (k, s) => `${k.padEnd(14)} n=${String(s.n).padStart(5)}  的中率 ${(s.hit * 100).toFixed(1)}% (${(s.lo * 100).toFixed(0)}〜${(s.hi * 100).toFixed(0)})  回収率 ${(s.roi * 100).toFixed(0)}%`;
const mid = rows.length ? rows.map(r => r.d).sort()[Math.floor(rows.length / 2)] : '';
console.log(`全カード n=${rows.length}  期間 ${rows[0].d}〜${rows[rows.length - 1].d}  前半/後半の境 ${mid}`);
console.log(fmt('全体', stat(rows)));
function by(title, keyf) {
  console.log('\n■ ' + title); const g = {}; rows.forEach(r => { const k = keyf(r); if (k != null) (g[k] = g[k] || []).push(r); });
  Object.keys(g).sort().forEach(k => { const a = g[k], s = stat(a), f = stat(a.filter(r => r.d < mid)), l = stat(a.filter(r => r.d >= mid)); console.log(fmt(String(k), s) + `   前半${f.n ? (f.roi * 100).toFixed(0) : '-'}% 後半${l.n ? (l.roi * 100).toFixed(0) : '-'}%${s.n < 30 ? '  (n<30 参考外)' : ''}`); });
}
const bin = (v, cuts, lab) => { if (v == null || !isFinite(v)) return null; let i = 0; while (i < cuts.length && v >= cuts[i]) i++; return lab[i]; };
by('目安', r => r.rank);
by('合成オッズ(12点)', r => bin(r.gosei, [1.5, 2, 2.5, 3, 4], ['a<1.5', 'b1.5-2', 'c2-2.5', 'd2.5-3', 'e3-4', 'f4+']));
by('荒れ度', r => bin(r.upset, [0.2, 0.3, 0.4, 0.5, 0.6], ['a<20%', 'b20-30', 'c30-40', 'd40-50', 'e50-60', 'f60+']));
by('12点の確率合計(p13の近似)', r => bin(r.p13, [0.1, 0.15, 0.2, 0.25, 0.3], ['a<10%', 'b10-15', 'c15-20', 'd20-25', 'e25-30', 'f30+']));
by('1号艇の逃げ見込み', r => bin(r.escape1, [0.3, 0.4, 0.5, 0.6, 0.7], ['a<30%', 'b30-40', 'c40-50', 'd50-60', 'e60-70', 'f70+']));
by('レース番号', r => r.rn <= 4 ? 'a1-4R' : r.rn <= 8 ? 'b5-8R' : 'c9-12R');
by('買い目の頭の艇', r => r.axis);

console.log('\n■ 組み合わせ(重なりが大きい条件なので、足し算ではなく重ねて確認)');
const combos = {
  '確率合計25%以上': r => r.p13 >= 0.25,
  '確率合計25%以上 かつ 逃げ見込み50%未満': r => r.p13 >= 0.25 && r.escape1 < 0.5,
  '確率合計25%以上 かつ 荒れ度60%以上': r => r.p13 >= 0.25 && r.upset >= 0.6,
  '確率合計25%以上 かつ 荒れ度60%以上 かつ 1〜8R': r => r.p13 >= 0.25 && r.upset >= 0.6 && r.rn <= 8,
  '確率合計20%未満': r => r.p13 < 0.2,
  '合成2.5倍未満': r => r.gosei < 2.5,
  '合成2.5倍未満 かつ 確率合計25%以上': r => r.gosei < 2.5 && r.p13 >= 0.25,
};
for (const k in combos) { const a = rows.filter(combos[k]); if (!a.length) continue; const s = stat(a), f = stat(a.filter(r => r.d < mid)), l = stat(a.filter(r => r.d >= mid)); console.log(fmt(k, s).replace(k.padEnd(14), k + ' ') + `  前半${f.n ? (f.roi * 100).toFixed(0) : '-'}%(n${f.n}) 後半${l.n ? (l.roi * 100).toFixed(0) : '-'}%(n${l.n})  1日${(s.n / 20).toFixed(1)}本`); }
// 雄大さんが実際に入ったレース(最後の記録)の分布
const led = new Map(); fs.readFileSync(path.join(W, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).forEach(x => { try { const e = JSON.parse(x); if (e.mode === 'live' && e.action === 'bet' && e.raceDate >= '2026-10-19') led.set(e.raceDate + e.venue + e.raceNo, e); } catch (e) { } });
const mineRows = rows.filter(r => led.has(r.d + r.venue + r.rn));
console.log(`\n■ 雄大さんが入ったレース n=${mineRows.length} / 全カード ${rows.length}`);
for (const [k, f] of [['確率合計25%以上', r => r.p13 >= 0.25], ['確率合計20%未満', r => r.p13 < 0.2], ['荒れ度60%以上', r => r.upset >= 0.6], ['合成3倍以上', r => r.gosei >= 3], ['逃げ見込み50%以上', r => r.escape1 >= 0.5]]) console.log(k.padEnd(14) + ` 雄大さん ${(mineRows.filter(f).length / mineRows.length * 100).toFixed(0)}%  全カード ${(rows.filter(f).length / rows.length * 100).toFixed(0)}%`);
