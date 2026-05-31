# たき 個人ドキュメント（作業メモ ＆ チェックリスト）

たき個人の進捗・TODO メモ用。自由に書き換えてOK。
役割の全体像 → [ROLES.md](ROLES.md)　連携仕様 → [ARCHITECTURE.md](ARCHITECTURE.md)　開発文脈 → [../ios-app/CLAUDE.md](../ios-app/CLAUDE.md)

- **担当**：iOS 全般（センサー・振動演出・スマホUI）
- **フォルダ**：`ios-app/`
- **ブランチ**：`feature/ios-setup`

---

## ✅ 実装済み（コードフリーズ 2026-05-31）

### セットアップ
- [x] Xcode で `ios-app/` を開いて実機ビルドできる
- [x] `FirestoreConfig.plist` で Firestore 接続（`.gitignore` で除外済み）

### センサー（CoreMotion）
- [x] 加速度・傾きの値を取得（`MotionManager.swift`）
- [x] 加速度マグニチュードをリアルタイム表示（ゲージ付き）
- [x] 抜刀完了の変位積分（2 階積分、`drawDisplacementThreshold` ごとに武器差あり）
- [x] 振り検出（`swingThreshold` / `swingReleaseThreshold` のヒステリシス付き）
- [ ] 構え位置の判定（腰・肩後ろ）— 未実装。現状はボタンを押して「構える」

### 振動（CoreHaptics）
- [x] ライトセーバー：常時ハム → 抜刀「フ…ジャキィン」→ 振り transient + 余韻
- [x] 大剣：静止時無音 → 振ると重い低音 → 抜刀「ズシ…ズドン」
- [x] 小剣：軽い常時気配 → 抜刀「チッ…シャキィン」→ 振り連打パルス
- [x] ライトセーバー振り時に音源（`ライトセーバ.mp3`）と同期再生
- [x] 加速度連動でハム強度・シャープネスが動的変化

### スマホUI（SwiftUI）
- [x] `PlayerSelectView`：P1/P2 選択画面
- [x] `ContentView`：武器 Picker・加速度ゲージ・構えボタン・抜刀フロー・完了バナー
- [x] Web の `status="drawing"` 受信 → 自動で抜刀待機開始
- [x] 武器を Web から受信して自動同期（`p{n}_weapon`）
- [x] 手動フォールバックボタン（通信不通時に手動で抜刀開始）

### Firebase 連携
- [x] `FirestoreEventSender`：REST API で `p{n}_ready` を `shinken_rooms/battle` に書く
- [x] `FirestoreListener`：1 秒ポーリングで `status` / `p{n}_weapon` を受信
- [x] 起動時に `p{n}_ready = false` でリセット（presence 確認）
- [x] 抜刀完了で `p{n}_ready = true` を自動送信

---

## 🔲 残タスク・確認事項

- [ ] 2 台同時対戦での `p1_ready && p2_ready` → `playing` 自動遷移の動作確認
- [ ] 構え位置の判定（腰・肩後ろ）— 時間があれば
- [ ] 勝敗表示（`winner` フィールドを受信して iOS 側に表示）— 時間があれば

---

## メモ / 気づき

- `drawDisplacementThreshold`：ライトセーバ=0.06m / 大剣=0.08m / 小剣=0.04m（実機でのフィーリングで調整）
- 抜刀積分は `drawResetWindow = 4.0s` でドリフトリセット（長時間抜けなければ自動再スタート）
- `FirestoreConfig.plist` は `.gitignore` で除外。チームメンバーには別ルートで共有すること

## 詰まっていること（ヘルプ要請）

-
