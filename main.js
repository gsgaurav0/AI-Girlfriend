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
import { VRMLoaderPlugin, VRMUtils, VRMLookAt } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';
import { handleAction } from './actionHandler.js';

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
scene.fog = new THREE.FogExp2(0xffffff, 0.035);

const camera = new THREE.PerspectiveCamera(26, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.15, 2.5); // Zoomed in (~20%) and lifted to upper torso

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.15, 0); // Focus on upper body (face down to waist)
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.6;
controls.maxDistance = 5;
controls.update();

// Lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xfff8ff, 2.2);
keyLight.position.set(1, 3, 2.5);
keyLight.castShadow = true;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xe2e8f0, 0.8);
fillLight.position.set(-2, 2, -1);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xc7d2fe, 0.6);
rimLight.position.set(0, 2, -3);
scene.add(rimLight);

// Floor
const floorMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(10, 10),
  new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 1.0, metalness: 0.1 })
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
  parse(text, targetDuration = 0) {
    const events = [];
    let totalDur = 0;

    // Split text into words and punctuation
    const tokens = text.split(/([\s.,!?~…\-;:'"()]+)/);

    for (const token of tokens) {
      if (!token) continue;

      // If punctuation/whitespace
      if (/^[\s.,!?~…\-;:'"()]+$/.test(token)) {
        const isLongPause = /[.,!?~…]/.test(token);
        const d = isLongPause ? 0.3 : 0.08;
        events.push({ shape: null, weight: 0, duration: d });
        totalDur += d;
        continue;
      }

      // Process word by finding vowels (syllable beats)
      const vowels = token.match(/[aeiouyAEIOUY]/g);
      if (vowels && vowels.length > 0) {
        const d = 0.12; // ~120ms per syllable
        for (const v of vowels) {
          const [shape, weight] = this.CHAR_MAP[v] || this.CHAR_MAP[v.toLowerCase()] || ['aa', 0.6];
          events.push({ shape, weight, duration: d });
          totalDur += d;

          // Tiny micro-close between syllables to make mouth flap distinguishable
          events.push({ shape: null, weight: 0.1, duration: 0.03 });
          totalDur += 0.03;
        }
      } else {
        // Word with no standard vowels (e.g. "hmm", "shh")
        const d = 0.15;
        events.push({ shape: 'ih', weight: 0.4, duration: d });
        totalDur += d;
      }

      // Brief pause after every word so words don't blur into a single open mouth
      events.push({ shape: null, weight: 0, duration: 0.06 });
      totalDur += 0.06;
    }

    // Scale to exact audio duration if available
    if (targetDuration > 0 && targetDuration !== Infinity && totalDur > 0) {
      const scale = targetDuration / totalDur;
      for (const ev of events) ev.duration *= scale;
    }

    return events;
  },
};

// ─────────────────────────────────────────────────
// VRM LOADER & ADVANCED LOOKAT
// ─────────────────────────────────────────────────
let currentVRM = null;
let currentMixer = null;
let currentAction = null;

class VRMSmoothLookAt extends VRMLookAt {
  constructor(humanoid, applier) {
    super(humanoid, applier);
    this.smoothFactor = 7.0; // Dampens physics bouncing
    this.yawLimit = 40.0;
    this.pitchLimit = 35.0;
    this._yawDamped = 0.0;
    this._pitchDamped = 0.0;
  }
  update(delta) {
    if (this.target && this.autoUpdate) {
      const _v3 = new THREE.Vector3();
      this.lookAt(this.target.getWorldPosition(_v3));
      // Clamp neck limits based on avatar design
      if (this.yawLimit < Math.abs(this._yaw) || this.pitchLimit < Math.abs(this._pitch)) {
        this._yaw = 0.0;
        this._pitch = 0.0;
      }
      // Damped smooth pursuit
      const k = 1.0 - Math.exp(-this.smoothFactor * delta);
      this._yawDamped += (this._yaw - this._yawDamped) * k;
      this._pitchDamped += (this._pitch - this._pitchDamped) * k;
      this.applier.applyYawPitch(this._yawDamped, this._pitchDamped);
      this._needsUpdate = false;
    }
    if (this._needsUpdate) {
      this._needsUpdate = false;
      this.applier.applyYawPitch(this._yaw, this._pitch);
    }
  }
}

const loader = new GLTFLoader();
const lookAtTarget = new THREE.Object3D();
scene.add(lookAtTarget); // The invisible point she looks at
lookAtTarget.position.set(0, 1.4, 3.0);
loader.register(p => new VRMLoaderPlugin(p));
loader.register(p => new VRMAnimationLoaderPlugin(p));

const setLoadingText = t => {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = t;
};

function loadVRMModel(url) {
  // Show loading overlay
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.remove('hidden');
  setLoadingText('Loading VRM model…');

  loader.load(url,
    (gltf) => {
      const vrm = gltf.userData.vrm;
      if (!vrm) { setLoadingText('Error: VRM data missing.'); return; }

      // Cleanup existing VRM if it exists
      if (currentVRM) {
        scene.remove(currentVRM.scene);
      }
      if (currentMixer) {
        currentMixer.stopAllAction();
      }

      VRMUtils.removeUnnecessaryJoints(gltf.scene);
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      vrm.scene.traverse(o => { if (o.isMesh) o.castShadow = true; });
      VRMUtils.rotateVRM0(vrm);

      // Swap out lookAt for our advanced Smooth pursuit
      if (vrm.lookAt) {
        const smoothLookAt = new VRMSmoothLookAt(vrm.humanoid, vrm.lookAt.applier);
        smoothLookAt.copy(vrm.lookAt);
        vrm.lookAt = smoothLookAt;
        vrm.lookAt.target = lookAtTarget;
      }

      // Add look at quaternion proxy to the VRM (needed for VRMA lookAt animations)
      const lookAtQuatProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      lookAtQuatProxy.name = 'lookAtQuaternionProxy';
      vrm.scene.add(lookAtQuatProxy);

      scene.add(vrm.scene);
      currentVRM = vrm;
      window.currentVRM = vrm;

      // Create AnimationMixer for VRM
      currentMixer = new THREE.AnimationMixer(currentVRM.scene);

      // Fade back to the procedural body (idle) when an animation finishes playing
      currentMixer.addEventListener('finished', (e) => {
        if (currentAction === e.action) {
          currentAction.fadeOut(0.8);
          setTimeout(() => {
            if (currentAction === e.action) {
              currentAction.stop();
              currentAction = null;
            }
          }, 800);
        }
      });

      if (vrm.expressionManager) {
        console.log('[VRM] Expressions:', Object.keys(vrm.expressionManager.expressionMap).join(', '));
        // Disable built-in overrides so expressions don't block our custom lip-sync and blinking logic
        vrm.expressionManager.expressions.forEach(expr => {
          expr.overrideMouth = 'none';
          expr.overrideBlink = 'none';
          expr.overrideLookAt = 'none';
        });
      }

      if (overlay) {
        overlay.classList.add('hidden');
      }

      face.init(vrm);

      // Only connect WS and init UI if they haven't been initialized yet
      if (!window.hasInitializedOnce) {
        window.hasInitializedOnce = true;
        ws.connect();
        ui.init();
      }
    },
    prog => {
      // Avoid dividing by zero or undefined
      const total = prog.total > 0 ? prog.total : prog.loaded;
      setLoadingText(`Loading… ${Math.round((prog.loaded / total) * 100)}%`);
    },
    (e) => { setLoadingText('Error loading VRM.'); console.error(e); }
  );
}

// Initial Load
loadVRMModel('./model /model.vrm');

// Listen to Model Dropdown
document.addEventListener('DOMContentLoaded', () => {
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', (e) => {
      const selectedModelUrl = e.target.value;
      console.log(`[UI] Switching model to: ${selectedModelUrl}`);
      loadVRMModel(selectedModelUrl);
    });
  }
});

