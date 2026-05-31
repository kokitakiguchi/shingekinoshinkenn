# タッキー（たき）個人ドキュメント（作業メモ ＆ チェックリスト）

タッキー（たき）個人の進捗・TODO・メモ用。自由に書き換えてOK。
役割の全体像は [../docs/ROLES.md](../docs/ROLES.md)、連携仕様は [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)、開発の文脈メモは [CLAUDE.md](CLAUDE.md)。

- **担当**：セットアップ ＆ iOS 全般（センサー・振動演出・スマホUI）
- **フォルダ**：`ios-app/`
- **ブランチ**：`feature/ios-setup`

> 剣の選択・構え判定はすべて **Web 側（MediaPipe ポーズ検出）** が担当する。
> タッキーは抜刀を振動付きで実行し、完了を `p{n}_ready=true` として Firestore に書く。
> Web がこれを受け取って両者揃ったらバトル開始する。

---

## やること

### セットアップ
- [x] Xcode で `ios-app/shingekinoshinkenn.xcodeproj` を開いて実機ビルドできる
- [x] 実機の「デベロッパを信頼」設定済み

### センサー（CoreMotion）
- [x] 加速度の値を取得できる（`MotionManager` で `userAcceleration` のマグニチュードを 60Hz 取得）
- [ ] 傾きの値を取得できる（`CMDeviceMotion.attitude` の roll / pitch など）
- [x] 振り（スイング）検出（加速度マグニチュード閾値 + デバウンス）
- [ ] 抜刀完了（引き抜きの移動量）の判定ロジック
- ~~[ ] 「腰（刀）」の構え判定~~ → **Web（MediaPipe）が担当**
- ~~[ ] 「肩の後ろ（大剣）」の構え判定~~ → **Web（MediaPipe）が担当**

### 振動（CoreHaptics）
- [x] 振動を 1 発鳴らす（★初手）
- [x] 武器別の常時ハム + 加速度連動（ライトセーバー / 大剣 / 小剣）
- [x] 振り抜き時の武器別スパイクパターン
- [ ] 抜刀（鞘走り → ジャキィン）を構え→抜刀のフローに組み込む

### スマホUI（SwiftUI）
- [ ] 抜刀待機画面
- [ ] UI とセンサー・振動ロジックの結線（画面遷移・状態受け渡し）
- [x] 剣選択は Web 側で行う方針に変更

### 連携（はると協働）
- [x] Firebase との簡易連携テストで、データ送受信が動作することを確認
- [x] `FirestoreListener` で `shinken_rooms/battle` を 1 秒ポーリング（`status` / `p{n}_weapon` を監視）
- [x] Web が `status="drawing"` にした瞬間を検知 → 自動で抜刀待機開始
- [x] 抜刀完了時に `shinken_rooms/battle` の `p{n}_ready=true` を送信（`FirestoreEventSender.sendDrawReady`）
- [ ] はると組んで、抜刀検知 → `p{n}_ready=true` → Web がバトル開始する end-to-end テスト

### 発表前タスク
- [ ] 水木の正式フロントエンドコードと現状実装の統合を確認する
- [ ] 自分が実装した振動・モーション・Firestore 送信機能の説明を Discord に投稿する
- [ ] スライド用に「できたこと」と「今後やりたいこと」を短くまとめる
- [ ] 時間があれば抜刀機能（構え→抜刀の自動判定）を実装する

---

## ★ 初手のアクション
1. Xcode プロジェクトを立ち上げ、iPhone 実機を繋ぐ
2. **CoreHaptics で簡単な振動を 1 発**鳴らせるか確認
3. 続けて **SwiftUI で画面ラフを 1 枚**作ってみる

---

## メモ / 気づき

### 振動デモの構成（2026-05-30 時点）
- `WeaponType` で 3 武器（ライトセーバー / 大剣 / 小剣）のプロファイル（ハム強度・鋭さ・振り閾値・振りパターン）を定義
- `HapticManager` は `CHHapticAdvancedPatternPlayer` で最大値テンプレートのハムをループ再生し、`hapticIntensityControl` / `hapticSharpnessControl` の dynamic parameter を毎フレーム送って加速度に追従させる
- `MotionManager` が 60Hz で `userAcceleration` のマグニチュード(g) を配信、しきい値超えで武器別スパイクを 1 発（デバウンス付き）
- ContentView は武器ピッカー + 加速度ゲージ（オレンジ縦線が選択中武器の閾値） + 構える／おさめるトグル

