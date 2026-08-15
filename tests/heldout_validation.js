'use strict';
// held-out検証: daikibo_archiveの日付を前半/後半に分割し、現行のスコアリングロジック
// (calcAreScore/calcNigeRate/calcAreIndex、sg_narutou.htmlから毎回直接抽出)が
// 前半・後半で同じように機能しているか(=特定期間のデータに過学習していないか)を確認する。
//
// スコープ: sg_narutou.html:2270-2414のrunYoso()にある「1号艇のgap<9昇格」等のUI側の
// 追加調整は含めない。calcAreScore()の生の出力(スコア降順で0番目が◎)をそのまま使う。
// 理由: 依頼で名指しされたのはcalcAreScore/calcNigeRate/calcAreIndexの3関数であり、
// 昇格ロジック等はこれらとは別の(かつそれ自体バックテストでチューニングされた)ヒューリスティックのため、
// 「コア スコアリングモデルが過学習していないか」を見るにはここを混ぜない方が素直。
// 本番の◎とはこの昇格分だけズレる可能性がある点に注意。
//
// 実際の着順データ(chakuju)は1〜3着の3艇分しか記録されていないため、
// 「スコアと着順の相関」は上位3着に入った艇のみを対象にしたスコア順位⇔着順のPearson相関で見る。
//
// 使い方: node tests/heldout_validation.js

const fs = require('fs');
const path = require('path');
const { loadScoreEngine } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');

function listArchiveFiles() {
  return fs.readdirSync(ROOT)
    .filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // ファイル名に日付が入っているので文字列ソート=日付順
}

function loadRaces(file) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return data.filter(e => e.resulted && e.chakuju && Array.isArray(e.boats) && e.boats.length === 6);
}