// ─────────────────────────────────────────────────
// MIXAMO FBX & VRMA DRAG & DROP
// ─────────────────────────────────────────────────
async function loadFBX(animationUrl) {
  if (currentMixer && currentVRM) {
    console.log('[Mixamo] Loading FBX:', animationUrl);
    try {
      const clip = await loadMixamoAnimation(animationUrl, currentVRM);
      const newAction = currentMixer.clipAction(clip);
      newAction.setLoop(THREE.LoopOnce, 1);
      newAction.clampWhenFinished = true;
      newAction.reset().play();
      if (currentAction && currentAction !== newAction) {
        currentAction.crossFadeTo(newAction, 0.5, false);
      }
      currentAction = newAction;
    } catch (err) {
      console.error('[Mixamo] Failed to load FBX', err);
    }
  }
}

async function loadVRMA(animationUrl) {
  if (currentMixer && currentVRM) {
    console.log('[VRMA] Loading VRMA:', animationUrl);
    try {
      const gltfVrma = await loader.loadAsync(animationUrl);
      const vrmAnimation = gltfVrma.userData.vrmAnimations[0];
      const clip = createVRMAnimationClip(vrmAnimation, currentVRM);
      const newAction = currentMixer.clipAction(clip);
      newAction.setLoop(THREE.LoopOnce, 1);
      newAction.clampWhenFinished = true;
      newAction.reset().play();
      if (currentAction && currentAction !== newAction) {
        currentAction.crossFadeTo(newAction, 0.5, false);
      }
      currentAction = newAction;
    } catch (err) {
      console.error('[VRMA] Failed to load VRMA', err);
    }
  }
}

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const fileType = file.name.split('.').pop().toLowerCase();

  const blob = new Blob([file], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  if (fileType === 'fbx') {
    loadFBX(url);
  } else if (fileType === 'vrma') {
    loadVRMA(url);
  }
  // Optional: could handle dropping .vrm here too, but out of scope
});

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

  // Ultra-Realistic Blink & Expressions
  _blinkTimer: 3,
  _blinkState: 'idle',
  _blinkProg: 0,
  _blinkDur: 0.1,
  _blinkAsym: 0,

  // Mood Drifting
  _moodTimer: 5,
  _currentMood: 'relaxed',
  _moodWeight: 0,
  _targetMoodWeight: 0,

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
  _lookTimer: 0,        // time until next random look
  _lookHoldTime: 4,     // how long to hold current gaze

  // ── Init ──
  init(vrm) {
    this.vrm = vrm;
    this._blinkTimer = 2 + Math.random() * 3;

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
  startSpeaking(text, duration = 0) {
    // Build phoneme queue from actual text
    this._phonQueue = TextPhoneme.parse(text, duration);
    this._phonTimer = 0;
    this._phonCurrent = null;
    this._speaking = true;
    // Clear all lip targets
    this.LIP_SHAPES.forEach(n => { this._lipTarget[n] = 0; });
    console.log(`[LipSync] Phonemes: ${this._phonQueue.length} events, target duration: ${duration.toFixed(2)}s for: "${text.slice(0, 40)}…"`);
  },

  stopSpeaking() {
    this._speaking = false;
    this._phonQueue = [];
    // Close mouth
    this.LIP_SHAPES.forEach(n => { this._lipTarget[n] = 0; });
  },

  setHeadLook(x, y) {
    // Map abstract -1 to 1 into real world meters relative to her head (Z=3ish)
    this._tgX = -x * 1.5;
    this._tgY = 1.4 - y * 1.0;
  },

  // ── Ultra-Realistic Expressions ──
  _handleExpressions(em, delta) {
    if (!em) return;

    // 1. Crisp Symmetrical Blinking (Anime models look uncanny with asymmetrical twitches)
    this._blinkTimer -= delta;
    if (this._blinkTimer <= 0) {
      this._blinkState = 'closing';
      this._blinkTimer = 2 + Math.random() * 4; // natural interval
      this._blinkDur = 0.08; // extremely fast, snappy blink
      this._blinkProg = 0;
    }

    if (this._blinkState !== 'idle') {
      this._blinkProg += delta / this._blinkDur;
      if (this._blinkState === 'closing') {
        if (this._blinkProg >= 1) {
          this._blinkProg = 1;
          this._blinkState = 'opening';
        }
      } else {
        if (this._blinkProg >= 2) {
          this._blinkProg = 0;
          this._blinkState = 'idle';
        }
      }
      const amt = this._blinkState === 'closing' ? this._blinkProg : (2 - this._blinkProg);
      em.setValue('blink', Math.max(0, Math.min(1, amt)));
    } else {
      em.setValue('blink', 0);
    }

    // 2. Pleasant Baseline (Avoid Dead Stare)
    // Instead of random 10% deformities, VRMs look best when resting cleanly
    if (!this._speaking && this._activeExpr === 'neutral') {
      // Faint, stable smile so she feels warm and alive, not robotic
      em.setValue('happy', 0.15);
    }
  },

  // ── Main Update ──
  update(delta, elapsed) {
    if (!this.vrm) return;
    const em = this.vrm.expressionManager;
    const hum = this.vrm.humanoid;

    // ─ 1. Expression smooth cross-fade ─
    const exprSpeed = Math.min(1, delta * 5.5);
    for (const name of Object.keys(this._exprCurrent)) {
      const tgt = this._exprTarget[name] ?? 0;
      const cur = this._exprCurrent[name] ?? 0;
      if (Math.abs(tgt - cur) < 0.001) { this._exprCurrent[name] = tgt; continue; }
      const next = cur + (tgt - cur) * exprSpeed;
      this._exprCurrent[name] = next;
      // ONLY set value here if it's the active macro emotion, Micro-expressions handle themselves
      if (em) try { em.setValue(name, Math.max(0, Math.min(1, next))); } catch (_) { }
    }

    // ─ 2. TEXT-DRIVEN LIP SYNC ─
    let vocalIntensity = 0; // measure how "active" the mouth is
    if (this._speaking) {
      this._phonTimer += delta;

      if (!this._phonCurrent || this._phonTimer >= this._phonCurrent.duration) {
        if (this._phonQueue.length > 0) {
          this._phonCurrent = this._phonQueue.shift();
          this._phonTimer = 0;
          this.LIP_SHAPES.forEach(n => { this._lipTarget[n] = 0; });
          if (this._phonCurrent.shape) {
            const variation = 0.50 + Math.random() * 0.30;
            this._lipTarget[this._phonCurrent.shape] = Math.min(1, this._phonCurrent.weight * variation);
          }
        } else {
          this.stopSpeaking();
          setTimeout(() => this.returnToNeutral(), 500);
        }
      }
    }

    const lipSpeed = Math.min(1, delta * 12);
    for (const name of this.LIP_SHAPES) {
      const tgt = this._lipTarget[name] ?? 0;
      const cur = this._lipCurrent[name] ?? 0;
      const next = cur + (tgt - cur) * lipSpeed;
      this._lipCurrent[name] = next;
      vocalIntensity += next; // accumulate total mouth openness
      if (em && (next > 0.01 || cur > 0.01)) {
        try { em.setValue(name, Math.max(0, Math.min(1, next))); } catch (_) { }
      }
    }

    // ─ 3. Micro-Expressions & Blinking ─
    this._handleExpressions(em, delta);

    // ─ 4. Head Look ─
    // Timer-based drift to update the Object3D target
    if (!this._mouseActive) {
      this._lookTimer -= delta;
      if (this._lookTimer <= 0) {
        if (this._speaking) {
          // Minimal drift forward
          this._tgX = (Math.random() - 0.5) * 0.3;
          this._tgY = 1.4 + (Math.random() - 0.5) * 0.15;
        } else {
          // Occasional broader glance
          this._tgX = (Math.random() - 0.5) * 1.5;
          this._tgY = 1.4 + (Math.random() - 0.5) * 0.6;
        }
        this._lookHoldTime = 3 + Math.random() * 5;
        this._lookTimer = this._lookHoldTime;
      }
    }

    // Ultra-smooth physical object interpolation
    const tgtSpeed = Math.min(1, delta * (this._mouseActive ? 4.0 : 1.2));
    lookAtTarget.position.x += (this._tgX - lookAtTarget.position.x) * tgtSpeed;
    lookAtTarget.position.y += (this._tgY - lookAtTarget.position.y) * tgtSpeed;
    lookAtTarget.position.z = 2.5; // lock depth of focal point point so it's realistically in front of her

    // (Native VRMSmoothLookAt updates the actual head/neck/bones in vrm.update)

    // ─ 5. Procedural Body ─
    // Only apply procedural math if a Mixamo FBX animation is NOT playing!
    if (!currentAction) {
      this._proceduralBody(hum, elapsed);
    }

    // ─ 6. Flush expression manager ─
    if (em) em.update();
  },

  _proceduralBody(hum, elapsed) {
    if (!hum) return;

    // Organic Waves (Multi-frequency)
    const breath = (Math.sin(elapsed * 1.5) + Math.sin(elapsed * 0.8)) * 0.5;
    const sway = (Math.sin(elapsed * 0.5) + Math.sin(elapsed * 1.1)) * 0.5;
    const headMod = Math.sin(elapsed * 2.3) * Math.sin(elapsed * 3.7);

    const chest = hum.getNormalizedBoneNode('chest');
    const upperChest = hum.getNormalizedBoneNode('upperChest');
    const spine = hum.getNormalizedBoneNode('spine');
    const hips = hum.getNormalizedBoneNode('hips');
    const neck = hum.getNormalizedBoneNode('neck');
    const head = hum.getNormalizedBoneNode('head');
    const lShol = hum.getNormalizedBoneNode('leftShoulder');
    const rShol = hum.getNormalizedBoneNode('rightShoulder');
    const lArm = hum.getNormalizedBoneNode('leftUpperArm');
    const rArm = hum.getNormalizedBoneNode('rightUpperArm');
    const lLow = hum.getNormalizedBoneNode('leftLowerArm');
    const rLow = hum.getNormalizedBoneNode('rightLowerArm');

    // 1. Breathing (Chest expands, shoulders lift subtly)
    if (chest) chest.rotation.x = -0.01 + breath * 0.01;
    if (upperChest) upperChest.rotation.x = breath * 0.005;
    if (lShol) lShol.rotation.z = breath * 0.02;
    if (rShol) rShol.rotation.z = -breath * 0.02;

    // 2. Weight Shift (Hips sway laterally, spine counter-balances to keep head centered)
    if (hips) hips.rotation.z = sway * 0.02;
    if (spine) {
      spine.rotation.x = -0.02 + breath * 0.005;
      spine.rotation.z = -sway * 0.02; // Opposite of hips
    }

    // 3. Postural micro-movements on neck and head
    if (neck) {
      neck.rotation.z = headMod * 0.01;
      neck.rotation.x = headMod * 0.01;
    }
    if (head) {
      head.rotation.z = headMod * 0.005;
    }

    // 4. Relaxed, hanging arms dynamically influenced by breath
    if (lArm) lArm.rotation.set(0.08, 0, -1.35 - breath * 0.005);
    if (rArm) rArm.rotation.set(0.08, 0, 1.35 + breath * 0.005);
    if (lLow) lLow.rotation.set(0.1, 0, 0);
    if (rLow) rLow.rotation.set(0.1, 0, 0);
  },

  onMouseEnter() { this._mouseActive = true; },
  onMouseLeave() { this._mouseActive = false; },
};

