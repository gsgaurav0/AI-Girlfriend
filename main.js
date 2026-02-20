/**
 * AI Girlfriend VRM — main.js
 *
 * Key improvement: TEXT-DRIVEN LIP SYNC
 *   - Parse response text → phoneme queue
 *   - Vowels map to actual VRM blendshapes (aa/ee/ih/oh/ou)
 *   - Scheduled at natural speech rate (~0.085s/char)
 *   - Smooth lerp between transitions (no hard jumps)
 *
 * Expression: smooth cross-fade, auto-neutral after speaking.
 * Pose: standing (arms at sides), enforced every frame.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// ─────────────────────────────────────────────────
// SCENE SETUP
// ─────────────────────────────────────────────────
const container = document.getElementById('canvas-container');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0a14, 0.035);

const camera = new THREE.PerspectiveCamera(26, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.52, 2.0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.42, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.6;
controls.maxDistance = 5;
controls.update();

// Lights
const ambientLight = new THREE.AmbientLight(0xfff0ff, 0.75);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xfff8ff, 2.2);
keyLight.position.set(1, 3, 2.5);
keyLight.castShadow = true;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xc084fc, 0.55);
fillLight.position.set(-2, 2, -1);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0x818cf8, 0.7);
rimLight.position.set(0, 2, -3);
scene.add(rimLight);

// Floor
const floorMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.MeshStandardMaterial({ color: 0x0d0d1a, roughness: 0.85, transparent: true, opacity: 0.5 })
);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.receiveShadow = true;
scene.add(floorMesh);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─────────────────────────────────────────────────
// TEXT → PHONEME CONVERTER
// Maps each character in the response text to a blendshape + timing.
// VRM blendshapes available: aa, ih, ou, ee, oh
// ─────────────────────────────────────────────────
const TextPhoneme = {
  // Character → [blendshapeName, weight]
  // Vowels drive the mouth open, consonants give slight movement
  CHAR_MAP: {
    a: ['aa', 0.85], A: ['aa', 0.85],
    e: ['ee', 0.55], E: ['ee', 0.55],
    i: ['ih', 0.50], I: ['ih', 0.50], y: ['ih', 0.35], Y: ['ih', 0.35],
    o: ['oh', 0.70], O: ['oh', 0.70],
    u: ['ou', 0.50], U: ['ou', 0.50],
    // Bilabials (b, m, p) → slight close then open  
    b: ['aa', 0.15], m: ['aa', 0.10], p: ['aa', 0.12],
    B: ['aa', 0.15], M: ['aa', 0.10], P: ['aa', 0.12],
    // Labio-dentals (f, v)
    f: ['ih', 0.20], v: ['ih', 0.20], F: ['ih', 0.20], V: ['ih', 0.20],
    // Rounded fricatives (w)
    w: ['ou', 0.30], W: ['ou', 0.30],
    // Other consonants → small aa
    default: ['aa', 0.18],
    // Space / punctuation → silence (mouth closes)
    ' ': [null, 0], '\n': [null, 0],
    '.': [null, 0], ',': [null, 0], '!': [null, 0],
    '?': [null, 0], '~': [null, 0], '…': [null, 0],
  },

  // Seconds per character (average speech rate ~120 wpm ≈ 10 chars/sec)
  CHAR_DURATION: 0.09,
  SPACE_DURATION: 0.07,

  /**
   * Convert text string → array of phoneme events
   * Each event: { shape: string|null, weight: number, duration: number }
   */
  parse(text) {
    const events = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === ' ' || ch === '\n') {
        events.push({ shape: null, weight: 0, duration: this.SPACE_DURATION });
        continue;
      }
      if (/[.,!?~…\-;:'"()]/.test(ch)) {
        events.push({ shape: null, weight: 0, duration: this.CHAR_DURATION * 0.5 });
        continue;
      }
      const [shape, weight] = this.CHAR_MAP[ch] ?? this.CHAR_MAP.default;
      // Skip emoji / non-latin characters
      if (ch.codePointAt(0) > 127) {
        events.push({ shape: null, weight: 0, duration: this.CHAR_DURATION * 0.4 });
        continue;
      }
      events.push({ shape, weight, duration: this.CHAR_DURATION });
    }
    return events;
  },
};

// ─────────────────────────────────────────────────
// VRM LOADER
// ─────────────────────────────────────────────────
let currentVRM = null;
const loader = new GLTFLoader();
loader.register(p => new VRMLoaderPlugin(p));

const setLoadingText = t => {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = t;
};

