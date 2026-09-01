'use strict';
// GARON-20260901-002/セキュリティ監査継続(CEO承認: 展示欠損0秒問題の研究用最小修正を、
// 現行Qの参戦集合固定で比較する)。本番garon_q_engine.htmlは一切変更せず、
// tests/lib/fixed-q-engine.js の一時複製版で比較する。

const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadFixedQEngine } = require('./lib/fixed-q-engine.js');
const { allocateStakesEqualRet, isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }

function evalGroup(rows) {
  const hits = rows.filter(r => r.hit);
  const stake = rows.reduce((s, r) => s + r.stake, 0);
  const payout = rows.reduce((s, r) => s + r.payout, 0);
  return { n: rows.length, hits: hits.length, hitRate: rows.length ? hits.length / rows.length * 100 : 0, stake, payout, roi: stake ? payout / stake * 100 : 0 };
}

function main() {
  const orig = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const fixed = loadFixedQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  console.log(`候補母集団(isUsable) n=${usable.length}`);

  // 現行Q(原本)の参戦集合を固定
  const origRows = [];
  for (const r of usable) {
    let bets; try { bets = orig.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { continue; }
    origRows.push({ raw: r, entered: bets.judge.entered, axisBoat: bets.axes[0].boat, gap: bets.gap, bets });
  }
  const origEntered = origRows.filter(r => r.entered);
  console.log(`現行Q参戦集合(原本) n=${origEntered.length}`);

  // === 主比較: 現行Qの参戦集合(固定)で、原本 vs 修正後を比較 ===
  console.log('\n========== 主比較: 現行Qの参戦集合を固定、原本vs修正後 ==========');
  let axisChanged = 0, gapChanged = 0, betsChanged = 0;
  const origBetRows = [], fixedBetRows = [];
  for (const row of origEntered) {
    const r = row.raw;
    const origPts = [...new Set(row.bets.formations.flatMap(f => f.points))];
    const origAmt = allocateStakesEqualRet(origPts, r.oddsMap, SHIKIN);
    const pay100 = parsePayout100(r.payout);
    const origHit = origPts.includes(r.chakuju);
    origBetRows.push({ hit: origHit, stake: origAmt.reduce((s, a) => s + a, 0), payout: origHit ? Math.round(origAmt[origPts.indexOf(r.chakuju)] / 100 * pay100) : 0 });

    let fixedBets; try { fixedBets = fixed.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { fixedBets = null; }
    if (!fixedBets) continue;
    if (fixedBets.axes[0].boat !== row.axisBoat) axisChanged++;
    if (Math.abs(fixedBets.gap - row.gap) > 0.001) gapChanged++;
    const fixedPts = [...new Set(fixedBets.formations.flatMap(f => f.points))];
    if (JSON.stringify([...fixedPts].sort()) !== JSON.stringify([...origPts].sort())) betsChanged++;
    const fixedAmt = allocateStakesEqualRet(fixedPts, r.oddsMap, SHIKIN);
    const fixedHit = fixedPts.includes(r.chakuju);
    fixedBetRows.push({ hit: fixedHit, stake: fixedAmt.reduce((s, a) => s + a, 0), payout: fixedHit ? Math.round(fixedAmt[fixedPts.indexOf(r.chakuju)] / 100 * pay100) : 0 });
  }
  console.log(`軸が変わったレース数: ${axisChanged}/${origEntered.length}`);
  console.log(`gapが変わったレース数: ${gapChanged}/${origEntered.length}`);
  console.log(`買い目が変わったレース数: ${betsChanged}/${origEntered.length}`);

  const sOrig = evalGroup(origBetRows), sFixed = evalGroup(fixedBetRows);
  console.log(`\n原本  : n=${sOrig.n} 的中率${sOrig.hitRate.toFixed(1)}% ROI${sOrig.roi.toFixed(1)}%`);
  console.log(`修正後: n=${sFixed.n} 的中率${sFixed.hitRate.toFixed(1)}% ROI${sFixed.roi.toFixed(1)}%(差${(sFixed.roi - sOrig.roi).toFixed(1)}pt)`);

  // === 別表: 修正による参戦集合そのものの変化 ===
  console.log('\n========== 別表: 修正による参戦集合の変化 ==========');
  let enteredToSkipped = 0, skippedToEntered = 0;
  const fixedRowsAll = [];
  for (const r of usable) {
    let fb; try { fb = fixed.generateQBets(r.boats, r.oddsMap || {}); } catch (e) { continue; }
    fixedRowsAll.push({ raw: r, entered: fb.judge.entered });
  }
  const fixedEnteredKeys = new Set(fixedRowsAll.filter(r => r.entered).map(r => `${r.raw.date}_${r.raw.venue}_${r.raw.racenum}`));
  const origEnteredKeys = new Set(origEntered.map(r => `${r.raw.date}_${r.raw.venue}_${r.raw.racenum}`));
  for (const k of origEnteredKeys) if (!fixedEnteredKeys.has(k)) enteredToSkipped++;
  for (const k of fixedEnteredKeys) if (!origEnteredKeys.has(k)) skippedToEntered++;
  console.log(`原本で参戦→修正後は見送り: ${enteredToSkipped}件`);
  console.log(`原本で見送り→修正後は参戦: ${skippedToEntered}件`);
  console.log(`修正後の参戦集合 n=${fixedEnteredKeys.size}(原本${origEnteredKeys.size}との差、参考値)`);

  return { sOrig, sFixed, axisChanged, gapChanged, betsChanged, enteredToSkipped, skippedToEntered };
}

if (require.main === module) main();
module.exports = { main };