### 武器ごとの感触メモ
- **ライトセーバー**: 常時ハム強め、振ると鋭く太くなる。閾値 1.3g
- **大剣**: 静止時は無音、振ると重い低周波の唸り＋振り抜きで重インパクト＋低音余韻。閾値 1.8g、デバウンス長め
- **小剣**: 微かなハム、軽快に反応。振りスパイクは「シュッシュッ」3 連パルス。閾値 0.9g、デバウンス短く連撃可

### 次のステップ
- 構え検出（腰／肩の後ろの姿勢判定）— `CMDeviceMotion.attitude` のロール・ピッチで判定する想定
- 抜刀完了の判定（鞘から引き抜く移動量・速度ベクトル）
- そのあと SwiftUI の画面（スタート / 武器セレクト / 抜刀待機）に組み込み、はるの Firestore 連携と繋ぐ

### Firestore 連携（本番実装）

**本番コレクション：`shinken_rooms/battle`（ドキュメント固定）**

#### iOS が読むフィールド（`FirestoreListener` が 1 秒ポーリング）

| フィールド | 書く側 | iOS の使い方 |
|-----------|--------|-------------|
| `status` / `match_status` | Web | `"drawing"` になったら抜刀待機を自動開始 |
| `p{n}_weapon` | Web（武器確定時） | 選択された武器を `selectedWeapon` に反映 |

- Web 側は `"sword"` / `"greatsword"` / `"lightsaber"` の 3 種の文字列を使う（Web 内部の `selectionState` のキー）。
- `FirestoreListener.WeaponType.init(firestoreValue:)` でこれを iOS の `WeaponType` にマッピングする。

#### iOS が書くフィールド（`FirestoreEventSender.sendDrawReady` が PATCH）

| タイミング | フィールド | 値 | Web の反応 |
|-----------|-----------|----|-----------| 
| 抜刀完了 | `p{n}_ready` | `true` | `onSnapshot` で受信し、`p1_ready && p2_ready` が揃ったらバトル開始 |

- `n` はアプリ起動時に選択したプレイヤー番号（1 or 2）。
- Web が `drawing` フェーズ移行時に `p1_ready: false, p2_ready: false` にリセットする。

#### ゲームフロー（iOS 視点）

```
Web が status="selecting"（武器選択中、iOS は待機）
  ↓
Web が status="drawing" + p{n}_weapon を書く
  ↓ （FirestoreListener が検知、1秒以内）
iOS: 武器を p{n}_weapon に合わせて更新 + 抜刀待機自動開始
  ↓
プレイヤーが実際に抜刀（CoreMotion で移動量を積分）
  ↓
iOS: CoreHaptics で抜刀振動 + Firestore に p{n}_ready=true を PATCH
  ↓
Web: p1_ready && p2_ready を確認 → バトル開始（playing フェーズへ）
```

#### 注意事項

- Firebase SDK はまだ使わず、`URLSession` だけで動かす簡易版（ポーリング間隔 1 秒）。
- ローカルに `ios-app/shingekinoshinkenn/FirestoreConfig.plist` を作り、`FirestoreConfig.example.plist` と同じキーで実値を入れる（**Xcode の Target に追加して Copy Bundle Resources に入れる**。含めないと `missingFile` になる）。
- `FirestoreConfig.plist` は `.gitignore` 対象。公開リポジトリには入れない。
- Firestore ルールがテストモード等で未認証書き込みを許可していない場合は `HTTP 403` になる。
- `matches/{matchId}` コレクションは通信確認テスト用の旧実装。本番は `shinken_rooms/battle` のみを使う。

### 2026-05-31 時点の共有状況

