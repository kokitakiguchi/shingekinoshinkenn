// ── Firebase Web SDK (v10) のインポート ──
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, onSnapshot, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ── Firebase 初期化設定 ──
const firebaseConfig = {
  apiKey: "AIzaSyCkW3UAnb8jRF8VJggYD69Apyb8GZYY7LY",
  authDomain: "momotake-2f30b.firebaseapp.com",
  projectId: "momotake-2f30b",
  storageBucket: "momotake-2f30b.firebasestorage.app",
  messagingSenderId: "321614595316",
  appId: "1:321614595316:web:5bd921f114eb8f4c58caa1"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ── HTML要素の取得 ──
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas'); // output_canvasに統一
const ctx = canvasElement.getContext('2d');
const setupOverlay = document.getElementById('setup-overlay');
const startBtn = document.getElementById('start-btn');
const setupStatus = document.getElementById('setup-status');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

const p1ScoreEl = document.getElementById('p1-score');
const p2ScoreEl = document.getElementById('p2-score');
const timerEl = document.getElementById('game-timer');
const phaseTitleEl = document.getElementById('game-phase-title');

const p1RegStatusEl = document.getElementById('p1-reg-status');
const p2RegStatusEl = document.getElementById('p2-reg-status');

const p1Card = document.getElementById('p1-card');
const p2Card = document.getElementById('p2-card');
const p1Flash = document.getElementById('p1-flash');
const p2Flash = document.getElementById('p2-flash');

// ── ゲーム状態管理 ──
let gameStatus = "selecting";
let timeRemaining = 90;
let timerInterval = null;
let poseEngine = null; // Official MediaPipe Pose インスタンス
let cameraEngine = null; // Official MediaPipe Camera インスタンス
let isDetecting = false;

let p1Score = 0;
let p2Score = 0;

const COOLDOWN_MS = 300;

const playersState = {
  player1: { prevLeftWristY: null, prevRightWristY: null, lastSwingTime: 0 },
  player2: { prevLeftWristY: null, prevRightWristY: null, lastSwingTime: 0 }
};

// ── 💡 猶予時間（グレースピリオド）と滑らかな累積・減衰に対応したステート ──
const selectionState = {
  player1: { locked: false, selectedWeapon: null, detectingWeapon: null, lastActiveTime: 0, accumulatedTime: 0, progress: 0, lostStartTime: 0 },
  player2: { locked: false, selectedWeapon: null, detectingWeapon: null, lastActiveTime: 0, accumulatedTime: 0, progress: 0, lostStartTime: 0 }
};

// MediaPipe Pose 33点 接続ライン
const SKELETON_CONNECTIONS = [
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  [11, 23], [12, 24],
  [23, 24],
  [23, 25], [25, 27],
  [24, 26], [26, 28]
];

// ── 💡 武器選択用の固定ターゲット座標と半径の定義 ──
const TARGET_RADIUS = 55; // 基本のターゲット円の半径 (55px)
const KEEP_RADIUS = 95;   // キープ中の許容半径 (95px) - 吸い付き境界シールド

const TARGETS = {
  player1: {
    greatsword: { x: 100, y: 70 },   // 大剣 (左右上部)
    katana: { x: 100, y: 220 },      // 刀 (左右下部)
    lightsaber: { x: 100, y: 145 }   // セーバー (左右中央)
  },
  player2: {
    greatsword: { x: 300, y: 70 },
    katana: { x: 300, y: 220 },
    lightsaber: { x: 300, y: 145 }
  }
};

// ── 直線距離計算 ──
function getDistance(kp1, kp2) {
  try {
    if (!kp1 || !kp2 || kp1.score < 0.15 || kp2.score < 0.15) return Infinity;
    return Math.hypot(kp1.x - kp2.x, kp1.y - kp2.y);
  } catch (e) {
    return Infinity;
  }
}

// ── ベクトル内積角度（度数法）算出 ──
function getAngle(p1, p2, p3) {
  try {
    if (!p1 || !p2 || !p3 || p1.score < 0.15 || p2.score < 0.15 || p3.score < 0.15) return 180;
    const v1 = { x: p1.x - p2.x, y: p1.y - p2.y };
    const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const mag1 = Math.hypot(v1.x, v1.y);
    const mag2 = Math.hypot(v2.x, v2.y);
    if (mag1 === 0 || mag2 === 0) return 180;
    const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    return Math.acos(cosTheta) * (180 / Math.PI);
  } catch (e) {
    return 180;
  }
}

// ── フェーズに応じたUI更新 ──
function updatePhaseUI() {
  try {
    if (gameStatus === "selecting") {
      phaseTitleEl.textContent = "フェーズ：武器選択中（1.5秒キープ）";
      statusText.textContent = "カメラの前で大剣/刀/ライトセーバーの構えを取ってください！";
    } else if (gameStatus === "drawing") {
      phaseTitleEl.textContent = "フェーズ：抜刀待機中（スマホ検知待ち）";
      statusText.textContent = "スマホを持って一気に抜刀アクションを実行してください！";
    } else if (gameStatus === "playing") {
      phaseTitleEl.textContent = "フェーズ：試合中（斬撃バトル中！）";
      statusText.textContent = "手を上から下に振り下ろして、斬撃を叩き込め！";
    } else if (gameStatus === "finished") {
      phaseTitleEl.textContent = "対戦終了！";
      statusText.textContent = "試合終了！お疲れ様でした！";
    }
  } catch (e) {
    console.log("updatePhaseUI エラー:", e);
  }
}

// ── タイマー制御 ──
function startTimer() {
  try {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (timeRemaining > 0) {
        timeRemaining--;
        timerEl.textContent = timeRemaining;
      } else {
        clearInterval(timerInterval);
        gameStatus = "finished";
        updatePhaseUI();
        updateFirestoreGameStatus("finished");
        isDetecting = false;
      }
    }, 1000);
  } catch (e) {
    console.log("startTimer エラー:", e);
  }
}

