"""GARON-WILD(荒れ予想)のAIおすすめ(確率順13点・1つの頭は最大8点・1号艇は頭にしない)が、どんな条件のレースで当たり・回収できるか(2026-09-26)。
完全に未来の期間(学習に使っていない 2025-12-21〜2026-09-18、42,296レース)。払戻は実績。オッズが過去に無いので「10倍以上」は確率からの目安(0.75/確率)。
前半・後半に分け、前半で選んだ条件が後半でも成り立つかを見る(多重比較で、偶然の当たり条件を拾わないため)。
使い方: PYTHONIOENCODING=utf-8 python tests/wild_entry_conditions.py  (読み取りだけ)"""
import numpy as np, itertools, os, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'engine_db', 'data')
z = np.load(os.path.join(ROOT, 'dataset.npz'), allow_pickle=True)
date_all = z['date']; te = date_all >= '2025-12-21'
X = z['X'][te]; fin = z['fin'][te]; payy = z['payy'][te]; payc = z['payc'][te]; date = date_all[te]; venue = z['venue'][te]; rno = z['rno'][te]
names = [str(n) for n in z['names']]; col = {n: i for i, n in enumerate(names)}
P = np.load(os.path.join(ROOT, 'eval_P_2025-12-21.npy')).astype(np.float64); R = len(P)
COMBOS = list(itertools.permutations(range(6), 3)); cn = np.array([f'{a+1}-{b+1}-{c+1}' for a, b, c in COMBOS]); head = np.array([c[0] for c in COMBOS])
order = np.argsort(fin, axis=1); truth = np.array([f'{order[i,0]+1}-{order[i,1]+1}-{order[i,2]+1}' for i in range(R)]); hidx = np.array([np.where(cn == t)[0][0] for t in truth])
win = np.stack([P[:, head == k].sum(1) for k in range(6)], 1)
K, CAP, ODDS = 13, 8, 10
ret = np.zeros(R); hit = np.zeros(R, bool); cover = np.zeros(R); nheads = np.zeros(R, int); chosen_n = np.zeros(R, int)
for r in range(R):
    idx = np.where(head != 0)[0]; idx = idx[np.argsort(-P[r, idx])]
    out = []; cnt = {}
    for j in idx:
        if 0.75 / P[r, j] < ODDS: continue
        if cnt.get(head[j], 0) < CAP: out.append(j); cnt[head[j]] = cnt.get(head[j], 0) + 1
        if len(out) >= K: break
    chosen_n[r] = len(out); cover[r] = P[r, out].sum() if out else 0; nheads[r] = len(cnt)
    if hidx[r] in set(out): hit[r] = True; ret[r] = payy[r] / 100.0
stake = np.maximum(chosen_n, 1)
half = np.median(np.arange(R)); A = np.arange(R) < R // 2; B = ~A
print('期間 前半', date[A][0], '〜', date[A][-1], '後半', date[B][0], '〜', date[B][-1])

def stats(m):
    n = int(m.sum())
    if n == 0: return (0, 0.0, 0.0)
    return (n, 100 * hit[m].mean(), 100 * ret[m].sum() / stake[m].sum())
allm = np.ones(R, bool)
print('全レース(参入条件なし): n=%d 的中%.1f%% 回収%.1f%%' % stats(allm))

# ---- 条件の材料(レース前に分かるものだけ) ----
def lane(name, k): return X[:, k, col[name]]
feat = {}
feat['1号艇の1着確率'] = win[:, 0]
feat['荒れ度上位頭の1着確率'] = np.sort(win[:, 1:], axis=1)[:, -1]
feat['プランの当たる確率(エンジン)'] = cover
feat['頭の数'] = nheads.astype(float)
feat['風速'] = lane('wind', 0); feat['波高'] = lane('wave', 0)
feat['1号艇の級'] = lane('cls', 0); feat['1号艇の全国勝率'] = lane('nat_w', 0); feat['1号艇のモーター2連'] = lane('mot_t2', 0)
feat['1号艇のST(その枠)'] = lane('st_lane', 0)
inner_st = np.nanmean(X[:, :, col['st_lane']][:, :4], axis=1)
feat['2〜4号艇の最速ST−1号艇ST'] = np.nanmin(X[:, 1:4, col['st_lane']], axis=1) - X[:, 0, col['st_lane']]
feat['1号艇の同会場勝率(枠1)'] = lane('vn_w', 0)
feat['レース番号'] = rno.astype(float)
mon = np.array([int(d[5:7]) for d in date]).astype(float); feat['月'] = mon
feat['出走表の勝率の散らばり'] = np.nanstd(X[:, :, col['nat_w']], axis=1)
feat['外枠(4〜6)の平均勝率−内枠(1〜3)'] = np.nanmean(X[:, 3:, col['nat_w']], axis=1) - np.nanmean(X[:, :3, col['nat_w']], axis=1)
venues = sorted(set(venue.tolist()))

