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

import AVFoundation
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
    private var swingAudioResources: [WeaponType: CHHapticAudioResourceID] = [:]
    private let logger = Logger(subsystem: "shingekinoshinkenn", category: "Haptics")

    /// 加速度を 0..1 に正規化する基準（g）。これ以上は飽和扱い。
    private let accelerationNormalizationCeiling: Double = 2.5

    init() {
        supportsHaptics = CHHapticEngine.capabilitiesForHardware().supportsHaptics
        logger.notice("🪶 init: supportsHaptics=\(self.supportsHaptics, privacy: .public)（シミュレータでは常に false。実機で確認すること）")
        configureAudioSession()
        prepareEngine()
        registerWeaponAudio()
    }

    // MARK: - Engine lifecycle

    private func configureAudioSession() {
        // CHHapticEngine 経由の音声を再生できるようにカテゴリを設定する。
        // .playback だと消音スイッチに関係なく鳴る（武器デモなので可聴を優先）。
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            logger.error("Failed to configure audio session: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func prepareEngine() {
        guard supportsHaptics else {
            logger.notice("🪶 prepareEngine: ❌ supportsHaptics=false のためエンジンを生成しません")
            return
        }
        do {
            let engine = try CHHapticEngine()

            engine.resetHandler = { [weak self] in
                self?.logger.notice("🪶 ⚠️ engine reset → 再起動します")
                try? self?.engine?.start()
                self?.registerWeaponAudio() // リソース ID は再登録が要る
            }

            engine.stoppedHandler = { [weak self] reason in
                self?.logger.notice("🪶 ⚠️ engine stopped: reason=\(reason.rawValue, privacy: .public)")
            }

            try engine.start()
            self.engine = engine
            logger.notice("🪶 prepareEngine: ✅ エンジン起動成功")
        } catch {
            logger.error("🪶 prepareEngine: ❌ エンジン起動失敗: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// 各武器の音源を Bundle ルート直下の固定パスで参照し engine に登録、リソース ID をキャッシュする。
    private func registerWeaponAudio() {
        guard let engine else { return }
        swingAudioResources.removeAll()
        let bundleURL = Bundle.main.bundleURL
        for weapon in WeaponType.allCases {
            guard let filename = weapon.swingAudioFilename else { continue }
            let url = bundleURL.appendingPathComponent(filename)
            guard FileManager.default.fileExists(atPath: url.path) else {
                logger.error("Audio file missing at \(url.path, privacy: .public)")
                continue
            }
            do {
                let id = try engine.registerAudioResource(url, options: [:])
                swingAudioResources[weapon] = id
            } catch {
                logger.error("Failed to register audio for \(weapon.rawValue, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - 装備の切り替え

    /// 武器を装備し、常時ハムをループ再生し始める。
    func equip(_ weapon: WeaponType) {
        logger.notice("🪶 equip: \(weapon.rawValue, privacy: .public) を装備します")
        disengage() // 既存ハムを止める
        guard supportsHaptics, let engine else {
            logger.notice("🪶 equip: ⚠️ 非対応端末（supportsHaptics=\(self.supportsHaptics, privacy: .public)）のため状態のみ更新。振動は鳴りません")
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
            logger.notice("🪶 equip: ✅ ハム再生開始 intensityAtRest=\(weapon.humIntensityAtRest, privacy: .public) sharpnessAtRest=\(weapon.humSharpnessAtRest, privacy: .public)（静止時 intensity=0 の武器は無音。動かすと鳴ります）")
        } catch {
            logger.error("🪶 equip: ❌ 装備失敗: \(error.localizedDescription, privacy: .public)")
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
        guard let weapon = equippedWeapon else {
            // 未装備のまま加速度が来ている＝「構える」を押していない可能性
            logger.debug("🪶 updateMotion: 未装備のためスキップ g=\(g, privacy: .public)")
            return
        }
        let normalized = Float(min(max(g, 0) / accelerationNormalizationCeiling, 1.0))

        if let player = humPlayer {
            let intensity = lerp(weapon.humIntensityAtRest, weapon.humIntensityAtMax, normalized)
            let sharpness = lerp(weapon.humSharpnessAtRest, weapon.humSharpnessAtMax, normalized)
            try? sendHumParameters(to: player, intensity: intensity, sharpness: sharpness)
        } else {
            logger.debug("🪶 updateMotion: ⚠️ humPlayer が nil（ハム未再生）g=\(g, privacy: .public)")
        }

        if g >= weapon.swingThreshold {
            let now = Date()
            if now.timeIntervalSince(lastSwingTime) >= weapon.swingDebounce {
                lastSwingTime = now
                let span = max(accelerationNormalizationCeiling - weapon.swingThreshold, 0.0001)
                let boost = Float(min((g - weapon.swingThreshold) / span, 1.0))
                logger.notice("🪶 🎯 振り検出! g=\(String(format: "%.2f", g), privacy: .public) threshold=\(weapon.swingThreshold, privacy: .public) boost=\(String(format: "%.2f", boost), privacy: .public)")
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
            let pattern = try weapon.makeSwingPattern(
                boost: boost,
                audioResourceID: swingAudioResources[weapon]
            )
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