async function updateFirestoreGameStatus(status) {
  try {
    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, { status: status, match_status: status }, { merge: true });
  } catch (e) {
    console.error("Firestore status更新エラー:", e);
  }
}

// ── バトル開始（playingへ移行） ──
async function startMatch() {
  try {
    gameStatus = "playing";
    timeRemaining = 90;
    timerEl.textContent = timeRemaining;
    p1Score = 0;
    p2Score = 0;
    p1ScoreEl.textContent = 0;
    p2ScoreEl.textContent = 0;

    updatePhaseUI();

    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, {
      status: "playing",
      match_status: "playing",
      player1_score: 0,
      player2_score: 0,
      player1_weapon: selectionState.player1.selectedWeapon,
      player2_weapon: selectionState.player2.selectedWeapon,
      p1_vibrate: false,
      p2_vibrate: false
    }, { merge: true });

    startTimer();
  } catch (e) {
    console.error("startMatch エラー:", e);
  }
}

// ── スイング検知・送信 ──
async function handleSwing(playerKey) {
  try {
    const now = Date.now();
    const state = playersState[playerKey];

    if (now - state.lastSwingTime < COOLDOWN_MS) return;
    state.lastSwingTime = now;

    if (playerKey === 'player1') {
      p1Score++;
      animateScore(p1ScoreEl, p1Card, p1Flash, 'flash-cyan');
    } else {
      p2Score++;
      animateScore(p2ScoreEl, p2Card, p2Flash, 'flash-magenta');
    }

    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, {
      [`${playerKey === 'player1' ? 'player1_score' : 'player2_score'}`]: increment(1)
    }, { merge: true });
  } catch (e) {
    console.error("Firestoreスコア送信エラー:", e);
  }
}

function animateScore(scoreEl, cardEl, flashEl, flashClass) {
  try {
    scoreEl.textContent = cardEl.classList.contains('p1') ? p1Score : p2Score;
    scoreEl.classList.remove('pop-animation');
    void scoreEl.offsetWidth; // リフロー
    scoreEl.classList.add('pop-animation');

    cardEl.classList.add('active');
    setTimeout(() => cardEl.classList.remove('active'), 200);

    flashEl.classList.remove(flashClass);
    void flashEl.offsetWidth;
    flashEl.classList.add(flashClass);
  } catch (e) {
    console.log("animateScore エラー:", e);
  }
}