def bins_of(v, q=5):
    ok = ~np.isnan(v)
    if len(set(v[ok].tolist())) <= 8: return [(f'={x:g}', ok & (v == x)) for x in sorted(set(v[ok].tolist()))]
    edges = np.unique(np.nanquantile(v, np.linspace(0, 1, q + 1)))
    return [(f'{edges[i]:.3g}〜{edges[i+1]:.3g}', ok & (v >= edges[i]) & (v <= edges[i + 1] if i == len(edges) - 2 else v < edges[i + 1])) for i in range(len(edges) - 1)]

conds = []
for name, v in feat.items():
    for lab, m in bins_of(v): conds.append((f'{name} {lab}', m))
for vv in venues: conds.append((f'会場{vv}', venue == vv))

rows = []
for lab, m in conds:
    a, b = stats(m & A), stats(m & B); rows.append((lab, stats(m), a, b))
print('\n■ 1つの条件ごと(全期間 n≥600、前半・後半とも n≥250)。回収率の低い方(前半・後半の小さい方)が高い順')
good = [r for r in rows if r[1][0] >= 600 and r[2][0] >= 250 and r[3][0] >= 250]
good.sort(key=lambda r: -min(r[2][2], r[3][2]))
for lab, t, a, b in good[:18]:
    print(f'{lab:44s} n={t[0]:5d} 的中{t[1]:5.1f}% 回収{t[2]:5.1f}% | 前半 n={a[0]:5d} 回収{a[2]:5.1f}% | 後半 n={b[0]:5d} 回収{b[2]:5.1f}%')
print('\n■ 的中率の高い条件(前半・後半の小さい方)')
good.sort(key=lambda r: -min(r[2][1], r[3][1]))
for lab, t, a, b in good[:12]:
    print(f'{lab:44s} n={t[0]:5d} 的中{t[1]:5.1f}% 回収{t[2]:5.1f}% | 前半 的中{a[1]:5.1f}% | 後半 的中{b[1]:5.1f}%')
print('\n■ 回収率の低い条件(避ける候補、前半・後半の大きい方が低い順)')
good.sort(key=lambda r: max(r[2][2], r[3][2]))
for lab, t, a, b in good[:8]:
    print(f'{lab:44s} n={t[0]:5d} 的中{t[1]:5.1f}% 回収{t[2]:5.1f}% | 前半 回収{a[2]:5.1f}% | 後半 回収{b[2]:5.1f}%')

# ---- 2つの条件の組み合わせ: 前半で選び、後半で確かめる ----
print('\n■ 2つの組み合わせ: 前半(n≥150)の回収率上位30を、後半で確かめる')
small = [(l, m) for l, m in conds if 800 <= m.sum() <= 30000]
res = []
for (l1, m1), (l2, m2) in itertools.combinations(small, 2):
    if l1.split(' ')[0] == l2.split(' ')[0]: continue
    m = m1 & m2; a = stats(m & A)
    if a[0] >= 150: res.append((l1 + ' かつ ' + l2, m, a))
res.sort(key=lambda r: -r[2][2])
print('  調べた組み合わせ数:', len(res))
sel = res[:30]
tot_a = np.mean([r[2][2] for r in sel]); tot_b = np.mean([stats(r[1] & B)[2] for r in sel if stats(r[1] & B)[0] > 0])
for lab, m, a in sel[:12]:
    b = stats(m & B); print(f'{lab:70s} 前半 n={a[0]:4d} 回収{a[2]:5.1f}% → 後半 n={b[0]:4d} 回収{b[2]:5.1f}% 的中{b[1]:4.1f}%')
print(f'  上位30の平均: 前半 {tot_a:.1f}% → 後半 {tot_b:.1f}%(全体の平均 前半 {stats(A)[2]:.1f}% 後半 {stats(B)[2]:.1f}%)')
print('  (前半で偶然よく見えた条件は、後半では全体の平均に戻る。戻らない条件だけが、参入条件の候補)')
