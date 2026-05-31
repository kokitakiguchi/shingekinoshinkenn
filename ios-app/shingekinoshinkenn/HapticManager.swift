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

    /// 振りフェーズ（抜刀完了後）かどうか。`true` の間だけ加速度由来の処理
    /// （ハム強度の動的更新 + 振り検出）を行う。
    /// 「構える → 抜く → 振る」の順なので、equip 直後と抜刀待機中はいずれも
    /// `false` のままで、加速度連動の振動は走らない（ハムは静止値で再生のみ継続）。
    @Published private(set) var isSwingPhaseActive: Bool = false

    /// 「構え完了」通知を受け取り済みかどうか。ライトセーバはここまで本格的なハムを
    /// 立ち上げない（無音）。greatsword/smallsword は equip 直後から静止値で鳴っているので
    /// このフラグの影響は受けない。
    @Published private(set) var isStanceComplete: Bool = false

    private var engine: CHHapticEngine?
    private var humPlayer: CHHapticAdvancedPatternPlayer?
    private var lastSwingTime: Date = .distantPast
    /// 振り検出の「武装」状態。true のときだけ次の振りを発火できる。
    /// 発火すると false になり、加速度が swingReleaseThreshold を下回ると true に戻る。
    /// これで「1 振り＝1 発火」を保証する（ヒステリシス／エッジ検出）。
    private var isSwingArmed: Bool = true
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
            // 構え直後はライトセーバを無音にしておき、構え完了の通知が来てから本格的な
            // ハムを立ち上げる（markStanceComplete で intensity を at-rest に持ち上げる）。
            try sendHumParameters(
                to: player,
                intensity: preStanceIntensity(for: weapon),
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
        isSwingArmed = true
        isSwingPhaseActive = false
        isStanceComplete = false
    }

    /// 構え直後のハム強度。ライトセーバは無音、それ以外は静止値で鳴らす。
    private func preStanceIntensity(for weapon: WeaponType) -> Float {
        weapon == .lightsaber ? 0 : weapon.humIntensityAtRest
    }

    // MARK: - 構えフェーズ制御

    /// サーバ（今はボタン）から「構え完了」を受け取った瞬間に呼ぶ。
    /// ライトセーバの本格的なハムはこのタイミングで立ち上がる。
    func markStanceComplete() {
        isStanceComplete = true
        guard let player = humPlayer, let weapon = equippedWeapon else { return }
        try? sendHumParameters(
            to: player,
            intensity: weapon.humIntensityAtRest,
            sharpness: weapon.humSharpnessAtRest
        )
        logger.notice("🪶 🙌 構え完了 — ハムを at-rest に立ち上げ")
    }

    /// 抜刀待機をキャンセルしたときなどに呼ぶ。ライトセーバは再び無音に戻る。
    func resetStanceComplete() {
        isStanceComplete = false
        guard let player = humPlayer, let weapon = equippedWeapon else { return }
        try? sendHumParameters(
            to: player,
            intensity: preStanceIntensity(for: weapon),
            sharpness: weapon.humSharpnessAtRest
        )
        logger.notice("🪶 ↩️ 構え完了リセット — ハムを構え直後の値に戻す")
    }

    // MARK: - 振りフェーズ制御

    /// 抜刀完了後に呼ぶ。これ以降、加速度連動のハム更新と振り検出が有効になる。
    /// 抜刀直後の余韻で勝手にスイング判定が走らないよう、再武装は g が落ちるまで待たせる。
    func activateSwingPhase() {
        isSwingPhaseActive = true
        isSwingArmed = false
        lastSwingTime = Date()
        logger.notice("🪶 ⚔️ 振りフェーズ ON — 加速度連動のハム/振り検出を有効化")
    }

    /// 振りフェーズを明示的に止めたいときに呼ぶ（テストや UI からのリセット用）。
    func deactivateSwingPhase() {
        guard isSwingPhaseActive else { return }
        isSwingPhaseActive = false
        logger.notice("🪶 ⚔️ 振りフェーズ OFF")
    }

    /// 抜刀完了の振動を 1 発鳴らす。剣の振り（`playSwing`）とは構造が違う
    /// 「弱→強→余韻」パターン（フィードバック.md Level 2）に、登録済みの音源を
    /// 同期再生（Level 3）して達成感を強めている。
    func playDraw(weapon: WeaponType) {
        guard supportsHaptics, let engine else {
            logger.notice("🪶 playDraw: ⚠️ 非対応端末のためスキップ")
            return
        }
        do {
            try engine.start()
            let pattern = try weapon.makeDrawPattern(
                audioResourceID: swingAudioResources[weapon]
            )
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
            logger.notice("🪶 🗡️ 抜刀振動: \(weapon.rawValue, privacy: .public)")
        } catch {
            logger.error("🪶 playDraw: ❌ \(error.localizedDescription, privacy: .public)")
        }
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

        // 「構える → 抜く → 振る」の順なので、抜刀完了で振りフェーズが有効になるまで
        // 加速度連動の処理（ハム強度の動的更新、振り検出）はいっさい走らせない。
        // ハム自体は equip 時に静止値で再生済みなので、無音や単調な低唸りのまま続く。
        guard isSwingPhaseActive else { return }

        let normalized = Float(min(max(g, 0) / accelerationNormalizationCeiling, 1.0))

        if let player = humPlayer {
            let intensity = lerp(weapon.humIntensityAtRest, weapon.humIntensityAtMax, normalized)
            let sharpness = lerp(weapon.humSharpnessAtRest, weapon.humSharpnessAtMax, normalized)
            try? sendHumParameters(to: player, intensity: intensity, sharpness: sharpness)
        } else {
            logger.debug("🪶 updateMotion: ⚠️ humPlayer が nil（ハム未再生）g=\(g, privacy: .public)")
        }

        // 振り検出：エッジ検出 + ヒステリシス。
        // - 武装中(isSwingArmed)に g が swingThreshold を上抜けした「立ち上がり」で 1 回だけ発火。
        // - 発火後は武装解除し、g が swingReleaseThreshold を下回るまで再発火しない。
        //   → 1 振りで g がしきい値付近を上下しても、また上回り続けても、鳴るのは 1 回だけ。
        // - swingDebounce は最短間隔の保険（解除が速すぎる場合の連打防止）。
        if isSwingArmed {
            // しきい値を超えたフレームだけ Date() を生成する（60Hz の無駄な割り当て回避）。
            if g >= weapon.swingThreshold {
                let now = Date()
                if now.timeIntervalSince(lastSwingTime) >= weapon.swingDebounce {
                    isSwingArmed = false // 立ち上がりで発火 → 解除されるまで武装解除
                    lastSwingTime = now
                    let span = max(accelerationNormalizationCeiling - weapon.swingThreshold, 0.0001)
                    let boost = Float(min((g - weapon.swingThreshold) / span, 1.0))
                    logger.notice("🪶 🎯 振り検出! g=\(String(format: "%.2f", g), privacy: .public) threshold=\(weapon.swingThreshold, privacy: .public) boost=\(String(format: "%.2f", boost), privacy: .public)")
                    playSwing(weapon: weapon, boost: boost)
                }
            }
        } else if g < weapon.swingReleaseThreshold {
            // 加速度が十分落ちた＝振り終わり。次の振りに備えて再武装する。
            isSwingArmed = true
            logger.debug("🪶 ↩️ 再武装 g=\(String(format: "%.2f", g), privacy: .public) < release=\(weapon.swingReleaseThreshold, privacy: .public)")
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