// ── 【極限吸い付き判定】減衰付き時間累積方式 ＆ 境界シールド（ヒステリシス）判定 ──
function handleWeaponSelection(pose, playerKey, regStatusEl, cardEl) {
  try {
    const sel = selectionState[playerKey];
    if (sel.locked) return;

    const leftShoulder = pose.keypoints[11];
    const rightShoulder = pose.keypoints[12];
    const leftWrist = pose.keypoints[15];
    const rightWrist = pose.keypoints[16];
    const nose = pose.keypoints[0];

    // 肩の見切れに完全対応した、鼻・手首連携プレイヤー特定フォールバック (スコア基準を 0.15 に引き下げ)
    let poseCenterX = 200;
    if (leftShoulder && rightShoulder && leftShoulder.score > 0.15 && rightShoulder.score > 0.15) {
      poseCenterX = (leftShoulder.x + rightShoulder.x) / 2;
    } else if (nose && nose.score > 0.15) {
      poseCenterX = nose.x;
    } else if (leftWrist && leftWrist.score > 0.15) {
      poseCenterX = leftWrist.x;
    } else if (rightWrist && rightWrist.score > 0.15) {
      poseCenterX = rightWrist.x;
    }

    const isP1 = poseCenterX < 200;

    // 当該プレイヤーに割り当てられた固定ターゲット座標を参照
    const t = isP1 ? TARGETS.player1 : TARGETS.player2;

    // 現在吸い付き中の武器かどうかに応じて、判定半径を動的に決定（境界シールド）
    const getRadius = (weaponKey) => {
      return (sel.detectingWeapon === weaponKey) ? KEEP_RADIUS : TARGET_RADIUS;
    };

    let currentPoseDetecting = null;
    let debugTargetKp = null;
    let debugWristKp = null;
    let debugWristKp2 = null;

    // ── 1. 【ライトセーバー（中）】 ──
    const lsRadius = getRadius("lightsaber");
    if (rightWrist && leftWrist && rightWrist.score > 0.15 && leftWrist.score > 0.15) {
      const rDist = Math.hypot(rightWrist.x - t.lightsaber.x, rightWrist.y - t.lightsaber.y);
      const lDist = Math.hypot(leftWrist.x - t.lightsaber.x, leftWrist.y - t.lightsaber.y);
      if (rDist <= lsRadius && lDist <= lsRadius) {
        currentPoseDetecting = "lightsaber";
        debugWristKp = rightWrist;
        debugWristKp2 = leftWrist;
        debugTargetKp = t.lightsaber;
      }
    }

    // ── 2. 【大剣（上）】 ──
    const gsRadius = getRadius("greatsword");
    if (!currentPoseDetecting) {
      if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.greatsword.x, rightWrist.y - t.greatsword.y) <= gsRadius) {
        currentPoseDetecting = "greatsword";
        debugWristKp = rightWrist;
        debugTargetKp = t.greatsword;
      } else if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.greatsword.x, leftWrist.y - t.greatsword.y) <= gsRadius) {
        currentPoseDetecting = "greatsword";
        debugWristKp = leftWrist;
        debugTargetKp = t.greatsword;
      }
    }

    // ── 3. 【刀（下）】 ──
    const ktRadius = getRadius("sword");
    if (!currentPoseDetecting) {
      if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.katana.x, rightWrist.y - t.katana.y) <= ktRadius) {
        currentPoseDetecting = "sword";
        debugWristKp = rightWrist;
        debugTargetKp = t.katana;
      } else if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.katana.x, leftWrist.y - t.katana.y) <= ktRadius) {
        currentPoseDetecting = "sword";
        debugWristKp = leftWrist;
        debugTargetKp = t.katana;
      }
    }

    const weaponNames = { sword: "刀", greatsword: "大剣", lightsaber: "ライトセーバー" };

    if (currentPoseDetecting) {
      const weaponNameJP = weaponNames[currentPoseDetecting];

      // 的に入っているため、外れた際の猶予タイマーをリセット
      sel.lostStartTime = 0;

      if (sel.detectingWeapon === currentPoseDetecting) {
        // 検知継続：時間経過分を加算 (1.5秒 = 1500ms で確実に100%確定へ)
        const now = Date.now();
        const dt = now - sel.lastActiveTime;
        sel.lastActiveTime = now;

        sel.accumulatedTime = Math.min(1500, (sel.accumulatedTime || 0) + dt);
        sel.progress = Math.min(100, Math.floor((sel.accumulatedTime / 1500) * 100));

        regStatusEl.textContent = `${weaponNameJP}の構え... (${sel.progress}%)`;
        regStatusEl.className = "reg-status detecting";

        // ガイドラインの描画
        if (debugWristKp && debugTargetKp) {
          ctx.beginPath();
          ctx.moveTo(debugWristKp.x, debugWristKp.y);
          ctx.lineTo(debugTargetKp.x, debugTargetKp.y);
          if (debugWristKp2) {
            ctx.moveTo(debugWristKp2.x, debugWristKp2.y);
            ctx.lineTo(debugTargetKp.x, debugTargetKp.y);
          }
          ctx.strokeStyle = '#ffdd59';
          ctx.lineWidth = 3;
          ctx.stroke();
        }

        if (sel.accumulatedTime >= 1500) {
          sel.locked = true;
          sel.selectedWeapon = currentPoseDetecting;
          sel.progress = 100;
          regStatusEl.textContent = `確定！[${weaponNameJP}]`;
          regStatusEl.className = "reg-status ready";
          cardEl.classList.add('ready');

          if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
          checkAllWeaponsSelected();
        }
      } else {
        // 新規検知：開始
        sel.detectingWeapon = currentPoseDetecting;
        sel.lastActiveTime = Date.now();
        sel.accumulatedTime = sel.accumulatedTime || 0; // 途中減衰値から引き継ぎ
        sel.progress = Math.min(100, Math.floor((sel.accumulatedTime / 1500) * 100));
        
        regStatusEl.textContent = `${weaponNameJP}の構え... (${sel.progress}%)`;
        regStatusEl.className = "reg-status detecting";
      }
    } else {
      // ターゲットから外れた：猶予時間（グレースピリオド）と滑らかなデクリメント
      const now = Date.now();
      
      if (!sel.lostStartTime) {
        sel.lostStartTime = now; // 最初にはずれた時刻を記録
      }

      const elapsedLost = now - sel.lostStartTime;
      const dt = sel.lastActiveTime ? (now - sel.lastActiveTime) : 0;
      sel.lastActiveTime = now;

      // 💡 超重要：外れてから 500ms（0.5秒）以内は、進捗を一切減らさず完璧にキープ！
      if (elapsedLost > 500) {
        // 0.5秒を過ぎたら、1フレームあたり通常の 0.3 倍の速度でゆっくり減衰させる
        sel.accumulatedTime = Math.max(0, (sel.accumulatedTime || 0) - dt * 0.3);
      }
      
      sel.progress = Math.min(100, Math.floor((sel.accumulatedTime / 1500) * 100));

      if (sel.accumulatedTime > 0 && sel.detectingWeapon) {
        const weaponNameJP = weaponNames[sel.detectingWeapon];
        regStatusEl.textContent = `${weaponNameJP}の構え... (${sel.progress}%)`;
        regStatusEl.className = "reg-status detecting";
      } else {
        sel.detectingWeapon = null;
        sel.progress = 0;
        sel.lostStartTime = 0;
        regStatusEl.textContent = "武器の構えを取ってください (大剣/刀/セーバー)";
        regStatusEl.className = "reg-status";
      }
    }
  } catch (err) {
    console.log("handleWeaponSelection エラー:", err);
  }
}