loader.load('./model.vrm',
  (gltf) => {
    const vrm = gltf.userData.vrm;
    if (!vrm) { setLoadingText('Error: VRM data missing.'); return; }

    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    vrm.scene.traverse(o => { if (o.isMesh) o.castShadow = true; });
    VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);
    currentVRM = vrm;
    window.currentVRM = vrm;

    if (vrm.expressionManager?.expressionMap) {
      console.log('[VRM] Expressions:', Object.keys(vrm.expressionManager.expressionMap).join(', '));
    }

    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 900);

    face.init(vrm);
    ws.connect();
    ui.init();
  },
  prog => setLoadingText(`Loading… ${Math.round((prog.loaded / (prog.total || 1)) * 100)}%`),
  err => { console.error(err); setLoadingText('Failed to load model.vrm'); }
);

// ─────────────────────────────────────────────────
// FACE CONTROLLER
// ─────────────────────────────────────────────────
const face = {
  vrm: null,

  // Expression presets (exact blendshape names from this VRM)
  EXPR_NAMES: {
    happy: 'happy',
    sad: 'sad',
    angry: 'angry',
    surprised: 'surprised',
    thinking: 'relaxed',
    neutral: 'neutral',
    excited: 'happy',
    worried: 'sad',
    love: 'happy',
  },

  BLINK_SHAPES: ['blink', 'blinkLeft', 'blinkRight'],
  LIP_SHAPES: ['aa', 'ih', 'ou', 'ee', 'oh'],

  // ── State ──
  // Expressions: track current live weight per blendshape name
  _exprCurrent: {},   // { shapeName: liveWeight }
  _exprTarget: {},   // { shapeName: targetWeight }
  _activeExpr: 'neutral',

  // Blink
  _blinkTimer: 0,
  _blinkCooldown: 2.5,
  _blinkPhase: 0,
  _blinking: false,

  // Lip sync (text-driven queue)
  _phonQueue: [],   // array of { shape, weight, duration }
  _phonTimer: 0,    // time into current phoneme
  _phonCurrent: null, // current event
  _lipCurrent: {},   // { shapeName: liveWeight } — for smooth lerp
  _lipTarget: {},   // { shapeName: targetWeight }
  _speaking: false,

  // Head look
  _headX: 0, _headY: 0, _tgX: 0, _tgY: 0,
  _mouseActive: false,

  // ── Init ──
  init(vrm) {
    this.vrm = vrm;
    this._blinkCooldown = 2 + Math.random() * 3;
    // Initialize expression weights to 0
    const allNames = [...new Set(Object.values(this.EXPR_NAMES))];
    allNames.forEach(n => { this._exprCurrent[n] = 0; this._exprTarget[n] = 0; });
    // Initialize lip weights to 0
    this.LIP_SHAPES.forEach(n => { this._lipCurrent[n] = 0; this._lipTarget[n] = 0; });
    // Start at neutral
    this._exprTarget['neutral'] = 1;
  },

  // ── Set Emotion ──
  setEmotion(key) {
    const preset = this.EXPR_NAMES[key] || 'neutral';
    if (preset === this._activeExpr) return;
    // Fade out previous
    this._exprTarget[this._activeExpr] = 0;
    this._activeExpr = preset;
    this._exprTarget[preset] = 1;
    // Update badge
    const badge = document.getElementById('emotion-badge');
    if (badge) {
      badge.textContent = key;
      badge.classList.add('visible');
      clearTimeout(badge._t);
      badge._t = setTimeout(() => badge.classList.remove('visible'), 4500);
    }
  },

  returnToNeutral() { this.setEmotion('neutral'); },

  // ── Start Speaking (text-driven) ──
  startSpeaking(text) {
    // Build phoneme queue from actual text
    this._phonQueue = TextPhoneme.parse(text);
    this._phonTimer = 0;
    this._phonCurrent = null;
    this._speaking = true;
    // Clear all lip targets
    this.LIP_SHAPES.forEach(n => { this._lipTarget[n] = 0; });
    console.log(`[LipSync] Phonemes: ${this._phonQueue.length} events for: "${text.slice(0, 40)}…"`);
  },

  stopSpeaking() {
    this._speaking = false;
    this._phonQueue = [];
    // Close mouth
    this.LIP_SHAPES.forEach(n => { this._lipTarget[n] = 0; });
  },

  setHeadLook(x, y) {
    this._tgX = Math.max(-0.35, Math.min(0.35, x));
    this._tgY = Math.max(-0.25, Math.min(0.25, y));
  },

  // ── Main Update ──
  update(delta, elapsed) {
    if (!this.vrm) return;
    const em = this.vrm.expressionManager;
    const hum = this.vrm.humanoid;

    // ─ 1. Expression smooth cross-fade ─
    // Speed: reach target in ~0.35s (feels natural, not too fast not too slow)
    const exprSpeed = Math.min(1, delta * 5.5);
    for (const name of Object.keys(this._exprCurrent)) {
      const tgt = this._exprTarget[name] ?? 0;
      const cur = this._exprCurrent[name] ?? 0;
      if (Math.abs(tgt - cur) < 0.001) { this._exprCurrent[name] = tgt; continue; }
      const next = cur + (tgt - cur) * exprSpeed;
      this._exprCurrent[name] = next;
      if (em) try { em.setValue(name, Math.max(0, Math.min(1, next))); } catch (_) { }
    }

    // ─ 2. Blink ─
    this._blinkTimer += delta;
    if (!this._blinking && this._blinkTimer >= this._blinkCooldown) {
      this._blinking = true;
      this._blinkPhase = 0;
      this._blinkTimer = 0;
      this._blinkCooldown = 2 + Math.random() * 4;
    }
    if (this._blinking) {
      this._blinkPhase += delta;
      const CLOSE = 0.07, HOLD = 0.04, OPEN = 0.09, TOTAL = 0.20;
      let bv = 0;
      if (this._blinkPhase < CLOSE) bv = this._blinkPhase / CLOSE;
      else if (this._blinkPhase < CLOSE + HOLD) bv = 1;
      else if (this._blinkPhase < TOTAL) bv = 1 - (this._blinkPhase - CLOSE - HOLD) / OPEN;
      else { bv = 0; this._blinking = false; }
      const blinkVal = Math.max(0, Math.min(1, bv));
      for (const n of this.BLINK_SHAPES) {
        if (em) try { em.setValue(n, blinkVal); } catch (_) { }
      }
    }

    // ─ 3. TEXT-DRIVEN LIP SYNC ─
    if (this._speaking) {
      this._phonTimer += delta;

      // If no current phoneme or current has expired, advance to next
      if (!this._phonCurrent || this._phonTimer >= this._phonCurrent.duration) {
        if (this._phonQueue.length > 0) {
          this._phonCurrent = this._phonQueue.shift();
          this._phonTimer = 0;

          // Update lip targets: clear all, then set just the new shape
          this.LIP_SHAPES.forEach(n => { this._lipTarget[n] = 0; });
          if (this._phonCurrent.shape) {
            // Add subtle weight variation for naturalness
            const variation = 0.88 + Math.random() * 0.24;
            this._lipTarget[this._phonCurrent.shape] =
              Math.min(1, this._phonCurrent.weight * variation);
          }
        } else {
          // Queue exhausted → stop speaking
          this.stopSpeaking();
          setTimeout(() => this.returnToNeutral(), 500);
        }
      }
    }

    // Smooth lerp all lip shapes toward their targets (key to smooth feel)
    // Speed: ~0.12s to reach target — fast enough to track phonemes but smooth
    const lipSpeed = Math.min(1, delta * 14);
    for (const name of this.LIP_SHAPES) {
      const tgt = this._lipTarget[name] ?? 0;
      const cur = this._lipCurrent[name] ?? 0;
      const next = cur + (tgt - cur) * lipSpeed;
      this._lipCurrent[name] = next;
      if (em && (next > 0.01 || cur > 0.01)) {
        try { em.setValue(name, Math.max(0, Math.min(1, next))); } catch (_) { }
      }
    }

    // ─ 4. Head look (idle drift + mouse follow) ─
    if (!this._mouseActive) {
      this._tgX = Math.sin(elapsed * 0.31) * 0.022 + Math.sin(elapsed * 0.87) * 0.009;
      this._tgY = Math.cos(elapsed * 0.27) * 0.013;
    }
    const headSpeed = Math.min(1, delta * 4.5);
    this._headX += (this._tgX - this._headX) * headSpeed;
    this._headY += (this._tgY - this._headY) * headSpeed;
    if (hum) {
      const head = hum.getNormalizedBoneNode('head');
      const neck = hum.getNormalizedBoneNode('neck');
      if (head) { head.rotation.y = this._headX; head.rotation.x = this._headY; }
      if (neck) { neck.rotation.y = this._headX * 0.3; neck.rotation.x = this._headY * 0.3; }
    }

    // ─ 5. Standing arm pose (enforced every frame before vrm.update) ─
    this._standPose(hum);

    // ─ 6. Flush expression manager ─
    if (em) em.update();
  },

  _standPose(hum) {
    if (!hum) return;
    // Arms hang at sides: Z-rotation lowers arm from T-pose
    const lArm = hum.getNormalizedBoneNode('leftUpperArm');
    const rArm = hum.getNormalizedBoneNode('rightUpperArm');
    const lLow = hum.getNormalizedBoneNode('leftLowerArm');
    const rLow = hum.getNormalizedBoneNode('rightLowerArm');
    const lHand = hum.getNormalizedBoneNode('leftHand');
    const rHand = hum.getNormalizedBoneNode('rightHand');
    const spine = hum.getNormalizedBoneNode('spine');
    const chest = hum.getNormalizedBoneNode('chest');

    if (lArm) { lArm.rotation.x = 0.08; lArm.rotation.y = 0; lArm.rotation.z = -1.4; }
    if (rArm) { rArm.rotation.x = 0.08; rArm.rotation.y = 0; rArm.rotation.z = 1.4; }
    if (lLow) { lLow.rotation.x = 0.05; lLow.rotation.y = 0; lLow.rotation.z = 0; }
    if (rLow) { rLow.rotation.x = 0.05; rLow.rotation.y = 0; rLow.rotation.z = 0; }
    if (lHand) { lHand.rotation.x = 0; lHand.rotation.z = -0.08; }
    if (rHand) { rHand.rotation.x = 0; rHand.rotation.z = 0.08; }
    if (spine) { spine.rotation.x = -0.02; }
    if (chest) { chest.rotation.x = -0.02; }
  },

  onMouseEnter() { this._mouseActive = true; },
  onMouseLeave() { this._mouseActive = false; },
};

