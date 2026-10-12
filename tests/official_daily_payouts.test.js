'use strict';
// 公式「払戻金一覧」の解析(scripts/lib/official_daily_payouts.js)の回帰テスト。固定のHTML(2026-10-11)で検証する。
const fs = require('fs'), path = require('path'), assert = require('assert');
const { parseDailyPayouts, url } = require('../scripts/lib/official_daily_payouts');
const { addDays } = require('../scripts/fetch_daily_payouts');
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'official_pay_2026-10-11.html'), 'utf8');
const vmap = { '01': '桐生', '02': '戸田', '03': '江戸川', '06': '浜名湖', '08': '常滑' };
let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '-', e.message); process.exitCode = 1; } };
const rows = parseDailyPayouts(html, vmap);
t('URLの形式', () => assert.strictEqual(url('2026-10-11'), 'https://www.boatrace.jp/owpc/pc/race/pay?hd=20261011'));
t('桐生1Rの着順・払戻・人気', () => { const r = rows.find(x => x.venue === '桐生' && x.race === 1); assert.deepStrictEqual(r, { venue: '桐生', race: 1, chakuju: '1-2-3', payout: '¥1,680', popularity: 3 }); });
t('戸田1R・江戸川1Rも取れる', () => { assert.strictEqual(rows.find(x => x.venue === '戸田' && x.race === 1).chakuju, '3-2-6'); assert.strictEqual(rows.find(x => x.venue === '江戸川' && x.race === 1).payout, '¥1,680'); });
t('着順は1〜6の異なる3艇、払戻は100円以上、レース番号は1〜12', () => rows.forEach(r => { const c = r.chakuju.split('-'); assert(/^[1-6]-[1-6]-[1-6]$/.test(r.chakuju) && new Set(c).size === 3, r.chakuju); assert(Number(r.payout.replace(/[^0-9]/g, '')) >= 100); assert(r.race >= 1 && r.race <= 12); }));
t('同じ会場・レースが重複しない', () => assert.strictEqual(new Set(rows.map(r => r.venue + r.race)).size, rows.length));
t('会場の対応表に無い場は出さない', () => assert(rows.every(r => Object.values(vmap).includes(r.venue))));
t('日付の足し引き', () => { assert.strictEqual(addDays('2026-10-01', -1), '2026-09-30'); assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01'); });
console.log('\n' + pass + ' 項目合格');
