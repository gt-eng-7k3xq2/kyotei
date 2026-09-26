"""GARON-WILD のAIおすすめが「当たりやすい」レースの特徴を、DBの数字から洗い出す(2026-09-26)。
未来期間(2025-12-21〜2026-09-18)を前半・後半に分け、前半で学び、後半で確かめる。
見るもの: ①スタートの乖離・1号艇の逃げ率などの、条件ごとの的中率(前後半) ②エンジンの見立て(プランの当たる確率)を超えて当たる条件があるか(残差) ③機械学習で当たりやすさを予測できるか。
使い方: PYTHONIOENCODING=utf-8 python tests/wild_hit_drivers.py  (読み取りだけ)"""
import io, contextlib, sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
with contextlib.redirect_stdout(io.StringIO()):
    import wild_entry_conditions as W
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score, log_loss

X, col, R, A, B = W.X, W.col, W.R, W.A, W.B
hit = W.hit.astype(int); cover = W.cover
def L(name, k): return X[:, k, col[name]]
st = X[:, :, col['st_lane']]
F = {}
F['プランの当たる確率'] = cover
F['1号艇の1着確率'] = W.win[:, 0]
F['1号艇の逃げ率(1コース勝率・直近720日)'] = L('ln_w720', 0)
F['1号艇の逃げ率(直近180日)'] = L('ln_w180', 0)
F['1号艇の1コース2連率(720日)'] = L('ln_t2_720', 0)
F['1号艇の全国勝率'] = L('nat_w', 0)
F['1号艇のST(その枠の平均)'] = st[:, 0]
F['2号艇のST'] = st[:, 1]
F['3号艇のST'] = st[:, 2]
F['4号艇のST'] = st[:, 3]
F['5号艇のST'] = st[:, 4]
F['6号艇のST'] = st[:, 5]
F['1号艇STの遅れ(2〜4号艇の平均との差)'] = st[:, 0] - np.nanmean(st[:, 1:4], axis=1)
F['2〜4号艇の最速ST−1号艇ST'] = np.nanmin(st[:, 1:4], axis=1) - st[:, 0]
F['3〜5号艇の最速ST−内側(1〜2号艇)の平均ST'] = np.nanmin(st[:, 2:5], axis=1) - np.nanmean(st[:, :2], axis=1)
F['ST差の最大(攻め艇−内側の平均、最も速い艇)'] = np.nanmin(np.stack([st[:, a] - np.nanmean(st[:, :a], axis=1) for a in (1, 2, 3, 4)], 1), axis=1)
F['1号艇のモーター2連'] = L('mot_t2', 0)
F['1号艇と2号艇の勝率差'] = L('nat_w', 0) - L('nat_w', 1)
F['波高'] = L('wave', 0); F['風速'] = L('wind', 0)
F['出走表の勝率の散らばり'] = np.nanstd(X[:, :, col['nat_w']], axis=1)
F['1号艇の直近10走の調子'] = L('form10', 0)
F['1号艇の休養日数'] = L('rest_days', 0)
F['1号艇の同会場勝率'] = L('vn_w', 0)
F['1号艇の年齢'] = L('age', 0)
F['1号艇の体重'] = L('weight', 0)
F['1号艇のF持ち数'] = L('f_cnt', 0)
names = list(F)

def stat(m):
    n = int(m.sum()); return n, (100 * hit[m].mean() if n else 0.0), (100 * cover[m].mean() if n else 0.0)

def qbins(v, q=5):
    ok = ~np.isnan(v); e = np.unique(np.nanquantile(v[ok], np.linspace(0, 1, q + 1)))
    return [(f'{e[i]:.3g}〜{e[i+1]:.3g}', ok & (v >= e[i]) & ((v <= e[i + 1]) if i == len(e) - 2 else (v < e[i + 1]))) for i in range(len(e) - 1)]

print('全体: 的中%.1f%% / エンジンの見立て(プランの当たる確率)%.1f%%' % stat(np.ones(R, bool))[1:])
print('\n■ 特徴ごとの「当たりやすさ」(5分位)。上位と下位の的中率の差が大きい順。前半・後半とも同じ向きのものだけ ○')
rows = []
for nm in names:
    if nm == 'プランの当たる確率': continue
    bs = qbins(F[nm]);
    if len(bs) < 3: continue
    hi = bs[-1][1]; lo = bs[0][1]
    d = {k: (stat(hi & S)[1] - stat(lo & S)[1]) for k, S in (('前', A), ('後', B))}
    rows.append((nm, stat(hi), stat(lo), d, bs))
