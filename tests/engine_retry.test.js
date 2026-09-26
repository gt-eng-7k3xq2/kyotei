'use strict';
// エンジン呼び出しの「ブロックされたときだけ再試行」の回帰テスト。作り物の呼び出し関数で、待ち時間も注入する(実際には待たない)。
const { isBlockedFailure, retrySync, retryAsync } = require('../scripts/lib/engine-db-adapter');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log('  PASS: ' + name); pass++; } else { console.log('  FAIL: ' + name); fail++; } }
const OK = { ok: true, top1p: 0.2, probs: [1] };
const BLOCKED = () => ({ ok: false, error: 'エンジン異常終了: ImportError: DLL load failed', _blocked: true });
const REAL_ERR = () => ({ ok: false, error: 'エンジン異常終了: KeyError: boats', _blocked: false });

console.log('=== ブロックの判定 ===');
check('日本語のブロックのメッセージを検知', isBlockedFailure('ImportError: DLL load failed while importing _qmvnt_cy: アプリケーション制御ポリシーによってこのファイルがブロックされました。'));
check('DLL load failed を検知', isBlockedFailure('ImportError: DLL load failed while importing _shortest_path'));
check('英語の application control を検知', isBlockedFailure('blocked by an application control policy'));
check('普通のエラー(KeyError)は、ブロックと判定しない', !isBlockedFailure('KeyError: boats'));
check('空でも例外を出さない', !isBlockedFailure('') && !isBlockedFailure(null) && !isBlockedFailure(undefined));

console.log('=== 同期の再試行 ===');
{
  let calls = 0; const sleeps = []; const logs = [];
  const r = retrySync(() => (++calls <= 2 ? BLOCKED() : OK), { sleep: (ms) => sleeps.push(ms), log: (m) => logs.push(m) });
  check('2回ブロックされても、3回目で成功する', r.ok === true && calls === 3);
  check('待ち時間は 3秒→9秒', sleeps.length === 2 && sleeps[0] === 3000 && sleeps[1] === 9000);
  check('成功した結果に、内部の目印(_blocked)が残らない', !('_blocked' in r));
  check('再試行の記録が、2件残る', logs.length === 2);
}
{
  let calls = 0; const sleeps = [];
  const r = retrySync(() => { calls++; return BLOCKED(); }, { sleep: (ms) => sleeps.push(ms), log: () => {} });
  check('ずっとブロックされたら、3回で諦める', calls === 3 && r.ok === false);
  check('諦めたときのメッセージに、再試行済みと出る', /再試行しても/.test(r.error) && !('_blocked' in r));
  check('待つ合計は12秒以内', sleeps.reduce((a, b) => a + b, 0) <= 12000);
}
{
  let calls = 0; const r = retrySync(() => { calls++; return REAL_ERR(); }, { sleep: () => { throw new Error('待つべきでない'); }, log: () => {} });
  check('本当のエラーは、再試行しない(1回だけ)', calls === 1 && r.ok === false && !/再試行しても/.test(r.error));
}
{
  let calls = 0; const r = retrySync(() => { calls++; return OK; }, { sleep: () => { throw new Error('待つべきでない'); }, log: () => {} });
  check('最初から成功なら、1回だけ・結果はそのまま', calls === 1 && r === OK);
}
{
  const r = retrySync(() => ({ ok: false, error: 'エンジン起動失敗: タイムアウト' }), { sleep: () => { throw new Error('待つべきでない'); }, log: () => {} });
  check('タイムアウトなど、目印(_blocked)が無い失敗は、再試行しない', r.ok === false);
}

console.log('=== 非同期の再試行 ===');
(async () => {
  {
    let calls = 0; const sleeps = [];
    const r = await retryAsync(async () => (++calls <= 1 ? BLOCKED() : OK), { sleep: async (ms) => { sleeps.push(ms); }, log: () => {} });
    check('1回ブロックされても、2回目で成功する', r.ok === true && calls === 2 && sleeps[0] === 3000);
  }
  {
    let calls = 0; const r = await retryAsync(async () => { calls++; return BLOCKED(); }, { sleep: async () => {}, log: () => {} });
    check('ずっとブロックされたら、3回で諦める', calls === 3 && r.ok === false && /再試行しても/.test(r.error));
  }
  {
    let calls = 0; const r = await retryAsync(async () => { calls++; return REAL_ERR(); }, { sleep: async () => { throw new Error('待つべきでない'); }, log: () => {} });
    check('本当のエラーは、再試行しない', calls === 1 && r.ok === false);
  }
  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`); process.exit(fail ? 1 : 0);
})();