// ─────────────────────────────────────────────────
// WEBSOCKET CLIENT
// ─────────────────────────────────────────────────
const ws = {
  socket: null,

  connect() {
    this.socket = new WebSocket(`ws://${location.hostname}:8000/ws`);
    this._status('connecting');
    this.socket.onopen = () => { console.log('[WS] Connected'); this._status('connected'); };
    this.socket.onmessage = ev => { try { this._handle(JSON.parse(ev.data)); } catch (_) { } };
    this.socket.onerror = () => this._status('error');
    this.socket.onclose = () => { this._status('disconnected'); setTimeout(() => this.connect(), 2000); };
  },

  send(text) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'user_message', text }));
  },

  _handle(cmd) {
    console.log('[WS]', cmd);
    if (cmd.type !== 'dialogue') return;

    // Subtitle
    const el = document.getElementById('subtitle-text');
    if (el) {
      el.textContent = cmd.text || '';
      el.classList.add('visible');
      clearTimeout(el._t);
      el._t = setTimeout(
        () => el.classList.remove('visible'),
        Math.max(3000, (cmd.text?.length || 0) * 70)
      );
    }

    // Emotion first (smooth fade-in)
    if (cmd.emotion) face.setEmotion(cmd.emotion);

    // Text-driven lip sync
    if (cmd.lipSync && cmd.text) face.startSpeaking(cmd.text);
  },

  _status(state) {
    const ind = document.getElementById('ws-indicator');
    const lbl = document.getElementById('ws-label');
    if (!ind || !lbl) return;
    ind.className = '';
    const MAP = {
      connecting: ['', 'Connecting…'],
      connected: ['connected', 'Connected'],
      error: ['error', 'Error'],
      disconnected: ['error', 'Disconnected'],
    };
    const [cls, txt] = MAP[state] || ['', state];
    if (cls) ind.classList.add(cls);
    lbl.textContent = txt;
  },
};

