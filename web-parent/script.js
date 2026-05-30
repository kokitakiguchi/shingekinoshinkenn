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
let detector = null;
let isDetecting = false;

let p1Score = 0;
let p2Score = 0;

const COOLDOWN_MS = 300;

const playersState = {
  player1: { prevLeftWristY: null, prevRightWristY: null, lastSwingTime: 0 },
  player2: { prevLeftWristY: null, prevRightWristY: null, lastSwingTime: 0 }
};

const selectionState = {
  player1: { locked: false, selectedWeapon: null, detectingWeapon: null, poseStartTime: 0, progress: 0 },
  player2: { locked: false, selectedWeapon: null, detectingWeapon: null, poseStartTime: 0, progress: 0 }
};

// MediaPipe Pose 33点 接続ライン (下半身が映っていなくてもエラーを防ぐためkp.score判定を入れる)
const SKELETON_CONNECTIONS = [
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  [11, 23], [12, 24],
  [23, 24],
  [23, 25], [25, 27],
  [24, 26], [26, 28]
];

// ── 直線距離計算 ──
function getDistance(kp1, kp2) {
  if (!kp1 || !kp2 || kp1.score < 0.3 || kp2.score < 0.3) return Infinity;
  return Math.hypot(kp1.x - kp2.x, kp1.y - kp2.y);
}

// ── ベクトル内積角度（度数法）算出 ──
function getAngle(p1, p2, p3) {
  if (!p1 || !p2 || !p3 || p1.score < 0.3 || p2.score < 0.3 || p3.score < 0.3) return 180;
  const v1 = { x: p1.x - p2.x, y: p1.y - p2.y };
  const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return 180;
  const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cosTheta) * (180 / Math.PI);
}

// ── フェーズに応じたUI更新 ──
function updatePhaseUI() {
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
}

// ── タイマー制御 ──
function startTimer() {
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
  gameStatus = "playing";
  timeRemaining = 90;
  timerEl.textContent = timeRemaining;
  p1Score = 0;
  p2Score = 0;
  p1ScoreEl.textContent = 0;
  p2ScoreEl.textContent = 0;

  updatePhaseUI();

  try {
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
  } catch (e) {
    console.error("Firestore 試合初期化エラー:", e);
  }

  startTimer();
}

// ── スイング検知・送信 ──
async function handleSwing(playerKey) {
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

  try {
    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, {
      [`${playerKey === 'player1' ? 'player1_score' : 'player2_score'}`]: increment(1)
    }, { merge: true });
  } catch (e) {
    console.error("Firestoreスコア送信エラー:", e);
  }
}

function animateScore(scoreEl, cardEl, flashEl, flashClass) {
  scoreEl.textContent = cardEl.classList.contains('p1') ? p1Score : p2Score;
  scoreEl.classList.remove('pop-animation');
  void scoreEl.offsetWidth; // リフロー
  scoreEl.classList.add('pop-animation');

  cardEl.classList.add('active');
  setTimeout(() => cardEl.classList.remove('active'), 200);

  flashEl.classList.remove(flashClass);
  void flashEl.offsetWidth;
  flashEl.classList.add(flashClass);
}