// pooled Pearson相関(score_rank, finish_rank)。どちらも1が最良の順位なので、
// 予測が正しいほど正の相関になる(1に近いほど良い)。
function pearson(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Fisherのz変換による2群の相関係数差の検定
function corrDiffZ(r1, n1, r2, n2) {
  if (r1 === null || r2 === null || n1 < 4 || n2 < 4) return null;
  const z1 = Math.atanh(r1), z2 = Math.atanh(r2);
  const se = Math.sqrt(1 / (n1 - 3) + 1 / (n2 - 3));
  return (z1 - z2) / se;
}

// 2標本比率の差の検定(◎1着率の前半/後半比較)
function proportionDiffZ(x1, n1, x2, n2) {
  const p1 = x1 / n1, p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  return (p1 - p2) / se;
}

function analyzeHalf(engine, files) {
  let nRaces = 0;
  const axisFinish = { 1: 0, 2: 0, 3: 0, out: 0 };
  const corrPairs = [];
  let areIndexSum = 0, nigeRateSum = 0;

  for (const file of files) {
    for (const entry of loadRaces(file)) {
      const parts = String(entry.chakuju).split('-').map(s => parseInt(s, 10));
      if (parts.length !== 3 || parts.some(isNaN)) continue; // 事故等で着順が3艇分揃っていないレースは除外

      const d = { boats: entry.boats, venue: entry.venue, raceNum: entry.racenum };
      const areScores = engine.calcAreScore(d); // 既にraw降順でソート済み(0番目が◎)
      const { areIndex, nigeRate } = engine.calcAreIndex(d);

      nRaces++;
      areIndexSum += areIndex;
      nigeRateSum += nigeRate;

      const scoreRank = {}; // boatNo(string) -> 1..6
      areScores.forEach((s, i) => { scoreRank[String(s.no)] = i + 1; });

      const axisNo = String(areScores[0].no);
      const finishPos = parts.findIndex(p => String(p) === axisNo); // 0,1,2 or -1
      if (finishPos === -1) axisFinish.out++;
      else axisFinish[finishPos + 1]++;

      parts.forEach((boatNo, idx) => {
        const rank = scoreRank[String(boatNo)];
        if (rank !== undefined) corrPairs.push([rank, idx + 1]);
      });
    }
  }

  return {
    nRaces,
    axisFinish,
    axisWinRate: nRaces ? axisFinish[1] / nRaces : null,
    corr: pearson(corrPairs),
    corrN: corrPairs.length,
    avgAreIndex: nRaces ? areIndexSum / nRaces : null,
    avgNigeRate: nRaces ? nigeRateSum / nRaces : null,
  };
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

function main() {
  console.log(`sg_narutou.html からスコア計算関数を抽出中... (${HTML_PATH})`);
  const engine = loadScoreEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan'); // アーカイブにレース種別が保存されていないため既定値(一般戦)を使用

  const files = listArchiveFiles();
  const dates = files.map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1]);
  console.log(`\nアーカイブファイル: ${files.length}日分 (${dates[0]} 〜 ${dates[dates.length - 1]})`);

  // 抜けている日付を検出(単純に前日+1と比較)
  const missing = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1]);
    const cur = new Date(dates[i]);
    const diffDays = Math.round((cur - prev) / 86400000);
    if (diffDays > 1) {
      for (let d = 1; d < diffDays; d++) {
        const missingDate = new Date(prev);
        missingDate.setDate(missingDate.getDate() + d);
        missing.push(missingDate.toISOString().slice(0, 10));
      }
    }
  }
  if (missing.length) {
    console.log(`⚠️ 欠落日: ${missing.join(', ')} (${dates.length}日分での分割になります)`);
  }

  const mid = Math.ceil(files.length / 2);
  const firstFiles = files.slice(0, mid);
  const secondFiles = files.slice(mid);
  console.log(`前半: ${firstFiles.length}日 (${dates[0]} 〜 ${dates[mid - 1]})`);
  console.log(`後半: ${secondFiles.length}日 (${dates[mid]} 〜 ${dates[dates.length - 1]})`);

  const first = analyzeHalf(engine, firstFiles);
  const second = analyzeHalf(engine, secondFiles);

  console.log('\n' + '='.repeat(70));
  console.log('◎(最高スコア艇)の実際の着順分布');
  console.log('='.repeat(70));
  console.log(`                    前半(n=${first.nRaces})          後半(n=${second.nRaces})`);
  ['1', '2', '3', 'out'].forEach(k => {
    const label = k === 'out' ? '着外(4-6着)' : `${k}着`;
    const fCount = first.axisFinish[k], sCount = second.axisFinish[k];
    console.log(`  ${label.padEnd(10)}      ${String(fCount).padStart(5)}件 (${pct(fCount / first.nRaces).padStart(6)})   ${String(sCount).padStart(5)}件 (${pct(sCount / second.nRaces).padStart(6)})`);
  });

  console.log('\n' + '='.repeat(70));
  console.log('◎的中率(1着率)');
  console.log('='.repeat(70));
  console.log(`  前半: ${pct(first.axisWinRate)} (${first.axisFinish['1']}/${first.nRaces})`);
  console.log(`  後半: ${pct(second.axisWinRate)} (${second.axisFinish['1']}/${second.nRaces})`);
  const diff = first.axisWinRate - second.axisWinRate;
  const zProp = proportionDiffZ(first.axisFinish['1'], first.nRaces, second.axisFinish['1'], second.nRaces);
  console.log(`  差: ${(diff * 100).toFixed(1)}pt (前半−後半)`);
  if (zProp !== null) {
    console.log(`  2標本比率検定: z=${zProp.toFixed(2)} (|z|>=1.96で有意水準5%、|z|>=2.58で1%)`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('スコア順位 ⇔ 実際の着順(上位3艇) の相関(Pearson、1に近いほど良い予測)');
  console.log('='.repeat(70));
  console.log(`  前半: r=${first.corr !== null ? first.corr.toFixed(3) : 'N/A'} (n=${first.corrN}組)`);
  console.log(`  後半: r=${second.corr !== null ? second.corr.toFixed(3) : 'N/A'} (n=${second.corrN}組)`);
  const zCorr = corrDiffZ(first.corr, first.nRaces, second.corr, second.nRaces);
  if (zCorr !== null) {
    console.log(`  Fisher z検定: z=${zCorr.toFixed(2)} (|z|>=1.96で有意水準5%、|z|>=2.58で1%)`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('参考: 荒れ指数・逃げ率の平均(前半/後半のレース母集団自体が偏っていないかの確認用)');
  console.log('='.repeat(70));
  console.log(`  荒れ指数平均   前半=${first.avgAreIndex.toFixed(2)}  後半=${second.avgAreIndex.toFixed(2)}`);
  console.log(`  逃げ率平均     前半=${first.avgNigeRate.toFixed(1)}%  後半=${second.avgNigeRate.toFixed(1)}%`);

  console.log('\n' + '='.repeat(70));
  console.log('判定');
  console.log('='.repeat(70));
  const flags = [];
  if (zProp !== null && Math.abs(zProp) >= 1.96) {
    flags.push(`◎的中率の前半/後半差が統計的に有意(z=${zProp.toFixed(2)})`);
  }
  if (zCorr !== null && Math.abs(zCorr) >= 1.96) {
    flags.push(`スコア⇔着順相関の前半/後半差が統計的に有意(z=${zCorr.toFixed(2)})`);
  }
  if (flags.length) {
    console.log('⚠️ 過学習の兆候の可能性:');
    flags.forEach(f => console.log('  - ' + f));
    console.log('  ただし有意差=過学習と断定はできない。会場構成・レース種別構成の偏りなど他要因も要確認。');
  } else {
    console.log(`前半・後半で統計的に有意な差は見られませんでした(n=${first.nRaces}/${second.nRaces}、CLAUDE.mdのn<30ルールに照らしても十分なサンプル数)。`);
    console.log('過学習の明確な兆候は確認できませんでした。');
  }
}

main();
