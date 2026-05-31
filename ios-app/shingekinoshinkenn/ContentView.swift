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
    /// PlayerSelectView から渡されるプレイヤー番号（1 or 2）。
    let playerNumber: Int

    @StateObject private var haptics = HapticManager()
    @StateObject private var motion = MotionManager()
    @StateObject private var firestoreSender = FirestoreEventSender()
    @StateObject private var listener = FirestoreListener()

    @State private var selectedWeapon: WeaponType = .lightsaber
    @State private var isAwaitingDraw: Bool = false
    @State private var lastDrawnDistance: Double?

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 6) {
                Text("真剣 — \(selectedWeapon.displayName)")
                    .font(.title.bold())
                HStack(spacing: 6) {
                    Text("P\(playerNumber)")
                        .font(.subheadline.bold())
                        .foregroundStyle(playerNumber == 1 ? .blue : .red)
                    Text("·")
                        .foregroundStyle(.secondary)
                    Text(listener.connectionStatus)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            weaponPicker

            accelerationGauge

            equipButton

            drawFlowSection

            // 送信ステータス（小さく表示）
            Text(firestoreSender.state.message)
                .font(.caption)
                .foregroundStyle(firestoreSender.state.isSuccess ? Color.green : Color.secondary)

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
        .onAppear {
            listener.playerNumber = playerNumber
            listener.startListening()
            // ドキュメント記載の流れ：まずスマホから Firebase に書き込みを 1 発走らせて
            // presence を伝え、p{n}_ready を false にリセットする。
            // この送信のあと、Web 側が status="drawing" を返し、それを onChange で拾う。
            Task {
                await firestoreSender.sendDrawReady(playerNumber: playerNumber, value: false)
            }
        }
        .onDisappear {
            listener.stopListening()
            motion.endDrawDetection()
            motion.stop()
            haptics.disengage()
        }
        .onChange(of: selectedWeapon) { _, _ in
            // 抜刀待機中に武器を変えたら、安全のため待機を解除する。
            if isAwaitingDraw {
                cancelDrawWaiting()
            }
        }
        // Web が status="drawing" にしたら抜刀待機を自動開始する。
        // このタイミングで p{n}_weapon も更新されているため、武器の同期も先に行う。
        // 未装備でも自動で構えてから待機に入る（ユーザは「構える」ボタンを押さなくてよい）。
        .onChange(of: listener.isDrawingPhaseStarted) { _, started in
            guard started else { return }
            listener.consumeDrawingPhase()
            enterDrawWaitingFromServer()
        }
        // Web が p{n}_weapon を更新したら武器を同期する。
        .onChange(of: listener.weapon) { _, newWeapon in
            guard let w = newWeapon, w != selectedWeapon else { return }
            selectedWeapon = w
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
        let ceiling = 2.5
        let ratio = min(mag / ceiling, 1.0)
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
                        .offset(x: geo.size.width * (threshold / ceiling) - 1)
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

    // MARK: - 抜刀フロー
    //
    // Firestore（shinken_rooms/battle）を 1 秒ポーリングし、
    // Web 側（はる）が p{n}_ready = true を書いた瞬間に自動で抜刀待機を開始する。
    // 引き抜きの移動量がしきい値を超えたら振動 + p{n}_vibrate=true を Firestore に送信。

    private var drawFlowSection: some View {
        VStack(spacing: 12) {
            phaseBadge

            if isAwaitingDraw {
                drawWaitingView
            } else if haptics.isSwingPhaseActive {
                if let dist = lastDrawnDistance {
                    drawCompletedBanner(distance: dist)
                }
            } else {
                // status="drawing" 受信を待機中（未装備でも OK：受信時に自動装備する）。
                VStack(spacing: 10) {
                    Label("Web の status=drawing を待機中...",
                          systemImage: "antenna.radiowaves.left.and.right")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text("（Web 側で両者の武器が確定すると自動で抜刀待機が始まります）")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    manualDrawFallbackButton
                }
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.7), value: lastDrawnDistance != nil)
    }

    /// 「構え中 / 抜刀待機中 / 抜刀完了・振り可能」を常時表示するフェーズ表示。
    /// どの段階にいるか・加速度連動の振動がオンかオフかが一目でわかるようにする。
    private var phaseBadge: some View {
        let (text, systemImage, color): (String, String, Color) = {
            if haptics.equippedWeapon == nil {
                return ("未装備", "minus.circle", .secondary)
            } else if isAwaitingDraw {
                return ("抜刀待機中（振動オフ）", "hourglass", .orange)
            } else if haptics.isSwingPhaseActive {
                return ("抜刀完了・振り可能", "checkmark.seal.fill", .green)
            } else {
                return ("構え中（抜刀待ち）", "hand.raised.fill", .blue)
            }
        }()
        return Label(text, systemImage: systemImage)
            .font(.footnote.bold())
            .foregroundStyle(color)
            .padding(.vertical, 6)
            .padding(.horizontal, 12)
            .background(color.opacity(0.12), in: Capsule())
    }

    /// 抜刀完了を大きく表示するバナー。`おさめる` まで残り続けるので、
    /// 抜刀できたかどうかをひと目で判別できる。
    /// フィードバック.md の課題「抜刀成功時の達成感がやや弱い」に対応するため、
    /// アイコン・タイトル・パディングを一段大きくして存在感を強める。
    private func drawCompletedBanner(distance: Double) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 64, weight: .bold))
                .foregroundStyle(.green)
                .shadow(color: .green.opacity(0.5), radius: 8)

            Text("抜刀完了！")
                .font(.largeTitle.bold())
                .foregroundStyle(.green)

            Text(String(format: "移動量 %.2f m", distance))
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(.primary)

            Text("⚔️ 振りフェーズ開始")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(Color.green.opacity(0.15))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(Color.green.opacity(0.55), lineWidth: 2)
        )
        .transition(.scale.combined(with: .opacity))
    }

    private var drawWaitingView: some View {
        let threshold = (haptics.equippedWeapon ?? selectedWeapon).drawDisplacementThreshold
        let displacement = motion.drawDisplacement
        let ratio = min(displacement / threshold, 1.0)
        return VStack(spacing: 6) {
            Text("抜刀してください")
                .font(.headline)
            Text(String(format: "移動量 %.2f / %.2f m", displacement, threshold))
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule().fill(Color.green).frame(width: geo.size.width * ratio)
                }
            }
            .frame(height: 10)
            .animation(.linear(duration: 0.05), value: displacement)
            Button("キャンセル", role: .cancel) {
                cancelDrawWaiting()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    /// 通信が来ない場合のフォールバック。Web の status=drawing を待たず、
    /// 現在選択中の武器で構え→抜刀待機までを手動で進める。
    private var manualDrawFallbackButton: some View {
        Button {
            startManualDrawWaiting()
        } label: {
            Label("通信不通の時：手動で抜刀開始", systemImage: "hand.tap.fill")
                .font(.footnote.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.bordered)
        .tint(.orange)
    }

    /// Web から status="drawing" を受け取った時の処理。未装備なら自動装備してから
    /// 抜刀待機に入る。武器が変わっていれば装備し直す。
    private func enterDrawWaitingFromServer() {
        let weapon = listener.weapon ?? selectedWeapon
        if weapon != selectedWeapon { selectedWeapon = weapon }
        ensureEquipped(weapon: weapon)
        beginDrawWaiting()
    }

    /// 手動フォールバック：通信に頼らず、選択中の武器で抜刀待機に入る。
    private func startManualDrawWaiting() {
        let weapon = selectedWeapon
        ensureEquipped(weapon: weapon)
        beginDrawWaiting()
    }

    /// 指定の武器で装備状態を整える。未装備なら新規装備、別武器なら装備し直し。
    private func ensureEquipped(weapon: WeaponType) {
        if haptics.equippedWeapon == nil {
            haptics.equip(weapon)
            motion.start { [weak haptics] g in
                haptics?.updateMotion(accelerationMagnitude: g)
            }
        } else if haptics.equippedWeapon != weapon {
            haptics.equip(weapon)
        }
    }

    private func beginDrawWaiting() {
        guard let weapon = haptics.equippedWeapon else { return }
        lastDrawnDistance = nil
        isAwaitingDraw = true

        // 抜く段階では加速度連動の振り検出を止める
        haptics.deactivateSwingPhase()
        // 構え完了 → ライトセーバの本格的なハムをここで立ち上げる
        haptics.markStanceComplete()

        motion.beginDrawDetection(threshold: weapon.drawDisplacementThreshold) { displacement in
            handleDrawDetected(weapon: weapon, displacement: displacement)
        }
    }

    private func cancelDrawWaiting() {
        motion.endDrawDetection()
        haptics.deactivateSwingPhase()
        // 構え完了を取り消し → ライトセーバを再び無音に戻す
        haptics.resetStanceComplete()
        isAwaitingDraw = false
    }

    private func handleDrawDetected(weapon: WeaponType, displacement: Double) {
        // 抜刀完了の振動
        haptics.playDraw(weapon: weapon)

        // 抜刀が完了したら振りフェーズを開始
        haptics.activateSwingPhase()

        isAwaitingDraw = false
        lastDrawnDistance = displacement

        // shinken_rooms/battle の p{n}_ready=true を送信。
        // Web はこれを onSnapshot で受け取り、両者揃ったらバトル開始する。
        Task {
            await firestoreSender.sendDrawReady(playerNumber: playerNumber)
        }
    }
}

#Preview {
    ContentView(playerNumber: 1)
}
