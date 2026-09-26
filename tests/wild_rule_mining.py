"""荒れやすい条件を、DBの全期間(2023-01〜)から、結果を使って直接さがす(2026-09-26)。エンジンの予測は使わない。
学習: 2025-12-21より前(約16.4万レース)。確かめる: 2025-12-21以降(未来、4.2万レース)で、そのときAIおすすめの買い方(確率順13点・1つの頭は最大8点)がどうだったか。
目的変数: ①荒れ(1号艇が1着でない) ②高配当(3連単50倍以上=5,000円以上)。決定木で「人が読める条件」に落とす。
使い方: PYTHONIOENCODING=utf-8 python -W ignore tests/wild_rule_mining.py  (読み取りだけ)"""
import io, contextlib, sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
with contextlib.redirect_stdout(io.StringIO()):
    import wild_entry_conditions as W
from sklearn.tree import DecisionTreeClassifier, _tree

ROOT = W.ROOT
z = np.load(os.path.join(ROOT, 'dataset.npz'), allow_pickle=True)
X = z['X']; fin = z['fin']; date = z['date']; payy = z['payy']; venue = z['venue']; rno = z['rno']
col = W.col; N = len(X)
st = X[:, :, col['st_lane']]
def Lc(name, k): return X[:, k, col[name]]
F = {}
F['1号艇の逃げ率(1コース勝率720日)'] = Lc('ln_w720', 0)
F['1号艇の逃げ率(180日)'] = Lc('ln_w180', 0)
F['1号艇の1コース2連率'] = Lc('ln_t2_720', 0)
F['1号艇の全国勝率'] = Lc('nat_w', 0)
F['1号艇の同会場勝率'] = Lc('vn_w', 0)
F['1号艇の直近10走'] = Lc('form10', 0)
F['1号艇のST'] = st[:, 0]
F['1号艇のモーター2連'] = Lc('mot_t2', 0)
F['1号艇の級'] = Lc('cls', 0)
F['1号艇と2号艇の勝率差'] = Lc('nat_w', 0) - Lc('nat_w', 1)
F['2〜4号艇の最速ST-1号艇ST'] = np.nanmin(st[:, 1:4], axis=1) - st[:, 0]
F['3〜5号艇の最速ST-1〜2号艇平均ST'] = np.nanmin(st[:, 2:5], axis=1) - np.nanmean(st[:, :2], axis=1)
F['攻め艇と内側のST差の最大'] = np.nanmin(np.stack([st[:, a] - np.nanmean(st[:, :a], axis=1) for a in (1, 2, 3, 4)], 1), axis=1)
F['2号艇のST'] = st[:, 1]; F['3号艇のST'] = st[:, 2]; F['4号艇のST'] = st[:, 3]
F['4号艇の全国勝率'] = Lc('nat_w', 3); F['3号艇の全国勝率'] = Lc('nat_w', 2); F['2号艇の全国勝率'] = Lc('nat_w', 1)
F['2〜6号艇の最高全国勝率'] = np.nanmax(X[:, 1:, col['nat_w']], axis=1)
F['4号艇のモーター2連'] = Lc('mot_t2', 3); F['2号艇のモーター2連'] = Lc('mot_t2', 1)
F['波高'] = Lc('wave', 0); F['風速'] = Lc('wind', 0)
F['出走表の勝率の散らばり'] = np.nanstd(X[:, :, col['nat_w']], axis=1)
F['レース番号'] = rno.astype(float); F['会場'] = venue.astype(float)
F['月'] = np.array([int(d[5:7]) for d in date]).astype(float)
names = list(F); M = np.nan_to_num(np.stack([F[n] for n in names], 1), nan=-9)
tr = date < '2025-12-21'; te = ~tr
upset = (np.argmin(np.where(fin == 1, 0, 9), axis=1) != 0).astype(int)   # 1着の艇が1号艇でない
big = (payy >= 5000).astype(int)
print('学習 %d レース(〜2025-12-20) / 確かめ %d レース(2025-12-21〜)' % (tr.sum(), te.sum()))
print('荒れ率: 学習 %.1f%% 確かめ %.1f%% | 高配当(50倍以上): 学習 %.1f%% 確かめ %.1f%%' % (100 * upset[tr].mean(), 100 * upset[te].mean(), 100 * big[tr].mean(), 100 * big[te].mean()))

# 確かめ側のAIおすすめの結果(Wの配列は確かめ側と同じ並び)
hit, ret, chosen = W.hit, W.ret, np.maximum(W.chosen_n, 1)
per = ret / chosen

def leaves(tree, feature_names):
    t = tree.tree_; out = []
    def walk(node, path):
        if t.feature[node] == _tree.TREE_UNDEFINED: out.append((node, path)); return
        f = feature_names[t.feature[node]]; th = t.threshold[node]
        walk(t.children_left[node], path + [f'{f} <= {th:.3g}']); walk(t.children_right[node], path + [f'{f} > {th:.3g}'])
    walk(0, []); return out

def mine(target, label, depth, leaf, min_rate):
    tr_i = np.where(tr)[0]; te_i = np.where(te)[0]
    clf = DecisionTreeClassifier(max_depth=depth, min_samples_leaf=leaf, random_state=0).fit(M[tr_i], target[tr_i])
    lid_tr = clf.apply(M[tr_i]); lid_te = clf.apply(M[te_i])
    rows = []
    for node, path in leaves(clf, names):
        a = lid_tr == node; b = lid_te == node
        if a.sum() == 0 or b.sum() < 200: continue
        rows.append((target[tr_i][a].mean(), int(a.sum()), int(b.sum()), target[te_i][b].mean(), 100 * hit[b].mean(), 100 * per[b].mean(), path))
    rows = [r for r in rows if r[0] >= min_rate]; rows.sort(key=lambda r: -r[0])
    print(f'\n■ {label}(木の深さ{depth}、1つの葉に{leaf}レース以上)')
    base_b = target[te_i].mean()
    for rate, na, nb, rb, hb, roib, path in rows[:8]:
        print(f'  学習: {100*rate:.1f}%(n={na}) → 確かめ: {100*rb:.1f}%(n={nb}, 全体{100*base_b:.1f}%) | AIおすすめ 的中{hb:.1f}% 回収{roib:.1f}%')
        print('     条件: ' + ' かつ '.join(path))
    return rows

mine(upset, '荒れ(1号艇が1着でない)', 4, 1500, 0.55)
mine(upset, '荒れ(1号艇が1着でない)', 5, 800, 0.6)
mine(big, '高配当(3連単50倍以上)', 4, 1500, 0.30)
mine(big, '高配当(3連単50倍以上)', 5, 800, 0.33)
