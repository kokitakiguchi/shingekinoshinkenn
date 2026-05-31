//
//  shingekinoshinkennTests.swift
//  shingekinoshinkennTests
//
//  Created by Koki Takiguchi on 2026/05/30.
//

import Testing
import Foundation
@testable import shingekinoshinkenn

struct shingekinoshinkennTests {

    @Test func firestoreConfigDecodesValuesAndDefaults() throws {
        let data = try plistData([
            "FIRESTORE_PROJECT_ID": " sample-project ",
            "FIRESTORE_API_KEY": " sample-key ",
            "FIRESTORE_MATCH_ID": "",
            "FIRESTORE_PLAYER_ID": ""
        ])

        let config = try FirestoreConfig.decode(from: data)

        #expect(config.projectId == "sample-project")
        #expect(config.apiKey == "sample-key")
        #expect(config.matchId == "test")
        #expect(config.playerId == "p1")
    }

    @Test func firestoreConfigRejectsPlaceholderValues() throws {
        let data = try plistData([
            "FIRESTORE_PROJECT_ID": "your-firebase-project-id",
            "FIRESTORE_API_KEY": "your-web-api-key"
        ])

        do {
            _ = try FirestoreConfig.decode(from: data)
            Issue.record("placeholder project id should be rejected")
        } catch FirestoreConfigError.missingProjectId {
            #expect(true)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func drawnEventURLTargetsConfiguredMatchAndPlayer() throws {
        let config = FirestoreConfig(
            projectId: "sample-project",
            apiKey: "sample-key",
            matchId: "match-123",
            playerId: "p2"
        )

        let url = try FirestoreEventSender.makeURL(config: config, event: .drawn(weapon: .lightsaber))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let queryItems = components.queryItems ?? []
        let updateMasks = queryItems
            .filter { $0.name == "updateMask.fieldPaths" }
            .compactMap(\.value)

        #expect(components.scheme == "https")
        #expect(components.host == "firestore.googleapis.com")
        #expect(components.path == "/v1/projects/sample-project/databases/(default)/documents/matches/match-123")
        #expect(queryItems.contains(URLQueryItem(name: "key", value: "sample-key")))
        #expect(updateMasks.contains("players.p2.drawn"))
        #expect(updateMasks.contains("players.p2.weapon"))
        #expect(updateMasks.contains("players.p2.drawnAt"))
        #expect(!updateMasks.contains("players.p2.drawSource"))
    }

    @Test func readyEventURLIncludesReadyFieldPaths() throws {
        let config = FirestoreConfig(
            projectId: "sample-project",
            apiKey: "sample-key",
            matchId: "match-123",
            playerId: "p2"
        )

        let url = try FirestoreEventSender.makeURL(config: config, event: .ready(weapon: .greatsword))
        let updateMasks = (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .filter { $0.name == "updateMask.fieldPaths" }
            .compactMap(\.value)

        #expect(updateMasks.contains("players.p2.ready"))
        #expect(updateMasks.contains("players.p2.weapon"))
        #expect(updateMasks.contains("players.p2.readyAt"))
    }

    @Test func drawnEventBodyIncludesWeaponAndTimestamp() throws {
        let date = try #require(ISO8601DateFormatter().date(from: "2026-05-30T08:00:00Z"))
        let body = FirestoreEventSender.makeBody(
            playerId: "p2",
            event: .drawn(weapon: .smallsword),
            date: date
        )
        let json = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let text = try #require(String(data: json, encoding: .utf8))

        #expect(text.contains("\"p2\""))
        #expect(text.contains("\"drawn\":{\"booleanValue\":true}"))
        #expect(text.contains("\"weapon\":{\"stringValue\":\"smallsword\"}"))
        #expect(text.contains("\"drawnAt\":{\"stringValue\":\"2026-05-30T08:00:00Z\"}"))
        #expect(!text.contains("ios-rest-test"))
    }

    @Test func readyEventBodyIncludesWeaponAndTimestamp() throws {
        let date = try #require(ISO8601DateFormatter().date(from: "2026-05-30T08:00:00Z"))
        let body = FirestoreEventSender.makeBody(
            playerId: "p2",
            event: .ready(weapon: .lightsaber),
            date: date
        )
        let json = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let text = try #require(String(data: json, encoding: .utf8))

        #expect(text.contains("\"ready\":{\"booleanValue\":true}"))
        #expect(text.contains("\"weapon\":{\"stringValue\":\"lightsaber\"}"))
        #expect(text.contains("\"readyAt\":{\"stringValue\":\"2026-05-30T08:00:00Z\"}"))
    }

    private func plistData(_ dictionary: [String: String]) throws -> Data {
        try PropertyListSerialization.data(fromPropertyList: dictionary, format: .xml, options: 0)
    }

}