- Firebase との連携テストは成功。データの送受信が正常に動くことを確認済み。
- 振動機能は実装完了。Pull Request 提出済み。
- バトル画面では、プレイヤーの準備状態と Web 側で選択した武器データが正しく反映されることを確認済み。
- ボタンでのデータ送信は実装済み。次は CoreMotion の検知結果から自動送信する。
- 水木の正式フロントエンドコードはルート直下に配置済み。正式配置を `web-parent/` にするかは要確認。

---

## 振動設計（技術仕様）

振動は **2 種類を「対極の質感」で設計する**のが基本方針。これに、武器を構えている間の地の感触（常時ハム）を加えた **3 レイヤ**構成になる。基盤はすべて CoreHaptics。

| レイヤ | 役割 | 質感 | 実装状況 |
|---|---|---|---|
| 常時ハム（idle） | 武器を構えている間のベース | 持続・加速度連動 | 実装済み |
| 振動A：抜刀 | 鞘から抜く瞬間 | 長く・なめらか・徐々に高まる持続 | TODO |
| 振動B：斬撃 | 振り抜く瞬間 | 短く・鋭い一瞬の打撃 | 実装済み |

抜刀（A）と斬撃（B）を「長い持続 vs 短い一撃」と正反対にすることが、抜刀→斬撃の体験を最も際立たせる。

### 振動A：抜刀（鞘走り → ジャキィン）

- **目的**：刃が鞘を擦りながら滑り出す「シャァァ…」という摩擦感 → 抜き切りで「ジャキィン」の一撃。
- **イベント種別**：継続的（continuous）を本体に、終端に一時的（transient）を 1 発。
- **再生方式**：`CHHapticAdvancedPatternPlayer` でループ再生（既存の常時ハムと同じ仕組みを流用）。抜いている間だけ鳴らし、抜刀完了で停止する。
- **強度連動**：抜く進捗（または抜く速さ）を `hapticIntensityControl` の dynamic parameter で毎フレーム送り、振動の強さを追従させる。ゆっくり抜けば弱く、勢いよく抜けば強い摩擦感になる。常時ハムの加速度連動と同じ機構を使い回せる。
- **シャープネス**：中〜高（`hapticSharpnessControl`）。金属が擦れる硬質な質感を出す。
- **音**：AHAP 内に金属滑走音を `AudioCustom` イベントで埋め込み、振動と「シャァ」音を完全同期させる。
- **終端**：抜刀完了の瞬間に鋭い transient を 1 発（ジャキィン）。構成は「持続で高まる → 終わりに一撃のアクセント」。
- **フロー連携**：構え判定 → 抜刀検知中は continuous を再生 → 抜刀完了で終端 transient ＋ ループ停止。検知ロジック（attitude／引き抜き量）は本仕様の対象外で、ここは**振動の責務のみ**。

### 振動B：斬撃（振り抜きスパイク）※実装済み

- **目的**：斬る瞬間の、鋭く一瞬の打撃感。
- **イベント種別**：一時的（transient）を核に、直後にごく短い continuous を足して刃が走り抜ける余韻を付ける。
- **再生方式**：振りを検知するたびにプレーヤーを start し直す即時再生。**振り数のカウントはしない**（毎回鳴らすだけ）。
- **パラメータ**：強度・シャープネスともに高め。抜刀の低く長いゴロゴロとは正反対の、硬く鋭い質感にする。差は `WeaponType` プロファイルで付ける。
- **音**：風切り＋金属音を `AudioCustom` で同期。
- **連撃**：パターンは短く保ち、即座に再トリガーできる形にする（小剣の「シュッシュッ」3 連パルス等）。

### 共通の設計原則（WWDC21 セッション 10278）

- **因果関係**：動作の「その瞬間」に鳴らす。検知から再生までの遅延をゼロに近づける。
- **調和性**：A と B の質感をはっきり分け、それぞれを音・画面アニメーションと一致させる。抜きが速い／強いほど振動・音・見た目もそろって強くする。
- **有用性**：この 3 レイヤ（常時ハム・抜刀・斬撃）以外では振動させない。意味のない振動を足さない。

---

## サウンド（効果音）再生 仕様