// ── 【新仕様】腰（HIP）完全排除＆上半身特化武器選択ポーズ判定 ──
function handleWeaponSelection(pose, playerKey, regStatusEl, cardEl) {
  const sel = selectionState[playerKey];
  if (sel.locked) return;

  const leftShoulder = pose.keypoints[11];
  const rightShoulder = pose.keypoints[12];
  const leftElbow = pose.keypoints[13];
  const rightElbow = pose.keypoints[14];
  const leftWrist = pose.keypoints[15];
  const rightWrist = pose.keypoints[16];

  if (!leftShoulder || !rightShoulder || leftShoulder.score < 0.3 || rightShoulder.score < 0.3) {
    return;
  }

  // 腰を使わず、両肩の座標をアンカーにして判定用の的を動的に決定
  const chest = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
  
  // 各武器の的（ターゲット）の座標と半径
  const rGreatswordTarget = { x: rightShoulder.x, y: rightShoulder.y - 35 };
  const lGreatswordTarget = { x: leftShoulder.x, y: leftShoulder.y - 35 };
  const greatswordRadius = 55;

  const katanaTarget = { x: chest.x, y: chest.y + 80 };
  const katanaRadius = 65;

  const saberTarget = { x: chest.x, y: chest.y + 45 };
  const saberRadius = 55;

  let currentPoseDetecting = null;
  let debugTargetKp = null;
  let debugWristKp = null;
  let debugWristKp2 = null;

  // ── 1. 【ライトセーバー】最優先チェック ──
  // 両手首が極めて近く（32px = 正規化0.08相当）、かつ両手首が肩のY座標より下（胸〜お腹）で、かつセーバーの的（胸中央）に入っていること
  const isWristsNear = (rightWrist && leftWrist && rightWrist.score > 0.4 && leftWrist.score > 0.4) && 
                       Math.hypot(rightWrist.x - leftWrist.x, rightWrist.y - leftWrist.y) <= 32;
  const handCenter = { x: (rightWrist.x + leftWrist.x) / 2, y: (rightWrist.y + leftWrist.y) / 2 };
  const isHandsInSaberTarget = isWristsNear && 
                               Math.hypot(handCenter.x - saberTarget.x, handCenter.y - saberTarget.y) <= saberRadius && 
                               (rightWrist.y > rightShoulder.y && leftWrist.y > leftShoulder.y);

  if (isHandsInSaberTarget) {
    currentPoseDetecting = "lightsaber";
    debugWristKp = rightWrist;
    debugWristKp2 = leftWrist;
    debugTargetKp = saberTarget;
  }

  // ── 2. 【大剣】 ──
  // 手首が同側の肩の少し上の的（大剣の的）に入っており、かつ手首のY座標が肩のY座標より上（頭の横〜上）にあり、肘角度がしっかり曲がっている（120度以下）
  if (!currentPoseDetecting) {
    const rightArmAngle = getAngle(rightShoulder, rightElbow, rightWrist);
    const leftArmAngle = getAngle(leftShoulder, leftElbow, leftWrist);

    const isRightWristInRGS = (rightWrist && rightWrist.score > 0.4) && 
                              Math.hypot(rightWrist.x - rGreatswordTarget.x, rightWrist.y - rGreatswordTarget.y) <= greatswordRadius && 
                              (rightWrist.y < rightShoulder.y) && 
                              (rightArmAngle <= 120);

    const isLeftWristInLGS = (leftWrist && leftWrist.score > 0.4) && 
                             Math.hypot(leftWrist.x - lGreatswordTarget.x, leftWrist.y - lGreatswordTarget.y) <= greatswordRadius && 
                             (leftWrist.y < leftShoulder.y) && 
                             (leftArmAngle <= 120);

    // 反対側の腕は胸や肩の近くにないこと（誤検知防止セーフティ）
    const leftWristNearChestOrShoulder = (leftWrist && leftWrist.score > 0.4) && 
                                         (Math.hypot(leftWrist.x - chest.x, leftWrist.y - chest.y) < 100 || 
                                          Math.hypot(leftWrist.x - leftShoulder.x, leftWrist.y - leftShoulder.y) < 100);

    const rightWristNearChestOrShoulder = (rightWrist && rightWrist.score > 0.4) && 
                                          (Math.hypot(rightWrist.x - chest.x, rightWrist.y - chest.y) < 100 || 
                                           Math.hypot(rightWrist.x - rightShoulder.x, rightWrist.y - rightShoulder.y) < 100);

    if (isRightWristInRGS && !leftWristNearChestOrShoulder) {
      currentPoseDetecting = "greatsword";
      debugWristKp = rightWrist;
      debugTargetKp = rGreatswordTarget;
    }
    else if (isLeftWristInLGS && !rightWristNearChestOrShoulder) {
      currentPoseDetecting = "greatsword";
      debugWristKp = leftWrist;
      debugTargetKp = lGreatswordTarget;
    }
  }

  // ── 3. 【刀】 ──
  // 手首のY座標が肩のY座標より拳2個分（55px）以上下（お腹の前）にあり、お腹の的（刀の的）に入っており、肘角度がしっかり曲がっている（140度以下）
  if (!currentPoseDetecting) {
    const rightArmAngle = getAngle(rightShoulder, rightElbow, rightWrist);
    const leftArmAngle = getAngle(leftShoulder, leftElbow, leftWrist);

    const isRightWristInKatana = (rightWrist && rightWrist.score > 0.4) && 
                                 Math.hypot(rightWrist.x - katanaTarget.x, rightWrist.y - katanaTarget.y) <= katanaRadius && 
                                 (rightWrist.y > rightShoulder.y + 55) && 
                                 (rightArmAngle <= 140);

    const isLeftWristInKatana = (leftWrist && leftWrist.score > 0.4) && 
                                Math.hypot(leftWrist.x - katanaTarget.x, leftWrist.y - katanaTarget.y) <= katanaRadius && 
                                (leftWrist.y > leftShoulder.y + 55) && 
                                (leftArmAngle <= 140);

    if (isRightWristInKatana) {
      currentPoseDetecting = "sword";
      debugWristKp = rightWrist;
      debugTargetKp = katanaTarget;
    }
    else if (isLeftWristInKatana) {
      currentPoseDetecting = "sword";
      debugWristKp = leftWrist;
      debugTargetKp = katanaTarget;
    }
  }

  const weaponNames = { sword: "刀", greatsword: "大剣", lightsaber: "ライトセーバー" };

  if (currentPoseDetecting) {
    const weaponNameJP = weaponNames[currentPoseDetecting];

    if (sel.detectingWeapon === currentPoseDetecting) {
      const elapsed = Date.now() - sel.poseStartTime;
      sel.progress = Math.min(100, Math.floor((elapsed / 1500) * 100));

      regStatusEl.textContent = `${weaponNameJP}の構え... (${sel.progress}%)`;
      regStatusEl.className = "reg-status detecting";

      // 判定吸い付きガイドライン描画
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

      if (elapsed >= 1500) {
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
      sel.detectingWeapon = currentPoseDetecting;
      sel.poseStartTime = Date.now();
      sel.progress = 0;
      regStatusEl.textContent = `${weaponNameJP}の構え... (0%)`;
      regStatusEl.className = "reg-status detecting";
    }
  } else {
    sel.detectingWeapon = null;
    sel.poseStartTime = 0;
    sel.progress = 0;
    regStatusEl.textContent = "武器の構えを取ってください (大剣/刀/セーバー)";
    regStatusEl.className = "reg-status";
  }
}

async function checkAllWeaponsSelected() {
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

      try {
        const battleDocRef = doc(db, "shinken_rooms", "battle");
        await setDoc(battleDocRef, {
          status: "drawing",
          match_status: "drawing",
          p1_weapon: selectionState.player1.selectedWeapon,
          p2_weapon: selectionState.player2.selectedWeapon,
          p1_ready: false,
          p2_ready: false
        }, { merge: true });
      } catch (e) {
        console.error("Firestore drawing更新エラー:", e);
      }
    }, 1500);
  }
}

