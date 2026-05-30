# 真剣（しんけん） / SHINGEKI NO SHINKEN

> ハッカソンテーマ **「しん」** — スマホを刀に見立て、腰から抜く居合を **振動** で再現する iPhone 向け **真剣勝負** 対戦アプリ。

「**しん**」のつく言葉だけで体験が一本につながっているのが、このプロジェクトの核です。

| しん | 役割 |
|------|------|
| **振動** | 抜刀・斬撃の手応えを Taptic / CoreHaptics で再現する中核の仕組み |
| **真剣** | 本気の（＝真剣な）／本物の剣（＝真剣）による勝負。ダブルミーニングのアプリ名 |
| **進撃** | 相手に斬りかかる攻めの動作 |
| **真剣勝負** | 一瞬の抜刀で決着をつける対戦そのもの |

---

## ドキュメント一覧

開発に入る前に、まず自分の担当に関係するページを読んでください。

| ファイル | 内容 | 主に読む人 |
|----------|------|-----------|
| [docs/CONCEPT.md](docs/CONCEPT.md) | アイディア・コンセプト・体験の流れ・対戦モード（発表のベースにもなる） | 全員 |
| [docs/ROLES.md](docs/ROLES.md) | メンバーごとの役割・やることリスト・初手アクション | 全員 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 全体構成図・Firebase データモデル・連携の仕様 | 全員（特に繋ぎ込み担当） |
| [docs/BRANCH_STRATEGY.md](docs/BRANCH_STRATEGY.md) | ブランチ運用・コミット/PR ルール・コンフリクト回避 | 全員 |
| [docs/SETUP.md](docs/SETUP.md) | 環境構築（iOS / Web / Firebase） | 全員 |
| [ios-app/TAKI.md](ios-app/TAKI.md) | たき個人の作業メモ＆チェックリスト | たき |

---

## リポジトリ構成

```
shingekinoshinkenn/
├── README.md              ← いまここ
├── docs/                  ← 設計・運用ドキュメント
├── ios-app/               ← iPhone アプリ（Xcode / Swift）  担当: たき
│   ├── shingekinoshinkenn.xcodeproj
│   ├── shingekinoshinkenn/
│   └── TAKI.md
└── web-parent/            ← PC 大画面用の Web（HTML/CSS/JS）  担当: はる・みずき
```

- **担当フォルダの中だけで作業すれば、基本的にコンフリクトしません。**
- データのやり取りは **Firebase (Firestore)** を介してリアルタイムに行います。詳細は [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## クイックスタート（最初の数時間）

1. このリポジトリを clone する → [SETUP.md](docs/SETUP.md)
2. 自分のブランチを `main` から切る → [BRANCH_STRATEGY.md](docs/BRANCH_STRATEGY.md)
3. [ROLES.md](docs/ROLES.md) の自分の **「初手のアクション」** をクリアする
4. Firebase に繋いで、最小の「繋ぎ込みテスト」をする

> まずは各自の初手アクションを終わらせて、ベースを繋ぎ込むところまでを目標にしましょう 🗡️
