// ── Firebase Web SDK (v10) のインポート ──
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, onSnapshot, increment } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ── Firebase 初期化設定 (環境変数動的ロード) ──
import { loadFirebaseConfig } from "./firebase-config.js";

let app = null;
let db = null;

// ── HTML要素の取得 ──
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('output_canvas');
const ctx = canvasElement.getContext('2d');
const setupOverlay = document.getElementById('setup-overlay');
const startBtn = document.getElementById('start-btn');
const setupStatus = document.getElementById('setup-status');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// 1回生UIのIDに合わせてマッピング
const p1ScoreEl = document.getElementById('p1Score');
const p2ScoreEl = document.getElementById('p2Score');
const timerEl = document.getElementById('game-timer');
const phaseTitleEl = document.getElementById('game-phase-title');

const p1RegStatusEl = document.getElementById('p1-reg-status');
const p2RegStatusEl = document.getElementById('p2-reg-status');

const p1Card = document.getElementById('p1-card');
const p2Card = document.getElementById('p2-card');

// スイング時の演出用要素
const slashLine = document.getElementById('slashLine');
const slashText = document.getElementById('slashText');
const body = document.body;

// ── 📸 バトルモーメント撮影・保存用変数 ──
let capturedPhotoData = null;
let photoCaptureTimeout = null;

// ── ゲーム状態管理 ──
let gameStatus = "selecting";
let timeRemaining = 30;
let timerInterval = null;
let poseEngine = null; // Official MediaPipe Pose インスタンス
let cameraEngine = null; // Official MediaPipe Camera インスタンス
let isDetecting = false;
let isTransitioningToBattle = false; // 重複実行防止フラグ

let p1Score = 0;
let p2Score = 0;

const COOLDOWN_MS = 300;

// 直近のローカル検知スイング時刻を保持（Firebase同期時の演出重複防止用）
const lastLocalSwingTimes = { player1: 0, player2: 0 };

const playersState = {
  player1: { prevLeftWristY: null, prevRightWristY: null, lastSwingTime: 0 },
  player2: { prevLeftWristY: null, prevRightWristY: null, lastSwingTime: 0 }
};

// 猶予時間（グレースピリオド）と滑らかな累積・減衰に対応したステート
const selectionState = {
  player1: { locked: false, selectedWeapon: null, detectingWeapon: null, lastActiveTime: 0, accumulatedTime: 0, progress: 0, lostStartTime: 0 },
  player2: { locked: false, selectedWeapon: null, detectingWeapon: null, lastActiveTime: 0, accumulatedTime: 0, progress: 0, lostStartTime: 0 }
};

// ── 🔊 【サウンドシステム】 ──
let isAudioUnlocked = false;
const soundFiles = {
  katana: './sounds/斬撃1.mp3',
  taiken: './sounds/大剣.mp3',
  sabers: './sounds/ライトセーバー.mp3'
};

const sounds = {};
for (const [key, src] of Object.entries(soundFiles)) {
  const audio = new Audio(src);
  audio.preload = 'auto';
  audio.load();
  sounds[key] = audio;
}

// ユーザーのアクションをトリガーにブラウザの自動再生制限を突破する
function unlockAudio() {
  if (isAudioUnlocked) return;
  
  const unlockPromises = Object.values(sounds).map(audio => {
    audio.muted = true;
    return audio.play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
      })
      .catch(e => console.log('Audio unlock waiting...', e));
  });

  Promise.allSettled(unlockPromises).finally(() => {
    isAudioUnlocked = true;
    const notice = document.getElementById('audioNotice');
    if (notice) notice.style.display = 'none';
    console.log("Audio system unlocked successfully!");
  });
}
window.unlockAudio = unlockAudio; // HTMLのonclick等から呼べるように露出

// 音源再生
function playWeaponSound(weaponType) {
  // HTML/UI側のキーを判定器側のキーにマッピング
  const mappedKey = weaponType === 'sword' ? 'katana' : (weaponType === 'greatsword' ? 'taiken' : (weaponType === 'lightsaber' ? 'sabers' : weaponType));
  const audio = sounds[mappedKey];
  if (!audio) {
    console.warn('Unknown weapon sound:', weaponType);
    return;
  }
  audio.currentTime = 0;
  audio.muted = false;
  audio.play().catch(e => console.error('再生エラー:', e));
}

// 斬撃演出とサウンドを再生する関数
function triggerSlash(playerNum, weaponType) {
  body.classList.remove('flash-p1', 'flash-p2');
  void body.offsetWidth; // リフロー

  if (playerNum === 1) {
    body.classList.add('flash-p1');
    setTimeout(() => body.classList.remove('flash-p1'), 100);
    showVisuals('line-p1', 'text-p1');
  } else {
    body.classList.add('flash-p2');
    setTimeout(() => body.classList.remove('flash-p2'), 100);
    showVisuals('line-p2', 'text-p2');
  }
  playWeaponSound(weaponType);
}

function showVisuals(lineClass, textClass) {
  if (!slashLine || !slashText) return;
  slashLine.className = 'slash-line ' + lineClass;
  slashLine.classList.remove('swipe-animation');
  void slashLine.offsetWidth;
  slashLine.classList.add('swipe-animation');

  slashText.className = 'slash-text ' + textClass;
  slashText.classList.remove('pop-animation');
  void slashText.offsetWidth;
  slashText.classList.add('pop-animation');
}

// ── 🖥️ 【画面遷移システム】 ──
let currentActiveScreen = "startScreen"; // 初期状態
let lastScreenTransitionTime = 0; // スイング画面遷移の連打防止用

function switchScreen(screenId) {
  currentActiveScreen = screenId; // 現在のアクティブ画面を記録
  
  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });
  const targetScreen = document.getElementById(screenId);
  if (targetScreen) {
    targetScreen.classList.add('active');
  }

  // 選択画面とバトル画面の時のみWebカメラモニターを表示する
  const monitor = document.querySelector('.monitor-wrapper');
  if (monitor) {
    if (screenId === 'selectionScreen' || screenId === 'battleScreen') {
      monitor.classList.remove('hidden');
    } else {
      monitor.classList.add('hidden');
    }
  }
}
window.switchScreen = switchScreen; // グローバルに露出

// ── 🎯 【UNDERTALE風 ボタン攻撃エフェクト】 ──
function triggerUndertaleSlash(targetButton) {
  if (!targetButton) return;
  
  try {
    const rect = targetButton.getBoundingClientRect();
    const slash = document.createElement('div');
    slash.className = 'undertale-slash';
    
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    slash.style.position = 'absolute';
    slash.style.left = (rect.left + scrollLeft) + 'px';
    slash.style.top = (rect.top + scrollTop) + 'px';
    slash.style.width = rect.width + 'px';
    slash.style.height = rect.height + 'px';
    slash.style.pointerEvents = 'none';
    slash.style.zIndex = '9999';
    
    const line = document.createElement('div');
    line.className = 'undertale-slash-line';
    slash.appendChild(line);
    
    document.body.appendChild(slash);
    
    // ボタン自体の揺れ（被弾ブレ）エフェクト
    targetButton.classList.add('undertale-hit-shake');
    
    setTimeout(() => {
      slash.remove();
      targetButton.classList.remove('undertale-hit-shake');
    }, 450);
  } catch (e) {
    console.log("エフェクト生成エラー:", e);
  }
}

