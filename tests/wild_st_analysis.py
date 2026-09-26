"""スタートタイミング(その枠での平均ST)と荒れの関係(2026-09-26)。全期間の結果から。エンジンは使わない。
使い方: PYTHONIOENCODING=utf-8 python -W ignore tests/wild_st_analysis.py"""
import io, contextlib, sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
with contextlib.redirect_stdout(io.StringIO()):
    import wild_rule_mining as M
X, fin, date, col = M.X, M.fin, M.date, M.col
tr, te, upset = M.tr, M.te, M.upset
st = X[:, :, col['st_lane']]
win_boat = np.argmin(np.where(fin == 1, 0, 9), axis=1)
def rate(m, s=None):
    mm = m if s is None else m & s
    n = int(mm.sum()); return n, (100 * upset[mm].mean() if n else 0)
def show(label, v, cuts, mask=None):
    print(f'\n■ {label}' + ('' if mask is None else '(条件Aの中だけ)'))
    base = np.ones(len(v), bool) if mask is None else mask
    edges = [-9] + cuts + [9]
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = base & ~np.isnan(v) & (v >= lo) & (v < hi)
        a, b = rate(m, tr), rate(m, te)
        print(f'  {lo if lo>-9 else "〜":>6}〜{hi if hi<9 else "":<6} 荒れ率 学習{a[1]:5.1f}%(n={a[0]:6d}) 確かめ{b[1]:5.1f}%(n={b[0]:5d})')
# 条件A(1号艇の全国勝率≦5.41 かつ 逃げ率≦0.335 かつ 他の最高勝率>5.76)
nat = X[:, :, col['nat_w']]
A = (nat[:, 0] <= 5.41) & (X[:, 0, col['ln_w720']] <= 0.335) & (np.nanmax(nat[:, 1:], axis=1) > 5.76)
print('条件A: n=%d 荒れ率 学習%.1f%% 確かめ%.1f%% / 全体 %.1f%%' % (A.sum(), 100 * upset[A & tr].mean(), 100 * upset[A & te].mean(), 100 * upset.mean()))
f1 = st[:, 0]; g = np.nanmin(st[:, 1:4], axis=1) - st[:, 0]
inner = np.stack([st[:, a] - np.nanmean(st[:, :a], axis=1) for a in (1, 2, 3, 4)], 1); gmax = np.nanmin(inner, axis=1)
for lab, v, cuts in [('1号艇のスタート(遅いほど荒れる?)', f1, [0.13, 0.145, 0.16, 0.175]),
                     ('攻め艇(2〜4号艇)の最速ST − 1号艇ST(マイナス=攻め艇が速い)', g, [-0.04, -0.02, 0.0, 0.02]),
                     ('攻め艇と内側のST差の最大(マイナス=内側が凹んでいる)', gmax, [-0.05, -0.03, -0.01, 0.01])]:
    show(lab, v, cuts); show(lab, v, cuts, A)
# 決まり手別(勝った艇)の直前のST差: 実際に勝った艇が、内側より速かったか
print('\n■ 実際に1号艇以外が勝ったレースで、勝った艇のSTは内側の平均より速かったか(その枠の平均ST)')
rows = []
for a in range(1, 5):
    m = win_boat == a; d = st[:, a] - np.nanmean(st[:, :a], axis=1)
    allm = np.ones(len(d), bool)
    print(f'  {a+1}号艇: 勝ったとき 内側との差の平均 {np.nanmean(d[m]):+.4f}秒 / 勝たなかったとき {np.nanmean(d[~m]):+.4f}秒 (勝ち{int(m.sum())}回)')