// ─────────────────────────────────────────────────
// BASE64 → BLOB URL HELPER
// ─────────────────────────────────────────────────
function b64ToObjectUrl(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
}

// ─────────────────────────────────────────────────
// TTS AUDIO QUEUE
// ─────────────────────────────────────────────────
const ttsPlayer = {
  _queue: [],
  _playing: false,
  _neutralTimer: null,
  _currentAudio: null,

  enqueue(b64, text, emotion) {
    clearTimeout(this._neutralTimer);
    this._queue.push({ b64, text, emotion });
    if (!this._playing) this._playNext();
  },

  _playNext() {
    if (this._queue.length === 0) {
      this._playing = false;
      face.stopSpeaking();
      this._neutralTimer = setTimeout(() => face.returnToNeutral(), 1500);
      return;
    }
    this._playing = true;
    const { b64, text, emotion } = this._queue.shift();

    let objUrl;
    try { objUrl = b64ToObjectUrl(b64); }
    catch (e) { console.warn('[TTS] Decode error:', e); this._playing = false; this._playNext(); return; }

    const audio = new Audio(objUrl);
    this._currentAudio = audio;

    const onPlaying = () => {
      if (emotion) face.setEmotion(emotion);
      face.startSpeaking(text, audio.duration);
    };
    audio.addEventListener('playing', onPlaying, { once: true });

    audio.addEventListener('ended', () => {
      face.stopSpeaking();
      URL.revokeObjectURL(objUrl);
      this._currentAudio = null;
      this._playNext();
    }, { once: true });

    audio.addEventListener('error', () => {
      console.warn('[TTS] Audio error');
      face.stopSpeaking();
      URL.revokeObjectURL(objUrl);
      this._currentAudio = null;
      this._playNext();
    }, { once: true });

    audio.play().catch(e => {
      console.warn('[TTS] play() failed:', e);
      face.stopSpeaking();
      URL.revokeObjectURL(objUrl);
      this._currentAudio = null;
      this._playing = false;
      this._playNext();
    });
  },

  clear() {
    this._queue = [];
    if (this._currentAudio) { this._currentAudio.pause(); this._currentAudio = null; }
    face.stopSpeaking();
    clearTimeout(this._neutralTimer);
    this._playing = false;
  },
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
    if (this.socket?.readyState === WebSocket.OPEN) {
      ttsPlayer.clear();
      this.socket.send(JSON.stringify({ type: 'user_message', text }));
      // Show thinking state
      const el = document.getElementById('subtitle-text');
      if (el) { el.textContent = '💭 Thinking…'; el.classList.add('visible'); }
      face.setEmotion('thinking');
    }
  },

  _handle(cmd) {
    console.log('[WS]', cmd.type, cmd.emotion || '', (cmd.text || '').slice(0, 50));
    if (cmd.type !== 'dialogue') return;

    // Subtitle
    const el = document.getElementById('subtitle-text');
    if (el) {
      if (cmd.first || !cmd.streaming) {
        el.textContent = cmd.text || '';
      } else {
        el.textContent += ' ' + (cmd.text || '');
      }
      el.classList.add('visible');
      clearTimeout(el._t);
      el._t = setTimeout(
        () => el.classList.remove('visible'),
        Math.max(4000, (el.textContent?.length || 0) * 80)
      );
    }

    if (cmd.audioB64) {
      ttsPlayer.enqueue(cmd.audioB64, cmd.text, cmd.emotion);
    } else if (cmd.emotion) {
      face.setEmotion(cmd.emotion);
    }

    // Process LLM Action (Dance/Pose)
    if (cmd.action) {
      console.log(`[WS] Action received: ${cmd.action}`);
      handleAction(cmd.action, currentVRM, currentMixer, loader).then(newAction => {
        if (newAction) {
          newAction.setLoop(THREE.LoopOnce, 1);
          newAction.clampWhenFinished = true;
          newAction.reset().play();
          if (currentAction && currentAction !== newAction) {
            currentAction.crossFadeTo(newAction, 0.5, false);
          }
          currentAction = newAction;
        }
      });
    }
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
  const delta = Math.min(clock.getDelta(), 0.05); // capped at 50ms
  const elapsed = clock.getElapsedTime();

  controls.update();

  if (currentMixer) {
    currentMixer.update(delta);
  }

  if (currentVRM) {
    face.update(delta, elapsed);   // ← sets normalized bones + expressions
    currentVRM.update(delta);      // ← converts normalized→raw + spring physics
  }

  renderer.render(scene, camera);
}
animate();