// ── 🎯 【グローバルスイング（決定）ハンドラー】 ──
function handleGlobalSwing(playerKey) {
  const now = Date.now();
  
  // 1. スタート画面 ＆ 説明画面での「決定（斬る動作）」画面遷移
  if (currentActiveScreen === "startScreen" || currentActiveScreen === "guideScreen") {
    // 誤作動・連打防止のため1.5秒のクールダウン
    if (now - lastScreenTransitionTime < 1500) return;
    lastScreenTransitionTime = now;
    
    // 決定時に爽快感のある斬撃効果音を再生
    playWeaponSound("katana");
    
    if (currentActiveScreen === "startScreen") {
      console.log("スイング検知：スタート画面決定 -> 説明画面へ");
      const btn = document.querySelector('#startScreen .btn-primary');
      if (btn) triggerUndertaleSlash(btn);
      
      setTimeout(() => {
        switchScreen("guideScreen");
      }, 350); // エフェクトと揺れをしっかり見せるため350msディレイ
    } else if (currentActiveScreen === "guideScreen") {
      console.log("スイング検知：説明画面決定 -> 武器選択画面へ");
      const btn = document.querySelector('#guideScreen .btn-primary');
      if (btn) triggerUndertaleSlash(btn);
      
      setTimeout(() => {
        switchScreen("selectionScreen");
      }, 350); // エフェクトと揺れをしっかり見せるため350msディレイ
    }
    return;
  }
  
  // 2. バトルステージ中（playingフェーズ）のスイング攻撃
  if (gameStatus === "playing" && currentActiveScreen === "battleScreen") {
    handleSwing(playerKey);
  }
}

// ── 武器選択時の動的UI更新（ボタン点灯 ＆ プレビューテキスト更新） ──
function updateWeaponUI(playerKey, weaponKey) {
  const prefix = playerKey === 'player1' ? 'p1' : 'p2';
  const htmlWeaponKey = weaponKey === 'sword' ? 'katana' : (weaponKey === 'greatsword' ? 'taiken' : 'sabers');
  
  // ボタンの点灯切り替え
  const buttons = document.querySelectorAll(`#${prefix}-katana, #${prefix}-taiken, #${prefix}-sabers`);
  buttons.forEach(btn => btn.classList.remove('selected'));
  const activeBtn = document.getElementById(`${prefix}-${htmlWeaponKey}`);
  if (activeBtn) {
    activeBtn.classList.add('selected');
  }
  
  // プレビューテキストの更新
  const weaponNamesJP = { sword: "刀", greatsword: "大剣", lightsaber: "光剣" };
  const jpName = weaponNamesJP[weaponKey] || "選択中...";
  
  const previewEl = document.getElementById(`preview${playerKey === 'player1' ? 'P1' : 'P2'}`);
  if (previewEl) {
    previewEl.textContent = jpName;
  }
  
  const battleWeaponEl = document.getElementById(`battleWeapon${playerKey === 'player1' ? 'P1' : 'P2'}`);
  if (battleWeaponEl) {
    battleWeaponEl.textContent = jpName;
  }
}

// MoveNet COCO 17点 接続ライン
const SKELETON_CONNECTIONS = [
  [5, 6], // 両肩
  [5, 7], [7, 9], // 左腕
  [6, 8], [8, 10], // 右腕
  [5, 11], [6, 12], [11, 12], // 胴体
  [11, 13], [13, 15], // 左足
  [12, 14], [14, 16]  // 右足
];

// 武器選択用の固定ターゲット座標と半径の定義
const TARGET_RADIUS = 75; // 基本のターゲット円の半径 (75px) - 大幅に拡大して吸い付きやすく！
const KEEP_RADIUS = 120;  // キープ中の許容半径 (120px) - 見切れやブレでも外れないように！

const TARGETS = {
  player1: { // 画面左側（青）＝ 生画像の右側（x: 300）
    greatsword: { x: 300, y: 85 },   // 少し下げて届きやすく
    katana: { x: 300, y: 220 },      
    lightsaber: { x: 300, y: 145 }   
  },
  player2: { // 画面右側（赤）＝ 生画像の左側（x: 100）
    greatsword: { x: 100, y: 85 },   // 少し下げて届きやすく
    katana: { x: 100, y: 220 },
    lightsaber: { x: 100, y: 145 }
  }
};

// 直線距離計算
function getDistance(kp1, kp2) {
  try {
    if (!kp1 || !kp2 || kp1.score < 0.15 || kp2.score < 0.15) return Infinity;
    return Math.hypot(kp1.x - kp2.x, kp1.y - kp2.y);
  } catch (e) {
    return Infinity;
  }
}

// ベクトル内積角度（度数法）算出
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

// 各ポーズを基準とした動的な武器選択ターゲット座標と半径の計算
function getDynamicTargets(pose) {
  try {
    const leftShoulder = pose.keypoints[5];
    const rightShoulder = pose.keypoints[6];
    const leftHip = pose.keypoints[11];
    const rightHip = pose.keypoints[12];
    const nose = pose.keypoints[0];

    // 肩の中心点
    let playerCenterX = 200;
    let playerCenterY = 150;
    let hasShoulders = false;

    if (leftShoulder && rightShoulder && leftShoulder.score > 0.15 && rightShoulder.score > 0.15) {
      playerCenterX = (leftShoulder.x + rightShoulder.x) / 2;
      playerCenterY = (leftShoulder.y + rightShoulder.y) / 2;
      hasShoulders = true;
    } else if (nose && nose.score > 0.15) {
      playerCenterX = nose.x;
      playerCenterY = nose.y + 40;
    }

    // 体格（カメラとの距離）によるスケーリング比率の計算
    let scaleRatio = 1.0;
    if (hasShoulders) {
      const shoulderWidth = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y);
      scaleRatio = Math.max(0.6, Math.min(1.8, shoulderWidth / 85)); // 標準肩幅 85px を基準に制限をかける
    }

    // 鼻の座標フォールバック
    const noseY = (nose && nose.score > 0.15) ? nose.y : (playerCenterY - 40 * scaleRatio);

    // 大剣：頭（鼻）の上部
    const gsTarget = {
      x: playerCenterX,
      y: noseY - 55 * scaleRatio
    };

    // ライトセーバー：胸（肩中心より少し下）
    const lsTarget = {
      x: playerCenterX,
      y: playerCenterY + 30 * scaleRatio
    };

    // 刀：腰（股関節）の横
    let katanaLeftTarget = { x: playerCenterX - 45 * scaleRatio, y: playerCenterY + 90 * scaleRatio };
    let katanaRightTarget = { x: playerCenterX + 45 * scaleRatio, y: playerCenterY + 90 * scaleRatio };

    if (leftHip && rightHip && leftHip.score > 0.15 && rightHip.score > 0.15) {
      const hipY = (leftHip.y + rightHip.y) / 2;
      katanaLeftTarget = { x: leftHip.x - 20 * scaleRatio, y: hipY };
      katanaRightTarget = { x: rightHip.x + 20 * scaleRatio, y: hipY };
    }

    return {
      scaleRatio,
      greatsword: gsTarget,
      lightsaber: lsTarget,
      katanaLeft: katanaLeftTarget,
      katanaRight: katanaRightTarget
    };
  } catch (e) {
    console.error("getDynamicTargets エラー:", e);
    return {
      scaleRatio: 1.0,
      greatsword: { x: 200, y: 70 },
      lightsaber: { x: 200, y: 145 },
      katanaLeft: { x: 150, y: 220 },
      katanaRight: { x: 250, y: 220 }
    };
  }
}

