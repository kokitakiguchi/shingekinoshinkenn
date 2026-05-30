# ブランチ運用 ＆ コンフリクト回避

ハッカソンなので **軽く・速く** 回す。ただし「壊れた `main`」だけは避ける。

---

## 基本方針

- **`main` は常に動く状態に保つ**（壊れたコードを直接 push しない）。
- 各自 **`main` から自分の feature ブランチを切って** 作業する。
- 担当フォルダを分けているので、**自分のフォルダ内だけ触れば基本コンフリクトしない**。

```
main
├── feature/haru-battle   … はる（web-parent/ のカメラ・判定）
├── feature/ios-setup     … たき（ios-app/）
└── feature/junior-ui     … みずき（web-parent/ の大画面 UI・演出）
```

---

## フォルダの所有権（コンフリクトの源を断つ）

| フォルダ | 主担当 | 補足 |
|----------|--------|------|
| `ios-app/` | たき | センサー・振動・スマホUI まで一括（みずきは触らない） |
| `web-parent/`（検出・判定） | はる | カメラ／MediaPipe／判定ロジック |
| `web-parent/`（表示・演出） | みずき | HP ゲージ／スコアボード／エフェクト |
| `docs/`・`README.md` | 全員 | 更新したら一言共有 |

> **コツ：同じファイルを 2 人で同時に編集しないこと。** ファイルを分ければ衝突しない。
> 例）`web-parent/` 内で `detector.js`（はる）と `display.js`（みずき）に分ける、など。

---

## 1 日の流れ（おすすめサイクル）

```bash
# 1. 朝イチ・作業前：最新の main を取り込む
git checkout main
git pull origin main
git checkout feature/ios-setup
git merge main            # or: git rebase main

# 2. 作業 → こまめにコミット（小さく・意味のある単位で）
git add <自分のフォルダ>
git commit -m "ios: CoreHaptics で抜刀の振動を再生"

# 3. 区切りがついたら push
git push origin feature/ios-setup
```

### 初回：自分のブランチを切る

```bash
git checkout main
git pull origin main          # まだ commit が無ければ不要
git checkout -b feature/ios-setup
git push -u origin feature/ios-setup
```

---

## main への取り込み（マージ）

- 区切りがついたら **GitHub で Pull Request** を作り、できれば誰か 1 人に見てもらってからマージ。
- ハッカソンで急ぐ場合は **セルフマージ可**。ただし **「動く状態」を確認してから**。
- マージ後は、他メンバーも各自のブランチで `git merge main` して最新を取り込む。

---

## コミットメッセージの目安

`領域: 何をしたか` の形で短く。例：

```
ios:   CoreMotion で腰の構えを判定
web:   HP ゲージを表示
cam:   MediaPipe で手首座標を取得
fire:  抜刀完了で drawn を更新
docs:  アーキテクチャ図を追加
```

---

## コンフリクトが起きたら

1. あわてない。`git status` で衝突ファイルを確認。
2. ファイル内の `<<<<<<<` / `=======` / `>>>>>>>` を見て、**両者の意図を残す形**で手で直す。
3. 判断に迷ったら、そのファイルの主担当に声をかける。
4. 直したら `git add` → `git commit`。

---

## ⚠️ 事前に整理しておきたいこと（重要）

現状、Xcode が自動生成する **ユーザー固有ファイルが Git に含まれている**。これは人によって中身が変わり、**コンフリクトの常連**になる。

該当例：
- `*.xcuserstate` / `xcuserdata/`（Xcode の個人設定・開いていたファイルなど）
- `.DS_Store`（macOS が作るゴミファイル）

→ **`.gitignore` で除外**しておくと、無用な衝突がほぼ消える。
ルートに `.gitignore` を用意してあるので、もし `git status` にこれらが出続ける場合は次で追跡を外す：

```bash
git rm -r --cached **/xcuserdata **/*.xcuserstate .DS_Store **/.DS_Store
git commit -m "chore: Xcode 個人設定と .DS_Store を Git 管理から除外"
```

セットアップ手順は [SETUP.md](SETUP.md) を参照。
