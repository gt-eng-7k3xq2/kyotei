'use strict';
// compressBetsSG()に「2着-3着固定・1着可変」の圧縮方式(compressBySecondThird)を追加した
// 2026-09-08の修正の回帰・可逆性検証(CEO指摘: 蒲郡5R実例で1-2-4/3-2-4のような「1着だけ違う」
// 組み合わせが圧縮されずに残っていた)。
//
// 検証方法: compressBetsSG()の出力を独立実装した decompress() で元の組み合わせ集合へ復元し、
// 元のselectedPoints(集合として)と完全一致することを確認する(圧縮による取りこぼし・
// 捏造が無いことの可逆性テスト)。
//
// 使い方: node tests/compress_bets_sg_2026-09-08.test.js

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'garon_q_engine.html');
const FROZEN_PATH = path.join(ROOT, 'research/q_stage_diagnosis_2026-09-07/snapshots/frozen_complete_races.json');

// compressBetsSG()が生成し得るセグメント形式を全て解釈して、元の"a-b-c"組み合わせ集合へ復元する。
function decompressSegment(seg) {
  // 1) hub形式: F-B=CD (2着=3着入れ替え、3人以上の相手)
  let m = seg.match(/^(\d)-(\d)=(\d+)$/);
  if (m) {
    const [, f, hub, opps] = m;
    const out = [];
    for (const o of opps) { out.push(`${f}-${hub}-${o}`); out.push(`${f}-${o}-${hub}`); }
    return out;
  }
  // 2) pair形式: F-XY-XY (2着=3着入れ替え、相手1人。2着3着が同一2文字列)
  m = seg.match(/^(\d)-(\d\d)-(\d\d)$/);
  if (m && m[2] === m[3] && m[2].length === 2) {
    const [, f, xy] = m;
    const [c1, c2] = xy.split('');
    return [`${f}-${c1}-${c2}`, `${f}-${c2}-${c1}`];
  }
  // 3) 1着=2着入れ替え形式: X=Y-CD
  m = seg.match(/^(\d)=(\d)-(\d+)$/);
  if (m) {
    const [, x, y, cs] = m;
    const out = [];
    for (const c of cs) { out.push(`${x}-${y}-${c}`); out.push(`${y}-${x}-${c}`); }
    return out;
  }
  // 4) natural形式: a-b-CD (3着可変)
  m = seg.match(/^(\d)-(\d)-(\d+)$/);
  if (m) {
    const [, a, b, cd] = m;
    return [...cd].map(c => `${a}-${b}-${c}`);
  }
  // 5) byFirstThird形式: a-BC-d (2着可変)
  m = seg.match(/^(\d)-(\d+)-(\d)$/);
  if (m) {
    const [, a, bc, d] = m;
    return [...bc].map(b => `${a}-${b}-${d}`);
  }
  // 6) bySecondThird形式(新規): AB-c-d (1着可変)
  m = seg.match(/^(\d+)-(\d)-(\d)$/);
  if (m) {
    const [, ab, c, d] = m;
    return [...ab].map(a => `${a}-${c}-${d}`);
  }
  throw new Error(`未知のセグメント形式: ${seg}`);
}

function decompress(text) {
  if (!text || text === '(なし)') return [];
  const segs = text.split('/');
  const out = [];
  for (const seg of segs) out.push(...decompressSegment(seg));
  return out;
}

function setEqual(a, b) {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}

function main() {
  console.log('garon_q_engine.html から圧縮ロジックを抽出中...');
  const engine = loadQEngine(HTML_PATH);

  // まずCEOが指摘した蒲郡5R実例そのものを検証
  const example = {
    honsen: ['2-1-4', '2-3-4', '2-5-4', '2-3-5', '2-1-3', '2-4-3', '2-5-3'],
    osaee: ['1-3-2', '1-3-4', '1-2-4', '4-3-2', '4-3-5', '4-5-2', '3-2-4', '3-5-2'],
  };
  const honsenText = engine.compressBetsSG(example.honsen.map(v => ({ val: v })));
  const osaeeText = engine.compressBetsSG(example.osaee.map(v => ({ val: v })));
  console.log(`蒲郡5R例 本線: ${honsenText}`);
  console.log(`蒲郡5R例 抑え: ${osaeeText} (旧: 1-3-24/1-2-4/4-3-25/4-5-2/3-2-4/3-5-2 = 6セグメント → 新: ${osaeeText.split('/').length}セグメント)`);
  const honsenOk = setEqual(decompress(honsenText), example.honsen);
  const osaeeOk = setEqual(decompress(osaeeText), example.osaee);
  console.log(`可逆性: 本線=${honsenOk ? 'OK' : 'NG'} 抑え=${osaeeOk ? 'OK' : 'NG'}`);
  if (!honsenOk || !osaeeOk) { console.log('蒲郡5R例で可逆性NG、中断'); process.exit(1); }

  console.log('\n凍結データで大規模検証中...');
  const races = JSON.parse(fs.readFileSync(FROZEN_PATH, 'utf8'));
  const sample = races.filter((_, i) => i % 8 === 0); // 約470件(全3,758件の約1/8)を対象、計算時間短縮のため間引き

  let fail = 0, checked = 0, bySecondThirdUsedCount = 0;
  const failExamples = [];

  for (const r of sample) {
    const support = engine.evaluateBoatSupport(r.boats);
    const attackCands = engine.identifyAttackCandidates(r.boats);
    const result = engine.generateQBets(r.boats, r.oddsMap);
    const maruBoat = result.axes[0].boat;
    let allPts = [];
    result.formations.forEach(f => f.points.forEach(p => allPts.push({ val: p })));
    const honsen = allPts.filter(b => parseInt(String(b.val).split('-')[0], 10) === maruBoat);
    const osaee = allPts.filter(b => parseInt(String(b.val).split('-')[0], 10) !== maruBoat);

    for (const [label, arr] of [['honsen', honsen], ['osaee', osaee]]) {
      if (!arr.length) continue;
      checked++;
      const text = engine.compressBetsSG(arr);
      if (/^\d\d+-\d-\d/.test(text) || text.split('/').some(s => /^\d\d+-\d-\d$/.test(s))) bySecondThirdUsedCount++;
      let decompressed;
      try { decompressed = decompress(text); } catch (e) {
        fail++; failExamples.push({ label, text, error: e.message, date: r.date, venue: r.venue, racenum: r.racenum });
        continue;
      }
      const original = arr.map(b => b.val);
      if (!setEqual(decompressed, original)) {
        fail++;
        failExamples.push({ label, text, original, decompressed, date: r.date, venue: r.venue, racenum: r.racenum });
      }
    }
  }

  console.log(`検証件数(本線/抑え個別): ${checked}`);
  console.log(`bySecondThird形式(1着可変セグメント)が実際に採用された件数: ${bySecondThirdUsedCount}`);
  console.log(`可逆性NG件数: ${fail}`);
  if (fail > 0) {
    console.log('失敗例(先頭5件):', JSON.stringify(failExamples.slice(0, 5), null, 2));
    process.exit(1);
  }
  console.log('結果: 全件、圧縮→復元が元の買い目集合と完全一致(可逆性OK)');
}

main();