// フェーズに応じたUI更新
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

// タイマー制御
function startTimer() {
  try {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (timeRemaining > 0) {
        timeRemaining--;
        timerEl.textContent = timeRemaining;
      } else {
        clearInterval(timerInterval);
        triggerBattleEndSequence();
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

// バトル開始（playingへ移行）
async function startMatch() {
  try {
    // 前回のバトル終了時の演出をクリーンアップ
    isBattleEndSequenceTriggered = false;
    const p1CardElement = document.getElementById("p1-battle-card");
    const p2CardElement = document.getElementById("p2-battle-card");
    if (p1CardElement) {
      p1CardElement.classList.remove("winner-active");
      p1CardElement.style.opacity = "1";
      p1CardElement.style.pointerEvents = "auto";
      const banner = p1CardElement.querySelector(".winner-banner");
      if (banner) banner.remove();
    }
    if (p2CardElement) {
      p2CardElement.classList.remove("winner-active");
      p2CardElement.style.opacity = "1";
      p2CardElement.style.pointerEvents = "auto";
      const banner = p2CardElement.querySelector(".winner-banner");
      if (banner) banner.remove();
    }
    const drawBanner = document.querySelector(".draw-banner");
    if (drawBanner) drawBanner.remove();
    document.querySelectorAll(".slice-container").forEach(c => c.remove());

    gameStatus = "playing";
    timeRemaining = 30;
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
      p1_score: 0,
      p2_score: 0,
      p1_weapon: selectionState.player1.selectedWeapon,
      p2_weapon: selectionState.player2.selectedWeapon,
      p1_vibrate: false,
      p2_vibrate: false
    }, { merge: true });

    startTimer();

    // バトル開始から【15秒が経過した瞬間】にバックグラウンド自動激写撮影タイマーを始動！
    if (photoCaptureTimeout) clearTimeout(photoCaptureTimeout);
    capturedPhotoData = null;
    photoCaptureTimeout = setTimeout(captureBattlePhoto, 15000);
  } catch (e) {
    console.error("startMatch エラー:", e);
  }
}

// スイング検知・送信
async function handleSwing(playerKey) {
  try {
    const now = Date.now();
    const state = playersState[playerKey];

    if (now - state.lastSwingTime < COOLDOWN_MS) return;
    state.lastSwingTime = now;
    
    // ローカルで検知したスイング時刻を記録（Firebase受信時の重複演出防止用）
    lastLocalSwingTimes[playerKey] = now;

    let weapon = "sword";
    if (playerKey === 'player1') {
      p1Score++;
      p1ScoreEl.textContent = p1Score;
      weapon = selectionState.player1.selectedWeapon || "sword";
      triggerSlash(1, weapon); // 音と演出を即時実行

      // スコアポップアップアニメーション
      p1ScoreEl.classList.remove('bump');
      void p1ScoreEl.offsetWidth;
      p1ScoreEl.classList.add('bump');
      setTimeout(() => p1ScoreEl.classList.remove('bump'), 100);
    } else {
      p2Score++;
      p2ScoreEl.textContent = p2Score;
      weapon = selectionState.player2.selectedWeapon || "sword";
      triggerSlash(2, weapon); // 音と演出を即時実行

      // スコアポップアップアニメーション
      p2ScoreEl.classList.remove('bump');
      void p2ScoreEl.offsetWidth;
      p2ScoreEl.classList.add('bump');
      setTimeout(() => p2ScoreEl.classList.remove('bump'), 100);
    }

    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, {
      [`${playerKey === 'player1' ? 'p1_score' : 'p2_score'}`]: increment(1)
    }, { merge: true });
  } catch (e) {
    console.error("Firestoreスコア送信エラー:", e);
  }
}

