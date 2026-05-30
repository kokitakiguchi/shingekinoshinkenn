//
//  WeaponType.swift
//  shingekinoshinkenn
//
//  武器ごとのハプティクス特性（常時ハム / 加速度応答 / 振り検出閾値 /
//  振り抜き時のパターン）を定義する。
//

import CoreHaptics
import Foundation

enum WeaponType: String, CaseIterable, Identifiable {
    case lightsaber
    case greatsword
    case smallsword

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .lightsaber: return "ライトセーバー"
        case .greatsword: return "大剣"
        case .smallsword: return "小剣"
        }
    }

    var symbolName: String {
        switch self {
        case .lightsaber: return "bolt.fill"
        case .greatsword: return "shield.lefthalf.filled"
        case .smallsword: return "scribble.variable"
        }
    }

    // MARK: - 常時ハムのプロファイル
    //
    // ハム本体は intensity = 1.0, sharpness = 1.0 のテンプレートとして再生し、
    // 動的パラメータ（hapticIntensityControl / hapticSharpnessControl）で
    // 静止時〜最大加速度の間を補間する。

    var humIntensityAtRest: Float {
        switch self {
        case .lightsaber: return 0.35
        case .greatsword: return 0.0   // 静止時は無音、重みは振らないと出ない
        case .smallsword: return 0.12  // ほんのり気配
        }
    }

    var humIntensityAtMax: Float {
        switch self {
        case .lightsaber: return 0.9
        case .greatsword: return 0.75  // 振るとぐっと重い唸りが立ち上がる
        case .smallsword: return 0.55  // 軽い武器なので控えめ
        }
    }

    var humSharpnessAtRest: Float {
        switch self {
        case .lightsaber: return 0.6
        case .greatsword: return 0.0   // 重低音側
        case .smallsword: return 0.7   // 高めの周波数
        }
    }

    var humSharpnessAtMax: Float {
        switch self {
        case .lightsaber: return 0.95
        case .greatsword: return 0.3   // 重い唸りはそのまま低周波寄り
        case .smallsword: return 1.0   // ピリッと鋭く
        }
    }

    // MARK: - 振り検出

    /// この値（g）を超えたら「振り」とみなし、専用パターンを 1 発鳴らす
    var swingThreshold: Double {
        switch self {
        case .lightsaber: return 1.3
        case .greatsword: return 1.8   // 重い武器、振り抜くのに気合いが要る
        case .smallsword: return 0.9   // 軽快に反応
        }
    }

    /// 同じ振りで多重発火しないためのデバウンス（秒）
    var swingDebounce: TimeInterval {
        switch self {
        case .lightsaber: return 0.25
        case .greatsword: return 0.45  // 重い余韻が落ち着くまで次は鳴らさない
        case .smallsword: return 0.12  // 連撃が効くように短く
        }
    }

    // MARK: - 音源（AudioCustom）
    //
    // 振り抜き時に同期再生する音源。Bundle ルート直下の固定ファイルを直接指す
    // （Bundle.url(forResource:withExtension:) でのリソース検索はしない）。

    /// Bundle ルート直下に置いた音源ファイル名（拡張子込み）。無ければ nil。
    var swingAudioFilename: String? {
        switch self {
        case .lightsaber:
            return "ライトセーバ.mp3"
        case .greatsword, .smallsword:
            return nil
        }
    }

    // MARK: - パターン生成

    /// 常時鳴らすハム用のループパターン。
    /// テンプレートは最大値で組み、HapticManager が dynamic parameter で減衰させる。
    func makeHumPattern() throws -> CHHapticPattern {
        let hum = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 1.0)
            ],
            relativeTime: 0,
            duration: 2.0
        )
        return try CHHapticPattern(events: [hum], parameters: [])
    }

    /// 振り抜いた瞬間に重ねる一発パターン。`boost` は 0..1 の振り強度。
    /// - Parameter audioResourceID: 同期再生する音源（事前に engine に登録済みのもの）。
    ///   nil なら振動のみ。
    func makeSwingPattern(
        boost: Float,
        audioResourceID: CHHapticAudioResourceID? = nil
    ) throws -> CHHapticPattern {
        let b = max(0, min(boost, 1.0))
        var events: [CHHapticEvent] = []
        switch self {
        case .lightsaber:
            // 仕様: transient 核 → ごく短い continuous の余韻で「ブォン！…」
            events.append(CHHapticEvent(
                eventType: .hapticTransient,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.6 + 0.4 * b),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 1.0)
                ],
                relativeTime: 0
            ))
            events.append(CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.45 + 0.45 * b),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.85),
                    CHHapticEventParameter(parameterID: .attackTime, value: 0.0),
                    CHHapticEventParameter(parameterID: .decayTime, value: 0.22),
                    CHHapticEventParameter(parameterID: .sustained, value: 0.0)
                ],
                relativeTime: 0.02,
                duration: 0.25
            ))

        case .greatsword:
            // 重い「ドゥンッ…」 強いインパクト → 長い低周波の余韻
            events.append(CHHapticEvent(
                eventType: .hapticTransient,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.2)
                ],
                relativeTime: 0
            ))
            events.append(CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.6 + 0.4 * b),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.05),
                    CHHapticEventParameter(parameterID: .attackTime, value: 0.0),
                    CHHapticEventParameter(parameterID: .decayTime, value: 0.55),
                    CHHapticEventParameter(parameterID: .sustained, value: 0.0)
                ],
                relativeTime: 0.02,
                duration: 0.65
            ))
            // 着地の重み: 終盤に小さな低音タップを足して余韻に陰影を付ける
            events.append(CHHapticEvent(
                eventType: .hapticTransient,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.35 + 0.3 * b),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.1)
                ],
                relativeTime: 0.55
            ))

        case .smallsword:
            // 「シュッシュッ」 速くて鋭いパルス列
            let count = 3
            for i in 0..<count {
                let fade = 1.0 - Float(i) * 0.15
                events.append(CHHapticEvent(
                    eventType: .hapticTransient,
                    parameters: [
                        CHHapticEventParameter(
                            parameterID: .hapticIntensity,
                            value: (0.65 + 0.35 * b) * fade
                        ),
                        CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.9)
                    ],
                    relativeTime: Double(i) * 0.05
                ))
            }
        }

        // 振動と同じタイミングで音源も鳴らす（登録済みのときのみ）。
        // 音は無編集（音程・音量を boost で変調しない）でそのまま鳴らす。
        if let resourceID = audioResourceID {
            events.append(CHHapticEvent(
                audioResourceID: resourceID,
                parameters: [],
                relativeTime: 0
            ))
        }

        return try CHHapticPattern(events: events, parameters: [])
    }
}