async function checkAllWeaponsSelected() {
  try {
    if (selectionState.player1.locked && selectionState.player2.locked) {
      statusText.textContent = "武器確定！抜刀準備をしてください！";
      
      setTimeout(async () => {
        gameStatus = "drawing";
        updatePhaseUI();
        
        p1RegStatusEl.textContent = "スマホ側抜刀待ち...";
        p1RegStatusEl.className = "reg-status detecting";
        p2RegStatusEl.textContent = "スマホ側抜刀待ち...";
        p2RegStatusEl.className = "reg-status detecting";

        p1Card.classList.remove('ready');
        p2Card.classList.remove('ready');

        const battleDocRef = doc(db, "shinken_rooms", "battle");
        await setDoc(battleDocRef, {
          status: "drawing",
          match_status: "drawing",
          p1_weapon: selectionState.player1.selectedWeapon,
          p2_weapon: selectionState.player2.selectedWeapon,
          p1_ready: false,
          p2_ready: false
        }, { merge: true });
      }, 1500);
    }
  } catch (e) {
    console.log("checkAllWeaponsSelected エラー:", e);
  }
}

// ── 【ステップ3：バトルフェーズのスイング判定】 ──
function processMovementLogics(pose, playerKey) {
  try {
    const state = playersState[playerKey];
    const leftWrist = pose.keypoints[15];
    const rightWrist = pose.keypoints[16];

    const currentLeftWristY = (leftWrist && leftWrist.score > 0.15) ? leftWrist.y : null;
    const currentRightWristY = (rightWrist && rightWrist.score > 0.15) ? rightWrist.y : null;

    let maxNormalizedDY = 0;

    if (state.prevLeftWristY !== null && currentLeftWristY !== null) {
      const dyLeft = (currentLeftWristY - state.prevLeftWristY) / 300;
      if (dyLeft > maxNormalizedDY) maxNormalizedDY = dyLeft;
    }

    if (state.prevRightWristY !== null && currentRightWristY !== null) {
      const dyRight = (currentRightWristY - state.prevRightWristY) / 300;
      if (dyRight > maxNormalizedDY) maxNormalizedDY = dyRight;
    }

    if (maxNormalizedDY > 0.09) {
      handleSwing(playerKey);
    }

    if (currentLeftWristY !== null) state.prevLeftWristY = currentLeftWristY;
    if (currentRightWristY !== null) state.prevRightWristY = currentRightWristY;
  } catch (e) {
    console.log("processMovementLogics エラー:", e);
  }
}