// 【極限吸い付き判定】減衰付き時間累積方式 ＆ 境界シールド（ヒステリシス）判定
function handleWeaponSelection(pose, playerKey, regStatusEl, cardEl) {
  try {
    const sel = selectionState[playerKey];
    if (sel.locked) return;

    const leftShoulder = pose.keypoints[5];
    const rightShoulder = pose.keypoints[6];
    const leftWrist = pose.keypoints[9];
    const rightWrist = pose.keypoints[10];
    const nose = pose.keypoints[0];

    // 肩の見切れに完全対応した、鼻・手首連携プレイヤー特定フォールバック
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

    // ── 人基準の相対座標から動的ターゲットを取得 ──
    const dTargets = getDynamicTargets(pose);
    const scaleRatio = dTargets.scaleRatio;

    // 現在吸い付き中の武器かどうかに応じて、判定半径を動的に決定（境界シールド）
    const getRadius = (weaponKey) => {
      const baseRadius = (sel.detectingWeapon === weaponKey) ? KEEP_RADIUS : TARGET_RADIUS;
      return baseRadius * scaleRatio;
    };

    let currentPoseDetecting = null;
    let debugTargetKp = null;
    let debugWristKp = null;
    let debugWristKp2 = null;

    // ── 1. 【ライトセーバー（中）】 ──
    // ライトセーバーの判定エリアが大きすぎて他の構え（刀など）に誤爆するのを防ぐため、独自の厳格な半径を適用
    const lsRadius = (sel.detectingWeapon === "lightsaber" ? 65 : 45) * scaleRatio;
    if (rightWrist && leftWrist && rightWrist.score > 0.15 && leftWrist.score > 0.15) {
      // 両手の中心（平均座標）で判定する！
      const centerWristX = (rightWrist.x + leftWrist.x) / 2;
      const centerWristY = (rightWrist.y + leftWrist.y) / 2;
      
      const dist = Math.hypot(centerWristX - dTargets.lightsaber.x, centerWristY - dTargets.lightsaber.y);
      // 両手で握る構えを厳密に判定するため、両手首の近接距離を 35px * scaleRatio に厳格化
      const wristsClose = Math.hypot(rightWrist.x - leftWrist.x, rightWrist.y - leftWrist.y) < (35 * scaleRatio);
      
      if (dist <= lsRadius && wristsClose) {
        currentPoseDetecting = "lightsaber";
        debugWristKp = rightWrist;
        debugWristKp2 = leftWrist;
        debugTargetKp = dTargets.lightsaber;
      }
    }

    // ── 2. 【大剣（上）】 ──
    const gsRadius = getRadius("greatsword");
    if (!currentPoseDetecting) {
      // 画面上部への見切れ対策：手首のy座標がターゲットy座標より高い（値が小さい）場合、yの距離は 0 とみなす（x座標の距離だけで判定する）
      const checkGSWrist = (wrist) => {
        if (!wrist || wrist.score <= 0.15) return false;
        const dx = wrist.x - dTargets.greatsword.x;
        const dy = wrist.y < dTargets.greatsword.y ? 0 : (wrist.y - dTargets.greatsword.y);
        return Math.hypot(dx, dy) <= gsRadius;
      };

      const isRightWristInGS = checkGSWrist(rightWrist);
      const isLeftWristInGS = checkGSWrist(leftWrist);
      
      // 肩の見切れ対策：肩が検出されないか、あるいは手首が肩より高い位置にある（15pxの許容誤差あり）
      const isRightWristAboveShoulder = !rightShoulder || rightShoulder.score <= 0.15 || (rightWrist && rightWrist.y < rightShoulder.y + 15);
      const isLeftWristAboveShoulder = !leftShoulder || leftShoulder.score <= 0.15 || (leftWrist && leftWrist.y < leftShoulder.y + 15);

      if (isRightWristInGS && isRightWristAboveShoulder) {
        currentPoseDetecting = "greatsword";
        debugWristKp = rightWrist;
        debugTargetKp = dTargets.greatsword;
      } else if (isLeftWristInGS && isLeftWristAboveShoulder) {
        currentPoseDetecting = "greatsword";
        debugWristKp = leftWrist;
        debugTargetKp = dTargets.greatsword;
      }
    }

    // ── 3. 【刀（下）】 ──
    const ktRadius = getRadius("sword");
    if (!currentPoseDetecting) {
      // 刀の構えの精度向上：腕をダラーンと下ろした誤検知を防ぐため、「肘が130度以下に曲がっている」ことを必須条件化！
      const leftElbow = pose.keypoints[7];
      const rightElbow = pose.keypoints[8];
      
      // 右手での刀の構え判定（右腰ターゲットを使用）
      let rightAngle = 180;
      if (rightShoulder && rightElbow && rightWrist) {
        rightAngle = getAngle(rightShoulder, rightElbow, rightWrist);
      }
      const isRightWristInKatana = rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - dTargets.katanaRight.x, rightWrist.y - dTargets.katanaRight.y) <= ktRadius;
      
      // 左手での刀の構え判定（左腰ターゲットを使用）
      let leftAngle = 180;
      if (leftShoulder && leftElbow && leftWrist) {
        leftAngle = getAngle(leftShoulder, leftElbow, leftWrist);
      }
      const isLeftWristInKatana = leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - dTargets.katanaLeft.x, leftWrist.y - dTargets.katanaLeft.y) <= ktRadius;

      if (isRightWristInKatana && rightAngle <= 130) {
        currentPoseDetecting = "sword";
        debugWristKp = rightWrist;
        debugTargetKp = dTargets.katanaRight;
      } else if (isLeftWristInKatana && leftAngle <= 130) {
        currentPoseDetecting = "sword";
        debugWristKp = leftWrist;
        debugTargetKp = dTargets.katanaLeft;
      }
    }

    const weaponNames = { sword: "刀", greatsword: "大剣", lightsaber: "ライトセーバー" };

    if (currentPoseDetecting) {
      const weaponNameJP = weaponNames[currentPoseDetecting];

      // 的に入っているため、外れた際の猶予タイマーをリセット
      sel.lostStartTime = 0;

      // 構えの進行に応じてリアルタイムにUI（ボタン点灯・プレビュー）を連動
      updateWeaponUI(playerKey, currentPoseDetecting);

      if (sel.detectingWeapon === currentPoseDetecting) {
        // 検知継続：時間経過分を加算 (1.5秒 = 1500ms で確実に100%確定へ)
        const now = Date.now();
        const dt = now - sel.lastActiveTime;
        sel.lastActiveTime = now;

        sel.accumulatedTime = Math.min(1500, (sel.accumulatedTime || 0) + dt);
        sel.progress = Math.min(100, Math.floor((sel.accumulatedTime / 1500) * 100));

        regStatusEl.textContent = `${weaponNameJP}の構え... (${sel.progress}%)`;
        regStatusEl.className = "reg-status detecting";



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

      // 外れてから 500ms（0.5秒）以内は、進捗を一切減らさず完璧にキープ！
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
        
        // 選択が完全に外れたらUIの選択状態もリセット
        const prefix = playerKey === 'player1' ? 'p1' : 'p2';
        const buttons = document.querySelectorAll(`#${prefix}-katana, #${prefix}-taiken, #${prefix}-sabers`);
        buttons.forEach(btn => btn.classList.remove('selected'));
        const previewEl = document.getElementById(`preview${playerKey === 'player1' ? 'P1' : 'P2'}`);
        if (previewEl) previewEl.textContent = "選択中...";
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
          p2_ready: false,
          p1_score: 0,
          p2_score: 0
        }); // merge: true を削除してデータベース上のゴミデータを毎回完全上書き消去！
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
    const leftWrist = pose.keypoints[9];
    const rightWrist = pose.keypoints[10];

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

    // しきい値を 0.13 に引き上げ、手を上にあげる際の微小なブレ誤検知を完全に防ぐ
    if (maxNormalizedDY > 0.13) {
      handleGlobalSwing(playerKey);
    }

    if (currentLeftWristY !== null) state.prevLeftWristY = currentLeftWristY;
    if (currentRightWristY !== null) state.prevRightWristY = currentRightWristY;
  } catch (e) {
    console.log("processMovementLogics エラー:", e);
  }
}