rows.sort(key=lambda r: -abs((r[3]['前'] + r[3]['後']) / 2))
for nm, hi, lo, d, bs in rows[:14]:
    same = (d['前'] > 0) == (d['後'] > 0)
    print(f"{'○' if same else '×'} {nm:38s} 上位20%:的中{hi[1]:5.1f}%(見立て{hi[2]:5.1f}%) 下位20%:的中{lo[1]:5.1f}%(見立て{lo[2]:5.1f}%)  差 前{d['前']:+5.1f} 後{d['後']:+5.1f}")

print('\n■ エンジンの見立てを超えて当たるか(残差 = 実際の的中率 − 見立て)。5分位の上位・下位、前半・後半')
res = []
for nm in names:
    if nm == 'プランの当たる確率': continue
    bs = qbins(F[nm])
    if len(bs) < 3: continue
    for lab, m in (bs[0], bs[-1]):
        r = [stat(m & S)[1] - stat(m & S)[2] for S in (A, B)]
        res.append((nm, '下位' if m is bs[0][1] else '上位', lab, r, int(m.sum())))
res.sort(key=lambda r: -min(abs(r[3][0]), abs(r[3][1])) if (r[3][0] > 0) == (r[3][1] > 0) else 0)
for nm, pos, lab, r, n in res[:10]:
    print(f'{nm:38s} {pos}20% [{lab}] n={n:5d}  残差 前{r[0]:+5.1f}pt 後{r[1]:+5.1f}pt')
print('  (残差が前後とも+で大きい条件 = エンジンが控えめに見ている当たりやすさ。前後で向きが違うものは除外)')

print('\n■ 機械学習で、当たりやすさを予測できるか(前半で学習 → 後半で評価)')
Xf = np.stack([F[n] for n in names], 1); ycol = hit
base_cols = [names.index('プランの当たる確率')]
def fit_eval(cols, label):
    m = HistGradientBoostingClassifier(max_depth=3, max_iter=150, learning_rate=0.05, random_state=0)
    m.fit(Xf[A][:, cols], ycol[A]); p = m.predict_proba(Xf[B][:, cols])[:, 1]
    print(f'{label:28s} 後半 AUC {roc_auc_score(ycol[B], p):.4f}  logloss {log_loss(ycol[B], p):.4f}')
    return p
p0 = fit_eval(base_cols, '見立てだけ')
allc = list(range(len(names))); p1 = fit_eval(allc, '見立て+全特徴')
noc = [i for i in allc if names[i] != 'プランの当たる確率']; fit_eval(noc, '全特徴(見立て無し)')
# 上位10%の的中率(後半)
for lab, p in (('見立てだけ', p0), ('見立て+全特徴', p1)):
    top = p >= np.quantile(p, 0.9); r = W.ret[B] / np.maximum(W.chosen_n[B], 1)
    print(f'  {lab}: 後半で予測上位10%(n={int(top.sum())}) 的中{100*ycol[B][top].mean():.1f}% 回収{100*r[top].mean():.1f}%  / 上位30% 的中{100*ycol[B][p>=np.quantile(p,0.7)].mean():.1f}% 回収{100*r[p>=np.quantile(p,0.7)].mean():.1f}%')
# 特徴の重要度(並べ替え)
m = HistGradientBoostingClassifier(max_depth=3, max_iter=150, learning_rate=0.05, random_state=0).fit(Xf[A], ycol[A])
base = log_loss(ycol[B], m.predict_proba(Xf[B])[:, 1]); imp = []
rng = np.random.default_rng(0)
for j, nm in enumerate(names):
    Xp = Xf[B].copy(); Xp[:, j] = rng.permutation(Xp[:, j]); imp.append((log_loss(ycol[B], m.predict_proba(Xp)[:, 1]) - base, nm))
imp.sort(reverse=True)
print('  並べ替え重要度(後半のloglossの悪化、大きいほど効いている):')
for d, nm in imp[:10]: print(f'    {nm:40s} +{d*1000:.2f}(×0.001)')
