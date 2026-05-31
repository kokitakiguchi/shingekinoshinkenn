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
| `p{n}_weapon` | Web（はる）drawing 開始時 | iOS / 大画面 | 確定した武器 |
| `p{n}_ready` | **iOS（タッキー）** 抜刀完了時 | Web（バトル開始トリガー） | 抜刀完了フラグ |
| `player{n}_score` | Web（はる）スイング検知時 | 大画面（みずき） | 斬撃の累計スコア |
| `winner` | Web（バトルロジック） | 大画面（みずき） | 勝者 |

> **原則：1 つのフィールドを書くのは 1 担当だけ。**
> iOS が書くのは `p{n}_ready` のみ。武器・スコア・フェーズはすべて Web が管理する。

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

## 連携テスト（最初の合流ポイント）

繋ぎ込みは **小さく 1 往復** から。いきなり全機能を繋がない。

1. **Web**：武器選択で `matches/test/players/p1/weapon` を更新できる。
2. **タッキー**：iOS で実際に抜刀して `shinken_rooms/battle` の `p1_ready=true` を送信できる。
3. **はる**：Web で武器選択まで進み `status="drawing"` + `p1_weapon` が書かれ、iOS が自動で抜刀待機を開始することを確認する。
4. **みずき**：大画面（Web）で `p1_ready && p2_ready` が揃ったらバトル画面へ遷移することを確認する。
5. **はる**：PC カメラのスイング検知で `player1_score` が `+1` できる。
5. 3 者が同じ `matchId = "test"` を見て、値が連動することを確認する。

ここまで通れば、あとは各自が中身を作り込むだけ。

---

## 決めておくべきこと（着手前に 5 分で合意）

- [ ] Firebase プロジェクト名・`matchId` の決め方（固定 `"test"` で始める？）
- [x] 武器はプレイヤー共通か、各自で選ぶか → **各自選択**で確定（`players.pX.weapon` を Web が書く）
- [ ] HP の初期値・斬撃 1 回のダメージ量
- [ ] 抜刀の「速さ」をスコアに反映するか、有無だけで良いか
- [ ] Firestore セキュリティルール（ハッカソン中は **テストモード**で可。公開前に要見直し）