// ── 骨格＆デバッグ用の的（サークル）描画メイン ──
function drawSkeleton(poses) {
  try {
    // 描画エリアの完全クリーン
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // デバッグ用：Canvasがどこに重畳されているかを明示する薄いネオン枠線
    ctx.strokeStyle = "rgba(0, 242, 254, 0.45)";
    ctx.lineWidth = 3.0;
    ctx.strokeRect(0, 0, canvasElement.width, canvasElement.height);

    ctx.save();
    ctx.translate(canvasElement.width, 0);
    ctx.scale(-1, 1); // 鏡像変換

    // ── 🎯 骨格ロスト時でも「的（ガイド円）」を絶対に強制描画 ──
    // (追従型サークルは poses.forEach ループ内で人基準で描画されるため、この静的ループは不要になりました)

    // ── 骨格線 ＆ キーポイント描画 ──
    if (poses && poses.length > 0) {
      poses.forEach((pose) => {
        if (pose.score < 0.15) return;

        try {
          const leftShoulder = pose.keypoints[5];
          const rightShoulder = pose.keypoints[6];
          const nose = pose.keypoints[0];
          const leftWrist = pose.keypoints[9];
          const rightWrist = pose.keypoints[10];
          
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

          const isPlayer1 = poseCenterX > 200;
          const playerKey = isPlayer1 ? 'player1' : 'player2';
          const playerColor = isPlayer1 ? '#00f2fe' : '#f35588';
          const regStatusEl = isPlayer1 ? p1RegStatusEl : p2RegStatusEl;
          const cardEl = isPlayer1 ? p1Card : p2Card;

          // 骨格接続線の描画
          SKELETON_CONNECTIONS.forEach(([i, j]) => {
            try {
              const kp1 = pose.keypoints[i];
              const kp2 = pose.keypoints[j];
              if (kp1 && kp2 && kp1.score > 0.15 && kp2.score > 0.15) {
                ctx.beginPath();
                ctx.moveTo(kp1.x, kp1.y);
                ctx.lineTo(kp2.x, kp2.y);
                ctx.strokeStyle = playerColor;
                ctx.lineWidth = 4.5;
                ctx.lineCap = 'round';
                ctx.stroke();
              }
            } catch (connErr) {}
          });

          // 関節ドット描画
          pose.keypoints.forEach((kp, idx) => {
            try {
              if (kp.score > 0.15) { 
                ctx.beginPath();
                const isWrist = (idx === 9 || idx === 10);
                ctx.arc(kp.x, kp.y, isWrist ? 7 : 5, 0, 2 * Math.PI);
                ctx.fillStyle = isWrist ? '#ff3f34' : '#ffffff';
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
            ctx.fillText("READY!", 0, 0);
            ctx.restore();
          }

          // スイング検出（決定・攻撃）は常時裏でトラッキングを実行
          processMovementLogics(pose, playerKey);

          // 武器選択画面かつselectingフェーズのみ、体に追従する的（サークル）をリアルタイム描画！
          if (gameStatus === "selecting" && currentActiveScreen === "selectionScreen") {
            const dTargets = getDynamicTargets(pose);
            const scale = dTargets.scaleRatio;
            const selState = selectionState[playerKey];

            // サークル描画共通ヘルパー
            const drawTargetCircle = (center, active, defaultFill, defaultStroke, label, radius) => {
              try {
                ctx.beginPath();
                ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
                ctx.fillStyle = active ? 'rgba(46, 204, 113, 0.35)' : defaultFill;
                ctx.strokeStyle = active ? '#2ecc71' : defaultStroke;
                ctx.lineWidth = active ? 4.5 : 3.5;
                ctx.fill();
                ctx.stroke();

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

            const getDrawRadius = (wKey) => {
              if (wKey === "lightsaber") {
                const base = (selState.detectingWeapon === "lightsaber") ? 65 : 45;
                return base * scale;
              }
              const base = (selState.detectingWeapon === wKey) ? KEEP_RADIUS : TARGET_RADIUS;
              return base * scale;
            };

            // 1. 大剣的 (頭の上)
            const gsRad = getDrawRadius("greatsword");
            const gsActive = selState.detectingWeapon === "greatsword";
            drawTargetCircle(dTargets.greatsword, gsActive, 'rgba(255, 170, 0, 0.15)', '#ffaa00', "大剣の的", gsRad);

            // 2. ライトセーバー的 (胸の前)
            const lsRad = getDrawRadius("lightsaber");
            const lsActive = selState.detectingWeapon === "lightsaber";
            drawTargetCircle(dTargets.lightsaber, lsActive, 'rgba(0, 242, 254, 0.15)', '#00f2fe', "光剣の的", lsRad);

            // 3. 刀的 (腰の横)
            const ktRad = getDrawRadius("sword");
            const ktActive = selState.detectingWeapon === "sword";
            const ktTarget = isPlayer1 ? dTargets.katanaRight : dTargets.katanaLeft;
            drawTargetCircle(ktTarget, ktActive, 'rgba(255, 65, 108, 0.15)', '#ff416c', "刀の的", ktRad);
          }

          // 武器選択画面にいる時のみ、構えの吸い付き判定を行う
          if (gameStatus === "selecting" && currentActiveScreen === "selectionScreen") {
            handleWeaponSelection(pose, playerKey, regStatusEl, cardEl);
          }
        } catch (poseInnerErr) {
          console.log("各骨格の内部描画処理エラー:", poseInnerErr);
        }
      });
    }

    // バトル終了時のホーム戻りバンザイ監視を稼働
    checkHomeReturnGesture(poses);

    ctx.restore();
  } catch (globalDrawErr) {
    console.log("drawSkeleton 全体エラー:", globalDrawErr);
  }
}

// ── 💡 MoveNet 検出器インスタンス ──
let poseDetector = null;

// ── 💡 2人同時検出ループ（Webカメラフレーム毎に実行） ──
async function detectionLoop() {
  if (!isDetecting) return;
  
  try {
    // 2人同時にポーズを推定
    const rawPoses = await poseDetector.estimatePoses(videoElement, {
      maxPoses: 2, // 同時に最大2人まで追跡
      flipHorizontal: false
    });
    
    const poses = rawPoses.map(pose => {
      return {
        score: pose.score,
        keypoints: pose.keypoints.map(kp => ({
          x: kp.x,
          y: kp.y,
          score: kp.score || 1.0 // 描画ロスト防止
        }))
      };
    }).slice(0, 2); // 確実に最大2人までに制限！
    
    // 検出インジケーターと状態の更新
    if (poses.length > 0) {
      statusDot.classList.add('active');
      statusText.textContent = `骨格検出中 (同時${poses.length}人ロックオン)`;
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = "カメラの前に立ってください";
      if (gameStatus === "selecting") {
        resetSelectionIfAbsent('player1', p1RegStatusEl, p1Card);
        resetSelectionIfAbsent('player2', p2RegStatusEl, p2Card);
      }
    }
    
    // 骨格および的の強制描画を実行！
    drawSkeleton(poses);
  } catch (err) {
    console.log("detectionLoop エラー:", err);
  }
  
  // 次フレームの呼び出し
  if (isDetecting) {
    requestAnimationFrame(detectionLoop);
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

// ── 検出器初期化（MoveNet MultiPose 超安定マルチポーズエンジン） ──
async function initPoseBattleSystem() {
  try {
    setupStatus.textContent = "Firebase環境変数をロード中...";
    if (!db) {
      const firebaseConfig = await loadFirebaseConfig();
      app = initializeApp(firebaseConfig);
      db = getFirestore(app);
    }
    setupStatus.textContent = "MoveNet 超軽量マルチポーズエンジンをロード中...";

    // SDKのロード状態を確実にチェックし、親切なエラーを投げる
    if (typeof poseDetection === 'undefined' || typeof tf === 'undefined') {
      throw new Error("MoveNet (poseDetection) または TensorFlow.js がブラウザにロードされていません。インターネット接続状態を確認してください。");
    }

    // TensorFlow backend WebGL の初期化
    await tf.ready();
    await tf.setBackend('webgl');

    // MoveNet MultiPose 検出器の生成
    poseDetector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableSmoothing: true
      }
    );

    setupStatus.textContent = "Webカメラを起動中...";

    // 標準のMediaDevicesを用いて、400x300アスペクト比でカメラ取得
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 400, height: 300, facingMode: "user" },
      audio: false
    });
    videoElement.srcObject = stream;
    
    // カメラのストリーム再生開始時に検出ループを始動する
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
      p1_score: 0,
      p2_score: 0
    }, { merge: true });

    setupFirestoreListener();

    isDetecting = true;
    
    // 検出ループを始動！
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

// ── 🙌 ホーム戻りバンザイジェスチャーステート ──
const homeReturnState = {
  accumulatedTime: 0,
  lastActiveTime: 0,
  progress: 0
};

// 両手を上げている（バンザイ）のジェスチャー判定
function isHandsUp(pose) {
  try {
    const leftShoulder = pose.keypoints[5];
    const rightShoulder = pose.keypoints[6];
    const leftWrist = pose.keypoints[9];
    const rightWrist = pose.keypoints[10];
    const nose = pose.keypoints[0];

    if (!leftWrist || !rightWrist || leftWrist.score < 0.15 || rightWrist.score < 0.15) {
      return false;
    }

    let baseRefY = 150;
    if (leftShoulder && rightShoulder && leftShoulder.score > 0.15 && rightShoulder.score > 0.15) {
      baseRefY = (leftShoulder.y + rightShoulder.y) / 2;
    } else if (nose && nose.score > 0.15) {
      baseRefY = nose.y + 30;
    }

    // 両手首が肩または鼻の基準座標よりも40px以上高いこと
    return leftWrist.y < (baseRefY - 40) && rightWrist.y < (baseRefY - 40);
  } catch (e) {
    return false;
  }
}

// バトル終了後のホーム戻りジェスチャーの毎フレーム判定
function checkHomeReturnGesture(poses) {
  if (gameStatus !== "finished" || !isBattleEndSequenceTriggered) return;
  
  const banner = document.getElementById("home-return-banner");
  if (!banner || !banner.classList.contains("active")) return;

  let anyPlayerHandsUp = false;
  if (poses && poses.length > 0) {
    poses.forEach(pose => {
      if (pose.score > 0.15 && isHandsUp(pose)) {
        anyPlayerHandsUp = true;
      }
    });
  }

  const progressEl = document.getElementById("home-return-progress");

  if (anyPlayerHandsUp) {
    const now = Date.now();
    if (homeReturnState.lastActiveTime === 0) {
      homeReturnState.lastActiveTime = now;
    }
    const dt = now - homeReturnState.lastActiveTime;
    homeReturnState.lastActiveTime = now;

    homeReturnState.accumulatedTime = Math.min(1500, homeReturnState.accumulatedTime + dt);
    homeReturnState.progress = Math.min(100, Math.floor((homeReturnState.accumulatedTime / 1500) * 100));

    if (progressEl) {
      progressEl.textContent = `RESETTING... ${homeReturnState.progress}%`;
    }

    if (homeReturnState.accumulatedTime >= 1500) {
      resetToHome();
    }
  } else {
    const now = Date.now();
    const dt = homeReturnState.lastActiveTime ? (now - homeReturnState.lastActiveTime) : 0;
    homeReturnState.lastActiveTime = now;

    homeReturnState.accumulatedTime = Math.max(0, homeReturnState.accumulatedTime - dt * 0.5);
    homeReturnState.progress = Math.min(100, Math.floor((homeReturnState.accumulatedTime / 1500) * 100));

    if (progressEl) {
      if (homeReturnState.progress > 0) {
        progressEl.textContent = `RESETTING... ${homeReturnState.progress}%`;
      } else {
        progressEl.textContent = "🙌 両手を上げ続けるとホームに戻ります";
      }
    }
  }
}

// 全ての状態をリセットしてホーム（スタート画面）へ戻す
async function resetToHome() {
  console.log("🔄 ホーム（スタート画面）へリセットします 🔄");
  
  isBattleEndSequenceTriggered = false;
  isTransitioningToBattle = false;
  
  homeReturnState.accumulatedTime = 0;
  homeReturnState.lastActiveTime = 0;
  homeReturnState.progress = 0;
  
  gameStatus = "selecting";
  timeRemaining = 30;
  
  p1Score = 0;
  p2Score = 0;
  p1ScoreEl.textContent = 0;
  p2ScoreEl.textContent = 0;

  // 選択進捗の初期化
  selectionState.player1 = { locked: false, selectedWeapon: null, detectingWeapon: null, lastActiveTime: 0, accumulatedTime: 0, progress: 0, lostStartTime: 0 };
  selectionState.player2 = { locked: false, selectedWeapon: null, detectingWeapon: null, lastActiveTime: 0, accumulatedTime: 0, progress: 0, lostStartTime: 0 };

  const previewP1 = document.getElementById("previewP1");
  const previewP2 = document.getElementById("previewP2");
  if (previewP1) previewP1.textContent = "選択中...";
  if (previewP2) previewP2.textContent = "選択中...";

  const battleWeaponP1 = document.getElementById("battleWeaponP1");
  const battleWeaponP2 = document.getElementById("battleWeaponP2");
  if (battleWeaponP1) battleWeaponP1.textContent = "未確定";
  if (battleWeaponP2) battleWeaponP2.textContent = "未確定";

  const p1CardElement = document.getElementById("p1-battle-card");
  const p2CardElement = document.getElementById("p2-battle-card");
  if (p1CardElement) {
    p1CardElement.classList.remove("winner-active");
    p1CardElement.style.opacity = "1";
    p1CardElement.style.pointerEvents = "auto";
    const banner = p1CardElement.querySelector(".winner-banner");
    if (banner) banner.remove();
  }
  if (p2CardElement) {
    p2CardElement.classList.remove("winner-active");
    p2CardElement.style.opacity = "1";
    p2CardElement.style.pointerEvents = "auto";
    const banner = p2CardElement.querySelector(".winner-banner");
    if (banner) banner.remove();
  }

  // 📸 写真関連のクリーンアップ
  if (photoCaptureTimeout) clearTimeout(photoCaptureTimeout);
  capturedPhotoData = null;
  document.querySelectorAll(".winner-photo-container").forEach(c => c.remove());

  const drawBanner = document.querySelector(".draw-banner");
  if (drawBanner) drawBanner.remove();
  
  const returnBanner = document.getElementById("home-return-banner");
  if (returnBanner) returnBanner.remove();
  
  document.querySelectorAll(".slice-container").forEach(c => c.remove());

  // 画面遷移
  switchScreen('startScreen');
  updatePhaseUI();

  // モーションキャプチャ再起動
  isDetecting = true;
  requestAnimationFrame(detectionLoop);

  // Firestoreリセット
  try {
    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, {
      status: "selecting",
      match_status: "selecting",
      p1_ready: false,
      p2_ready: false,
      p1_score: 0,
      p2_score: 0,
      winner: ""
    }, { merge: true });
  } catch (e) {
    console.error("Firestoreリセットエラー:", e);
  }
}

// ── 📸 バトル中（15秒経過時点）の自動写真撮影（キャプチャ） ──
function captureBattlePhoto() {
  if (gameStatus !== "playing") return;
  console.log("📸 シャッターチャンス！自動撮影を実行します 📸");

  try {
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = videoElement.videoWidth || 400;
    captureCanvas.height = videoElement.videoHeight || 300;
    const captureCtx = captureCanvas.getContext("2d");

    // ビデオ表示と全く同じミラー反転設定で Canvas に複写
    captureCtx.translate(captureCanvas.width, 0);
    captureCtx.scale(-1, 1);
    captureCtx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);

    capturedPhotoData = captureCanvas.toDataURL("image/jpeg", 0.85);
    console.log("📸 バトル写真のキャプチャに成功しました 📸");

    // 激写フラッシュ演出（画面全体を一瞬白くする）
    document.body.classList.add("photo-flash");
    
    // シャッター音的な効果音（刀の音 katana）を再生
    playWeaponSound("katana");

    setTimeout(() => {
      document.body.classList.remove("photo-flash");
    }, 150);

  } catch (e) {
    console.error("写真キャプチャエラー:", e);
  }
}

