// 軸の展開コメント(scripts/wild/comment_axis.js)の試験。本番のひな型には未接続。
// 1) 実カードで、買い目との噛み合い検査NGが0 2) 買い目を差し替えても(CEOが編集しても)NGが0 3) 同じ入力なら同じ出力(決定性)
const fs = require('fs'), path = require('path');
const { makeAxisWriter } = require('../scripts/wild/comment_axis.js');
const AW = makeAxisWriter();
const base = path.join(__dirname, '..', 'logs', 'wild', 'cards');
const days = fs.existsSync(base) ? fs.readdirSync(base).sort().slice(-3) : [];
let n = 0, ng = 0, skip = 0, nondet = 0, noEv = 0, ovN = 0, ovNg = 0, fails = [];
for (const d of days) for (const f of fs.readdirSync(path.join(base, d)).sort()) {
  let c; try { c = JSON.parse(fs.readFileSync(path.join(base, d, f), 'utf8')).card; } catch (e) { continue; }
  const r = AW.build(c, d + f); if (r.skip) { skip++; continue; }
  n++; if (r.bad.length) { ng++; fails.push(d + '/' + f + ': ' + r.bad.join(',')); }
  if (r.noAxisEvidence) noEv++;
  if (AW.build(c, d + f).comment !== r.comment) nondet++;
  // 買い目を差し替え(確率順の上位8点)
  const L = ((c.aiPick && c.aiPick.lines) || []).slice().sort((a, b) => b.enginePct - a.enginePct).slice(0, 8);
  if (L.length >= 8) { ovN++; const o = AW.build(c, d + f, L); if (o.bad.length) { ovNg++; fails.push('[8点] ' + d + '/' + f + ': ' + o.bad.join(',')); } }
}
console.log(`実カード ${n}件(買い目なし${skip}) / 噛み合いNG ${ng} / 根拠0(出さない) ${noEv} / 非決定 ${nondet} / 8点差し替え ${ovN}件中NG ${ovNg}`);
fails.slice(0, 10).forEach(x => console.log('  ' + x));
const ok = n > 0 && ng === 0 && nondet === 0 && ovNg === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