> 目的：今は **振動（CoreHaptics）だけ** でフィードバックしている。
> これに **スピーカーからの効果音** を足して、「構える / 振る」が音でも分かるようにする。
> 振動と同じトリガーに音を重ねるのが基本方針。

### 1. 現状

- フィードバックの本体は [`HapticManager.swift`](shingekinoshinkenn/HapticManager.swift) の CoreHaptics。
- `AVAudioPlayer` ベースの `SoundManager` はまだ未実装。
- 例外として、`HapticManager` が `CHHapticEngine.registerAudioResource` と `AudioCustom` イベントで、ライトセーバーの振り音 `ライトセーバ.mp3` をハプティクスに同期再生する実験実装を持っている。
- 大剣・小剣の音、構え中のハム音、加速度連動の音量変化は未実装。

### 2. 音を鳴らす2つのタイミング（振動と対応させる）

振動のトリガーは [`HapticManager.swift`](shingekinoshinkenn/HapticManager.swift) にある。これと同じ場所に音を足す。

| タイミング | 振動側の処理 | 鳴らしたい音 | ループ |
|------------|--------------|--------------|--------|
| 構える（装備） | `equip(_:)` でハム開始 | 武器の「唸り（ハム）」をループ再生し、加速度で音量を変える | ◯ ループ |
| 振り抜く | `updateMotion` 内の振り検出 → `playSwing` | 「シュッ / ドゥンッ」など一発の斬撃音 | × 単発 |
| おさめる | `disengage()` | ハム音を停止（フェードアウト） | — |

※ ハム音の「加速度で音量を変える」は CoreHaptics の dynamic parameter と同じ考え方を、`AVAudioPlayer.volume` で再現する。

### 3. 現在の音源ファイル

- 現在 Xcode project に登録されている音源は、`ios-app/ライトセーバ.mp3` の 1 つ。
- `WeaponType.swingAudioFilename` は Bundle ルート直下の `ライトセーバ.mp3` を直接参照する。
- このファイルがない環境ではライトセーバーの振り音は登録されない。ハプティクス自体は鳴る。

#### ファイル名・パスの対応（参照は壊れていない）

ファイル名が `ライトセーバ.mp3`（ディスク上は `ios-app/ライトセーバ.mp3`）になっているが、
**Xcode は `ios-app/` をルートとして開く前提**なので参照は正しく解決される。各レイヤーの対応は次の通り：

| レイヤー | 参照 | 基準 | 解決先 |
|----------|------|------|--------|
| ディスク | — | — | `ios-app/ライトセーバ.mp3` |
| `.xcodeproj` の場所 | — | — | `ios-app/shingekinoshinkenn.xcodeproj` |
| pbxproj `mainGroup` | `sourceTree = "<group>"` | `.xcodeproj` の親 = `ios-app/` | `ios-app/` |
| pbxproj fileRef | `path = "ライトセーバ.mp3"; sourceTree = "<group>"` | mainGroup = `ios-app/` | `ios-app/ライトセーバ.mp3` ✅ |
| ビルド（Copy Bundle Resources） | `ライトセーバ.mp3` | — | アプリ Bundle ルート直下 |
| Swift（`WeaponType.swift`） | `Bundle.main.bundleURL.appendingPathComponent("ライトセーバ.mp3")` | Bundle ルート | Bundle ルート直下の `ライトセーバ.mp3` ✅ |

- つまり「pbxproj の参照名（`ライトセーバ.mp3`）」と「リポジトリ上の実体（`ios-app/ライトセーバ.mp3`）」は**矛盾していない**。
  pbxproj の `<group>` 相対パスはプロジェクトルート（`ios-app/`）起点なので、両者は同じファイルを指す。
- そのため**リネームやファイル移動は不要**。`ios-app/shingekinoshinkenn.xcodeproj` を開いてビルドすれば、
  mp3 は Bundle ルートにコピーされ、Swift 側の `appendingPathComponent("ライトセーバ.mp3")` で読み込める。
- 注意：`ios-app/` ではなくリポジトリルート（`shingekinoshinkenn/`）を起点に開いたり、
  mp3 を別ディレクトリ（例：`ios-app/shingekinoshinkenn/`）へ移すと `<group>` 相対の解決先がずれて参照が壊れる。
  移動する場合は Xcode 上でドラッグして pbxproj の `path` を更新すること。