// ── 📸 勝者側の領域を Canvas でトリミング ──
function cropWinnerPhoto(playerNum) {
  if (!capturedPhotoData) return Promise.resolve(null);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = 200;
        cropCanvas.height = 240;
        const cropCtx = cropCanvas.getContext("2d");

        // 元画像（ミラー全体 400x300）から勝者側（左半分または右半分）を切り抜き
        // P1（画面左）＝ ミラー画像の左半分 (x: 0〜200)
        // P2（画面右）＝ ミラー画像の右半分 (x: 200〜400)
        const sourceX = playerNum === 1 ? 0 : 200;
        const sourceY = 30; // 肩から顔が綺麗に収まる範囲
        const sourceWidth = 200;
        const sourceHeight = 240;

        cropCtx.drawImage(
          img,
          sourceX, sourceY, sourceWidth, sourceHeight,
          0, 0, cropCanvas.width, cropCanvas.height
        );

        resolve(cropCanvas.toDataURL("image/jpeg", 0.9));
      } catch (e) {
        console.error("トリミングエラー:", e);
        resolve(capturedPhotoData); // エラー時は全体を返す
      }
    };
    img.onerror = () => {
      resolve(null);
    };
    img.src = capturedPhotoData;
  });
}

// ── 💀 バトル終了時の勝利演出（敗者パネル両断・落下 ＆ 勝者お祝い） ──
let isBattleEndSequenceTriggered = false; // 二重実行防止用