// ── 骨格＆デバッグ用の的（サークル）描画メイン ──
// ⚠️ 骨格の有無やエラーにかかわらず、固定のデバッグ円を「絶対に強制描画」
function drawSkeleton(poses) {
  try {
    // 描画エリアの完全クリーン
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    ctx.save();
    ctx.translate(canvasElement.width, 0);
    ctx.scale(-1, 1); // 鏡像変換

    // ── 🎯 【最優先】骨格ロスト時でも「的（ガイド円）」を絶対に強制描画 ──
    if (gameStatus === "selecting") {
      let p1GS_Active = false;
      let p1KT_Active = false;
      let p1LS_Active = false;

      let p2GS_Active = false;
      let p2KT_Active = false;
      let p2LS_Active = false;

      // 骨格が1つでも検知されている場合のみ当たり判定を行い、的の点灯色を更新
      if (poses && poses.length > 0) {
        poses.forEach((pose) => {
          if (pose.score < 0.15) return; // 判定閾値を 0.15 に引き下げ
          try {
            const leftShoulder = pose.keypoints[11];
            const rightShoulder = pose.keypoints[12];
            const leftWrist = pose.keypoints[15];
            const rightWrist = pose.keypoints[16];
            const nose = pose.keypoints[0];

            let poseCenterX = 200;
            if (leftShoulder && rightShoulder && leftShoulder.score > 0.15 && rightShoulder.score > 0.15) {
              poseCenterX = (leftShoulder.x + rightShoulder.x) / 2;
            } else if (nose && nose.score > 0.15) {
              poseCenterX = nose.x;
            } else if (leftWrist && leftWrist.score > 0.15) {
              poseCenterX = leftWrist.x;
            } else if (rightWrist && rightWrist.score > 0.15) {
              poseCenterX = rightWrist.x;
            }

            const isP1 = poseCenterX < 200;
            const selState = isP1 ? selectionState.player1 : selectionState.player2;

            // 吸い付き中は的の円を大きくするヒステリシス半径
            const getDrawRadius = (wKey) => {
              return (selState.detectingWeapon === wKey) ? KEEP_RADIUS : TARGET_RADIUS;
            };

            if (isP1) {
              const t = TARGETS.player1;
              const lsRad = getDrawRadius("lightsaber");
              const gsRad = getDrawRadius("greatsword");
              const ktRad = getDrawRadius("sword");

              // ライトセーバー（両手首が的の中、スコア 0.15）
              if (rightWrist && leftWrist && rightWrist.score > 0.15 && leftWrist.score > 0.15) {
                const rDist = Math.hypot(rightWrist.x - t.lightsaber.x, rightWrist.y - t.lightsaber.y);
                const lDist = Math.hypot(leftWrist.x - t.lightsaber.x, leftWrist.y - t.lightsaber.y);
                if (rDist <= lsRad && lDist <= lsRad) {
                  p1LS_Active = true;
                }
              }
              // 大剣 (右手首 or 左手首)
              if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.greatsword.x, rightWrist.y - t.greatsword.y) <= gsRad) {
                p1GS_Active = true;
              }
              if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.greatsword.x, leftWrist.y - t.greatsword.y) <= gsRad) {
                p1GS_Active = true;
              }
              // 刀 (右手首 or 左手首)
              if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.katana.x, rightWrist.y - t.katana.y) <= ktRad) {
                p1KT_Active = true;
              }
              if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.katana.x, leftWrist.y - t.katana.y) <= ktRad) {
                p1KT_Active = true;
              }
            } else {
              const t = TARGETS.player2;
              const lsRad = getDrawRadius("lightsaber");
              const gsRad = getDrawRadius("greatsword");
              const ktRad = getDrawRadius("sword");

              // ライトセーバー
              if (rightWrist && leftWrist && rightWrist.score > 0.15 && leftWrist.score > 0.15) {
                const rDist = Math.hypot(rightWrist.x - t.lightsaber.x, rightWrist.y - t.lightsaber.y);
                const lDist = Math.hypot(leftWrist.x - t.lightsaber.x, leftWrist.y - t.lightsaber.y);
                if (rDist <= lsRad && lDist <= lsRad) {
                  p2LS_Active = true;
                }
              }
              // 大剣
              if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.greatsword.x, rightWrist.y - t.greatsword.y) <= gsRad) {
                p2GS_Active = true;
              }
              if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.greatsword.x, leftWrist.y - t.greatsword.y) <= gsRad) {
                p2GS_Active = true;
              }
              // 刀
              if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.katana.x, rightWrist.y - t.katana.y) <= ktRad) {
                p2KT_Active = true;
              }
              if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.katana.x, leftWrist.y - t.katana.y) <= ktRad) {
                p2KT_Active = true;
              }
            }
          } catch (poseErr) {
            console.log("当たり判定エラー（握りつぶし）:", poseErr);
          }
        });
      }

      // ── 🎯 ターゲット円を描画する内部関数 ──
      const drawTargetCircle = (center, active, defaultFill, defaultStroke, label, weaponKey, pKey) => {
        try {
          const sel = selectionState[pKey];
          const radius = (sel.detectingWeapon === weaponKey) ? KEEP_RADIUS : TARGET_RADIUS;

          ctx.beginPath();
          ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = active ? 'rgba(46, 204, 113, 0.35)' : defaultFill;
          ctx.strokeStyle = active ? '#2ecc71' : defaultStroke;
          ctx.lineWidth = active ? 4.5 : 3.5;
          ctx.fill();
          ctx.stroke();

          // テキストラベルの描画 (鏡像に反従して正しい向きにする)
          ctx.save();
          ctx.scale(-1, 1);
          ctx.font = "bold 12px sans-serif";
          ctx.fillStyle = "#ffffff";
          ctx.shadowBlur = 4;
          ctx.shadowColor = "black";
          ctx.textAlign = "center";
          ctx.fillText(label, -center.x, center.y - radius - 6);
          ctx.restore();
        } catch (circleErr) {}
      };

      // 【大剣の的（赤色）】: 画面の左右上部（固定座標）
      drawTargetCircle(TARGETS.player1.greatsword, p1GS_Active, 'rgba(231, 76, 60, 0.18)', '#e74c3c', "P1 大剣 (赤)", "greatsword", "player1");
      drawTargetCircle(TARGETS.player2.greatsword, p2GS_Active, 'rgba(231, 76, 60, 0.18)', '#e74c3c', "P2 大剣 (赤)", "greatsword", "player2");

      // 【刀の的（青色）】: 画面の左右下部（固定座標）
      drawTargetCircle(TARGETS.player1.katana, p1KT_Active, 'rgba(52, 152, 219, 0.18)', '#3498db', "P1 刀 (青)", "sword", "player1");
      drawTargetCircle(TARGETS.player2.katana, p2KT_Active, 'rgba(52, 152, 219, 0.18)', '#3498db', "P2 刀 (青)", "sword", "player2");

      // 【ライトセーバーの的（黄色）】: 画面の中央（固定座標）
      drawTargetCircle(TARGETS.player1.lightsaber, p1LS_Active, 'rgba(241, 196, 15, 0.18)', '#f1c40f', "P1 セーバー (黄)", "lightsaber", "player1");
      drawTargetCircle(TARGETS.player2.lightsaber, p2LS_Active, 'rgba(241, 196, 15, 0.18)', '#f1c40f', "P2 セーバー (黄)", "lightsaber", "player2");
    }

    // ── 骨格線 ＆ キーポイント描画 (肩の見切れがあっても描画ガードを完全に排除して強制表示) ──
    if (poses && poses.length > 0) {
      poses.forEach((pose) => {
        if (pose.score < 0.15) return; // 判定閾値を 0.15 に引き下げ

        try {
          const leftShoulder = pose.keypoints[11];
          const rightShoulder = pose.keypoints[12];
          const nose = pose.keypoints[0];
          const leftWrist = pose.keypoints[15];
          const rightWrist = pose.keypoints[16];
          
          let poseCenterX = 200;
          if (leftShoulder && rightShoulder && leftShoulder.score > 0.15 && rightShoulder.score > 0.15) {
            poseCenterX = (leftShoulder.x + rightShoulder.x) / 2;
          } else if (nose && nose.score > 0.15) {
            poseCenterX = nose.x;
          } else if (leftWrist && leftWrist.score > 0.15) {
            poseCenterX = leftWrist.x;
          } else if (rightWrist && rightWrist.score > 0.15) {
            poseCenterX = rightWrist.x;
          }

          const isPlayer1 = poseCenterX < 200;
          const playerKey = isPlayer1 ? 'player1' : 'player2';
          const playerColor = isPlayer1 ? '#00f2fe' : '#f35588';
          const shadowColor = isPlayer1 ? 'rgba(0, 242, 254, 0.8)' : 'rgba(243, 85, 136, 0.8)';
          const regStatusEl = isPlayer1 ? p1RegStatusEl : p2RegStatusEl;
          const cardEl = isPlayer1 ? p1Card : p2Card;

          // 骨格接続線の描画 (各点が 0.15 以上あれば肩なしでも繋がっている部分を描画)
          SKELETON_CONNECTIONS.forEach(([i, j]) => {
            try {
              const kp1 = pose.keypoints[i];
              const kp2 = pose.keypoints[j];
              if (kp1 && kp2 && kp1.score > 0.15 && kp2.score > 0.15) {
                ctx.beginPath();
                ctx.moveTo(kp1.x, kp1.y);
                ctx.lineTo(kp2.x, kp2.y);
                ctx.strokeStyle = playerColor;
                ctx.lineWidth = 4;
                ctx.lineCap = 'round';
                ctx.shadowColor = shadowColor;
                ctx.shadowBlur = 10;
                ctx.stroke();
              }
            } catch (connErr) {}
          });

          // 関節ドット描画（手首は大きめ赤丸7pxで描画、しきい値 0.15）
          pose.keypoints.forEach((kp, idx) => {
            try {
              if (kp.score > 0.15) { 
                ctx.beginPath();
                const isWrist = (idx === 15 || idx === 16);
                ctx.arc(kp.x, kp.y, isWrist ? 7 : 5, 0, 2 * Math.PI);
                ctx.fillStyle = isWrist ? '#ff3f34' : '#ffffff';
                ctx.shadowBlur = 8;
                ctx.shadowColor = isWrist ? '#ff3f34' : shadowColor;
                ctx.fill();
              }
            } catch (dotErr) {}
          });

          const nosePoint = pose.keypoints[0];
          const isReadyToShow = (gameStatus === "drawing" && selectionState[playerKey].locked) || (gameStatus === "selecting" && selectionState[playerKey].locked);
          if (isReadyToShow && nosePoint && nosePoint.score > 0.15) {
            ctx.save();
            ctx.translate(nosePoint.x, nosePoint.y - 45);
            ctx.scale(-1, 1);
            ctx.font = "bold 15px 'Space Grotesk', sans-serif";
            ctx.fillStyle = playerColor;
            ctx.textAlign = "center";
            ctx.shadowBlur = 6;
            ctx.shadowColor = shadowColor;
            ctx.fillText("READY!", 0, 0);
            ctx.restore();
          }

          if (gameStatus === "selecting") {
            handleWeaponSelection(pose, playerKey, regStatusEl, cardEl);
          } else if (gameStatus === "playing") {
            processMovementLogics(pose, playerKey);
          }
        } catch (poseInnerErr) {
          console.log("各骨格の内部描画処理エラー（握りつぶし）:", poseInnerErr);
        }
      });
    }

    ctx.restore();
  } catch (globalDrawErr) {
    console.log("drawSkeleton 全体エラー（握りつぶし）:", globalDrawErr);
  }
}

