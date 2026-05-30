# CLAUDE.md — iOS アプリ（たき専用）

このファイルは `ios-app/` で作業するときの文脈メモ。**担当はたき 1 人**（センサー・振動・スマホUI まで一括）。

> プロジェクト全体の企画・役割・連携は親ドキュメントを参照：
> [../README.md](../README.md) ／ [../docs/CONCEPT.md](../docs/CONCEPT.md) ／ [../docs/ROLES.md](../docs/ROLES.md) ／ [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

---

## このアプリの役割（一言）

スマホを「刀」に見立て、**腰から抜く居合の所作を CoreMotion で検知**し、**CoreHaptics で抜刀・斬撃の手応え（振動）を返す**。抜刀の結果は Firebase 経由で大画面・バトルロジックに共有する。

---

## たきの担当タスク

**センサー（CoreMotion）**
- 傾き・加速度の検知
- 「腰（刀）」「肩の後ろ（大剣）」に正しく構えられているかの判定
- シュッと引き抜いた際の「抜刀完了」の移動量計算ロジック

**振動（CoreHaptics）**
- 武器ごとの精密な振動（抜刀時のジャキィン、大剣の重い減衰など）

**スマホUI（SwiftUI ／ みずきから移管）**
- スタート画面 / 剣セレクト画面 / 抜刀待機画面
- 上記 UI とセンサー・振動ロジックの結線（画面遷移・状態受け渡し）

**Firebase（※連携は はる 担当）**
- たきは抜刀完了・構え完了などの**イベント／状態を公開**するところまで。
- **Firestore への書き込み（iOS ↔ Firebase 連携）は はる が担当**。Firebase iOS SDK の導入・接続もはる側。

---

## 技術スタック / 前提

- Swift / SwiftUI、**Xcode**（最新版）
- **iPhone 実機必須**（CoreHaptics・CoreMotion はシミュレータ不可）
- Firebase iOS SDK は **Swift Package Manager** で追加、`GoogleService-Info.plist` を同梱
- セットアップ詳細：[../docs/SETUP.md](../docs/SETUP.md)

---

## Firestore 連携（書き込みは はる 担当）

> **Firestore への書き込みは はる が一手に担当**（iOS 側含む）。たきは抜刀・構えを**検知してイベントを渡す**ところまで。

| フィールド | たきの関与 | 意味 |
|------------|-----------|------|
| `matches/{matchId}/players/{pX}/ready` | 検知してイベント提供（書くのははる） | 正しく構えられた |
| `matches/{matchId}/players/{pX}/drawn` | 検知してイベント提供（書くのははる） | 抜刀完了 |
| `matches/{matchId}/players/{pX}/score` | 読むだけ | 斬撃の累計（はるが書く） |
| `matches/{matchId}/status` | 読むだけ | 試合フェーズ（はるが書く） |

データモデルの全体像：[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

---

## 進め方の指針（Claude へ）

- **作業フォルダは `ios-app/` 内のみ。** `web-parent/` や他メンバーの領域は触らない。
- ブランチは `feature/ios-setup`。コミットは `ios:` プレフィックスで小さく。
  - 例）`ios: CoreHaptics で抜刀の振動を再生`
- まず動かす順序の目安：
  1. CoreHaptics で振動を 1 発鳴らす（初手）
  2. SwiftUI で画面ラフを 1 枚
  3. CoreMotion で構え→抜刀の検知
  4. 抜刀検知のイベント／状態を公開し、はるの Firestore 連携と繋ぎ込みテスト（`drawn` 更新）
- 画面は機能ごとにファイルを分ける（例：`StartView.swift` / `WeaponSelectView.swift` / `DrawWaitView.swift`）。
- 秘密情報（`GoogleService-Info.plist` 等）は公開リポジトリに入れない。
