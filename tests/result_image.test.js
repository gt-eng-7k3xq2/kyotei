'use strict';
// 結果画像(scripts/lib/result_image.js)の純粋な部分の回帰テスト: 「結果が確定したページか」の判定とURL。画像の撮影そのものは、公式サイトへ接続する試験(手動)で確認する。
const fs = require('fs'), path = require('path'), assert = require('assert');
const R = require('../scripts/lib/result_image');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '-', e.message); process.exitCode = 1; } };
t('URLの形式', () => assert.strictEqual(R.pageUrl('20261012', '12', 8), 'https://www.boatrace.jp/owpc/pc/race/raceresult?rno=8&jcd=12&hd=20261012'));
t('結果が確定したページ(住之江8R)は「確定」と判定', () => assert.strictEqual(R.hasResult(fx('official_raceresult_suminoe8_2026-10-12.html')), true));
t('結果が未確定のページ(翌日の12R)は「確定していない」と判定(画像を作らない)', () => assert.strictEqual(R.hasResult(fx('official_raceresult_unconfirmed.html')), false));
t('引数が不正なら作らない', async () => { const r = await R.getResultPng({ date: '2026-10-12', jcd: '12', rno: 8 }); assert.strictEqual(r.ok, false); });
console.log('\n' + pass + ' 項目合格');