// ── 💡 公式生SDKのコールバック処理 ──
function onPoseResults(results) {
  if (!isDetecting) return;
  
  try {
    const poses = [];
    
    // results.poseLandmarks に全身33点のキーポイントが 0.0 〜 1.0 で入る
    if (results.poseLandmarks) {
      const formattedPose = {
        score: 0.95,
        keypoints: results.poseLandmarks.map((lm) => ({
          x: lm.x * 400,
          y: lm.y * 300,
          score: lm.visibility // visibility を score として流用
        }))
      };
      
      poses.push(formattedPose);
      
      statusDot.classList.add('active');
      statusText.textContent = "骨格検出中 (公式生エンジンロックオン)";
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = "カメラの前に立ってください";
      if (gameStatus === "selecting") {
        resetSelectionIfAbsent('player1', p1RegStatusEl, p1Card);
        resetSelectionIfAbsent('player2', p2RegStatusEl, p2Card);
      }
    }
    
    // 的の強制描画 ＆ 骨格の描画を確実に実行
    drawSkeleton(poses);
  } catch (err) {
    console.log("onPoseResults エラー（握りつぶし）:", err);
  }
}

function resetSelectionIfAbsent(playerKey, regStatusEl, cardEl) {
  try {
    const sel = selectionState[playerKey];
    if (!sel.locked && sel.detectingWeapon) {
      sel.lastActiveTime = Date.now();
    }
  } catch (e) {}
}

