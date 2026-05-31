//
//  PlayerSelectView.swift
//  shingekinoshinkenn
//
//  アプリ起動直後に表示するプレイヤー選択画面。
//  P1 / P2 ボタンを押すとバトル画面（ContentView）に遷移する。
//

import SwiftUI

struct PlayerSelectView: View {
    @State private var selectedPlayer: Int? = nil

    var body: some View {
        if let player = selectedPlayer {
            ContentView(playerNumber: player)
        } else {
            selectionView
        }
    }

    private var selectionView: some View {
        VStack(spacing: 48) {
            VStack(spacing: 10) {
                Text("真剣")
                    .font(.system(size: 52, weight: .black, design: .rounded))
                Text("プレイヤーを選択してください")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 28) {
                playerButton(number: 1, color: .blue)
                playerButton(number: 2, color: .red)
            }
        }
        .padding()
    }

    private func playerButton(number: Int, color: Color) -> some View {
        Button {
            selectedPlayer = number
        } label: {
            VStack(spacing: 14) {
                Image(systemName: "person.fill")
                    .font(.system(size: 52))
                Text("P\(number)")
                    .font(.system(size: 36, weight: .black, design: .rounded))
            }
            .frame(width: 148, height: 172)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 24))
            .overlay(
                RoundedRectangle(cornerRadius: 24)
                    .strokeBorder(color, lineWidth: 2)
            )
            .foregroundStyle(color)
        }
    }
}

#Preview {
    PlayerSelectView()
}
