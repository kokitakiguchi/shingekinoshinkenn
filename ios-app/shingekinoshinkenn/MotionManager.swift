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

    /// この端末でデバイスモーションが取得可能か（シミュレータは false）
    let isAvailable: Bool

    private let motion = CMMotionManager()

    init() {
        isAvailable = motion.isDeviceMotionAvailable
        motion.deviceMotionUpdateInterval = 1.0 / 60.0
    }

    /// モーション計測を開始する。
    /// - Parameter onUpdate: 毎フレーム呼ばれる加速度マグニチュード(g)。
    ///   ハプティクスの動的パラメータ更新・振り検出に使う想定。
    func start(onUpdate: @escaping @MainActor (Double) -> Void) {
        guard isAvailable, !motion.isDeviceMotionActive else { return }
        motion.startDeviceMotionUpdates(to: .main) { [weak self] data, _ in
            guard let data else { return }
            let a = data.userAcceleration
            let mag = (a.x * a.x + a.y * a.y + a.z * a.z).squareRoot()
            // `.main` キューで呼ばれるので、メインアクター上にいることを表明する。
            MainActor.assumeIsolated {
                self?.accelerationMagnitude = mag
                onUpdate(mag)
            }
        }
    }

    func stop() {
        motion.stopDeviceMotionUpdates()
        accelerationMagnitude = 0
    }
}
