//
//  FirestoreEventSender.swift
//  shingekinoshinkenn
//
//  Sends ready / draw-complete events to Firestore via the REST API.
//

import Foundation
import Combine

@MainActor
final class FirestoreEventSender: ObservableObject {
    enum Event {
        case ready(weapon: WeaponType)
        case drawn(weapon: WeaponType)

        nonisolated var name: String {
            switch self {
            case .ready: return "ready"
            case .drawn: return "drawn"
            }
        }

        /// `players.{playerId}` の下に書き込む相対フィールドパス。
        nonisolated var relativeFieldPaths: [String] {
            switch self {
            case .ready: return ["ready", "weapon", "readyAt"]
            case .drawn: return ["drawn", "weapon", "drawnAt"]
            }
        }

        nonisolated func playerFields(date: Date) -> [String: Any] {
            let timestamp = ISO8601DateFormatter().string(from: date)
            switch self {
            case .ready(let weapon):
                return [
                    "ready": ["booleanValue": true],
                    "weapon": ["stringValue": weapon.rawValue],
                    "readyAt": ["stringValue": timestamp]
                ]
            case .drawn(let weapon):
                return [
                    "drawn": ["booleanValue": true],
                    "weapon": ["stringValue": weapon.rawValue],
                    "drawnAt": ["stringValue": timestamp]
                ]
            }
        }
    }

    enum State: Equatable {
        case idle
        case sending
        case sent(String)
        case failed(String)

        var message: String {
            switch self {
            case .idle:
                return "未送信"
            case .sending:
                return "送信中..."
            case .sent(let detail):
                return "送信完了: \(detail)"
            case .failed(let detail):
                return "送信失敗: \(detail)"
            }
        }
    }

    @Published private(set) var state: State = .idle

    func sendReady(weapon: WeaponType) async {
        await send(.ready(weapon: weapon))
    }

    func sendDrawComplete(weapon: WeaponType) async {
        await send(.drawn(weapon: weapon))
    }

    private func send(_ event: Event) async {
        state = .sending
        do {
            let config = try FirestoreConfig.load()
            try await patch(config: config, event: event)
            state = .sent("matches/\(config.matchId)/players.\(config.playerId).\(event.name)")
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func patch(config: FirestoreConfig, event: Event) async throws {
        var request = URLRequest(url: try Self.makeURL(config: config, event: event))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(
            withJSONObject: Self.makeBody(playerId: config.playerId, event: event)
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw FirestoreEventError.invalidResponse
        }
        guard 200..<300 ~= httpResponse.statusCode else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw FirestoreEventError.server(statusCode: httpResponse.statusCode, body: body)
        }
    }

    nonisolated static func makeURL(config: FirestoreConfig, event: Event) throws -> URL {
        let base = "https://firestore.googleapis.com/v1/projects/\(config.projectId)/databases/(default)/documents/matches/\(config.matchId)"
        guard var components = URLComponents(string: base) else {
            throw FirestoreEventError.invalidURL
        }
        var queryItems = [URLQueryItem(name: "key", value: config.apiKey)]
        for path in event.relativeFieldPaths {
            queryItems.append(
                URLQueryItem(
                    name: "updateMask.fieldPaths",
                    value: "players.\(config.playerId).\(path)"
                )
            )
        }
        components.queryItems = queryItems
        guard let url = components.url else {
            throw FirestoreEventError.invalidURL
        }
        return url
    }

    nonisolated static func makeBody(playerId: String, event: Event, date: Date = Date()) -> [String: Any] {
        [
            "fields": [
                "players": [
                    "mapValue": [
                        "fields": [
                            playerId: [
                                "mapValue": [
                                    "fields": event.playerFields(date: date)
                                ]
                            ]
                        ]
                    ]
                ]
            ]
        ]
    }
}

enum FirestoreEventError: LocalizedError {
    case invalidURL
    case invalidResponse
    case server(statusCode: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Firestore REST API の URL を作れません"
        case .invalidResponse:
            return "Firestore から不正なレスポンスが返りました"
        case .server(let statusCode, let body):
            return "HTTP \(statusCode) \(body)"
        }
    }
}
