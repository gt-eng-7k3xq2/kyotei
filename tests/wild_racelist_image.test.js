'use strict';
// 公式の出走表の画像(WILD画面のボタン1つ)の、サーバーの窓口と画面の試験(2026-10-08)。
// 公式サイトには行かない(画像を作る部分は差し替え)。127.0.0.1のループバックと、ヘッドレスブラウザだけ。
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wildrl-')); const WILD = path.join(tmp, 'wild'); fs.mkdirSync(WILD, { recursive: true });
process.env.GARON_WILD_DIR = WILD; process.env.GARON_WILD_SCAN = '0';
const RL = require('../scripts/lib/racelist_image.js');
// 画像を作る部分の差し替え: 呼ばれた回数を数え、gate が開くまで待つ。失敗も作れる
let calls = 0, mode = 'ok'; let gate = Promise.resolve();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
RL.getRacelistPng = (a) => {
  calls++; const key = `${a.date}_${a.jcd}_${a.rno}`;
  const run = (async () => { await gate; if (mode === 'fail') return { ok: false, error: '公式ページを開けませんでした' }; const f = path.join(WILD, 'racelist_png'); fs.mkdirSync(f, { recursive: true }); fs.writeFileSync(path.join(f, `${key}.png`), PNG); return { ok: true, png: PNG, fromCache: false }; })().finally(() => RL._inflight.delete(key));
  RL._inflight.set(key, run); return run;   // 本物と同じく、作成中として登録する
};
const { startServer } = require('../scripts/race_ops_server');
const W = require('../scripts/lib/wild_live'); const { todayDateStrJST } = require('../scripts/lib/jst_time'); const date = todayDateStrJST();
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wild', 'samples', 'sample_cards.json'), 'utf8')); const [a, b] = samples;
let pass = 0, fail = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);
const now = async (name, fn) => { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + String(e.message).split(String.fromCharCode(10))[0]); } };
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { const ch = []; r.on('data', (c) => ch.push(c)); r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'] || '', body: Buffer.concat(ch) })); }).on('error', rej));
const q = (sm) => `/api/wild/racelist-image?venue=${encodeURIComponent(sm.venue)}&race=${sm.race}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const sm of [a, b]) W.writeJsonAtomic(W.cardFile(date, sm.venue, sm.race), { ok: true, rawTs: 9e15, venue: sm.venue, race: sm.race, deadline: '23:50', card: JSON.parse(JSON.stringify(sm.card)) });
  const server = await startServer(0); const port = server.address().port;
  let release; gate = new Promise((r) => { release = r; });
  const r0 = await get(port, q(a)); const r0b = await get(port, q(a));
  await now('サーバー: できていないあいだは202(作成中)を返し、同じレースを何度聞いても、作成は1回だけ', () => { assert.strictEqual(r0.status, 202); assert.strictEqual(JSON.parse(r0.body).pending, true); assert.strictEqual(r0b.status, 202); assert.strictEqual(calls, 1, '作成を ' + calls + ' 回始めた'); });
  release(); await sleep(150); const r1 = await get(port, q(a));
  await now('サーバー: できたら200で、PNGの画像を返す(content-type: image/png)', () => { assert.strictEqual(r1.status, 200); assert(/image\/png/.test(r1.type)); assert.deepStrictEqual(r1.body.slice(0, 8), PNG.slice(0, 8)); });
  const callsAfter = calls; await get(port, q(a));
  await now('サーバー: できあがった後は、聞いても作り直さない', () => { assert.strictEqual(calls, callsAfter); });
  const s400 = (await get(port, '/api/wild/racelist-image?venue=xx&race=1')).status, s400b = (await get(port, q(a).replace(/race=\d+/, 'race=99'))).status, s404 = (await get(port, q({ venue: a.venue, race: a.race === 12 ? 11 : 12 }))).status;
  await now('サーバー: 会場・レース番号が不正なら400、カードの無いレースは404', () => { assert.strictEqual(s400, 400); assert.strictEqual(s400b, 400); assert.strictEqual(s404, 404); });
  mode = 'fail'; const rf1 = await get(port, q(b)); await sleep(150); const rf2 = await get(port, q(b)); const n1 = calls; const rf3 = await get(port, q(b));
  await now('サーバー: 作成に失敗したら、次の問い合わせは502とエラー文。直後の1分は作り直さない', () => { assert.strictEqual(rf1.status, 202); assert.strictEqual(rf2.status, 502); assert(/公式ページ/.test(JSON.parse(rf2.body).error)); assert.strictEqual(rf3.status, 502); assert.strictEqual(calls, n1); });
  await new Promise((res) => server.close(res));

  // ---- 画面 ----
  let chromium; try { ({ chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'))); } catch (e) { chromium = null; }
  const live = path.join(__dirname, '..', 'garon_wild.html');
  if (chromium && fs.existsSync(live)) {
    const br = await chromium.launch({ headless: true }); const p = await br.newPage(); await p.goto(require('url').pathToFileURL(live).href); await p.waitForTimeout(600);
    const sample = await p.evaluate(async () => { await startRace(1); await new Promise((r) => setTimeout(r, 200)); return { btn: !!document.getElementById('btnRacelist'), rl: S.rl || null }; });
    t('画面: サンプル(ダミー)モードでは、画像のボタンを出さず、準備もしない', () => { assert.strictEqual(sample.btn, false); assert.strictEqual(sample.rl, null); });
    const ui = await p.evaluate(async (pngB64) => {
      DataSource.mode = 'live'; const out = { texts: [], shared: null, fetches: 0 };
      const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0)); let n = 0;
      window.fetch = async (u) => { out.fetches++; n++; if (n === 1) return new Response(JSON.stringify({ ok: true, pending: true }), { status: 202, headers: { 'content-type': 'application/json' } }); return new Response(new Blob([bytes], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } }); };
      window.setTimeout = ((orig) => (fn, ms, ...a) => orig(fn, ms > 1000 ? 5 : ms, ...a))(window.setTimeout);   // 3秒の待ちを短く
      S = { meta: { venue: '桐生', race: 12, deadline: '20:45' }, card: SAMPLES[0].card, blocks: [], attacker: 1, excluded: new Set(), tags: new Set() };
      const holder = document.createElement('div'); holder.innerHTML = racelistButtonHtml(); document.body.appendChild(holder); const btn = document.getElementById('btnRacelist'); btn.onclick = onRacelistClick;
      updateRacelistButton(); out.texts.push(btn.textContent);
      await onRacelistClick();   // 作成中(prefetch開始前の押下は、準備を始める)
      for (let i = 0; i < 60 && !(S.rl && S.rl.state === 'ready'); i++) await new Promise((r) => setTimeout(r, 20));
      out.texts.push(btn.textContent); out.state = S.rl && S.rl.state;
      navigator.canShare = () => true; navigator.share = async (d) => { out.shared = { n: d.files.length, name: d.files[0].name, type: d.files[0].type, size: d.files[0].size, title: d.title }; };
      await onRacelistClick(); return out; }, PNG.toString('base64'));
    t('画面: 準備ができるとボタンの表示が変わり、押すと共有(ファイル名・PNG)が1回で出る', () => { assert(/準備中/.test(ui.texts[0]), ui.texts[0]); assert.strictEqual(ui.state, 'ready'); assert(/公式の出走表を画像で保存/.test(ui.texts[1]), ui.texts[1]); assert(ui.shared, '共有が呼ばれていない'); assert.strictEqual(ui.shared.n, 1); assert.strictEqual(ui.shared.name, 'G_出走表_桐生12R.png'); assert.strictEqual(ui.shared.type, 'image/png'); assert(ui.shared.size > 0); });
    await br.close();
  } else console.log('SKIP 画面の試験(playwrightまたはgaron_wild.htmlが無い)');
  for (const [name, fn] of tests) { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + ': ' + e.message.split('\n')[0]); } }
  console.log(`\n${pass} 項目合格 / ${fail} 項目不合格`); if (fail) process.exitCode = 1; process.exit(process.exitCode || 0);
})();