### 4. 今後の音源ファイル規約（SoundManager を作る場合）

- 形式：**`.wav`**（無圧縮・低レイテンシ。効果音はこれが無難）
- 置き場所：`ios-app/shingekinoshinkenn/Sounds/` を作り、**Xcode の Target に追加**（Copy Bundle Resources に入ること）
- ファイル名（武器の `rawValue` に合わせる。`WeaponType` は `lightsaber / greatsword / smallsword`）：

  | 用途 | ファイル名 |
  |------|-----------|
  | ライトセーバーのハム | `lightsaber_hum.wav` |
  | ライトセーバーの振り | `lightsaber_swing.wav` |
  | 大剣のハム | `greatsword_hum.wav` |
  | 大剣の振り | `greatsword_swing.wav` |
  | 小剣のハム | `smallsword_hum.wav` |
  | 小剣の振り | `smallsword_swing.wav` |

- ハム音は **シームレスにループできる素材**（先頭と末尾が繋がる）にする。
- 著作権フリー / 自作の音源のみ使用。リポジトリに入れてよいか要確認（容量・ライセンス）。

### 5. 実装方針（新規 `SoundManager.swift`）

`HapticManager` をいじり倒さず、対になる `SoundManager`（`AVAudioPlayer` ラッパー）を作り、
`ContentView` と `HapticManager` のトリガーに合わせて呼ぶ。

```
SoundManager（新規, @MainActor / ObservableObject）
├─ init()                  … AVAudioSession を設定（.playback or .ambient）
├─ preload()               … 6ファイルを AVAudioPlayer に読み込み prepareToPlay()
├─ startHum(_ weapon)      … 該当ハムを numberOfLoops = -1 でループ再生
├─ updateHum(volume:)      … 加速度に応じて hum の volume を 0..1 で更新
├─ playSwing(_ weapon)     … 振り音を単発再生（currentTime=0 → play()）
└─ stopHum()               … ハムを停止
```

#### 結線ポイント

- 構える：`ContentView` の equipButton で `haptics.equip` の隣に `sound.startHum(selectedWeapon)`
- 加速度：`motion.start { g in haptics.updateMotion(...) ; sound.updateHum(volume: 正規化(g)) }`
- 振り：振動の `playSwing` と同じ瞬間に `sound.playSwing(weapon)`
  - 一番きれいなのは、振り検出を `HapticManager` から **コールバック / Combine で外に通知**し、`ContentView` で振動と音を同時に出す形。
  - 手早くやるなら `HapticManager` に `SoundManager` を持たせて `playSwing` 内から直接鳴らす。
- おさめる / 画面離脱：`disengage()` / `onDisappear` で `sound.stopHum()`

#### AVAudioSession の注意

- カテゴリは `.ambient`（マナースイッチで消える、BGMを止めない）か `.playback`（消音スイッチ無視で必ず鳴る）を用途で選ぶ。
- **消音（サイレント）スイッチ ON だと `.ambient` では鳴らない** ＝ 「鳴らない」最頻の原因。デモは `.playback` 推奨。
- `setActive(true)` を忘れない。

### 6. 「鳴らない」ときの切り分けチェックリスト

実装後に音が出ないときは上から順に確認：

1. 端末の **消音スイッチ / 音量** が下がっていないか（`outputVolume == 0` をログで確認）
2. **音源ファイルがバンドルに入っているか**（現状の `AudioCustom` 実装では `Bundle.main.bundleURL.appendingPathComponent("ライトセーバ.mp3")` が存在するか）
3. `AVAudioSession` の **category / setActive(true)** が成功しているか
4. `AVAudioPlayer.play()` の **戻り値が true** か（false なら再生失敗）
5. 振りトリガー自体が発火しているか（振動が出ているなら発火はしている → 音側の問題）
6. シミュレータか実機か（音はシミュレータでも出るが、振動・加速度は実機のみ）

