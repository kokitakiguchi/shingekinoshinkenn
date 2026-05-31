//
//  FirestoreListener.swift
//  shingekinoshinkenn
//
//  本番 Firestore ドキュメント（shinken_rooms/battle）を 1 秒間隔でポーリングし、
//  status / p{n}_weapon の変化を MainActor 上で公開する。
//
//  【実際のフロー】
//    selecting: Web がポーズで武器選択（iOS は待機）
//    drawing:   Web が p{n}_weapon を書き status="drawing" にする
//               → iOS がこれを検知して抜刀待機を自動開始
//               → 抜刀完了後、iOS が p{n}_ready=true を書く
//    playing:   Web が p1_ready && p2_ready を確認してバトル開始
//
//  Firebase iOS SDK なしで動作する（URLSession + REST API）。
//

import Foundation

@MainActor
final class FirestoreListener: ObservableObject {

    // MARK: - 公開プロパティ

    /// 監視するプレイヤー番号（1 or 2）。PlayerSelectView で決まる。
    var playerNumber: Int = 1 {
        didSet { resetState() }
    }

    /// status が "selecting" → "drawing" に変わった瞬間に true になる（エッジ検出）。
    /// ContentView はこれをトリガに抜刀待機を自動開始する。
    /// 消費したら consumeDrawingPhase() で false に戻す。
    @Published private(set) var isDrawingPhaseStarted: Bool = false

    /// Web が drawing フェーズ開始時に p{n}_weapon へ書いた武器。
    /// nil は未取得 or マッピング不明。
    @Published private(set) var weapon: WeaponType?

    /// 現在のゲームフェーズ（"selecting" / "drawing" / "playing" / "finished"）。
    @Published private(set) var gameStatus: String = ""

    /// ポーリングの状態を UI に表示するためのステータス文字列。
    @Published private(set) var connectionStatus: String = "未接続"

    // MARK: - 内部状態

    private var pollingTask: Task<Void, Never>?
    private var previousStatus: String = ""
    private let pollInterval: UInt64 = 1_000_000_000 // 1 秒 (nanoseconds)

    // MARK: - 制御

    func startListening() {
        stopListening()
        resetState()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: self?.pollInterval ?? 1_000_000_000)
            }
        }
        connectionStatus = "接続中..."
    }

    func stopListening() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    /// drawing フェーズ検知フラグを消費する。ContentView が onChange で呼ぶ。
    func consumeDrawingPhase() {
        isDrawingPhaseStarted = false
    }

    private func resetState() {
        isDrawingPhaseStarted = false
        previousStatus = ""
        gameStatus = ""
        weapon = nil
    }

    // MARK: - ポーリング本体

    private func poll() async {
        guard let config = try? FirestoreConfig.load() else {
            await MainActor.run { self.connectionStatus = "設定ファイル未取得" }
            return
        }
        let urlStr = "https://firestore.googleapis.com/v1/projects/\(config.projectId)"
            + "/databases/(default)/documents/shinken_rooms/battle?key=\(config.apiKey)"
        guard let url = URL(string: urlStr) else { return }

        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let doc = try JSONDecoder().decode(FirestoreDocumentResponse.self, from: data)
            await MainActor.run { [weak self] in self?.apply(doc.fields) }
        } catch {
            await MainActor.run { [weak self] in
                self?.connectionStatus = "通信エラー"
            }
        }
    }

    private func apply(_ fields: [String: FirestoreFieldValue]) {
        let weaponKey = "p\(playerNumber)_weapon"

        // status: "selecting" → "drawing" のエッジを検知
        let currentStatus = fields["status"]?.stringValue
            ?? fields["match_status"]?.stringValue
            ?? ""
        if currentStatus == "drawing" && previousStatus != "drawing" {
            isDrawingPhaseStarted = true
        }
        previousStatus = currentStatus
        gameStatus = currentStatus

        // 武器：drawing フェーズ移行時に Web が p{n}_weapon に書く
        if let weaponStr = fields[weaponKey]?.stringValue {
            let mapped = WeaponType(firestoreValue: weaponStr)
            if mapped != weapon { weapon = mapped }
        }

        connectionStatus = "受信中 (status: \(currentStatus))"
    }

    deinit {
        pollingTask?.cancel()
    }
}

// MARK: - Firestore REST レスポンスの最小デコード型

private struct FirestoreDocumentResponse: Decodable {
    let fields: [String: FirestoreFieldValue]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        fields = (try? container.decodeIfPresent([String: FirestoreFieldValue].self, forKey: .fields)) ?? [:]
    }

    private enum CodingKeys: String, CodingKey { case fields }
}

private struct FirestoreFieldValue: Decodable {
    let booleanValue: Bool?
    let stringValue: String?
    let integerValue: String?

    private enum CodingKeys: String, CodingKey {
        case booleanValue, stringValue, integerValue
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        booleanValue  = try c.decodeIfPresent(Bool.self,   forKey: .booleanValue)
        stringValue   = try c.decodeIfPresent(String.self, forKey: .stringValue)
        integerValue  = try c.decodeIfPresent(String.self, forKey: .integerValue)
    }
}

// MARK: - WeaponType の Firestore 文字列マッピング

extension WeaponType {
    /// Firestore の p{n}_weapon 文字列から WeaponType を返す。
    /// Web 側は "sword" / "greatsword" / "lightsaber" を使う（selectionState のキー）。
    /// 旧キー（"katana" / "taiken" / "sabers"）も互換で受け付ける。
    init?(firestoreValue: String) {
        switch firestoreValue {
        case "lightsaber", "sabers":
            self = .lightsaber
        case "greatsword", "taiken":
            self = .greatsword
        case "sword", "smallsword", "katana":
            self = .smallsword
        default:
            if let w = WeaponType(rawValue: firestoreValue) { self = w } else { return nil }
        }
    }
}