async function triggerBattleEndSequence() {
  if (isBattleEndSequenceTriggered) return;
  isBattleEndSequenceTriggered = true;

  console.log("🏆 バトル終了演出シーケンス開始 🏆");
  
  // ゲームの状態を完全に終了にする
  gameStatus = "finished";
  updatePhaseUI();
  if (timerInterval) clearInterval(timerInterval);
  isDetecting = false;

  // 1. スコア判定
  const p1FinalScore = p1Score;
  const p2FinalScore = p2Score;
  console.log(`最終スコア - P1: ${p1FinalScore} / P2: ${p2FinalScore}`);

  const p1CardElement = document.getElementById("p1-battle-card");
  const p2CardElement = document.getElementById("p2-battle-card");
  const arena = document.querySelector(".battle-arena");

  if (!p1CardElement || !p2CardElement || !arena) {
    console.error("バトルパネルの要素が見つかりません。");
    return;
  }

  // バトル終了の共通効果音（大剣の一撃音など）
  playWeaponSound("taiken");

  if (p1FinalScore === p2FinalScore) {
    // ── 引き分け（DRAW）の場合 ──
    console.log("判定：引き分け");
    
    // DRAW バナーを生成
    const drawBanner = document.createElement("div");
    drawBanner.className = "draw-banner";
    drawBanner.textContent = "DRAW";
    arena.appendChild(drawBanner);

    // 引き分け時のサウンド
    setTimeout(() => {
      playWeaponSound("katana");
    }, 400);

  } else {
    // ── 勝敗が決まった場合 ──
    const isP1Winner = p1FinalScore > p2FinalScore;
    const winnerCard = isP1Winner ? p1CardElement : p2CardElement;
    const loserCard = isP1Winner ? p2CardElement : p1CardElement;
    const winnerName = isP1Winner ? "PLAYER 1" : "PLAYER 2";
    const loserName = isP1Winner ? "PLAYER 2" : "PLAYER 1";
    const winnerWeapon = isP1Winner ? (selectionState.player1.selectedWeapon || "sword") : (selectionState.player2.selectedWeapon || "sword");

    console.log(`勝者: ${winnerName} / 敗者: ${loserName}`);

    // (1) 敗者カードに真っ二つのスライス線を走らせる
    const loserRect = loserCard.getBoundingClientRect();
    const slash = document.createElement('div');
    slash.className = 'undertale-slash';
    
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    slash.style.position = 'absolute';
    slash.style.left = (loserRect.left + scrollLeft) + 'px';
    slash.style.top = (loserRect.top + scrollTop) + 'px';
    slash.style.width = loserRect.width + 'px';
    slash.style.height = loserRect.height + 'px';
    slash.style.pointerEvents = 'none';
    slash.style.zIndex = '9999';
    
    const line = document.createElement('div');
    line.className = 'undertale-slash-line';
    line.style.backgroundColor = '#ff416c'; // 敗者のスライス線はネオンレッド
    line.style.boxShadow = '0 0 20px #ff003c, 0 0 10px #fff';
    slash.appendChild(line);
    document.body.appendChild(slash);

    // 敗者カードの被弾シェイク
    loserCard.classList.add('undertale-hit-shake');

    // (2) 250ms後に、敗者カードをクリップパスで分割したダミー破片要素に置き換え
    setTimeout(() => {
      slash.remove();
      loserCard.classList.remove('undertale-hit-shake');
      
      // 元のカードを透明にして見えなくする
      loserCard.style.opacity = "0";
      loserCard.style.pointerEvents = "none";

      // 破片用コンテナを生成
      const sliceContainer = document.createElement("div");
      sliceContainer.className = "slice-container";
      sliceContainer.style.left = loserCard.offsetLeft + "px";
      sliceContainer.style.top = loserCard.offsetTop + "px";
      sliceContainer.style.width = loserCard.offsetWidth + "px";
      sliceContainer.style.height = loserCard.offsetHeight + "px";

      // 右上破片の生成
      const pieceTop = document.createElement("div");
      pieceTop.className = "slice-piece piece-top";
      pieceTop.innerHTML = loserCard.innerHTML;
      
      // 左下破片の生成
      const pieceBottom = document.createElement("div");
      pieceBottom.className = "slice-piece piece-bottom";
      pieceBottom.innerHTML = loserCard.innerHTML;

      sliceContainer.appendChild(pieceTop);
      sliceContainer.appendChild(pieceBottom);
      arena.appendChild(sliceContainer);

      // 両断音を再生
      playWeaponSound("taiken");

      // 破片が落ちきった後のゴミ掃除 (1.5秒後)
      setTimeout(() => {
        sliceContainer.remove();
      }, 1500);

    }, 250);

    // (3) 敗者落下中 (700ms後) に勝者側の超プレミアムお祝い演出を始動
    setTimeout(async () => {
      // 勝者カードを光り輝かせて大きくする
      winnerCard.classList.add("winner-active");

      // 王冠 ＆ WINNER バナーをポップアップ
      const banner = document.createElement("div");
      banner.className = "winner-banner";
      banner.innerHTML = "👑 WINNER 👑";
      winnerCard.appendChild(banner);

      // 📸 勝者の写真をトリミングしてカード内に挿入！
      if (capturedPhotoData) {
        const croppedSrc = await cropWinnerPhoto(isP1Winner ? 1 : 2);
        if (croppedSrc) {
          const photoContainer = document.createElement("div");
          photoContainer.className = "winner-photo-container";
          photoContainer.innerHTML = `
            <div class="winner-photo-title">BATTLE MOMENT</div>
            <img class="winner-photo-neon" src="${croppedSrc}" alt="Winner Photo" />
          `;
          winnerCard.appendChild(photoContainer);
          
          requestAnimationFrame(() => {
            photoContainer.classList.add("active");
          });
        }
      }

      // 勝者の武器効果音でお祝い！
      playWeaponSound(winnerWeapon);

      // 振動 (対応端末のみ)
      if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200, 100, 300]);
      }
    }, 700);
  }

  // 2. Firestoreに勝敗ステータスを書き込む
  try {
    const battleDocRef = doc(db, "shinken_rooms", "battle");
    await setDoc(battleDocRef, {
      status: "finished",
      match_status: "finished",
      winner: p1FinalScore === p2FinalScore ? "draw" : (p1FinalScore > p2FinalScore ? "player1" : "player2")
    }, { merge: true });
  } catch (e) {
    console.error("Firestore終了ステータス書き込みエラー:", e);
  }

  // 3. ホームへ戻るための案内バナーを表示する（勝利演出等の完了を見計らってディレイ表示）
  setTimeout(() => {
    const existing = document.getElementById("home-return-banner");
    if (existing) existing.remove();

    const returnBanner = document.createElement("div");
    returnBanner.id = "home-return-banner";
    returnBanner.className = "home-return-banner";
    returnBanner.innerHTML = `
      🙌 ホームに戻るには両手を上げてください
      <span id="home-return-progress" class="home-return-progress">🙌 両手を上げ続けるとホームに戻ります</span>
    `;
    arena.appendChild(returnBanner);

    // 次のフレームでアクティブにして滑らかにフェードイン
    requestAnimationFrame(() => {
      returnBanner.classList.add("active");
    });

    // 案内完了のため、再度モーションキャプチャのポーズ検知を一時的にONにし、バンザイ監視を稼働する
    isDetecting = true;
    requestAnimationFrame(detectionLoop);
  }, 1800);
}

