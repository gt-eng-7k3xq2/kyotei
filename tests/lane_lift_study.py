"""「その枠(コース)の連対率を、全選手のその枠の平均と比べた巧者度」が、エンジンの見立てを超えて効くか(2026-09-26、CEO依頼)。
巧者度(lift) = 選手のその枠の連対率(ln_t2_720) ÷ 全選手のその枠の平均。例: 6コースの平均3.6%、この選手12% → lift 3.3。
エンジンの予測(eval_P: 学習に使っていない期間の予測)から艇ごとの連対確率を作り、実際と比べる。A期間で補正を学び、B期間(完全に未来)で確かめる。
使い方: PYTHONIOENCODING=utf-8 python -W ignore tests/lane_lift_study.py  (読み取りだけ)"""
import os, itertools, numpy as np
from sklearn.linear_model import LogisticRegression
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'engine_db', 'data')
z = np.load(os.path.join(ROOT, 'dataset.npz'), allow_pickle=True)
X, fin, date = z['X'], z['fin'], z['date']; names = [str(n) for n in z['names']]; col = {n: i for i, n in enumerate(names)}
COMBOS = list(itertools.permutations(range(6), 3))
def boat_top2(P):
    """艇ごとの連対(2着以内)確率と3着以内確率。P: レース×120"""
    R = len(P); t2 = np.zeros((R, 6)); t3 = np.zeros((R, 6))
    for j, (a, b, c) in enumerate(COMBOS):
        t2[:, a] += P[:, j]; t2[:, b] += P[:, j]; t3[:, a] += P[:, j]; t3[:, b] += P[:, j]; t3[:, c] += P[:, j]
    return t2, t3
# 枠ごとの、全選手の連対率の平均(2025-04-01より前=Aの学習より前だけで作る。先読みしない)
pre = date < '2025-04-01'
lane_avg = np.array([np.mean((fin[pre][:, k] <= 2) & (fin[pre][:, k] >= 1)) for k in range(6)])
print('全選手の、枠ごとの連対率の平均(〜2025-03-31):', ' '.join(f'{k+1}コース{100*v:.1f}%' for k, v in enumerate(lane_avg)))

def prep(start, end, Pfile):
    m = (date >= start) & (date < end); P = np.load(os.path.join(ROOT, Pfile)).astype(np.float64)
    # Pfileは、その期間の最初から並んでいる(eval_Pの作り方)。行数が期間と合わない場合は先頭から切る
    Xs, fs = X[m], fin[m]; n = min(len(P), len(Xs)); P, Xs, fs = P[:n], Xs[:n], fs[:n]
    t2, t3 = boat_top2(P); y2 = ((fs >= 1) & (fs <= 2)).astype(int); y3 = ((fs >= 1) & (fs <= 3)).astype(int)
    rate = Xs[:, :, col['ln_t2_720']]; nn = Xs[:, :, col['ln_n720']]
    lift = rate / lane_avg[None, :]
    return dict(t2=t2, t3=t3, y2=y2, y3=y3, lift=lift, n=nn, rate=rate)
A = prep('2025-04-01', '2025-12-21', 'eval_P_2025-04-01.npy'); B = prep('2025-12-21', '2027-01-01', 'eval_P_2025-12-21.npy')
print('A期間', A['t2'].shape[0], 'レース / B期間', B['t2'].shape[0], 'レース')

def lg(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
print('\n■ 巧者度(lift)の区分ごとの、エンジンの見立てと実際(B期間、連対=2着以内)')
bins = [(0, 0.5), (0.5, 0.8), (0.8, 1.2), (1.2, 1.8), (1.8, 3.0), (3.0, 99)]
for lane in (6, 5, 4, 3, 2, 1):
    k = lane - 1; print(f'  [{lane}コース] 全選手の平均連対 {100*lane_avg[k]:.1f}%')
    for lo, hi in bins:
        m = (B['lift'][:, k] >= lo) & (B['lift'][:, k] < hi) & (B['n'][:, k] >= 10)   # 直近720日で10走以上の選手
        if m.sum() < 200: continue
        print(f'     lift {lo}〜{hi if hi<99 else ""}: n={int(m.sum()):6d}  選手の連対率(平均){100*B["rate"][m, k].mean():5.1f}%  エンジンの見立て{100*B["t2"][m, k].mean():5.1f}%  実際{100*B["y2"][m, k].mean():5.1f}%')

print('\n■ エンジンの見立てに、巧者度を足すと良くなるか(A期間で学習→B期間で評価。艇ごとの連対を予測、対数損失、小さいほど良い)')
def rows(D, lanes):
    out = []
    for k in lanes:
        m = D['n'][:, k] >= 0
        p = np.clip(D['t2'][:, k], 1e-4, 1 - 1e-4); lg_p = np.log(p / (1 - p)); lf = np.log(np.clip(D['lift'][:, k], 0.05, 20))
        n = np.log1p(D['n'][:, k]); conf = lf * (D['n'][:, k] / (D['n'][:, k] + 12))    # 走数が少ない選手の巧者度は割り引く
        out.append((np.stack([lg_p, lf, conf, n], 1), D['y2'][:, k]))
    return out
for label, lanes in (('全コース', range(6)), ('外枠 4〜6コース', range(3, 6)), ('6コースだけ', [5])):
    Xa = np.vstack([r[0] for r in rows(A, lanes)]); ya = np.concatenate([r[1] for r in rows(A, lanes)])
    Xb = np.vstack([r[0] for r in rows(B, lanes)]); yb = np.concatenate([r[1] for r in rows(B, lanes)])
    base = lg(1 / (1 + np.exp(-Xb[:, 0])), yb)                                           # エンジンそのまま
    m1 = LogisticRegression(C=1.0, max_iter=200).fit(Xa[:, :1], ya); l1 = lg(m1.predict_proba(Xb[:, :1])[:, 1], yb)      # 較正だけ
    m2 = LogisticRegression(C=1.0, max_iter=200).fit(Xa, ya); l2 = lg(m2.predict_proba(Xb)[:, 1], yb)                    # 巧者度も足す
    print(f'  {label:14s} エンジンそのまま {base:.5f} / 較正だけ {l1:.5f} / +巧者度 {l2:.5f}  (較正だけとの差 {l2-l1:+.5f})   係数(見立て,lift,割引lift,走数)={np.round(m2.coef_[0],3)}')
