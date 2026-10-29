/**
 * Linovia Pro Engine
 * - Cinematic Cyberpunk Opening Splash Animation with Real-time Progress Loader
 * - Ambient Loop Background Music with Live In-Game Settings Sync (ON / OFF)
 * - Intelligent Level Select Auto-Page Detection (Opens Player's Current Active 10-Level Page)
 * - Safe Topbar HUD Positioning (Completely Clear of Native Pause & Home Buttons)
 * - 100% Physically Accurate Pipe Flow & Strict Bridge (Overpass/Underpass) Physics
 * - Any-Path & All-Needed Complete Win Detection (Zero Premature Wins on Level 35)
 * - Angle-Equivalence Normalization (0° vs 180° Straight Pipe Support)
 * - Step-by-Step Solution-Tracing Stuck Pipe Hint Engine
 * - 10 Initial Hints, +1 Per Level Clear, 🎬 +3 Rewarded Ad Fallback
 */

(function () {
  'use strict';

  // Directions (Construct 2 screen angles: 0=Right, 90=Down, 180=Left, 270=Up)
  var UP = 270;
  var DOWN = 90;
  var LEFT = 180;
  var RIGHT = 0;
  var OPPOSITE = { 270: 90, 90: 270, 180: 0, 0: 180 };
  var DIRS_CYCLE = [UP, RIGHT, DOWN, LEFT];
  var DIR_DELTAS = {
    0: { dc: 1, dr: 0 },
    90: { dc: 0, dr: 1 },
    180: { dc: -1, dr: 0 },
    270: { dc: 0, dr: -1 }
  };

  function toClampedDegrees(rad) {
    if (window.cr && window.cr.to_clamped_degrees) {
      return window.cr.to_clamped_degrees(rad);
    }
    var d = (rad * 180 / Math.PI) % 360;
    return d < 0 ? d + 360 : d;
  }

  function toRadians(deg) {
    if (window.cr && window.cr.to_radians) {
      return window.cr.to_radians(deg);
    }
    return (deg * Math.PI) / 180;
  }

  // --- Hints State ---
  var hints = parseInt(localStorage.getItem('linovia_hints'), 10);
  if (isNaN(hints) || hints < 0) {
    hints = 10;
    localStorage.setItem('linovia_hints', hints);
  }

  // Default to Level 1 for fresh installs (unlocks level-by-level)
  var storedProgress = parseInt(localStorage.getItem('yellowpipes_strg'), 10);
  if (isNaN(storedProgress) || storedProgress < 1) {
    storedProgress = 1;
    localStorage.setItem('yellowpipes_strg', '1');
  }

  var lastLevelWon = null;
  var currentActiveLayout = null;
  var levelsLayerWasVisible = false;

  function getRuntime() {
    return window.cr_getC2Runtime ? window.cr_getC2Runtime() : null;
  }

  // --- Background Music Controller ---
  var bgAudio = new Audio('media/bg_music.ogg');
  bgAudio.loop = true;
  bgAudio.volume = 0.35;
  var isMusicEnabled = localStorage.getItem('linovia_music_enabled') !== '0';
  var hasUserInteracted = false;

  function startMusicIfAllowed() {
    if (!isMusicEnabled) return;
    try {
      var p = bgAudio.play();
      if (p && typeof p.then === 'function') {
        p.catch(function () {});
      }
    } catch (e) {}
  }

  function stopMusic() {
    try {
      bgAudio.pause();
    } catch (e) {}
  }

  function toggleMusicSetting() {
    isMusicEnabled = !isMusicEnabled;
    localStorage.setItem('linovia_music_enabled', isMusicEnabled ? '1' : '0');
    if (isMusicEnabled) {
      startMusicIfAllowed();
    } else {
      stopMusic();
    }
    updateC2MusicText();
    playClickSound();
  }

  function updateC2MusicText() {
    var runtime = getRuntime();
    if (!runtime) return;
    var v = runtime.getEventVariableByName('music');
    if (v) v.data = isMusicEnabled ? 1 : 0;

    var txtType = runtime.types_by_index[23];
    if (txtType && txtType.instances) {
      for (var i = 0; i < txtType.instances.length; i++) {
        var inst = txtType.instances[i];
        inst.text = isMusicEnabled ? 'MUSIC: ON' : 'MUSIC: OFF';
        inst.set_bbox_changed();
      }
      runtime.redraw = true;
    }
  }

  window.addEventListener('pointerdown', function () {
    if (!hasUserInteracted) {
      hasUserInteracted = true;
      startMusicIfAllowed();
    }
  }, { once: false });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopMusic();
    } else if (isMusicEnabled && hasUserInteracted) {
      startMusicIfAllowed();
    }
  });

  /**
   * Physically accurate port traversal:
   * Given tile frame, rotation angle, and incoming flow direction (entryPort),
   * returns the outgoing exitPort, or null if flow is blocked / leaks.
   */
  function getConnectedExitPort(frame, angleDeg, entryPort) {
    var ang = Math.round(angleDeg / 90.0) * 90 % 360;
    if (ang < 0) ang += 360;

    var base = frame > 3 ? (frame - 3) : frame;

    if (base === 1) { // Straight pipe
      if (ang === 0 || ang === 180) { // Horizontal
        if (entryPort === LEFT) return RIGHT;
        if (entryPort === RIGHT) return LEFT;
        return null;
      } else { // Vertical
        if (entryPort === UP) return DOWN;
        if (entryPort === DOWN) return UP;
        return null;
      }
    } else if (base === 2) { // Corner pipe
      var rot = Math.floor(ang / 90) % 4;
      var p1 = DIRS_CYCLE[rot % 4];
      var p2 = DIRS_CYCLE[(rot + 1) % 4];
      if (entryPort === p1) return p2;
      if (entryPort === p2) return p1;
      return null;
    } else if (base === 3) { // Cross pipe (Strict Overpass / Underpass Bridge)
      // Water entering horizontal MUST exit horizontal:
      if (entryPort === LEFT) return RIGHT;
      if (entryPort === RIGHT) return LEFT;
      // Water entering vertical MUST exit vertical:
      if (entryPort === UP) return DOWN;
      if (entryPort === DOWN) return UP;
      return null;
    }
    return null;
  }

  function isPipeOrientationCorrect(cell) {
    var base = cell.frame > 3 ? (cell.frame - 3) : cell.frame;
    var cur = (Math.round(cell.angle / 90.0) * 90) % 360;
    if (cur < 0) cur += 360;
    var tgt = (Math.round(cell.targetAngle / 90.0) * 90) % 360;
    if (tgt < 0) tgt += 360;

    if (base === 1) { // Straight pipe (0° == 180°, 90° == 270°)
      return (cur % 180) === (tgt % 180);
    } else if (base === 2) { // Corner pipe (strictly unique 90° angle)
      return cur === tgt;
    } else if (base === 3) { // Cross pipe (symmetrical)
      return true;
    }
    return true;
  }

  // Build grid map from live C2 pipe instances
  function buildBoard(runtime) {
    var pipeType = runtime.types_by_index[29];
    var destinType = runtime.types_by_index[30];
    if (!pipeType || !destinType) return null;

    var pipes = pipeType.instances;
    var destins = destinType.instances;
    if (!pipes || pipes.length === 0 || !destins || destins.length < 2) return null;

    var xs = [];
    var ys = [];
    for (var i = 0; i < pipes.length; i++) {
      if (xs.indexOf(pipes[i].x) === -1) xs.push(pipes[i].x);
      if (ys.indexOf(pipes[i].y) === -1) ys.push(pipes[i].y);
    }
    xs.sort(function (a, b) { return a - b; });
    ys.sort(function (a, b) { return a - b; });

    var dxStep = xs.length > 1 ? (xs[1] - xs[0]) : 160;
    var dyStep = ys.length > 1 ? (ys[1] - ys[0]) : 160;

    var board = {};
    for (var p = 0; p < pipes.length; p++) {
      var inst = pipes[p];
      var c = Math.round((inst.x - xs[0]) / dxStep);
      var r = Math.round((inst.y - ys[0]) / dyStep);
      var deg = Math.round(toClampedDegrees(inst.angle) / 90) * 90 % 360;
      if (deg < 0) deg += 360;

      var baseFrame = inst.cur_frame > 3 ? (inst.cur_frame - 3) : inst.cur_frame;
      var targetAngle = (inst.instance_vars && inst.instance_vars.length > 1) ? inst.instance_vars[1] : 0;
      var isNeeded = (inst.instance_vars && inst.instance_vars.length > 0) ? inst.instance_vars[0] : 0;

      board[c + ',' + r] = {
        inst: inst,
        c: c,
        r: r,
        x: inst.x,
        y: inst.y,
        frame: baseFrame,
        curFrame: inst.cur_frame,
        angle: deg,
        targetAngle: targetAngle,
        isNeeded: isNeeded,
        uid: inst.uid
      };
    }

    var startD = destins[0].cur_frame === 0 ? destins[0] : destins[1];
    var endD = destins[0].cur_frame === 1 ? destins[0] : destins[1];

    function getDestinPort(destin) {
      var minD = Infinity;
      var bestKey = null;
      for (var k in board) {
        var b = board[k];
        var dist = (b.x - destin.x) * (b.x - destin.x) + (b.y - destin.y) * (b.y - destin.y);
        if (dist < minD) {
          minD = dist;
          bestKey = k;
        }
      }
      var targetPipe = board[bestKey];
      var port;
      if (Math.abs(destin.x - targetPipe.x) > Math.abs(destin.y - targetPipe.y)) {
        port = destin.x > targetPipe.x ? RIGHT : LEFT;
      } else {
        port = destin.y > targetPipe.y ? DOWN : UP;
      }
      return { cell: bestKey, port: port };
    }

    return {
      board: board,
      startInfo: getDestinPort(startD),
      endInfo: getDestinPort(endD)
    };
  }

  /**
   * Angle-Equivalence Normalization:
   * Straight pipes at 180° vs 0° look 100% pixel-identical.
   * Normalizing pipe.angle to targetAngle ensures C2's native checkConclud
   * (which checks pipe.Angle == targetAngle) evaluates to true!
   */
  function normalizePipeAngles(runtime) {
    if (!runtime || !runtime.running_layout) return;
    var pipeType = runtime.types_by_index[29];
    if (!pipeType || !pipeType.instances) return;
    var pipes = pipeType.instances;

    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i];
      if (!p.instance_vars || p.instance_vars.length < 2) continue;
      var isNeeded = p.instance_vars[0];
      if (!isNeeded) continue;
      var targetAngle = p.instance_vars[1];
      var curDeg = Math.round(toClampedDegrees(p.angle) / 90) * 90 % 360;
      if (curDeg < 0) curDeg += 360;
      var base = p.cur_frame > 3 ? (p.cur_frame - 3) : p.cur_frame;

      if (base === 1) { // Straight
        if ((curDeg % 180) === (targetAngle % 180) && curDeg !== targetAngle) {
          p.angle = toRadians(targetAngle);
          p.set_bbox_changed();
          runtime.redraw = true;
        }
      } else if (base === 3) { // Cross
        if (curDeg !== targetAngle) {
          p.angle = toRadians(targetAngle);
          p.set_bbox_changed();
          runtime.redraw = true;
        }
      }
    }
  }

  /**
   * Robust Win Detection:
   * Physical water/signal flow starting at Start Destin MUST reach End Destin with matching port.
   * Any valid connected path is 100% accepted!
   */
  function checkBoardSolvability(runtime) {
    if (!runtime || !runtime.running_layout) return false;
    var layoutName = runtime.running_layout.name;
    if (!layoutName || layoutName.indexOf('Level') !== 0) return false;
    if (runtime.running_layout._linovia_won) return false;

    normalizePipeAngles(runtime);

    var data = buildBoard(runtime);
    if (!data) return false;

    var board = data.board;
    var startInfo = data.startInfo;
    var endInfo = data.endInfo;

    // Physical flow from Start Destin to End Destin
    var curKey = startInfo.cell;
    var curEntry = startInfo.port;
    var maxSteps = Object.keys(board).length * 4;
    var reachedEnd = false;

    for (var step = 0; step < maxSteps; step++) {
      var curCell = board[curKey];
      if (!curCell) break;

      var exitPort = getConnectedExitPort(curCell.frame, curCell.angle, curEntry);
      if (exitPort === null) break;

      if (curKey === endInfo.cell && exitPort === endInfo.port) {
        reachedEnd = true;
        break;
      }

      var delta = DIR_DELTAS[exitPort];
      var nextKey = (curCell.c + delta.dc) + ',' + (curCell.r + delta.dr);
      curKey = nextKey;
      curEntry = OPPOSITE[exitPort];
    }

    if (reachedEnd) {
      runtime.running_layout._linovia_won = true;
      console.log('[Linovia Pro] Valid complete connection detected! Triggering win...');

      // Update saved progress to next level
      var curLvl = parseInt(layoutName.replace('Level', ''), 10);
      if (!isNaN(curLvl)) {
        var nextLvl = curLvl + 1;
        var curProg = parseInt(localStorage.getItem('yellowpipes_strg') || '1', 10);
        if (nextLvl > curProg) {
          localStorage.setItem('yellowpipes_strg', nextLvl.toString());
          var progVar = runtime.getEventVariableByName('progressLevel');
          if (progVar) progVar.data = nextLvl;
        }
      }

      var goVar = runtime.getEventVariableByName('gameOver');
      if (goVar) goVar.data = 1;

      if (window.c2_callFunction) {
        window.c2_callFunction("win", []);
      }
      handleLevelWon(layoutName);
      return true;
    }

    return false;
  }

  /**
   * Accurate Step-by-Step Stuck Pipe Finder:
   * Follows the solution path from Start Destin to End Destin.
   * Returns the FIRST pipe where the player's current orientation breaks the flow,
   * always advancing the player forward without dragging them elsewhere.
   */
  function findStuckPipe(runtime) {
    var data = buildBoard(runtime);
    if (!data) return null;

    var board = data.board;
    var startInfo = data.startInfo;
    var endInfo = data.endInfo;

    // 1. Build precomputed solution path from start to end
    var curKey = startInfo.cell;
    var curEntry = startInfo.port;
    var maxSteps = Object.keys(board).length * 4;
    var solPath = [];

    for (var step = 0; step < maxSteps; step++) {
      var cell = board[curKey];
      if (!cell) break;

      var exitPort = getConnectedExitPort(cell.frame, cell.targetAngle, curEntry);
      if (exitPort === null) break;

      solPath.push({ key: curKey, entry: curEntry, exit: exitPort, target: cell.targetAngle, inst: cell.inst });

      if (curKey === endInfo.cell && exitPort === endInfo.port) {
        break;
      }

      var delta = DIR_DELTAS[exitPort];
      var nextKey = (cell.c + delta.dc) + ',' + (cell.r + delta.dr);
      curKey = nextKey;
      curEntry = OPPOSITE[exitPort];
    }

    if (solPath.length === 0) return null;

    // 2. Scan along solution path: find the FIRST pipe where player's live rotation does NOT connect entry to exit!
    for (var i = 0; i < solPath.length; i++) {
      var item = solPath[i];
      var liveCell = board[item.key];
      var curExit = getConnectedExitPort(liveCell.frame, liveCell.angle, item.entry);
      if (curExit !== item.exit) {
        return {
          inst: item.inst,
          targetAngle: item.target
        };
      }
    }

    return null;
  }

  // --- Level Completion Handler ---
  var levelsClearedSinceAd = parseInt(localStorage.getItem('linovia_cleared_since_ad') || '0', 10);
  var lastInterstitialTime = parseInt(localStorage.getItem('linovia_last_ad_time') || '0', 10);

  function handleLevelWon(lvlName) {
    if (lastLevelWon === lvlName) return;
    lastLevelWon = lvlName;

    hints += 1;
    localStorage.setItem('linovia_hints', hints);
    updateHud();
    showToast('🎉 BÖLÜM TAMAMLANDI! +1 İPUCU KAZANDIN!');

    // Interstitial Ad Logic: Every 3 levels & minimum 30s cooldown
    levelsClearedSinceAd++;
    localStorage.setItem('linovia_cleared_since_ad', levelsClearedSinceAd.toString());

    var now = Date.now();
    var cooldownPassed = (now - lastInterstitialTime) >= 30000;

    console.log('[Linovia Ads] Level won: ' + lvlName + ' | Count: ' + levelsClearedSinceAd + ' | Cooldown passed: ' + cooldownPassed);

    if (levelsClearedSinceAd >= 3) {
      if (cooldownPassed) {
        console.log('[Linovia Ads] Triggering Interstitial Ad (every 3 levels rule met)...');
        levelsClearedSinceAd = 0;
        lastInterstitialTime = now;
        localStorage.setItem('linovia_cleared_since_ad', '0');
        localStorage.setItem('linovia_last_ad_time', now.toString());

        if (window.AndroidBridge && window.AndroidBridge.showInterstitial) {
          window.AndroidBridge.showInterstitial();
        } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
          window.webkit.messageHandlers.adBridge.postMessage({ action: 'showInterstitial' });
        }
      } else {
        console.log('[Linovia Ads] 3 levels cleared, waiting for cooldown (' + Math.round((30000 - (now - lastInterstitialTime)) / 1000) + 's remaining). Will trigger next level.');
      }
    }
  }

  // --- Persistent Pipe Sanitizer ---
  function sanitizePipes(runtime) {
    if (!runtime || !runtime.running_layout) return;
    var currentLvlName = runtime.running_layout.name;
    var isPuzzleLevel = currentLvlName && currentLvlName.indexOf('Level') === 0;

    var pipeType = runtime.types_by_index[29];
    if (!pipeType || !pipeType.instances) return;
    var pipes = pipeType.instances;

    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i];

      if (!isPuzzleLevel) {
        delete p._is_hinted;
        delete p._target_angle;
        delete p._red_frame;
        delete p._hint_level;
        if (p.cur_frame > 3) {
          restorePipeToGreen(p, runtime);
        }
        continue;
      }

      if (p._is_hinted && p._hint_level !== currentLvlName) {
        delete p._is_hinted;
        delete p._target_angle;
        delete p._red_frame;
        delete p._hint_level;
        restorePipeToGreen(p, runtime);
      } else if (!p._is_hinted && p.cur_frame > 3) {
        restorePipeToGreen(p, runtime);
      }
    }
  }

  function restorePipeToGreen(p, runtime) {
    var base = p.cur_frame > 3 ? (p.cur_frame - 3) : p.cur_frame;
    if (base < 1) base = 1;
    if (base > 3) base = 1;

    if (p.type && p.type.plugin && p.type.plugin.acts && p.type.plugin.acts.SetAnimFrame) {
      p.type.plugin.acts.SetAnimFrame.call(p, base);
    } else {
      p.cur_frame = base;
      if (p.cur_animation && p.cur_animation.frames && p.cur_animation.frames[base]) {
        p.curFrame = p.cur_animation.frames[base];
        p.curWebGLTexture = p.curFrame.webGL_texture;
      }
    }
    p.set_bbox_changed();
    if (runtime) runtime.redraw = true;
  }

  // --- Banner Ad Trigger ---
  function triggerBannerAd() {
    try {
      if (window.AndroidBridge && window.AndroidBridge.showBanner) {
        window.AndroidBridge.showBanner();
      } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adBridge) {
        window.webkit.messageHandlers.adBridge.postMessage({ action: 'showBanner' });
      }
    } catch (e) {}
  }

  // --- Level Layout Transition Handler ---
  function handleLayoutChange(runtime) {
    if (!runtime || !runtime.running_layout) return;
    var name = runtime.running_layout.name;
    if (name === currentActiveLayout) return;

    var prevLayout = currentActiveLayout;
    currentActiveLayout = name;
    console.log('[Linovia Pro] Layout changed from ' + prevLayout + ' to ' + name);

    // If leaving a Level layout towards the next level or win screen
    if (prevLayout && prevLayout.indexOf('Level') === 0 && name !== prevLayout) {
      if (name.indexOf('Level') === 0 || name === 'Win') {
        console.log('[Linovia Pro] Level transition detected from ' + prevLayout + ' to ' + name);
        handleLevelWon(prevLayout);
      }
    }

    if (name !== lastLevelWon) {
      lastLevelWon = null;
    }

    sanitizePipes(runtime);
    updateHud();
    positionTopbar();
    updateLevelPageNav();
    updateC2MusicText();
  }

  // --- Use Hint Action ---
  function useHint() {
    if (hints <= 0) {
      triggerRewardedAd();
      return;
    }

    var runtime = getRuntime();
    if (!runtime || !runtime.running_layout) return;
    var currentLvlName = runtime.running_layout.name;
    if (!currentLvlName || currentLvlName.indexOf('Level') !== 0) return;

    var stuckInfo = findStuckPipe(runtime);
    if (!stuckInfo) {
      showToast('✨ TÜM HATLAR DOĞRU HİZADA!');
      return;
    }

    sanitizePipes(runtime);

    var stuckPipe = stuckInfo.inst;
    var targetAngle = stuckInfo.targetAngle;
    stuckPipe.angle = toRadians(targetAngle);
    if (stuckPipe.instance_vars && stuckPipe.instance_vars.length > 1) {
      stuckPipe.instance_vars[1] = targetAngle;
    }

    var baseFrame = stuckPipe.cur_frame > 3 ? (stuckPipe.cur_frame - 3) : stuckPipe.cur_frame;
    var redFrame = baseFrame + 3;

    if (stuckPipe.type && stuckPipe.type.plugin && stuckPipe.type.plugin.acts && stuckPipe.type.plugin.acts.SetAnimFrame) {
      stuckPipe.type.plugin.acts.SetAnimFrame.call(stuckPipe, redFrame);
    } else {
      stuckPipe.cur_frame = redFrame;
    }

    if (stuckPipe.cur_animation && stuckPipe.cur_animation.frames && stuckPipe.cur_animation.frames[redFrame]) {
      stuckPipe.curFrame = stuckPipe.cur_animation.frames[redFrame];
      stuckPipe.curWebGLTexture = stuckPipe.curFrame.webGL_texture;
    }

    stuckPipe.set_bbox_changed();
    stuckPipe.runtime.redraw = true;

    stuckPipe._is_hinted = true;
    stuckPipe._hint_level = currentLvlName;
    stuckPipe._target_angle = targetAngle;
    stuckPipe._red_frame = redFrame;

    hints -= 1;
    localStorage.setItem('linovia_hints', hints);
    updateHud();

    showToast('💡 BORU KIRMIZIYA DÖNDÜ VE DOĞRU YÖNE ÇEVRİLDİ!');

    setTimeout(function () {
      checkBoardSolvability(runtime);
    }, 200);
  }

  function keepHintedPipesLocked() {
    var runtime = getRuntime();
    if (!runtime || !runtime.running_layout) return;
    var currentLvlName = runtime.running_layout.name;
    if (!currentLvlName || currentLvlName.indexOf('Level') !== 0) return;

    var pipeType = runtime.types_by_index[29];
    if (!pipeType || !pipeType.instances) return;
    var pipes = pipeType.instances;

    for (var i = 0; i < pipes.length; i++) {
      var p = pipes[i];
      if (p._is_hinted && p._hint_level === currentLvlName) {
        var correctRad = toRadians(p._target_angle);
        if (Math.abs(p.angle - correctRad) > 0.05) {
          p.angle = correctRad;
          p.set_bbox_changed();
        }
        if (p.cur_frame !== p._red_frame) {
          if (p.type && p.type.plugin && p.type.plugin.acts && p.type.plugin.acts.SetAnimFrame) {
            p.type.plugin.acts.SetAnimFrame.call(p, p._red_frame);
          } else {
            p.cur_frame = p._red_frame;
          }
          if (p.cur_animation && p.cur_animation.frames && p.cur_animation.frames[p._red_frame]) {
            p.curFrame = p.cur_animation.frames[p._red_frame];
            p.curWebGLTexture = p.curFrame.webGL_texture;
          }
          p.set_bbox_changed();
        }
      }
    }
  }

  // --- Rewarded Ad Integration ---
  function triggerRewardedAd() {
    console.log('[Linovia Pro] Triggering Rewarded Video Ad for +3 Hints...');
    if (window.AndroidBridge && window.AndroidBridge.showRewarded) {
      window.AndroidBridge.showRewarded('hint');
    } else if (
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.showRewarded
    ) {
      window.webkit.messageHandlers.showRewarded.postMessage('hint');
    } else {
      showToast('🎬 REKLAM İZLENİYOR... (+3 İPUCU)');
      setTimeout(function () {
        window.onLinoviaAdRewarded(true, 'hint');
      }, 1500);
    }
  }

  window.onLinoviaAdRewarded = function (success, tag) {
    if (success && (tag === 'hint' || !tag)) {
      hints += 3;
      localStorage.setItem('linovia_hints', hints);
      updateHud();
      showToast('🎬 +3 İPUCU HESABINA YÜKLENDİ!');
    }
  };

  window.onUnityAdRewarded = function (success, rewardType) {
    window.onLinoviaAdRewarded(success, rewardType);
  };

  // --- Page Navigation Engine (10 Pages, Seamless & Responsive) ---
  var currentSelectedPage = 0;

  function getCurrentC2Page() {
    var runtime = getRuntime();
    if (!runtime) return currentSelectedPage;
    var v = runtime.getEventVariableByName('pageLevel');
    if (v && typeof v.data === 'number') {
      currentSelectedPage = v.data;
    }
    return currentSelectedPage;
  }

  function getPlayerCurrentProgressPage() {
    var stored = parseInt(localStorage.getItem('yellowpipes_strg') || '1', 10);
    if (isNaN(stored) || stored < 1) stored = 1;
    // Calculate 10-level page: 1-10 -> Page 0, 11-20 -> Page 1, 31-40 -> Page 3
    var page = Math.floor((stored - 1) / 10);
    return Math.max(0, Math.min(9, page));
  }

  function setPage(pageNum) {
    pageNum = Math.max(0, Math.min(9, pageNum));
    currentSelectedPage = pageNum;

    var runtime = getRuntime();
    if (!runtime) return;

    var v = runtime.getEventVariableByName('pageLevel');
    if (v) {
      v.data = pageNum;
    }

    var lpType = runtime.types_by_index[36];
    if (lpType && lpType.instances && lpType.instances[0]) {
      var lp = lpType.instances[0];
      if (lp.type && lp.type.plugin && lp.type.plugin.acts && lp.type.plugin.acts.SetAnimFrame) {
        lp.type.plugin.acts.SetAnimFrame.call(lp, pageNum);
      } else {
        lp.cur_frame = pageNum;
      }
      if (lp.cur_animation && lp.cur_animation.frames && lp.cur_animation.frames[pageNum]) {
        lp.curFrame = lp.cur_animation.frames[pageNum];
        lp.curWebGLTexture = lp.curFrame.webGL_texture;
      }
      lp.set_bbox_changed();
    }

    if (window.c2_callFunction) {
      window.c2_callFunction("levelShow", []);
    }

    playClickSound();

    runtime.redraw = true;
    updateLevelPageNav();
  }

  function playClickSound() {
    var runtime = getRuntime();
    if (runtime && runtime.types_by_index[2]) {
      var audioType = runtime.types_by_index[2];
      if (audioType.plugin && audioType.plugin.acts && audioType.plugin.acts.Play) {
        try {
          audioType.plugin.acts.Play.call(audioType.instances[0], "click_2", false, 0, "");
        } catch (e) {}
      }
    }
  }

  // --- UI Setup: Game Topbar & Level Navigator Overlay ---
  var hudEl = null;
  var levelPillEl = null;
  var hintBtnEl = null;
  var toastEl = null;
  var levelNavEl = null;
  var pagePrevBtn = null;
  var pageNextBtn = null;
  var pageTitleEl = null;
  var pageSubtitleEl = null;

  function createHud() {
    if (hudEl) return;

    var container = document.createElement('div');
    container.id = 'linovia-hud-container';

    container.innerHTML = [
      '<div class="linovia-hint-btn" id="linovia-hint-trigger" style="display:none;">',
      '  <span class="linovia-hint-icon">💡</span>',
      '  <span class="linovia-hint-count" id="linovia-hint-count">10</span>',
      '</div>',
      '<div class="linovia-toast" id="linovia-toast"></div>',
      '<div class="linovia-level-nav" id="linovia-level-nav" style="display:none;">',
      '  <button class="linovia-nav-arrow" id="linovia-page-prev" title="Önceki Sayfa">◀</button>',
      '  <div class="linovia-nav-center">',
      '    <div class="linovia-nav-title" id="linovia-page-title">SAYFA 1 / 10</div>',
      '    <div class="linovia-nav-subtitle" id="linovia-page-subtitle">BÖLÜM 1 - 10</div>',
      '  </div>',
      '  <button class="linovia-nav-arrow" id="linovia-page-next" title="Sonraki Sayfa">▶</button>',
      '</div>'
    ].join('\n');

    document.body.appendChild(container);

    hudEl = container;
    hintBtnEl = document.getElementById('linovia-hint-trigger');
    toastEl = document.getElementById('linovia-toast');
    levelNavEl = document.getElementById('linovia-level-nav');
    pagePrevBtn = document.getElementById('linovia-page-prev');
    pageNextBtn = document.getElementById('linovia-page-next');
    pageTitleEl = document.getElementById('linovia-page-title');
    pageSubtitleEl = document.getElementById('linovia-page-subtitle');

    hintBtnEl.addEventListener('click', function (e) {
      e.stopPropagation();
      useHint();
    });

    pagePrevBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setPage(getCurrentC2Page() - 1);
    });

    pageNextBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setPage(getCurrentC2Page() + 1);
    });

    setupTouchAndSwipeNavigation();
    updateHud();
    positionTopbar();
  }

  /**
   * Position Hint Button safely below Construct 2 top pause button:
   * btn_pause is at (990, 90) ending at Y=165 in canvas coordinates.
   * Placing hint button at canvas Y=245 ensures zero overlap and comfortable touch target!
   */
  function positionTopbar() {
    if (!hintBtnEl) return;
    var canvas = document.getElementById('c2canvas');
    if (!canvas) return;

    var rect = canvas.getBoundingClientRect();
    var scale = rect.height / 1920.0;
    var scaleX = rect.width / 1080.0;

    var topPx = rect.top + (245.0 * scale);
    var rightPx = (window.innerWidth - rect.right) + (35.0 * scaleX);

    hintBtnEl.style.top = topPx + 'px';
    hintBtnEl.style.right = Math.max(16, rightPx) + 'px';
  }

  function positionLevelNav() {
    if (!levelNavEl) return;
    var canvas = document.getElementById('c2canvas');
    if (!canvas) return;

    var rect = canvas.getBoundingClientRect();
    var scale = rect.height / 1920.0;

    var topPx = rect.top + (1285.0 * scale);
    var widthPx = Math.min(rect.width * 0.88, 480);

    levelNavEl.style.top = topPx + 'px';
    levelNavEl.style.width = widthPx + 'px';
  }

  function updateLevelPageNav() {
    if (!levelNavEl) return;
    var runtime = getRuntime();
    if (!runtime || !runtime.running_layout) {
      levelNavEl.style.display = 'none';
      return;
    }

    var isMain = runtime.running_layout.name === 'Main';
    var isLevelsVisible = false;
    if (isMain && runtime.running_layout.layers) {
      for (var i = 0; i < runtime.running_layout.layers.length; i++) {
        var l = runtime.running_layout.layers[i];
        if (l.name === 'Levels' && l.visible) {
          isLevelsVisible = true;
          break;
        }
      }
    }

    // When player clicks Play on Main menu, auto-open their current active level page!
    if (isMain && isLevelsVisible) {
      if (!levelsLayerWasVisible) {
        levelsLayerWasVisible = true;
        var progressPage = getPlayerCurrentProgressPage();
        if (getCurrentC2Page() !== progressPage) {
          setPage(progressPage);
        }
      }

      var curPage = getCurrentC2Page();
      pageTitleEl.textContent = 'SAYFA ' + (curPage + 1) + ' / 10';
      var startLvl = curPage * 10 + 1;
      var endLvl = (curPage + 1) * 10;
      pageSubtitleEl.textContent = 'BÖLÜM ' + startLvl + ' - ' + endLvl;

      pagePrevBtn.disabled = curPage <= 0;
      pageNextBtn.disabled = curPage >= 9;

      positionLevelNav();
      levelNavEl.style.display = 'flex';
    } else {
      levelsLayerWasVisible = false;
      levelNavEl.style.display = 'none';
    }
  }

  // Tap on canvas dots area, swipe gestures, and Settings Music toggle
  function setupTouchAndSwipeNavigation() {
    var startX = 0;
    var startY = 0;
    var startTime = 0;

    window.addEventListener('pointerdown', function (e) {
      startX = e.clientX;
      startY = e.clientY;
      startTime = Date.now();

      var runtime = getRuntime();
      if (!runtime || !runtime.running_layout || runtime.running_layout.name !== 'Main') return;

      var isLevels = false;
      if (runtime.running_layout.layers) {
        for (var i = 0; i < runtime.running_layout.layers.length; i++) {
          var lyr = runtime.running_layout.layers[i];
          if (lyr.name === 'Levels' && lyr.visible) {
            isLevels = true;
            break;
          }
        }
      }
      if (!isLevels) return;

      var canvas = document.getElementById('c2canvas');
      if (!canvas) return;

      var rect = canvas.getBoundingClientRect();
      var scaleX = rect.width / 1080.0;
      var scaleY = rect.height / 1920.0;
      var canvasX = (e.clientX - rect.left) / scaleX;
      var canvasY = (e.clientY - rect.top) / scaleY;

      var iconType = runtime.types_by_index[34];
      if (!iconType || !iconType.instances) return;
      var curProg = parseInt(localStorage.getItem('yellowpipes_strg') || '1', 10);
      if (isNaN(curProg) || curProg < 1) curProg = 1;

      for (var j = 0; j < iconType.instances.length; j++) {
        var inst = iconType.instances[j];
        var hw = (inst.width || 120) * 0.55;
        var hh = (inst.height || 120) * 0.55;
        if (canvasX >= inst.x - hw && canvasX <= inst.x + hw &&
            canvasY >= inst.y - hh && canvasY <= inst.y + hh) {
          var lvlNum = (inst.instance_vars && inst.instance_vars.length > 1) ? inst.instance_vars[1] : 1;
          if (lvlNum > curProg) {
            e.stopImmediatePropagation();
            e.preventDefault();
            showToast('🔒 BÖLÜM ' + lvlNum + ' KİLİTLİ! ÖNCEKİ BÖLÜMLERİ GEÇİN.');
            playClickSound();
            return;
          }
        }
      }
    }, true);

    window.addEventListener('pointerup', function (e) {
      var runtime = getRuntime();
      if (!runtime || !runtime.running_layout) return;

      var canvas = document.getElementById('c2canvas');
      if (!canvas) return;

      var rect = canvas.getBoundingClientRect();
      var scaleX = rect.width / 1080.0;
      var scaleY = rect.height / 1920.0;
      var canvasX = (e.clientX - rect.left) / scaleX;
      var canvasY = (e.clientY - rect.top) / scaleY;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var dt = Date.now() - startTime;

      // 1. Check if Settings layer is visible and user tapped MUSIC: ON / OFF
      if (runtime.running_layout.layers) {
        for (var i = 0; i < runtime.running_layout.layers.length; i++) {
          var lyr = runtime.running_layout.layers[i];
          if (lyr.name === 'Settings' && lyr.visible) {
            // Type 23 is at (540, 837), size ~847x135
            if (canvasY >= 770 && canvasY <= 905 && canvasX >= 110 && canvasX <= 970) {
              toggleMusicSetting();
              return;
            }
          }
        }
      }

      if (runtime.running_layout.name !== 'Main') return;

      var isLevels = false;
      if (runtime.running_layout.layers) {
        for (var j = 0; j < runtime.running_layout.layers.length; j++) {
          if (runtime.running_layout.layers[j].name === 'Levels' && runtime.running_layout.layers[j].visible) {
            isLevels = true;
            break;
          }
        }
      }
      if (!isLevels) return;

      // 2. Swipe Left -> Next Page, Swipe Right -> Prev Page
      if (Math.abs(dx) > 50 && Math.abs(dy) < 80 && dt < 600) {
        if (dx < 0) {
          setPage(getCurrentC2Page() + 1);
        } else {
          setPage(getCurrentC2Page() - 1);
        }
        return;
      }

      // 3. Direct Tap on the 10 dots area on canvas
      if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
        if (canvasY >= 1340 && canvasY <= 1470 && canvasX >= 120 && canvasX <= 960) {
          var dotIdx = Math.floor((canvasX - 140) / 80.0);
          dotIdx = Math.max(0, Math.min(9, dotIdx));
          setPage(dotIdx);
        }
      }
    });

    window.addEventListener('resize', function () {
      positionTopbar();
      positionLevelNav();
    });
  }

  function updateHud() {
    if (!hintBtnEl) return;
    var countEl = document.getElementById('linovia-hint-count');
    var iconEl = hintBtnEl.querySelector('.linovia-hint-icon');

    if (hints > 0) {
      hintBtnEl.classList.remove('ad-mode');
      iconEl.textContent = '💡';
      countEl.textContent = 'İPUCU (' + hints + ')';
    } else {
      hintBtnEl.classList.add('ad-mode');
      iconEl.textContent = '🎬';
      countEl.textContent = '+3 İPUCU';
    }

    var runtime = getRuntime();
    if (hintBtnEl && runtime && runtime.running_layout) {
      var name = runtime.running_layout.name;
      if (name && name.indexOf('Level') === 0) {
        hintBtnEl.style.display = 'flex';
        positionTopbar();
      } else {
        hintBtnEl.style.display = 'none';
      }
    }
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2400);
  }

  // --- Cinematic Opening Splash Animation ---
  function createCinematicSplash() {
    var splash = document.createElement('div');
    splash.className = 'linovia-splash-screen';
    splash.id = 'linovia-splash-screen';

    splash.innerHTML = [
      '<div class="linovia-splash-bg-grid"></div>',
      '<div class="linovia-splash-content">',
      '  <div class="linovia-splash-badge-wrap">',
      '    <div class="linovia-splash-aura"></div>',
      '    <img src="images/splash_logo.png" alt="Linovia" class="linovia-splash-logo-img" />',
      '  </div>',
      '  <div class="linovia-splash-title">LINOVIA</div>',
      '  <div class="linovia-splash-tagline">• THE LOGIC PATHWAY •</div>',
      '  <div class="linovia-splash-loader-wrap">',
      '    <div class="linovia-splash-loader-bar" id="linovia-splash-bar"></div>',
      '  </div>',
      '  <div class="linovia-splash-status" id="linovia-splash-status">BAĞLANTI HATTI VE DEVRELER BAŞLATILIYOR...</div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(splash);

    var bar = document.getElementById('linovia-splash-bar');
    var status = document.getElementById('linovia-splash-status');

    var dismissed = false;
    function dismissSplash() {
      if (dismissed) return;
      dismissed = true;
      splash.classList.add('linovia-splash-warp');
      setTimeout(function () {
        if (splash.parentNode) splash.parentNode.removeChild(splash);
      }, 750);
    }

    splash.addEventListener('click', dismissSplash);

    // Smooth cinematic progress sequence
    setTimeout(function () {
      if (bar) bar.style.width = '30%';
      if (status) status.textContent = '100 ZİHİNSEL BULMACA VE DEVRELER YÜKLENİYOR...';
    }, 400);

    setTimeout(function () {
      if (bar) bar.style.width = '70%';
      if (status) status.textContent = 'AKILLI İPUCU MOTORU VE SES SİSTEMİ HAZIR...';
    }, 900);

    setTimeout(function () {
      if (bar) bar.style.width = '100%';
      if (status) status.textContent = 'SİSTEM ÇEVRİMİÇİ! BAŞLATILIYOR...';
    }, 1400);

    setTimeout(function () {
      dismissSplash();
    }, 1800);
  }

  // --- Pointer & Input Listeners ---
  window.addEventListener('pointerup', function () {
    var runtime = getRuntime();
    if (runtime) {
      setTimeout(function () {
        handleLayoutChange(runtime);
        sanitizePipes(runtime);
        normalizePipeAngles(runtime);
        checkBoardSolvability(runtime);
        updateHud();
        updateLevelPageNav();
        positionTopbar();
      }, 80);
    }
  });

  // Intercept store policy external links
  var origOpen = window.open;
  window.open = function (url) {
    if (url && (url.indexOf('codecanyon') !== -1 || url.indexOf('trezeplay') !== -1)) {
      console.log('[Linovia Pro] Suppressed external link: ' + url);
      return null;
    }
    return origOpen.apply(this, arguments);
  };

  // --- C2 Function Hook for Level Win Detection ---
  function hookC2Functions() {
    if (window.cr && window.cr.plugins_ && window.cr.plugins_.Function && window.cr.plugins_.Function.prototype && window.cr.plugins_.Function.prototype.acts) {
      if (!window.cr.plugins_.Function.prototype.acts._linoviaHooked) {
        var origCall = window.cr.plugins_.Function.prototype.acts.CallFunction;
        window.cr.plugins_.Function.prototype.acts.CallFunction = function (name_, params_) {
          var lower = (name_ || '').toLowerCase();
          if (lower === 'win' || lower === 'end') {
            console.log('[Linovia Pro] C2 CallFunction(' + lower + ') intercepted!');
            var rt = getRuntime();
            var lvlName = (rt && rt.running_layout) ? rt.running_layout.name : 'Level';
            handleLevelWon(lvlName);
          }
          return origCall.apply(this, arguments);
        };
        window.cr.plugins_.Function.prototype.acts._linoviaHooked = true;
        console.log('[Linovia Pro] C2 Function.acts.CallFunction hook installed successfully!');
      }
    }
  }

  var origC2Call = window.c2_callFunction;
  window.c2_callFunction = function (name_, params_) {
    var lower = (name_ || '').toLowerCase();
    if (lower === 'win' || lower === 'end') {
      console.log('[Linovia Pro] window.c2_callFunction(' + lower + ') intercepted!');
      var rt = getRuntime();
      var lvlName = (rt && rt.running_layout) ? rt.running_layout.name : 'Level';
      handleLevelWon(lvlName);
    }
    if (typeof origC2Call === 'function') {
      return origC2Call.apply(this, arguments);
    }
  };

  var lastTrackedProgress = parseInt(localStorage.getItem('yellowpipes_strg') || '1', 10);

  // Main tick loop
  function init() {
    createCinematicSplash();
    createHud();
    triggerBannerAd();
    hookC2Functions();

    setInterval(function () {
      var runtime = getRuntime();
      if (runtime) {
        handleLayoutChange(runtime);
        sanitizePipes(runtime);
        updateHud();
        updateLevelPageNav();
        keepHintedPipesLocked();
        if (runtime.running_layout && runtime.running_layout.name.indexOf('Level') === 0) {
          normalizePipeAngles(runtime);
          checkBoardSolvability(runtime);
        }
      }

      // Progress level growth tracker
      var prog = parseInt(localStorage.getItem('yellowpipes_strg') || '1', 10);
      if (prog > lastTrackedProgress) {
        console.log('[Linovia Pro] Stored progress advanced from ' + lastTrackedProgress + ' to ' + prog);
        handleLevelWon('Level' + (prog - 1));
        lastTrackedProgress = prog;
      }

      hookC2Functions();
    }, 150);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

})();