// ── 【ステップ3：バトルフェーズのスイング判定】 ──
function processMovementLogics(pose, playerKey) {
  const state = playersState[playerKey];
  const leftWrist = pose.keypoints[15];
  const rightWrist = pose.keypoints[16];

  const currentLeftWristY = (leftWrist && leftWrist.score > 0.4) ? leftWrist.y : null;
  const currentRightWristY = (rightWrist && rightWrist.score > 0.4) ? rightWrist.y : null;

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
}

// ── 骨格＆デバッグ用の的（サークル）描画メイン ──
function drawSkeleton(poses) {
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  ctx.save();
  ctx.translate(canvasElement.width, 0);
  ctx.scale(-1, 1); // 鏡像

  poses.forEach((pose) => {
    if (pose.score < 0.25) return;

    const leftShoulder = pose.keypoints[11];
    const rightShoulder = pose.keypoints[12];
    const leftElbow = pose.keypoints[13];
    const rightElbow = pose.keypoints[14];
    const leftWrist = pose.keypoints[15];
    const rightWrist = pose.keypoints[16];
    
    if (!leftShoulder || !rightShoulder || leftShoulder.score < 0.3 || rightShoulder.score < 0.3) {
      return;
    }

    const poseCenterX = (leftShoulder.x + rightShoulder.x) / 2;
    const isPlayer1 = poseCenterX < 200;
    const playerKey = isPlayer1 ? 'player1' : 'player2';
    const playerColor = isPlayer1 ? '#00f2fe' : '#f35588';
    const shadowColor = isPlayer1 ? 'rgba(0, 242, 254, 0.8)' : 'rgba(243, 85, 136, 0.8)';
    const regStatusEl = isPlayer1 ? p1RegStatusEl : p2RegStatusEl;
    const cardEl = isPlayer1 ? p1Card : p2Card;

    const chest = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };

    // 腰を使わず、両肩の座標をアンカーにして判定用の的（サークル）を動的にマッピング
    const rGreatswordTarget = { x: rightShoulder.x, y: rightShoulder.y - 35 };
    const lGreatswordTarget = { x: leftShoulder.x, y: leftShoulder.y - 35 };
    const greatswordRadius = 55;

    const katanaTarget = { x: chest.x, y: chest.y + 80 };
    const katanaRadius = 65;

    const saberTarget = { x: chest.x, y: chest.y + 45 };
    const saberRadius = 55;

    // ── 💡 的（サークル）のリアルタイム描画 (selecting時) ──
    if (gameStatus === "selecting") {
      // 大剣の的（右）
      const isRightWristInRGS = (rightWrist && rightWrist.score > 0.4) && 
                                Math.hypot(rightWrist.x - rGreatswordTarget.x, rightWrist.y - rGreatswordTarget.y) <= greatswordRadius && 
                                (rightWrist.y < rightShoulder.y);
      ctx.beginPath();
      ctx.arc(rGreatswordTarget.x, rGreatswordTarget.y, greatswordRadius, 0, 2 * Math.PI);
      ctx.fillStyle = isRightWristInRGS ? 'rgba(46, 204, 113, 0.35)' : 'rgba(231, 76, 60, 0.18)';
      ctx.strokeStyle = isRightWristInRGS ? '#2ecc71' : '#e74c3c';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();

      // 大剣の的（左）
      const isLeftWristInLGS = (leftWrist && leftWrist.score > 0.4) && 
                               Math.hypot(leftWrist.x - lGreatswordTarget.x, leftWrist.y - lGreatswordTarget.y) <= greatswordRadius && 
                               (leftWrist.y < leftShoulder.y);
      ctx.beginPath();
      ctx.arc(lGreatswordTarget.x, lGreatswordTarget.y, greatswordRadius, 0, 2 * Math.PI);
      ctx.fillStyle = isLeftWristInLGS ? 'rgba(46, 204, 113, 0.35)' : 'rgba(231, 76, 60, 0.18)';
      ctx.strokeStyle = isLeftWristInLGS ? '#2ecc71' : '#e74c3c';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();

      // 刀の的（お腹）
      const isRightWristInKatana = (rightWrist && rightWrist.score > 0.4) && 
                                   Math.hypot(rightWrist.x - katanaTarget.x, rightWrist.y - katanaTarget.y) <= katanaRadius && 
                                   (rightWrist.y > rightShoulder.y + 55);
      const isLeftWristInKatana = (leftWrist && leftWrist.score > 0.4) && 
                                  Math.hypot(leftWrist.x - katanaTarget.x, leftWrist.y - katanaTarget.y) <= katanaRadius && 
                                  (leftWrist.y > leftShoulder.y + 55);
      const isKatanaReady = (isRightWristInKatana && getAngle(rightShoulder, rightElbow, rightWrist) <= 140) || 
                            (isLeftWristInKatana && getAngle(leftShoulder, leftElbow, leftWrist) <= 140);
      
      ctx.beginPath();
      ctx.arc(katanaTarget.x, katanaTarget.y, katanaRadius, 0, 2 * Math.PI);
      ctx.fillStyle = isKatanaReady ? 'rgba(46, 204, 113, 0.35)' : 'rgba(231, 76, 60, 0.18)';
      ctx.strokeStyle = isKatanaReady ? '#2ecc71' : '#e74c3c';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();

      // ライトセーバーの的（胸）
      const isWristsNear = (rightWrist && leftWrist && rightWrist.score > 0.4 && leftWrist.score > 0.4) && 
                           Math.hypot(rightWrist.x - leftWrist.x, rightWrist.y - leftWrist.y) <= 32;
      const handCenter = { x: (rightWrist.x + leftWrist.x) / 2, y: (rightWrist.y + leftWrist.y) / 2 };
      const isHandsInSaberTarget = isWristsNear && 
                                   Math.hypot(handCenter.x - saberTarget.x, handCenter.y - saberTarget.y) <= saberRadius && 
                                   (rightWrist.y > rightShoulder.y && leftWrist.y > leftShoulder.y);

      ctx.beginPath();
      ctx.arc(saberTarget.x, saberTarget.y, saberRadius, 0, 2 * Math.PI);
      ctx.fillStyle = isHandsInSaberTarget ? 'rgba(46, 204, 113, 0.35)' : 'rgba(231, 76, 60, 0.18)';
      ctx.strokeStyle = isHandsInSaberTarget ? '#2ecc71' : '#e74c3c';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();

      // テキストラベリング
      ctx.save();
      ctx.scale(-1, 1);
      ctx.font = "bold 12px sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.shadowBlur = 4;
      ctx.shadowColor = "black";
      ctx.textAlign = "center";
      ctx.fillText("大剣 (右肩上)", -rGreatswordTarget.x, rGreatswordTarget.y - 5);
      ctx.fillText("大剣 (左肩上)", -lGreatswordTarget.x, lGreatswordTarget.y - 5);
      ctx.fillText("刀 (お腹)", -katanaTarget.x, katanaTarget.y - 5);
      ctx.fillText("ライトセーバー", -saberTarget.x, saberTarget.y - 5);
      ctx.restore();
    }

    // 骨格線描画 (スコアチェックを行いロストを防ぐ)
    SKELETON_CONNECTIONS.forEach(([i, j]) => {
      const kp1 = pose.keypoints[i];
      const kp2 = pose.keypoints[j];
      if (kp1 && kp2 && kp1.score > 0.3 && kp2.score > 0.3) {
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
    });

    // キーポイント描画 (手首は大きめ赤丸ドット)
    pose.keypoints.forEach((kp, idx) => {
      if (kp.score > 0.3) {
        ctx.beginPath();
        const isWrist = (idx === 15 || idx === 16);
        ctx.arc(kp.x, kp.y, isWrist ? 7 : 5, 0, 2 * Math.PI);
        ctx.fillStyle = isWrist ? '#ff3f34' : '#ffffff';
        ctx.shadowBlur = 8;
        ctx.shadowColor = isWrist ? '#ff3f34' : shadowColor;
        ctx.fill();
      }
    });

    const nose = pose.keypoints[0];
    const isReadyToShow = (gameStatus === "drawing" && selectionState[playerKey].locked) || (gameStatus === "selecting" && selectionState[playerKey].locked);
    if (isReadyToShow && nose && nose.score > 0.4) {
      ctx.save();
      ctx.translate(nose.x, nose.y - 45);
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
  });

  ctx.restore();
}

async function detectionLoop() {
  if (!isDetecting) return;
  try {
    const poses = await detector.estimatePoses(videoElement, { maxPoses: 2, flipHorizontal: false });
    const activePoses = poses.filter(p => p.score > 0.25);
    if (activePoses.length > 0) {
      statusDot.classList.add('active');
      statusText.textContent = `骨格検出中 (ロックオン: ${activePoses.length}人)`;
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = "カメラの前に立ってください";
      if (gameStatus === "selecting") {
        resetSelectionIfAbsent('player1', p1RegStatusEl, p1Card);
        resetSelectionIfAbsent('player2', p2RegStatusEl, p2Card);
      }
    }
    drawSkeleton(poses);
  } catch (e) {
    console.error("Pose 推定中にエラー:", e);
  }
  requestAnimationFrame(detectionLoop);
}

function resetSelectionIfAbsent(playerKey, regStatusEl, cardEl) {
  const sel = selectionState[playerKey];
  if (!sel.locked && sel.detectingWeapon) {
    sel.detectingWeapon = null;
    sel.poseStartTime = 0;
    sel.progress = 0;
    regStatusEl.textContent = "カメラに映ってください";
    regStatusEl.className = "reg-status";
  }
}

// ── 検出器初期化 ──
async function initPoseBattleSystem() {
  setupStatus.textContent = "MediaPipe Pose 上半身特化検出器をロード中...";
  try {
    // MediaPipe Pose を上半身特化モードに設定し、頭、肩、肘、手首の検出精度と安定性を最優先
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.BlazePose,
      {
        runtime: 'mediapipe',
        modelComplexity: 2,
        upperBodyOnly: true, // 腰から下がはみ出していても骨格抽出を可能にする上半身特化設定
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.65,
        solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose'
      }
    );

    setupStatus.textContent = "Webカメラを起動中...";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 400, height: 300, facingMode: "user" },
      audio: false
    });
    videoElement.srcObject = stream;
    
    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play();
        resolve();
      };
    });

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
    requestAnimationFrame(detectionLoop);

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
function updateP1HealthGauge(score) {
  console.log("[受け皿関数] updateP1HealthGauge スコア:", score);
}

// ── 💡 1回生UI合体用の受け皿関数 ──
function updateP2HealthGauge(score) {
  console.log("[受け皿関数] updateP2HealthGauge スコア:", score);
}

// ── 💡 1回生UI合体用の受け皿関数 ──
function switchToBattleScreen() {
  console.log("[受け皿関数] switchToBattleScreen がキックされました。");
}

// ── Firestore リアルタイム同期 ──
function setupFirestoreListener() {
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
}
