//
//  FirestoreListener.swift
//  shingekinoshinkenn
//
//  本番 Firestore ドキュメント（shinken_rooms/battle）を 1 秒間隔でポーリングし、
//  p{n}_ready / p{n}_weapon の変化を MainActor 上で公開する。
//
//  Firebase iOS SDK なしで動作する（URLSession + REST API）。
//  ready の「false → true エッジ」だけを isReadyReceived で通知するので、
//  ContentView は onChange で受け取って抜刀待機を開始できる。
//

import Foundation

@MainActor
final class FirestoreListener: ObservableObject {

    // MARK: - 公開プロパティ

    /// 監視するプレイヤー番号（1 or 2）。PlayerSelectView で決まる。
    var playerNumber: Int = 1 {
        didSet { resetState() }
    }

    /// Web 側（はる）が p{n}_ready = true を書いた瞬間に true になる（エッジ検出）。
    /// ContentView はこれをトリガに抜刀待機を開始する。
    /// 一度発火したら false に戻す（再び ready になるまで再発火しない）。
    @Published private(set) var isReadyReceived: Bool = false

    /// Web 側が p{n}_weapon に書いた武器 ID。nil は未取得 or マッピング不明。
    @Published private(set) var weapon: WeaponType?

    /// ポーリングの状態を UI に表示するためのステータス文字列。
    @Published private(set) var connectionStatus: String = "未接続"

    // MARK: - 内部状態

    private var pollingTask: Task<Void, Never>?
    /// 前フレームの p{n}_ready 値。エッジ検出に使う。
    private var previousReady: Bool = false
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

    /// 「サーバから ready を受け取った」フラグをリセットする。
    /// 抜刀完了後 or キャンセル後に呼ぶことで、次回の ready を受け付けられる。
    func consumeReadyReceived() {
        isReadyReceived = false
    }

    private func resetState() {
        isReadyReceived = false
        previousReady = false
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
        let readyKey = "p\(playerNumber)_ready"
        let weaponKey = "p\(playerNumber)_weapon"

        // ready: false → true のエッジだけ通知
        let currentReady = fields[readyKey]?.booleanValue ?? false
        if currentReady && !previousReady {
            isReadyReceived = true
        }
        previousReady = currentReady

        // 武器：生文字列を WeaponType へマッピング
        if let weaponStr = fields[weaponKey]?.stringValue {
            weapon = WeaponType(firestoreValue: weaponStr)
        }

        connectionStatus = "受信中 (\(readyKey): \(currentReady))"
    }

    deinit {
        pollingTask?.cancel()
    }
}

// MARK: - Firestore REST レスポンスの最小デコード型

private struct FirestoreDocumentResponse: Decodable {
    /// ドキュメントが存在しない場合 fields がないケースに備え省略可能にする。
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
    let integerValue: String? // Firestore は整数を文字列で返す

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
    /// Web 側の rawValue（"lightsaber" / "greatsword" / "smallsword"）と
    /// 旧 web キー（"katana" / "taiken" / "sabers"）の両方を受け付ける。
    init?(firestoreValue: String) {
        switch firestoreValue {
        case "lightsaber", "katana", "sabers":
            self = .lightsaber
        case "greatsword", "taiken":
            self = .greatsword
        case "smallsword", "sword":
            self = .smallsword
        default:
            // WeaponType.rawValue と一致するか試みる（将来の拡張に備えて）
            if let w = WeaponType(rawValue: firestoreValue) { self = w } else { return nil }
        }
    }
}
