/* ============================================================================
   Neon Snake — retro 80s arcade snake
   Vanilla JS, no dependencies. Fixed-timestep simulation with interpolated
   rendering, so the snake glides instead of stuttering between grid cells.
   ========================================================================== */

(() => {
  'use strict';

  /* ── Configuration ─────────────────────────────────────────────────────── */

  const COLS = 20;
  const ROWS = 20;

  const BASE_STEP_MS = 165;   // ms per move at level 1
  const MIN_STEP_MS  = 72;    // speed ceiling
  const STEP_PER_LVL = 9;     // ms shaved off each level
  const FOOD_PER_LVL = 5;     // foods eaten before levelling up

  const GOLD_EVERY   = 4;     // every Nth food spawns golden
  const GOLD_TTL_MS  = 6500;  // golden food lifetime
  const POINTS       = 10;
  const GOLD_POINTS  = 50;

  const STORAGE_KEY  = 'neon-snake.best';
  const TAU = Math.PI * 2;

  const DIRS = {
    up:    { x:  0, y: -1 },
    down:  { x:  0, y:  1 },
    left:  { x: -1, y:  0 },
    right: { x:  1, y:  0 },
  };

  /* Snake colourway advances with each level — a small reward for surviving. */
  const SKINS = [
    { head: '#22e8ff', tail: '#a24bff' },
    { head: '#5dff9f', tail: '#22e8ff' },
    { head: '#ffd93d', tail: '#ff6b35' },
    { head: '#ff2fb9', tail: '#a24bff' },
    { head: '#ff6b35', tail: '#ff2fb9' },
  ];

  const FOOD_COLOR = '#ff2fb9';
  const GOLD_COLOR = '#ffd93d';

  /* ── Utilities ─────────────────────────────────────────────────────────── */

  const lerp  = (a, b, t) => a + (b - a) * t;
  const randInt = (n) => Math.floor(Math.random() * n);

  const readBest = () => {
    try { return Number(localStorage.getItem(STORAGE_KEY)) || 0; }
    catch { return 0; }
  };
  const writeBest = (value) => {
    try { localStorage.setItem(STORAGE_KEY, String(value)); }
    catch { /* storage unavailable — high score simply won't persist */ }
  };

  /* ── Sound: tiny WebAudio blip synth ───────────────────────────────────── */

  const Sound = {
    enabled: true,
    ctx: null,

    /** Lazily create/resume the context — browsers require a user gesture. */
    unlock() {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!this.ctx) this.ctx = new AudioCtor();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },

    tone(freq, delay, duration, type = 'square', peak = 0.05) {
      if (!this.enabled || !this.ctx) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.03);
    },

    sweep(from, to, duration, type = 'sawtooth', peak = 0.07) {
      if (!this.enabled || !this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t0);
      osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
      gain.gain.setValueAtTime(peak, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.03);
    },

    arpeggio(freqs, step = 0.07, type = 'square', peak = 0.05) {
      freqs.forEach((f, i) => this.tone(f, i * step, 0.16, type, peak));
    },

    eat()     { this.tone(660, 0, 0.09); this.tone(990, 0.055, 0.1); },
    gold()    { this.arpeggio([880, 1108, 1318, 1760], 0.055, 'square', 0.055); },
    levelUp() { this.arpeggio([523, 659, 784, 1046], 0.07, 'triangle', 0.06); },
    start()   { this.arpeggio([440, 660], 0.08, 'square', 0.05); },
    die()     { this.sweep(420, 55, 0.55); },
  };

  /* ── DOM ───────────────────────────────────────────────────────────────── */

  const canvas   = document.getElementById('board');
  const ctx      = canvas.getContext('2d');
  const stage    = canvas.parentElement;
  const overlay  = document.getElementById('overlay');
  const els = {
    score:        document.getElementById('score'),
    best:         document.getElementById('best'),
    level:        document.getElementById('level'),
    eyebrow:      document.getElementById('overlay-eyebrow'),
    title:        document.getElementById('overlay-title'),
    body:         document.getElementById('overlay-body'),
    action:       document.getElementById('primary-action'),
    soundToggle:  document.getElementById('sound-toggle'),
    soundLabel:   document.getElementById('sound-label'),
    dpad:         document.getElementById('dpad'),
  };

  /* ── Game state ────────────────────────────────────────────────────────── */

  /** @type {'ready'|'playing'|'paused'|'dead'} */
  let state = 'ready';

  let snake      = [];     // grid cells, head first
  let prevCells  = [];     // positions one step ago, for interpolation
  let direction  = DIRS.right;
  let queued     = [];     // buffered turns, so fast double-taps aren't eaten
  let food       = null;   // { x, y, golden, born }
  let foodsEaten = 0;
  let score      = 0;
  let level      = 1;
  let best       = readBest();

  let stepMs      = BASE_STEP_MS;
  let accumulator = 0;
  let lastFrame   = 0;

  const particles = [];
  const texts     = [];

  /* Canvas metrics, refreshed on resize */
  let boardSize = 0;   // CSS px (square)
  let cell      = 0;   // CSS px per grid cell
  let fontStack = 'monospace';

  /* ── Sizing ────────────────────────────────────────────────────────────── */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    boardSize = rect.width;
    cell = boardSize / COLS;
    fontStack = getComputedStyle(document.body).fontFamily;

    canvas.width  = Math.round(rect.width  * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────────── */

  function reset() {
    const midY = Math.floor(ROWS / 2);
    snake = [
      { x: 5, y: midY },
      { x: 4, y: midY },
      { x: 3, y: midY },
    ];
    prevCells  = snake.map((c) => ({ ...c }));
    direction  = DIRS.right;
    queued     = [];
    foodsEaten = 0;
    score      = 0;
    level      = 1;
    stepMs     = BASE_STEP_MS;
    accumulator = 0;
    particles.length = 0;
    texts.length = 0;
    spawnFood();
    syncHud();
  }

  function startGame() {
    Sound.unlock();
    reset();
    state = 'playing';
    lastFrame = performance.now();
    hideOverlay();
    Sound.start();
  }

  function togglePause() {
    if (state === 'playing') {
      state = 'paused';
      showOverlay({
        eyebrow: 'Paused',
        title: 'Take five',
        body: 'The grid will wait for you.',
        action: 'Resume',
      });
    } else if (state === 'paused') {
      state = 'playing';
      lastFrame = performance.now();
      hideOverlay();
    }
  }

  function gameOver() {
    state = 'dead';
    Sound.die();

    const head = snake[0];
    burst(head.x, head.y, SKINS[(level - 1) % SKINS.length].head, 26);

    if (!prefersReducedMotion()) {
      stage.classList.remove('is-shaking');
      void stage.offsetWidth;          // restart the animation
      stage.classList.add('is-shaking');
    }

    const isRecord = score > best;
    if (isRecord) {
      best = score;
      writeBest(best);
      syncHud();
    }

    showOverlay({
      eyebrow: isRecord ? 'New record' : 'Game over',
      title: `${score} points`,
      body: isRecord
        ? 'A new high score is burned into the cabinet.'
        : `You reached level ${level}. Best so far is ${best}.`,
      action: 'Play Again',
    });
  }

  /* ── Simulation ────────────────────────────────────────────────────────── */

  function step() {
    prevCells = snake.map((c) => ({ ...c }));

    // Consume the next buffered turn that isn't a reversal.
    while (queued.length) {
      const next = queued.shift();
      if (next.x !== -direction.x || next.y !== -direction.y) {
        direction = next;
        break;
      }
    }

    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };

    // Walls are lethal.
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) {
      gameOver();
      return;
    }

    // Self-collision. The final segment vacates this tick, so it's fair game.
    for (let i = 0; i < snake.length - 1; i++) {
      if (snake[i].x === head.x && snake[i].y === head.y) {
        gameOver();
        return;
      }
    }

    const ate = food && head.x === food.x && head.y === food.y;
    snake.unshift(head);
    if (!ate) snake.pop();
    else consume();

    // Golden food expires if you dawdle.
    if (food && food.golden && performance.now() - food.born > GOLD_TTL_MS) {
      burst(food.x, food.y, GOLD_COLOR, 8);
      spawnFood({ forceNormal: true });
    }
  }

  function consume() {
    const golden = food.golden;
    const gained = golden ? GOLD_POINTS : POINTS;

    score += gained;
    foodsEaten += 1;

    burst(food.x, food.y, golden ? GOLD_COLOR : FOOD_COLOR, golden ? 24 : 12);
    floatText(food.x, food.y, `+${gained}`, golden ? GOLD_COLOR : '#ffffff');
    golden ? Sound.gold() : Sound.eat();

    if (foodsEaten % FOOD_PER_LVL === 0) levelUp();

    spawnFood();
    syncHud();
  }

  function levelUp() {
    level += 1;
    stepMs = Math.max(MIN_STEP_MS, BASE_STEP_MS - (level - 1) * STEP_PER_LVL);
    floatText(COLS / 2 - 0.5, ROWS / 2 - 0.5, `LEVEL ${level}`, '#22e8ff', 1400, 1.35);
    Sound.levelUp();
  }

  function spawnFood({ forceNormal = false } = {}) {
    const occupied = new Set(snake.map((c) => `${c.x},${c.y}`));
    const open = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!occupied.has(`${x},${y}`)) open.push({ x, y });
      }
    }
    if (!open.length) { food = null; return; }   // board full — you win, basically

    const spot = open[randInt(open.length)];
    const golden = !forceNormal && foodsEaten > 0 && (foodsEaten + 1) % GOLD_EVERY === 0;
    food = { x: spot.x, y: spot.y, golden, born: performance.now() };
  }

  /* ── Effects ───────────────────────────────────────────────────────────── */

  function burst(gx, gy, color, count) {
    const cx = (gx + 0.5) * cell;
    const cy = (gy + 0.5) * cell;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const speed = (0.025 + Math.random() * 0.1) * cell;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        ttl: 380 + Math.random() * 420,
        size: cell * (0.055 + Math.random() * 0.075),
        color,
      });
    }
  }

  function floatText(gx, gy, text, color, ttl = 850, scale = 1) {
    texts.push({
      x: (gx + 0.5) * cell,
      y: (gy + 0.5) * cell,
      text, color, ttl, scale, life: 0,
    });
  }

  function advanceEffects(dt) {
    const f = dt / 16.667;                       // normalise to 60fps units

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.ttl) { particles.splice(i, 1); continue; }
      p.x += p.vx * f;
      p.y += p.vy * f;
      p.vy += cell * 0.0018 * f;                 // a whisper of gravity
      p.vx *= 0.97;
      p.vy *= 0.97;
    }

    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.life += dt;
      if (t.life >= t.ttl) { texts.splice(i, 1); continue; }
      t.y -= 0.22 * f;
    }
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  function render(t, now) {
    ctx.clearRect(0, 0, boardSize, boardSize);
    drawField();
    if (food) drawFood(now);
    drawSnake(t);
    drawParticles();
    drawTexts();
  }

  function drawField() {
    ctx.save();
    ctx.strokeStyle = 'rgba(162, 75, 255, 0.17)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < COLS; i++) {
      const p = Math.round(i * cell) + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, boardSize);
      ctx.moveTo(0, p); ctx.lineTo(boardSize, p);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Interpolated centre points of every segment.
   * Segment i moves from where segment i sat last tick to its current cell,
   * which makes the whole body slide as one continuous ribbon.
   */
  function segmentPoints(t) {
    return snake.map((c, i) => {
      const p = prevCells[i];
      const x = p ? lerp(p.x, c.x, t) : c.x;
      const y = p ? lerp(p.y, c.y, t) : c.y;
      return { x: (x + 0.5) * cell, y: (y + 0.5) * cell };
    });
  }

  function tracePath(points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (points.length === 1) ctx.lineTo(points[0].x, points[0].y);
  }

  function drawSnake(t) {
    const points = segmentPoints(t);
    if (!points.length) return;

    const skin = SKINS[(level - 1) % SKINS.length];
    const head = points[0];
    const tail = points[points.length - 1];

    const gradient = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
    gradient.addColorStop(0, skin.head);
    gradient.addColorStop(1, skin.tail);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Outer bloom
    ctx.shadowColor = skin.head;
    ctx.shadowBlur = cell * 1.15;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = cell * 0.68;
    tracePath(points);
    ctx.stroke();
    ctx.stroke();                    // second pass deepens the glow

    // Solid core
    ctx.shadowBlur = 0;
    tracePath(points);
    ctx.stroke();

    // Specular highlight down the spine
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = cell * 0.18;
    tracePath(points);
    ctx.stroke();

    ctx.restore();
    drawEyes(head, skin.head);
  }

  function drawEyes(head, color) {
    const r = cell * 0.075;
    const fwd = cell * 0.12;
    const side = cell * 0.15;

    // Perpendicular to travel direction
    const px = -direction.y;
    const py = direction.x;

    ctx.save();
    ctx.fillStyle = '#05010f';
    ctx.shadowColor = color;
    ctx.shadowBlur = cell * 0.25;
    for (const s of [1, -1]) {
      ctx.beginPath();
      ctx.arc(
        head.x + direction.x * fwd + px * side * s,
        head.y + direction.y * fwd + py * side * s,
        r, 0, TAU,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFood(now) {
    const color = food.golden ? GOLD_COLOR : FOOD_COLOR;
    const cx = (food.x + 0.5) * cell;
    const cy = (food.y + 0.5) * cell;
    const pulse = 1 + Math.sin(now / 190) * 0.1;
    const r = cell * (food.golden ? 0.34 : 0.29) * pulse;

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = cell * 1.3;

    const g = ctx.createRadialGradient(cx - r * 0.32, cy - r * 0.36, r * 0.12, cx, cy, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.42, color);
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();

    if (food.golden) {
      // Orbiting sparks
      ctx.shadowBlur = cell * 0.7;
      ctx.fillStyle = '#fff6c9';
      const spin = now / 420;
      for (let i = 0; i < 4; i++) {
        const a = spin + (i * TAU) / 4;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * cell * 0.46, cy + Math.sin(a) * cell * 0.46, cell * 0.05, 0, TAU);
        ctx.fill();
      }

      // Countdown ring
      const left = Math.max(0, 1 - (now - food.born) / GOLD_TTL_MS);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 217, 61, 0.85)';
      ctx.lineWidth = Math.max(1.5, cell * 0.06);
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.46, -Math.PI / 2, -Math.PI / 2 + TAU * left);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    for (const p of particles) {
      const fade = 1 - p.life / p.ttl;
      ctx.globalAlpha = Math.max(0, fade);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = cell * 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * fade, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawTexts() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of texts) {
      const progress = t.life / t.ttl;
      ctx.globalAlpha = Math.max(0, 1 - progress * progress);
      ctx.fillStyle = t.color;
      ctx.shadowColor = t.color;
      ctx.shadowBlur = cell * 0.8;
      ctx.font = `700 ${Math.round(cell * 0.62 * t.scale)}px ${fontStack}`;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.restore();
  }

  /* ── Main loop ─────────────────────────────────────────────────────────── */

  function frame(now) {
    const dt = Math.min(now - lastFrame, 120);
    lastFrame = now;

    if (state === 'playing') {
      accumulator += dt;
      while (accumulator >= stepMs && state === 'playing') {
        accumulator -= stepMs;
        step();
      }
    }

    advanceEffects(dt);
    render(state === 'playing' ? accumulator / stepMs : 0, now);
    requestAnimationFrame(frame);
  }

  /* ── HUD & overlay ─────────────────────────────────────────────────────── */

  function bump(el) {
    el.classList.remove('is-bumped');
    void el.offsetWidth;
    el.classList.add('is-bumped');
  }

  function syncHud() {
    if (els.score.textContent !== String(score)) {
      els.score.textContent = String(score);
      bump(els.score);
    }
    if (els.best.textContent !== String(best)) {
      els.best.textContent = String(best);
      bump(els.best);
    }
    if (els.level.textContent !== String(level)) {
      els.level.textContent = String(level);
      bump(els.level);
    }
  }

  function showOverlay({ eyebrow, title, body, action }) {
    els.eyebrow.textContent = eyebrow;
    els.title.textContent = title;
    els.body.textContent = body;
    els.action.textContent = action;
    overlay.dataset.state = state;   // drives the eyebrow accent colour
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
    overlay.dataset.state = 'playing';
  }

  const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Input ─────────────────────────────────────────────────────────────── */

  function turn(name) {
    const dir = DIRS[name];
    if (!dir) return;

    // A steer starts a fresh game, but never restarts a finished one — you've
    // just died, you're probably still mashing keys, and you deserve to read
    // your score before the next round begins.
    if (state === 'ready') {
      startGame();
      queued.push(dir);
      return;
    }
    if (state !== 'playing') return;

    // Compare against the last intent, not the current heading, so a queued
    // pair of turns (e.g. up-then-left) both register.
    const last = queued.length ? queued[queued.length - 1] : direction;
    if (dir.x === -last.x && dir.y === -last.y) return;
    if (dir.x === last.x && dir.y === last.y) return;
    if (queued.length < 2) queued.push(dir);
  }

  const KEY_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', a: 'left', s: 'down', d: 'right',
  };

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const dirName = KEY_MAP[e.key] || KEY_MAP[e.key.toLowerCase()];
    if (dirName) {
      e.preventDefault();
      Sound.unlock();
      turn(dirName);
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      Sound.unlock();
      if (state === 'ready' || state === 'dead') startGame();
      else togglePause();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (state === 'ready' || state === 'dead') startGame();
      return;
    }

    if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      Sound.unlock();
      startGame();
    }
  });

  els.action.addEventListener('click', () => {
    Sound.unlock();
    if (state === 'paused') togglePause();
    else startGame();
  });

  els.soundToggle.addEventListener('click', () => {
    Sound.enabled = !Sound.enabled;
    els.soundToggle.setAttribute('aria-pressed', String(Sound.enabled));
    els.soundLabel.textContent = Sound.enabled ? 'Sound on' : 'Sound off';
    if (Sound.enabled) { Sound.unlock(); Sound.tone(880, 0, 0.08); }
  });

  // D-pad
  els.dpad.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-dir]');
    if (!btn) return;
    e.preventDefault();
    Sound.unlock();
    turn(btn.dataset.dir);
  });

  // Swipe
  let swipeStart = null;
  stage.addEventListener('pointerdown', (e) => {
    swipeStart = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.hypot(dx, dy) < 24) return;
    Sound.unlock();
    turn(Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? 'right' : 'left')
      : (dy > 0 ? 'down' : 'up'));
  });

  // Auto-pause when the player looks away
  const autoPause = () => { if (state === 'playing') togglePause(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
  window.addEventListener('blur', autoPause);

  window.addEventListener('resize', resize);

  /* ── Boot ──────────────────────────────────────────────────────────────── */

  resize();
  reset();
  showOverlay({
    eyebrow: 'Ready',
    title: 'Neon Snake',
    body: 'Eat the orbs. Dodge the walls. Don’t bite yourself.',
    action: 'Start Game',
  });
  els.best.textContent = String(best);
  lastFrame = performance.now();
  requestAnimationFrame(frame);
})();