// ── 💡 1回生UI合体用の受け皿関数 ──
export function updateP1HealthGauge(score) {
  console.log("[受け皿関数] updateP1HealthGauge スコア:", score);
}

export function updateP2HealthGauge(score) {
  console.log("[受け皿関数] updateP2HealthGauge スコア:", score);
}

export function switchToBattleScreen() {
  console.log("[受け皿関数] switchToBattleScreen がキックされました。");
  try {
    statusText.textContent = "🔥 STEP 3: 斬撃連打！叩き込め！";
    if (phaseTitleEl) phaseTitleEl.textContent = "フェーズ：バトル中！";
    
    // バトル画面への完璧な画面切り替えを実行
    switchScreen('battleScreen');
  } catch (e) {
    console.error("switchToBattleScreen UI更新エラー:", e);
  }
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

          if (data.p1_ready === true && data.p2_ready === true && !isTransitioningToBattle) {
            isTransitioningToBattle = true;
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

        // スコア同期時の演出＆重複防止ロジック
        if (data.p1_score !== undefined && data.p1_score !== p1Score && gameStatus === "playing") {
          p1Score = data.p1_score;
          p1ScoreEl.textContent = p1Score;
          updateP1HealthGauge(p1Score);

          // 重複防止：直近にローカルで検知したスイングでなければ音と演出を再生
          if (Date.now() - lastLocalSwingTimes.player1 > 400) {
            const weapon = data.p1_weapon || selectionState.player1.selectedWeapon || "sword";
            triggerSlash(1, weapon);
            
            p1ScoreEl.classList.remove('bump');
            void p1ScoreEl.offsetWidth;
            p1ScoreEl.classList.add('bump');
            setTimeout(() => p1ScoreEl.classList.remove('bump'), 100);
          }
        }

        if (data.p2_score !== undefined && data.p2_score !== p2Score && gameStatus === "playing") {
          p2Score = data.p2_score;
          p2ScoreEl.textContent = p2Score;
          updateP2HealthGauge(p2Score);

          // 重複防止：直近にローカルで検知したスイングでなければ音と演出を再生
          if (Date.now() - lastLocalSwingTimes.player2 > 400) {
            const weapon = data.p2_weapon || selectionState.player2.selectedWeapon || "sword";
            triggerSlash(2, weapon);
            
            p2ScoreEl.classList.remove('bump');
            void p2ScoreEl.offsetWidth;
            p2ScoreEl.classList.add('bump');
            setTimeout(() => p2ScoreEl.classList.remove('bump'), 100);
          }
        }

        if ((data.status === "finished" || data.match_status === "finished") && gameStatus !== "finished") {
          triggerBattleEndSequence();
        }
      }
    });
  } catch (e) {
    console.log("Firestore監視エラー:", e);
  }
}

// ── 🚀 起動時に自動でモーションキャプチャー（MediaPipe ＆ カメラ）を起動 ──
document.addEventListener('DOMContentLoaded', () => {
  console.log("アプリ起動：モーションキャプチャーを自動起動します。");
  setTimeout(() => {
    initPoseBattleSystem().catch(err => {
      console.error("自動初期化エラー（ユーザー操作待ちなどの可能性）:", err);
    });
  }, 800); // ロード直後の競合を防ぐため少しディレイを置く
});