// ─────────────────────────────────────────────────
// DIALOGUE UI
// ─────────────────────────────────────────────────
const ui = {
  init() {
    const input = document.getElementById('dialogue-input');
    const btn = document.getElementById('send-btn');

    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      ws.send(text);
      input.value = '';
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 900);
      const el = document.getElementById('subtitle-text');
      if (el) { el.textContent = '…'; el.classList.add('visible'); }
    };

    btn.addEventListener('click', send);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    document.querySelectorAll('.quick-btn').forEach(b => {
      b.addEventListener('click', () => { input.value = b.dataset.text || ''; send(); });
    });

    container.addEventListener('mousemove', e => {
      face.onMouseEnter();
      face.setHeadLook(
        (e.clientX / window.innerWidth - 0.5) * 0.6,
        (e.clientY / window.innerHeight - 0.5) * -0.4
      );
    });
    container.addEventListener('mouseleave', () => face.onMouseLeave());
  },
};

// ─────────────────────────────────────────────────
// RENDER LOOP
// ─────────────────────────────────────────────────
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.getElapsedTime();
  controls.update();
  if (currentVRM) {
    face.update(delta, elapsed);   // ← sets normalized bones + expressions
    currentVRM.update(delta);      // ← converts normalized→raw + spring physics
  }
  renderer.render(scene, camera);
}
animate();
