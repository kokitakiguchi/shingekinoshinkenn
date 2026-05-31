# アーキテクチャ ＆ 連携仕様

3 つのコンポーネントを **Firebase (Firestore)** のリアルタイム DB で繋ぐ。
各担当は **「Firestore のどのフィールドを読み書きするか」だけ** を合意すれば、中身は独立して開発できる。

プロジェクト全体の発表向け説明は [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) を参照。

---

## 全体構成

```
   ┌─────────────────────────┐         ┌─────────────────────────┐
   │  iPhone（タッキー）      │         │  Web ブラウザ（はる）    │
   │  ios-app/                │         │  web-parent/             │
   │                          │         │                          │
   │  CoreMotion で抜刀検知   │         │  MediaPipe で骨格追跡    │
   │  CoreHaptics で振動演出  │         │  構え完了を判定・送信    │
   │  drawn を送信            │         │  武器選択・score を送信  │
   └───────────┬──────────────┘         └────────────┬─────────────┘
               │ 抜刀完了 (drawn)                    │ 構え完了 (ready)・斬撃スコア
               ▼                                     ▼
        ┌──────────────────────────────────────────────────┐
        │              Firebase / Firestore                 │
        │        （リアルタイムの共有ステート）             │
        └──────────────────────────────────────────────────┘
               ▲                                     ▲
               │ 画面ラフ（SwiftUI）                 │ 状態を購読して描画
   ┌───────────┴──────────────┐         ┌────────────┴─────────────┐
   │  iPhone UI（タッキー）   │         │  PC 大画面（みずき）     │
   │  SwiftUI 画面            │         │  web-parent/             │
   │  スタート/選択/待機      │         │  HP ゲージ・スコア・演出 │
   └──────────────────────────┘         └──────────────────────────┘
```

- **書き込む人**：Web（武器選択・status 遷移・斬撃スコア）／iPhone（抜刀完了 p{n}_ready=true）
- **読む人**：PC 大画面（全状態を購読して描画）／必要なら iPhone UI も購読
- 全員が同じ `matchId` を見ることで、1 つの試合状態を共有する。

---

## Firestore データモデル（たたき台）

> まずはシンプルに「1 試合 ＝ 1 ドキュメント」で始める。足りなければ拡張する。

### コレクション `matches`

```
matches/{matchId}
{
  status:         "selecting" | "drawing" | "playing" | "finished",
  match_status:   （status と同値。冗長だが Web が両方書く）

  // プレイヤーごとのフラット構造（ネストなし）
  p1_weapon:      "sword" | "greatsword" | "lightsaber",  // Web が drawing 開始時に書く
  p2_weapon:      "sword" | "greatsword" | "lightsaber",
  p1_ready:       false,   // iOS が抜刀完了時に true にする
  p2_ready:       false,   // iOS が抜刀完了時に true にする

  player1_score:  0,       // Web がスイング検知のたびに increment(1)
  player2_score:  0,
  player1_weapon: "...",   // startMatch 時に selectionState から再書き込み（表示用）
  player2_weapon: "...",
  p1_vibrate:     false,   // startMatch 時に false リセット（現状未使用）
  p2_vibrate:     false,
}
```

> **武器選択は Web のみ**。MediaPipe でポーズを 1.5 秒キープして確定。両者確定後 `status="drawing"` に遷移し、`p{n}_weapon` を書く。
> **iOS は `p{n}_ready` を true にするだけ**。構え判定・武器選択はいずれも Web が行う。
> 武器の文字列値は Web 内部キー `"sword"` / `"greatsword"` / `"lightsaber"`。iOS は `WeaponType.init(firestoreValue:)` でマッピングする。

---

## 誰がどのフィールドを触るか（責任分界）

| フィールド | 書く人 | 読む人 | 意味 |
|------------|--------|--------|------|
| `status` / `match_status` | Web（はる） | iOS / 全員 | 試合フェーズ遷移 |
| `p{n}_weapon` | Web（はる）drawing 開始時 | iOS / 大画面 | 確定した武器（`"sword"` / `"greatsword"` / `"lightsaber"`）|
| `p{n}_ready` | **iOS（たき）** Firestore REST API 直書き | Web（バトル開始トリガー） | 抜刀完了フラグ |
| `player{n}_score` | Web（はる）スイング検知時 | 大画面（みずき） | 斬撃の累計スコア |
| `winner` | Web（バトルロジック） | 大画面（みずき） | 勝者 |

> **原則：1 つのフィールドを書くのは 1 担当だけ。**
> iOS が書くのは `p{n}_ready` のみ（Firebase iOS SDK なし・REST API 直叩き）。武器・スコア・フェーズはすべて Web が管理する。

---

## 試合フェーズ（status）の遷移

```
selecting ──(両者の武器確定)──▶ drawing ──(p1_ready && p2_ready)──▶ playing ──(90秒 or HP 0)──▶ finished
```

- `selecting`：Web 側でプレイヤーがポーズをキープして武器を選ぶ（iOS は構える＋待機）
- `drawing`：Web が `p{n}_weapon` を書き iOS に通知。iOS が抜刀して `p{n}_ready=true` を送る
- `playing`：斬撃の判定中。スコア／HP が動く
- `finished`：勝敗確定。`winner` を表示

---

## 連携テスト状況（2026-05-31 時点）

> ✅ = 確認済み　🔲 = 未確認

1. ✅ **たき**：iOS で実際に抜刀して `shinken_rooms/battle` の `p1_ready=true` を送信できる
2. ✅ **はる**：Web で武器選択まで進み `status="drawing"` + `p{n}_weapon` が書かれ、iOS が自動で抜刀待機を開始することを確認
3. ✅ **はる**：PC カメラのスイング検知で `player1_score` が `+1` される
4. ✅ **みずき**：大画面（Web）でスコア・HP・フェーズが Firestore を購読してリアルタイム反映される
5. 🔲 `p1_ready && p2_ready` 両者揃ったら自動で `playing` 遷移することを 2 台同時で確認する

---

## 設計上の決定事項（確定済み）

- [x] コレクションは `shinken_rooms/battle`（固定。`matchId` 管理なし）
- [x] 武器は各自で選ぶ → Web（はる）がポーズ判定で確定し `p{n}_weapon` を書く
- [x] iOS は Firebase iOS SDK なし。Firestore REST API を直接叩いて `p{n}_ready` を書く
- [x] 武器は 3 種：`"sword"`（小剣）/ `"greatsword"`（大剣）/ `"lightsaber"`（ライトセーバー）。iOS 側は `WeaponType.init(firestoreValue:)` でマッピング
- [x] Firestore セキュリティルール：ハッカソン中はテストモード（公開リポジトリには秘密情報を入れない）