// ── 検出器初期化 ──
async function initPoseBattleSystem() {
  try {
    setupStatus.textContent = "Official MediaPipe Pose 超安定全身エンジンを起動中...";

    // 💡 SDKのロード状態を確実にチェックし、親切なエラーを投げる
    if (typeof Pose === 'undefined' || typeof Camera === 'undefined') {
      throw new Error("MediaPipe SDK (Pose または Camera) がブラウザにロードされていません。インターネット接続状態を確認するか、ブラウザキャッシュをクリアして再読み込みしてください。");
    }

    // 💡 最高の起動率・描画安定性を誇るバニラ（生の公式SDK）を初期化
    poseEngine = new Pose({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
      }
    });

    poseEngine.setOptions({
      modelComplexity: 1, // 0: Lite, 1: Full (全身を高精度かつ軽量・爆速ロード)
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    poseEngine.onResults(onPoseResults);

    setupStatus.textContent = "Webカメラを起動中...";

    // MediaPipe 公式 Camera ユーティリティでアスペクト比・ブラウザ互換を100%超安定化
    cameraEngine = new Camera(videoElement, {
      onFrame: async () => {
        try {
          await poseEngine.send({ image: videoElement });
        } catch (sendErr) {}
      },
      width: 400,
      height: 300
    });

    await cameraEngine.start();

    setupStatus.textContent = "ゲーム開始準備中...";
    gameStatus = "selecting";
    updatePhaseUI();
    p1RegStatusEl.textContent = "カメラに映ってください";
    p2RegStatusEl.textContent = "カメラに映ってください";
    
    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, {
      status: "selecting",
      match_status: "selecting",
      p1_ready: false,
      p2_ready: false,
      player1_score: 0,
      player2_score: 0
    }, { merge: true });

    setupFirestoreListener();

    isDetecting = true;

    setupOverlay.style.opacity = 0;
    setTimeout(() => setupOverlay.classList.add('hidden'), 500);
  } catch (e) {
    console.error("システム初期化エラー:", e);
    setupStatus.textContent = "エラーが発生しました。カメラ権限を確認してください。";
    setupStatus.style.color = "#ff5e57";
  }
}

