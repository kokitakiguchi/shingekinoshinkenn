//
//  HapticManager.swift
//  shingekinoshinkenn
//
//  CoreHaptics をラップし、武器ごとの「常時ハム + 加速度連動 + 振り検出」を行う。
//  参考: WWDC21 "Practice Audio Haptic Design" (session 10278)
//        Apple Sample "Delivering Rich App Experiences with Haptics"
//
//  ハム本体は最大値テンプレートのループとして CHHapticAdvancedPatternPlayer で再生し、
//  CHHapticDynamicParameter（hapticIntensityControl / hapticSharpnessControl）を
//  毎フレーム送ることで加速度に応じた表情を付ける。
//

import Combine
import CoreHaptics
import os

/// CoreHaptics の `CHHapticEngine` を管理し、装備中の武器に合わせて
/// 常時振動・振りスパイクを再生する。
///
/// - Note: ハプティクスは実機専用。シミュレータでは `supportsHaptics == false`。
@MainActor
final class HapticManager: ObservableObject {

    /// 端末がハプティクスに対応しているか
    let supportsHaptics: Bool

    /// 現在装備中の武器。`nil` のときはハム停止状態。
    @Published private(set) var equippedWeapon: WeaponType?

    private var engine: CHHapticEngine?
    private var humPlayer: CHHapticAdvancedPatternPlayer?
    private var lastSwingTime: Date = .distantPast
    private let logger = Logger(subsystem: "shingekinoshinkenn", category: "Haptics")

    /// 加速度を 0..1 に正規化する基準（g）。これ以上は飽和扱い。
    private let accelerationNormalizationCeiling: Double = 2.5

    init() {
        supportsHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
        prepareEngine()
    }

    // MARK: - Engine lifecycle

    private func prepareEngine() {
        guard supportsHaptics else { return }
        do {
            let engine = try CHHapticEngine()

            engine.resetHandler = { [weak self] in
                self?.logger.debug("Haptic engine reset; restarting.")
                try? self?.engine?.start()
            }

            engine.stoppedHandler = { [weak self] reason in
                self?.logger.debug("Haptic engine stopped: \(reason.rawValue, privacy: .public)")
            }

            try engine.start()
            self.engine = engine
        } catch {
            logger.error("Failed to start haptic engine: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - 装備の切り替え

    /// 武器を装備し、常時ハムをループ再生し始める。
    func equip(_ weapon: WeaponType) {
        disengage() // 既存ハムを止める
        guard supportsHaptics, let engine else {
            equippedWeapon = weapon // 状態だけ更新（非対応端末でも UI 動作確認できるよう）
            return
        }
        do {
            try engine.start()
            let pattern = try weapon.makeHumPattern()
            let player = try engine.makeAdvancedPlayer(with: pattern)
            player.loopEnabled = true
            player.loopEnd = 0 // 0 = パターン全体をループ
            // 静止状態から始める
            try sendHumParameters(
                to: player,
                intensity: weapon.humIntensityAtRest,
                sharpness: weapon.humSharpnessAtRest
            )
            try player.start(atTime: CHHapticTimeImmediate)
            humPlayer = player
            equippedWeapon = weapon
        } catch {
            logger.error("Failed to equip weapon: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// 装備を解除しハムを止める。
    func disengage() {
        if let player = humPlayer {
            try? player.stop(atTime: CHHapticTimeImmediate)
        }
        humPlayer = nil
        equippedWeapon = nil
        lastSwingTime = .distantPast
    }

    // MARK: - 加速度による動的更新

    /// MotionManager から毎フレーム呼ばれる。
    /// - 加速度に応じてハムの強度／鋭さを補間
    /// - 振り閾値を超えたら振りパターンを 1 発鳴らす（デバウンス付き）
    func updateMotion(accelerationMagnitude g: Double) {
        guard let weapon = equippedWeapon else { return }
        let normalized = Float(min(max(g, 0) / accelerationNormalizationCeiling, 1.0))

        if let player = humPlayer {
            let intensity = lerp(weapon.humIntensityAtRest, weapon.humIntensityAtMax, normalized)
            let sharpness = lerp(weapon.humSharpnessAtRest, weapon.humSharpnessAtMax, normalized)
            try? sendHumParameters(to: player, intensity: intensity, sharpness: sharpness)
        }

        if g >= weapon.swingThreshold {
            let now = Date()
            if now.timeIntervalSince(lastSwingTime) >= weapon.swingDebounce {
                lastSwingTime = now
                let span = max(accelerationNormalizationCeiling - weapon.swingThreshold, 0.0001)
                let boost = Float(min((g - weapon.swingThreshold) / span, 1.0))
                playSwing(weapon: weapon, boost: boost)
            }
        }
    }

    // MARK: - Helpers

    private func sendHumParameters(
        to player: CHHapticAdvancedPatternPlayer,
        intensity: Float,
        sharpness: Float
    ) throws {
        let intensityParam = CHHapticDynamicParameter(
            parameterID: .hapticIntensityControl,
            value: intensity,
            relativeTime: 0
        )
        let sharpnessParam = CHHapticDynamicParameter(
            parameterID: .hapticSharpnessControl,
            value: sharpness,
            relativeTime: 0
        )
        try player.sendParameters([intensityParam, sharpnessParam], atTime: CHHapticTimeImmediate)
    }

    private func playSwing(weapon: WeaponType, boost: Float) {
        guard let engine else { return }
        do {
            try engine.start()
            let pattern = try weapon.makeSwingPattern(boost: boost)
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            logger.error("Failed to play swing: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func lerp(_ a: Float, _ b: Float, _ t: Float) -> Float {
        a + (b - a) * t
    }
}
