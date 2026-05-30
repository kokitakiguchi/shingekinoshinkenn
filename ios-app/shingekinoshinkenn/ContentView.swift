//
//  ContentView.swift
//  shingekinoshinkenn
//
//  3 武器（ライトセーバー / 大剣 / 小剣）のハプティクスデモ：
//   - 装備すると武器ごとの常時ハムが再生される
//   - 端末を動かすと加速度に応じて唸りが変化
//   - 振り抜くと武器ごとのスパイクが走る
//

import SwiftUI

struct ContentView: View {
    @StateObject private var haptics = HapticManager()
    @StateObject private var motion = MotionManager()

    @State private var selectedWeapon: WeaponType = .lightsaber

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 6) {
                Text("真剣 — \(selectedWeapon.displayName)")
                    .font(.title.bold())
                Text("加速度で唸りが変化／振り抜くとスパイクが走ります")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            weaponPicker

            accelerationGauge

            equipButton

            if !haptics.supportsHaptics {
                Text("⚠️ この端末はハプティクスに対応していません。\n実機（iPhone）で実行してください。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
            if !motion.isAvailable {
                Text("⚠️ デバイスモーションが取得できません。実機で実行してください。")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
        .onDisappear {
            motion.stop()
            haptics.disengage()
        }
    }

    // MARK: - Subviews

    private var weaponPicker: some View {
        Picker("武器", selection: $selectedWeapon) {
            ForEach(WeaponType.allCases) { weapon in
                Text(weapon.displayName).tag(weapon)
            }
        }
        .pickerStyle(.segmented)
        .onChange(of: selectedWeapon) { _, newWeapon in
            // 構え中の切替は装備し直し、未構えなら表示だけ切替
            if haptics.equippedWeapon != nil {
                haptics.equip(newWeapon)
            }
        }
    }

    private var accelerationGauge: some View {
        let mag = motion.accelerationMagnitude
        let ratio = min(mag / 2.5, 1.0)
        let threshold = selectedWeapon.swingThreshold
        let isSwinging = mag >= threshold
        return VStack(spacing: 8) {
            Text(String(format: "加速度  %.2f g", mag))
                .font(.system(.title3, design: .monospaced))
                .foregroundStyle(isSwinging ? .red : .primary)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(.quaternary)
                    Capsule()
                        .fill(isSwinging ? Color.red : Color.accentColor)
                        .frame(width: geo.size.width * ratio)
                    // 振り検出ラインのマーカ（武器ごとに位置が変わる）
                    Rectangle()
                        .fill(.orange)
                        .frame(width: 2)
                        .offset(x: geo.size.width * (threshold / 2.5) - 1)
                }
            }
            .frame(height: 14)
            .animation(.linear(duration: 0.05), value: mag)
        }
    }

    private var equipButton: some View {
        Button {
            if haptics.equippedWeapon == nil {
                haptics.equip(selectedWeapon)
                motion.start { [weak haptics] g in
                    haptics?.updateMotion(accelerationMagnitude: g)
                }
            } else {
                motion.stop()
                haptics.disengage()
            }
        } label: {
            Label(
                haptics.equippedWeapon == nil ? "\(selectedWeapon.displayName)を構える" : "おさめる",
                systemImage: haptics.equippedWeapon == nil ? selectedWeapon.symbolName : "stop.fill"
            )
            .frame(maxWidth: .infinity)
            .padding()
        }
        .buttonStyle(.borderedProminent)
        .tint(haptics.equippedWeapon == nil ? .accentColor : .red)
        .disabled(!haptics.supportsHaptics)
        .opacity(haptics.supportsHaptics ? 1 : 0.4)
    }
}

#Preview {
    ContentView()
}