→ 上記 1〜4 を `print` / `Logger` でログ出力してから実機で再生し、どこで止まるか特定する。
（CoreHaptics 側は既に `Logger(subsystem: "shingekinoshinkenn", category: "Haptics")` で 🪶 付きログを出している。
　Console.app / Xcode コンソールで `shingekinoshinkenn` でフィルタすると追える。）

---

## やりたいことリスト（できれば / 余力があれば）

> 必須ではなく「できたら面白い」アイデア置き場。優先度は低めだが、企画の核に近いものから並べる。
> 実装するときはここから1つ選んで別途タスク化する。

### ◎ 空間オーディオ（攻撃の方向が音で分かる）

- **やりたいこと**：効果音をただ鳴らすのではなく、「どの方向から斬撃／攻撃が来たか」を音の定位で表現する。ヘッドホン時に没入感が大きく上がる。
- **使う技術**：Apple の **PHASE**（Physical Audio Spatialization Engine）／または `AVAudioEnvironmentNode` + `AVAudioPlayerNode`。ヘッドホンの向き連動まで狙うなら **CMHeadphoneMotionManager**（AirPods のヘッドトラッキング）。
- **段階**：
  1. まずは普通の `AVAudioPlayer`（[サウンド仕様](#サウンド効果音再生-仕様) のとおり）で「鳴る」を作る。
  2. それを空間オーディオエンジンに載せ替え、音源に 3D 位置を持たせる。
  3. 相手の攻撃イベント（方向つき）が来たら、その方向に音源を置いて鳴らす → 下のガードと連動。
- **メモ**：方向の単位を先に決める（例：自分の正面を 0°、右 +90° のように。Watch ガードと共通の角度系にすると話が早い）。

### ◎ Apple Watch で相手の攻撃をガードする

- **やりたいこと**：相手の攻撃が来た方向（空間オーディオで聞こえた方向）へ、**Apple Watch を着けた腕を構えてガード**する。タイミングと方向が合えば防御成功、ズレたら被弾。
- **体験の流れ（イメージ）**：
  1. 相手が攻撃 → こちらに「攻撃イベント（方向・タイミング）」が届く。
  2. iPhone（or AirPods）の空間オーディオで、その方向から斬撃音が鳴る。
  3. プレイヤーは音の方向に Watch の腕をかざす。
  4. Watch の姿勢（`attitude`）が攻撃方向と合致 ＆ タイミングが合えば **ガード成功**（Watch が成功の振動、iPhone が金属の受け止め音）。失敗なら被弾演出。
- **使う技術**：
  - **watchOS アプリ**（SwiftUI、iOS とコード共有しやすい）。
  - Watch 側で **CoreMotion**（`attitude.quaternion` / roll・pitch）から腕の向きを取得。
  - **WatchConnectivity** で iPhone ↔ Watch のイベント送受信（攻撃通知・ガード結果）。
  - ガード成功時の手応えは **WKHapticType**（watchOS の触覚）。
- **判定の考え方**：攻撃方向ベクトルと「Watch が向いている方向ベクトル」の内積（simd）が一定以上＝方向OK。さらに攻撃の着弾時刻との時間差が窓内＝タイミングOK。両方満たせば成功。
- **段階**：
  1. watchOS ターゲットを追加し、Watch の `attitude` を画面に出すだけのミニアプリ。
  2. WatchConnectivity で iPhone に「今この向き」を送れるようにする。
  3. iPhone から「攻撃が来た（方向X）」を送り、Watch で向き＆タイミング判定 → 成功/失敗を返す。
  4. 空間オーディオの方向と、攻撃方向の角度系を揃えて統合。

### 連携メモ（この2つはセットで効く）

- 「攻撃イベント」のデータ形（**方向の角度 + 着弾タイミング**）を最初に1つ決めておくと、空間オーディオとガード判定の両方で使い回せる。
- 攻撃を出すのは対戦相手 → ここは **はる の Firestore / 通信** と関わる領域。タッキー側は「方向つき攻撃イベントを受け取ったら、音を鳴らし、Watch のガード判定をする」ところを担当、という切り分けにできる。

---

## 詰まっていること（ヘルプ要請）
-
