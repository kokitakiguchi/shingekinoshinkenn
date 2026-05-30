# 環境構築（セットアップ）

各自、自分の担当に関係するセクションを進めてください。全員共通の「Git」と「Firebase」は最初に目を通すこと。

---

## 0. 共通：リポジトリの取得

```bash
git clone <このリポジトリの URL>
cd shingekinoshinkenn
```

ブランチの切り方は [BRANCH_STRATEGY.md](BRANCH_STRATEGY.md) を参照。

---

## 1. iOS アプリ（たき）

> `ios-app/` は **センサー・振動・スマホUI（SwiftUI）まで、たきが一括で担当**（スマホUIはみずきから移管）。

**担当範囲**
- **CoreMotion**：傾き・加速度の検知、構え／抜刀完了の判定
- **CoreHaptics**：武器ごとの振動演出
- **SwiftUI**：スタート画面 / 剣セレクト画面 / 抜刀待機画面の UI と、上記ロジックとの結線
- ※ **Firestore への書き込み（iOS ↔ Firebase 連携）は はる が担当**。たきは検知したイベント／状態を渡すところまで（§3 を参照）。

**必要なもの**
- macOS ＋ **Xcode**（最新版推奨）
- **iPhone 実機**（CoreHaptics / CoreMotion はシミュレータで振動・モーションを再現できないため、**実機必須**）
- Apple ID（実機ビルド用の無料の開発者署名で OK）

**手順**
1. `ios-app/shingekinoshinkenn.xcodeproj` を Xcode で開く。
2. `Signing & Capabilities` で Team に自分の Apple ID を設定。
3. iPhone を USB 接続し、ビルドターゲットを実機にして Run（▶）。
4. 初回は iPhone 側で「デベロッパを信頼」する必要がある（設定 → 一般 → VPN とデバイス管理）。

**たきの初手**：CoreHaptics で簡単な振動を 1 発鳴らせるか確認する。続けて SwiftUI で画面ラフを 1 枚作ってみる。

---

## 2. PC 側 Web / カメラ（はる・みずき）

`web-parent/` 配下で作業。まずはローカルで動けば OK。

**必要なもの**
- モダンブラウザ（Chrome 推奨）
- Web カメラ（ノート PC 内蔵で可）
- 簡易ローカルサーバ（カメラ／Firebase はファイル直開きだと動かないことがある）

```bash
cd web-parent
# どちらでも可
python3 -m http.server 8000
#   → http://localhost:8000
# あるいは Node があれば
npx serve
```

- **MediaPipe**（はる）：CDN 読み込みで始めるのが速い。手首ランドマークの座標から速度を計算 → 斬撃判定。
- **表示側**（みずき）：HP ゲージ・スコアボードの HTML/CSS から着手。

> カメラ利用は **https か localhost** でないとブラウザがアクセスを許可しないので注意。

---

## 3. Firebase（全員 / セットアップ・iOS連携とも はる 主導）

リアルタイム連携の心臓部。[ARCHITECTURE.md](ARCHITECTURE.md) のデータモデルとセットで読む。

**手順（1 回だけ）**
1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成。
2. **Cloud Firestore** を有効化。最初は **テストモード**で開始（※公開前にルール見直し）。
3. アプリを登録して接続情報（config）を取得：
   - **Web（はる・みずき）**：Web アプリを追加 → `firebaseConfig` を取得。
   - **iOS（はる）**：iOS アプリを追加 → `GoogleService-Info.plist` をダウンロードし、Xcode プロジェクトに追加。Swift Package Manager で `firebase-ios-sdk` を追加。※現状の iOS プロジェクトには未導入なので、たきと組んで作業（実機・プロジェクトはたきの環境）。
4. 接続情報をメンバーに共有（後述の注意あり）。

**最初の動作確認**
- `matches/test` ドキュメントを手動で 1 件作り、3 者からそれぞれ読み書きできるか試す。
- 詳細な連携テスト手順は [ARCHITECTURE.md](ARCHITECTURE.md#連携テスト最初の合流ポイント) を参照。

---

## ⚠️ 秘密情報・個人ファイルの扱い

- `GoogleService-Info.plist` や Web の `firebaseConfig`、API キーは **基本 Git に入れない**運用が望ましい。
  - ハッカソンで時間が無ければ共有して進めても良いが、**公開リポジトリにはしない**こと。
- Xcode の個人設定（`xcuserdata/`・`*.xcuserstate`）や `.DS_Store` は `.gitignore` で除外済み。
  すでに追跡されている場合の外し方は [BRANCH_STRATEGY.md](BRANCH_STRATEGY.md) の最後を参照。

---

## 困ったとき

- ビルドできない／実機で振動しない／スマホ画面（SwiftUI） → たき
- カメラ・手首検出が動かない → はる
- PC 大画面の表示・演出（HP ゲージ／エフェクト） → みずき
- Firebase に繋がらない → まず接続情報（config / plist）が正しいか確認
