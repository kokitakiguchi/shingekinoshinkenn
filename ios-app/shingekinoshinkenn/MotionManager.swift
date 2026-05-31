//
//  MotionManager.swift
//  shingekinoshinkenn
//
//  CoreMotion をラップし、`userAcceleration`（重力除外）のマグニチュード(g) を
//  60Hz で公開する。HapticManager がこれを購読してハム強度の動的更新と
//  振り検出に使う。
//

import Combine
import CoreMotion
import Foundation

@MainActor
final class MotionManager: ObservableObject {

    /// 現在の userAcceleration マグニチュード（単位: g）。UI 表示用。
    @Published private(set) var accelerationMagnitude: Double = 0

    /// 抜刀検出中に積分された変位の大きさ（m）。検出を始めると 0 から増えていく。
    /// `endDrawDetection()` または検出成立で 0 に戻る。
    @Published private(set) var drawDisplacement: Double = 0

    /// この端末でデバイスモーションが取得可能か（シミュレータは false）
    let isAvailable: Bool

    private let motion = CMMotionManager()
    private var onUpdate: (@MainActor (Double) -> Void)?

    // MARK: - 抜刀検出（変位積分）の状態
    //
    // userAcceleration（g, 重力除外）を 1 階積分して速度、2 階積分して位置を求める。
    // ・短い動作（数百ms）なので素朴な台形積分で十分。
    // ・装備中の微振動でドリフトしないよう、検出開始時に必ず 0 にリセットし、
    //   一定時間経っても抜けなければ再リセットする。
    private var drawVelocityX: Double = 0
    private var drawVelocityY: Double = 0
    private var drawVelocityZ: Double = 0
    private var drawPositionX: Double = 0
    private var drawPositionY: Double = 0
    private var drawPositionZ: Double = 0
    private var drawThreshold: Double = .infinity
    private var drawStartTimestamp: TimeInterval = 0
    private var drawLastTimestamp: TimeInterval = 0
    private var onDrawComplete: (@MainActor (Double) -> Void)?

    /// 抜けなかった場合に積分を強制リセットするまでの上限（秒）。
    private let drawResetWindow: TimeInterval = 4.0
    
    init() {
        isAvailable = motion.isDeviceMotionAvailable
        motion.deviceMotionUpdateInterval = 1.0 / 60.0
    }

    /// モーション計測を開始する。
    /// - Parameter onUpdate: 毎フレーム呼ばれる加速度マグニチュード(g)。
    ///   ハプティクスの動的パラメータ更新・振り検出に使う想定。
    func start(onUpdate: @escaping @MainActor (Double) -> Void) {
        self.onUpdate = onUpdate
        guard isAvailable, !motion.isDeviceMotionActive else { return }
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let self, let data else { return }
            let a = data.userAcceleration
            let mag = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot()
            let ts = data.timestamp
            // self 解放後にコールバックだけ呼ばれるケースは上の guard で弾く。
            // MainActor へは Task で確実に戻す（assumeIsolated は実行コンテキスト次第で未定義動作になり得る）。
            Task { @MainActor in
                self.accelerationMagnitude = mag
                self.onUpdate?(mag)
                self.updateDrawDetection(ax: a.x, ay: a.y, az: a.z, timestamp: ts)
            }
        }
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
        accelerationMagnitude = 0
        onUpdate = nil
        endDrawDetection()
    }

    // MARK: - 抜刀検出

    /// 抜刀検出を開始する。サーバから「構え完了」を受信した直後に呼ぶ想定。
    /// - Parameters:
    ///   - threshold: 抜刀とみなす移動量（m）。
    ///   - onComplete: 検出成立時に発火するコールバック（変位 m を渡す）。
    ///     発火後は自動で `endDrawDetection()` が呼ばれる。
    func beginDrawDetection(
        threshold: Double,
        onComplete: @escaping @MainActor (Double) -> Void
    ) {
        drawVelocityX = 0; drawVelocityY = 0; drawVelocityZ = 0
        drawPositionX = 0; drawPositionY = 0; drawPositionZ = 0
        drawDisplacement = 0
        drawThreshold = threshold
        drawStartTimestamp = 0
        drawLastTimestamp = 0
        onDrawComplete = onComplete
    }

    /// 抜刀検出を終了する。検出成立時は内部で呼ばれる。キャンセル時にも呼ぶ。
    func endDrawDetection() {
        onDrawComplete = nil
        drawVelocityX = 0; drawVelocityY = 0; drawVelocityZ = 0
        drawPositionX = 0; drawPositionY = 0; drawPositionZ = 0
        drawDisplacement = 0
        drawThreshold = .infinity
        drawStartTimestamp = 0
        drawLastTimestamp = 0
    }

    /// デバイスモーション 1 フレーム分の積分。検出中のみ走る。
    private func updateDrawDetection(ax: Double, ay: Double, az: Double, timestamp: TimeInterval) {
        guard let onComplete = onDrawComplete else { return }

        // 最初のフレームは dt が出せないので基準だけ取って抜ける。
        if drawStartTimestamp == 0 {
            drawStartTimestamp = timestamp
            drawLastTimestamp = timestamp
            return
        }

        let dt = timestamp - drawLastTimestamp
        drawLastTimestamp = timestamp
        // ガード：負の dt や大きな抜け（バックグラウンド復帰など）はスキップ。
        guard dt > 0, dt < 0.1 else { return }

        // userAcceleration は g 単位なので m/s² に変換して積分する。
        let g = 9.81
        drawVelocityX += ax * g * dt
        drawVelocityY += ay * g * dt
        drawVelocityZ += az * g * dt
        drawPositionX += drawVelocityX * dt
        drawPositionY += drawVelocityY * dt
        drawPositionZ += drawVelocityZ * dt

        let mag = (
            drawPositionX * drawPositionX +
            drawPositionY * drawPositionY +
            drawPositionZ * drawPositionZ
        ).squareRoot()
        drawDisplacement = mag

        if mag >= drawThreshold {
            onComplete(mag)
            endDrawDetection()
            return
        }

        // 長時間抜けない場合は積分ドリフトを切り捨てて、待機状態を保ったまま再スタートする。
        if timestamp - drawStartTimestamp > drawResetWindow {
            drawVelocityX = 0; drawVelocityY = 0; drawVelocityZ = 0
            drawPositionX = 0; drawPositionY = 0; drawPositionZ = 0
            drawDisplacement = 0
            drawStartTimestamp = timestamp
        }
    }
}
