# CLAUDE.md — iOS アプリ（たき専用）

このファイルは `ios-app/` で作業するときの文脈メモ。**担当はたき 1 人**（センサー・振動・スマホUI まで一括）。

> プロジェクト全体の企画・役割・連携は親ドキュメントを参照：
> [../README.md](../README.md) ／ [../docs/CONCEPT.md](../docs/CONCEPT.md) ／ [../docs/ROLES.md](../docs/ROLES.md) ／ [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)

---

## このアプリの役割（一言）

スマホを「刀」に見立て、**加速度・変位を CoreMotion で検知**し、**CoreHaptics で抜刀・斬撃の手応え（振動）を返す**。抜刀完了は Firestore REST API を直接叩いて共有する。

---

## 実装済みファイル一覧（コードフリーズ時点）

| ファイル | 内容 |
|---|---|
| `PlayerSelectView.swift` | P1/P2 選択画面（スタート画面） |
| `ContentView.swift` | メインバトル画面（武器選択・加速度ゲージ・構え・抜刀フロー全体） |
| `MotionManager.swift` | CoreMotion：加速度検知・抜刀変位の 2 階積分・振り検出 |
| `HapticManager.swift` | CoreHaptics：常時ハム・加速度連動・振りスパイク・抜刀パターン |
| `WeaponType.swift` | 3 武器の全パラメータ・振動パターン・抜刀パターン定義 |
| `FirestoreEventSender.swift` | REST API で `shinken_rooms/battle` の `p{n}_ready` を書く |
| `FirestoreListener.swift` | 1 秒ポーリングで `status` / `p{n}_weapon` を受信 |
| `FirestoreConfig.swift` | `FirestoreConfig.plist`（.gitignore 除外）から接続情報を読み込む |

---

## 技術スタック

- Swift / SwiftUI、**Xcode**（最新版）
- **iPhone 実機必須**（CoreHaptics・CoreMotion はシミュレータ不可）
- **Firebase iOS SDK は未使用**。`FirestoreConfig.plist` の APIキー + REST API で Firestore に直接書き込む
- セットアップ詳細：[../docs/SETUP.md](../docs/SETUP.md)

---

## 武器の種類（3種）

| WeaponType | Firestore 値 | 表示名 | 振動の特徴 |
|---|---|---|---|
| `.lightsaber` | `"lightsaber"` | ライトセーバー | 常時ハム。抜刀：「フ…ジャキィン」。振り：鋭い transient + 余韻 |
| `.greatsword` | `"greatsword"` | 大剣 | 静止時無音。振ると重い低音が立ち上がる。抜刀：「ズシ…ズドン」 |
| `.smallsword` | `"sword"` | 小剣 | 軽い常時気配。抜刀：「チッ…シャキィン」。振り：連打パルス |

---

## Firestore 連携

**コレクション：`shinken_rooms/battle`（固定。matchId なし）**

| フィールド | iOS の操作 | 意味 |
|---|---|---|
| `p{n}_ready` | **書く**（抜刀完了時に `true`、起動時に `false` リセット） | 抜刀完了フラグ |
| `status` / `match_status` | 読むだけ | 試合フェーズ（Web が書く） |
| `p{n}_weapon` | 読むだけ | 確定した武器（Web が書く） |
| `player{n}_score` | 読まない | スコア（Web が書く） |

> **Firestore への書き込みは iOS（たき）が REST API で直接担当**。
> 武器・スコア・フェーズはすべて Web（はる）が管理する。

---

## 画面・フロー

```
PlayerSelectView（P1/P2 選択）
    ↓
ContentView（メイン）
    ├─ 武器 Picker（.segmented）
    ├─ 加速度ゲージ（CoreMotion からリアルタイム更新）
    ├─ 構えるボタン → ハム開始
    ├─ 「Web の status=drawing を待機中」
    │       ↓（listener.isDrawingPhaseStarted）
    ├─ 抜刀待機 View（変位プログレスバー）
    │       ↓（変位 >= threshold）
    └─ 抜刀完了バナー + 振りフェーズ（スイング検知）
           ↓（sendDrawReady）
        Firestore: p{n}_ready = true
```

---

## 未実装（コードフリーズ後の確認・改善候補）

- 🔲 構え位置の判定（腰・肩後ろ）— 現状はボタンを押すだけで構え完了
- 🔲 2 台同時対戦での `p1_ready && p2_ready` 両者揃い → `playing` 自動遷移の確認
- 🔲 勝敗・結果表示（`winner` フィールドを受信して iOS 側に出す）

---

## Claude への作業指針

- **作業フォルダは `ios-app/` 内のみ。** `web-parent/` や他メンバーの領域は触らない。
- ブランチは `feature/ios-setup`。コミットは `ios:` プレフィックスで小さく。
- `FirestoreConfig.plist` は `.gitignore` 除外済み。コードに APIキーを直書きしない。