startBtn.addEventListener('click', initPoseBattleSystem);

// ── 💡 1回生UI合体用の受け皿関数 ──
export function updateP1HealthGauge(score) {
  console.log("[受け皿関数] updateP1HealthGauge スコア:", score);
}

export function updateP2HealthGauge(score) {
  console.log("[受け皿関数] updateP2HealthGauge スコア:", score);
}

export function switchToBattleScreen() {
  console.log("[受け皿関数] switchToBattleScreen がキックされました。");
}

// ── Firestore リアルタイム同期 ──
function setupFirestoreListener() {
  try {
    const battleDocRef = doc(db, "shinken_rooms", "battle");
    onSnapshot(battleDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        console.log("[Firestoreリアルタイム受信]", data);

        if (gameStatus === "drawing") {
          if (data.p1_ready) {
            p1RegStatusEl.textContent = "抜刀完了！(READY)";
            p1RegStatusEl.className = "reg-status ready";
            p1Card.classList.add('ready');
          } else {
            p1RegStatusEl.textContent = "スマホ側抜刀待ち...";
            p1RegStatusEl.className = "reg-status detecting";
            p1Card.classList.remove('ready');
          }

          if (data.p2_ready) {
            p2RegStatusEl.textContent = "抜刀完了！(READY)";
            p2RegStatusEl.className = "reg-status ready";
            p2Card.classList.add('ready');
          } else {
            p2RegStatusEl.textContent = "スマホ側抜刀待ち...";
            p2RegStatusEl.className = "reg-status detecting";
            p2Card.classList.remove('ready');
          }

          if (data.p1_ready === true && data.p2_ready === true) {
            statusText.textContent = "全員抜刀完了！バトルスタート！";
            setTimeout(() => {
              p1Card.classList.remove('ready');
              p2Card.classList.remove('ready');
              
              const weaponLabels = { sword: "刀装備中", greatsword: "大剣装備中", lightsaber: "セーバー装備中" };
              const p1W = selectionState.player1.selectedWeapon || data.p1_weapon || "sword";
              const p2W = selectionState.player2.selectedWeapon || data.p2_weapon || "sword";

              p1RegStatusEl.textContent = weaponLabels[p1W];
              p2RegStatusEl.textContent = weaponLabels[p2W];
              p1RegStatusEl.className = "reg-status ready";
              p2RegStatusEl.className = "reg-status ready";

              switchToBattleScreen();
              startMatch();
            }, 1500);
          }
        }

        if (data.player1_score !== undefined && data.player1_score !== p1Score && gameStatus === "playing") {
          p1Score = data.player1_score;
          p1ScoreEl.textContent = p1Score;
          updateP1HealthGauge(p1Score);

          p1ScoreEl.classList.remove('pop-animation');
          void p1ScoreEl.offsetWidth;
          p1ScoreEl.classList.add('pop-animation');

          p1Card.classList.add('active');
          setTimeout(() => p1Card.classList.remove('active'), 200);

          p1Flash.classList.remove('flash-cyan');
          void p1Flash.offsetWidth;
          p1Flash.classList.add('flash-cyan');
        }

        if (data.player2_score !== undefined && data.player2_score !== p2Score && gameStatus === "playing") {
          p2Score = data.player2_score;
          p2ScoreEl.textContent = p2Score;
          updateP2HealthGauge(p2Score);

          p2ScoreEl.classList.remove('pop-animation');
          void p2ScoreEl.offsetWidth;
          p2ScoreEl.classList.add('pop-animation');

          p2Card.classList.add('active');
          setTimeout(() => p2Card.classList.remove('active'), 200);

          p2Flash.classList.remove('flash-magenta');
          void p2Flash.offsetWidth;
          p2Flash.classList.add('flash-magenta');
        }

        if ((data.status === "finished" || data.match_status === "finished") && gameStatus !== "finished") {
          gameStatus = "finished";
          updatePhaseUI();
          if (timerInterval) clearInterval(timerInterval);
          isDetecting = false;
        }
      }
    });
  } catch (e) {
    console.log("Firestore監視エラー（握りつぶし）:", e);
  }
}
