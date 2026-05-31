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

// ── ゲーム状態管理 ──
let gameStatus = "selecting";
let timeRemaining = 90;
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
      switchScreen("guideScreen");
    } else if (currentActiveScreen === "guideScreen") {
      console.log("スイング検知：説明画面決定 -> 武器選択画面へ");
      switchScreen("selectionScreen");
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

// 武器選択用の固定ターゲット座標と半径の定義
const TARGET_RADIUS = 55; // 基本のターゲット円の半径 (55px)
const KEEP_RADIUS = 95;   // キープ中の許容半径 (95px) - 吸い付き境界シールド

const TARGETS = {
  player1: { // 画面左側（青）＝ 生画像の右側（x: 300）
    greatsword: { x: 300, y: 70 },   
    katana: { x: 300, y: 220 },      
    lightsaber: { x: 300, y: 145 }   
  },
  player2: { // 画面右側（赤）＝ 生画像の左側（x: 100）
    greatsword: { x: 100, y: 70 },
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

// バトル開始（playingへ移行）
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
      [`${playerKey === 'player1' ? 'player1_score' : 'player2_score'}`]: increment(1)
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

    const leftShoulder = pose.keypoints[11];
    const rightShoulder = pose.keypoints[12];
    const leftWrist = pose.keypoints[15];
    const rightWrist = pose.keypoints[16];
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

    const isP1 = poseCenterX > 200; // ミラー反転：生画像で右側(x > 200)の人が、画面上では左側（Player 1）に映る

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
      // 大剣の構えの精度向上：手が肩より高い位置（y座標が肩より小さい）にあることを必須条件化！
      const isRightWristInGS = rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.greatsword.x, rightWrist.y - t.greatsword.y) <= gsRadius;
      const isLeftWristInGS = leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.greatsword.x, leftWrist.y - t.greatsword.y) <= gsRadius;
      
      const isRightWristAboveShoulder = rightShoulder && rightWrist && rightWrist.y < rightShoulder.y;
      const isLeftWristAboveShoulder = leftShoulder && leftWrist && leftWrist.y < leftShoulder.y;

      if (isRightWristInGS && isRightWristAboveShoulder) {
        currentPoseDetecting = "greatsword";
        debugWristKp = rightWrist;
        debugTargetKp = t.greatsword;
      } else if (isLeftWristInGS && isLeftWristAboveShoulder) {
        currentPoseDetecting = "greatsword";
        debugWristKp = leftWrist;
        debugTargetKp = t.greatsword;
      }
    }

    // ── 3. 【刀（下）】 ──
    const ktRadius = getRadius("sword");
    if (!currentPoseDetecting) {
      // 刀の構えの精度向上：腕をダラーンと下ろした誤検知を防ぐため、「肘が130度以下に曲がっている」ことを必須条件化！
      const leftElbow = pose.keypoints[13];
      const rightElbow = pose.keypoints[14];
      
      // 右手での刀の構え判定
      let rightAngle = 180;
      if (rightShoulder && rightElbow && rightWrist) {
        rightAngle = getAngle(rightShoulder, rightElbow, rightWrist);
      }
      const isRightWristInKatana = rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.katana.x, rightWrist.y - t.katana.y) <= ktRadius;
      
      // 左手での刀の構え判定
      let leftAngle = 180;
      if (leftShoulder && leftElbow && leftWrist) {
        leftAngle = getAngle(leftShoulder, leftElbow, leftWrist);
      }
      const isLeftWristInKatana = leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.katana.x, leftWrist.y - t.katana.y) <= ktRadius;

      if (isRightWristInKatana && rightAngle <= 130) {
        currentPoseDetecting = "sword";
        debugWristKp = rightWrist;
        debugTargetKp = t.katana;
      } else if (isLeftWristInKatana && leftAngle <= 130) {
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
    if (gameStatus === "selecting") {
      let p1GS_Active = false;
      let p1KT_Active = false;
      let p1LS_Active = false;

      let p2GS_Active = false;
      let p2KT_Active = false;
      let p2LS_Active = false;

      if (poses && poses.length > 0) {
        poses.forEach((pose) => {
          if (pose.score < 0.15) return;
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

            const isP1 = poseCenterX > 200;
            const selState = isP1 ? selectionState.player1 : selectionState.player2;

            const getDrawRadius = (wKey) => {
              return (selState.detectingWeapon === wKey) ? KEEP_RADIUS : TARGET_RADIUS;
            };

            if (isP1) {
              const t = TARGETS.player1;
              const lsRad = getDrawRadius("lightsaber");
              const gsRad = getDrawRadius("greatsword");
              const ktRad = getDrawRadius("sword");

              if (rightWrist && leftWrist && rightWrist.score > 0.15 && leftWrist.score > 0.15) {
                const rDist = Math.hypot(rightWrist.x - t.lightsaber.x, rightWrist.y - t.lightsaber.y);
                const lDist = Math.hypot(leftWrist.x - t.lightsaber.x, leftWrist.y - t.lightsaber.y);
                if (rDist <= lsRad && lDist <= lsRad) {
                  p1LS_Active = true;
                }
              }
              const isRightWristInGS = rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.greatsword.x, rightWrist.y - t.greatsword.y) <= gsRad;
              const isLeftWristInGS = leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.greatsword.x, leftWrist.y - t.greatsword.y) <= gsRad;
              const isRightWristAboveShoulder = rightShoulder && rightWrist && rightWrist.y < rightShoulder.y;
              const isLeftWristAboveShoulder = leftShoulder && leftWrist && leftWrist.y < leftShoulder.y;

              if (isRightWristInGS && isRightWristAboveShoulder) p1GS_Active = true;
              if (isLeftWristInGS && isLeftWristAboveShoulder) p1GS_Active = true;

              const leftElbow = pose.keypoints[13];
              const rightElbow = pose.keypoints[14];
              
              let rightAngle = 180;
              if (rightShoulder && rightElbow && rightWrist) {
                rightAngle = getAngle(rightShoulder, rightElbow, rightWrist);
              }
              let leftAngle = 180;
              if (leftShoulder && leftElbow && leftWrist) {
                leftAngle = getAngle(leftShoulder, leftElbow, leftWrist);
              }

              if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.katana.x, rightWrist.y - t.katana.y) <= ktRad && rightAngle <= 130) {
                p1KT_Active = true;
              }
              if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.katana.x, leftWrist.y - t.katana.y) <= ktRad && leftAngle <= 130) {
                p1KT_Active = true;
              }
            } else {
              const t = TARGETS.player2;
              const lsRad = getDrawRadius("lightsaber");
              const gsRad = getDrawRadius("greatsword");
              const ktRad = getDrawRadius("sword");

              if (rightWrist && leftWrist && rightWrist.score > 0.15 && leftWrist.score > 0.15) {
                const rDist = Math.hypot(rightWrist.x - t.lightsaber.x, rightWrist.y - t.lightsaber.y);
                const lDist = Math.hypot(leftWrist.x - t.lightsaber.x, leftWrist.y - t.lightsaber.y);
                if (rDist <= lsRad && lDist <= lsRad) {
                  p2LS_Active = true;
                }
              }
              const isRightWristInGS = rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.greatsword.x, rightWrist.y - t.greatsword.y) <= gsRad;
              const isLeftWristInGS = leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.greatsword.x, leftWrist.y - t.greatsword.y) <= gsRad;
              const isRightWristAboveShoulder = rightShoulder && rightWrist && rightWrist.y < rightShoulder.y;
              const isLeftWristAboveShoulder = leftShoulder && leftWrist && leftWrist.y < leftShoulder.y;

              if (isRightWristInGS && isRightWristAboveShoulder) p2GS_Active = true;
              if (isLeftWristInGS && isLeftWristAboveShoulder) p2GS_Active = true;

              const leftElbow = pose.keypoints[13];
              const rightElbow = pose.keypoints[14];
              
              let rightAngle = 180;
              if (rightShoulder && rightElbow && rightWrist) {
                rightAngle = getAngle(rightShoulder, rightElbow, rightWrist);
              }
              let leftAngle = 180;
              if (leftShoulder && leftElbow && leftWrist) {
                leftAngle = getAngle(leftShoulder, leftElbow, leftWrist);
              }

              if (rightWrist && rightWrist.score > 0.15 && Math.hypot(rightWrist.x - t.katana.x, rightWrist.y - t.katana.y) <= ktRad && rightAngle <= 130) {
                p2KT_Active = true;
              }
              if (leftWrist && leftWrist.score > 0.15 && Math.hypot(leftWrist.x - t.katana.x, leftWrist.y - t.katana.y) <= ktRad && leftAngle <= 130) {
                p2KT_Active = true;
              }
            }
          } catch (poseErr) {
            console.log("当たり判定エラー:", poseErr);
          }
        });
      }

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


    }

    // ── 骨格線 ＆ キーポイント描画 ──
    if (poses && poses.length > 0) {
      poses.forEach((pose) => {
        if (pose.score < 0.15) return;

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
                const isWrist = (idx === 15 || idx === 16);
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

          // 武器選択画面にいる時のみ、構えの吸い付き判定を行う
          if (gameStatus === "selecting" && currentActiveScreen === "selectionScreen") {
            handleWeaponSelection(pose, playerKey, regStatusEl, cardEl);
          }
        } catch (poseInnerErr) {
          console.log("各骨格の内部描画処理エラー:", poseInnerErr);
        }
      });
    }

    ctx.restore();
  } catch (globalDrawErr) {
    console.log("drawSkeleton 全体エラー:", globalDrawErr);
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
        score: 1.0,
        keypoints: results.poseLandmarks.map((lm) => ({
          x: lm.x * 400,
          y: lm.y * 300,
          score: 1.0 // 見切れや隠れ部位による描画ロストを防ぐため、キーポイントのスコアを強制的に1.0に固定！
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
    console.log("onPoseResults エラー:", err);
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

    // SDKのロード状態を確実にチェックし、親切なエラーを投げる
    if (typeof Pose === 'undefined' || typeof Camera === 'undefined') {
      throw new Error("MediaPipe SDK (Pose または Camera) がブラウザにロードされていません。インターネット接続状態を確認するか、ブラウザキャッシュをクリアして再読み込みしてください。");
    }

    // 最高の起動率・描画安定性を誇るバニラ（生の公式SDK）を初期化
    poseEngine = new Pose({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
      }
    });

    poseEngine.setOptions({
      modelComplexity: 1, // 0: Lite, 1: Full
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
        if (data.player1_score !== undefined && data.player1_score !== p1Score && gameStatus === "playing") {
          p1Score = data.player1_score;
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

        if (data.player2_score !== undefined && data.player2_score !== p2Score && gameStatus === "playing") {
          p2Score = data.player2_score;
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
          gameStatus = "finished";
          updatePhaseUI();
          if (timerInterval) clearInterval(timerInterval);
          isDetecting = false;
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
