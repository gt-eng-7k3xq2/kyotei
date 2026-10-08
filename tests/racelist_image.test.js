'use strict';
// 公式の出走表を画像にする部品(scripts/lib/racelist_image.js)の試験(2026-10-08)。公式サイトには行かない(手元の試験用HTMLを撮る)。
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'racelist-')); process.env.GARON_WILD_DIR = path.join(tmp, 'wild');
const RL = require('../scripts/lib/racelist_image.js');
const fixture = require('url').pathToFileURL(path.join(__dirname, 'fixtures', 'racelist_fixture.html')).href;
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + e.message.split('\n')[0]); } };
const sizeOf = (png) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });
(async () => {
  await t('出走表の表(2つ目のtable1)だけを、PNGにする(2倍の解像度)', async () => {
    const r = await RL.getRacelistPng({ date: '20261008', jcd: '01', rno: 12, url: fixture, allowAll: true });
    assert(r.ok, r.error); assert(RL.isPng(r.png)); const s = sizeOf(r.png); assert(s.w === 1800, '幅 ' + s.w); assert(s.h > 200 && s.h < 700, '高さ ' + s.h);
    // 上の「レース 1R」の表ではなく出走表の表なので、見出しの青(背景画像)が写っているはず
    fs.writeFileSync(path.join(tmp, 'out.png'), r.png); });
  await t('2回目はキャッシュから返し(撮り直さない)、force=true なら撮り直す', async () => {
    const a = await RL.getRacelistPng({ date: '20261008', jcd: '01', rno: 12, url: fixture, allowAll: true }); assert(a.ok && a.fromCache === true);
    const b = await RL.getRacelistPng({ date: '20261008', jcd: '01', rno: 12, url: fixture, allowAll: true, force: true }); assert(b.ok && b.fromCache === false); });
  await t('キャッシュは40分で切れる', async () => { const r = await RL.getRacelistPng({ date: '20261008', jcd: '01', rno: 12, url: fixture, allowAll: true, nowMs: Date.now() + 41 * 60e3 }); assert(r.ok && r.fromCache === false); });
  await t('同じレースの同時リクエストは1回の撮影にまとめる', async () => {
    const args = { date: '20261008', jcd: '02', rno: 3, url: fixture, allowAll: true };
    const ps = [RL.getRacelistPng(args), RL.getRacelistPng(args), RL.getRacelistPng(args)]; assert(RL.isBuilding('20261008', '02', 3)); const rs = await Promise.all(ps); assert(rs.every((x) => x.ok)); assert(rs[0] === rs[1] && rs[1] === rs[2], '別々に撮っている'); assert(!RL.isBuilding('20261008', '02', 3)); });
  await t('表が無いページ・引数が不正なときは ok:false(例外にしない)', async () => {
    const noTable = 'data:text/html,<html><body>none</body></html>';
    const r = await RL.getRacelistPng({ date: '20261008', jcd: '03', rno: 1, url: noTable, allowAll: true, timeoutMs: 8000 }); assert(!r.ok && r.error);
    const r2 = await RL.getRacelistPng({ date: 'bad', jcd: '03', rno: 1 }); assert(!r2.ok); });

  // ---- 速い方式(公式のページをブラウザで開かず、HTMLと資源を普通のHTTPで取る)。公式には行かない: fetch を差し替える ----
  const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'racelist_fixture.html'), 'utf8');
  const realFetch = global.fetch; const seen = [];
  const mkRes = (body, type, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => type }, text: async () => String(body), arrayBuffer: async () => Buffer.from(body) });
  await t('速い方式: HTMLを普通のHTTPで取って(公式のページはブラウザで開かない)、同じ出走表の画像になる', async () => {
    global.fetch = async (u) => { seen.push(u); return mkRes(fixtureHtml, 'text/html'); };
    try { const r = await RL.shootFast({ date: '20261008', jcd: '01', rno: 12 }); assert(RL.isPng(r)); assert.strictEqual(sizeOf(r).w, 1800); }
    finally { global.fetch = realFetch; }
    assert(seen.length === 1 && /racelist\?rno=12&jcd=01&hd=20261008/.test(seen[0]), JSON.stringify(seen)); });
  await t('速い方式: 出走表の表が無いHTMLなら、例外(従来の方式に戻るきっかけ)', async () => {
    global.fetch = async () => mkRes('<html><head></head><body>none</body></html>', 'text/html');
    try { await assert.rejects(RL.shootFast({ date: '20261008', jcd: '01', rno: 1 }), /出走表の表/); } finally { global.fetch = realFetch; } });
  await t('資源(CSS・写真)は取ったら覚えて、期限内は取りに行かない。写真は14日、そのほかは2日で切れる', async () => {
    let n = 0; global.fetch = async () => { n++; return mkRes('BODY', 'image/jpeg'); };
    try {
      const u1 = 'https://www.boatrace.jp/racerphoto/9999.jpg', u2 = 'https://www.boatrace.jp/static_extra/pc/css/x.css'; const t0 = Date.now();
      const a = await RL.getAsset(u1, 'ref', t0); assert.strictEqual(a.body.toString(), 'BODY'); await RL.getAsset(u1, 'ref', t0 + 1000); assert.strictEqual(n, 1, '覚えたはずの写真を再取得している');
      await RL.getAsset(u1, 'ref', t0 + 13 * 24 * 3600e3); assert.strictEqual(n, 1, '写真が14日より前に切れている'); await RL.getAsset(u1, 'ref', t0 + 15 * 24 * 3600e3); assert.strictEqual(n, 2, '写真が14日で切れていない');
      await RL.getAsset(u2, 'ref', t0); const n2 = n; await RL.getAsset(u2, 'ref', t0 + 3 * 24 * 3600e3); assert.strictEqual(n, n2 + 1, 'CSSが2日で切れていない');
    } finally { global.fetch = realFetch; } });
  await t('資源が取れなければ null(その資源だけ写らない。全体は止めない)', async () => { global.fetch = async () => { throw new Error('offline'); }; try { assert.strictEqual(await RL.getAsset('https://www.boatrace.jp/racerphoto/1.jpg', 'ref', Date.now()), null); } finally { global.fetch = realFetch; } });
  await RL.closeBrowser();
  console.log(`\n${pass} 項目合格 / ${fail} 項目不合格`); if (fail) process.exitCode = 1; process.exit(process.exitCode || 0);
})();
