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
import { VRMSpringBoneJointHelper, VRMSpringBoneColliderHelper } from '@pixiv/three-vrm-springbone';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';
import { handleAction } from './actionHandler.js';
import { savePose, restorePose, resetPose } from './poseHelper.js';

// ── Advanced Feature Flags (toggle via browser console) ─────────────────────
// window.debugSpringBone = true  → show spring bone collider/joint helpers
// window.debugFirstPerson = true → switch camera to first-person layer
window.debugSpringBone = window.debugSpringBone ?? false;

// Expose Humanoid Pose API globally for console use
window.savePose = () => currentVRM ? savePose(currentVRM) : null;
window.restorePose = (pose) => currentVRM && restorePose(currentVRM, pose);
window.resetPose = () => currentVRM && resetPose(currentVRM);

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

// ─────────────────────────────────────────────────────────────────────────
// REAL-TIME AUDIO LIP SYNC  (Web Audio API FFT)
//
// The audio element is routed through an AnalyserNode. Each animation frame
// we read the FFT frequency bins and map them to VRM mouth shapes:
//
//   Bass  0-1.4 kHz  → aa / oh  (open jaw, round open)
//   Mid   1.4-4 kHz  → ou / oh  (round forward)
//   High  4-8 kHz    → ee / ih  (spread / narrow)
//
// This gives PERFECT sync because the mouth is driven by the actual audio
// signal, not by a text-guessing timer.
// ─────────────────────────────────────────────────────────────────────────
const AudioLipSync = {
  ctx: null,
  analyser: null,
  source: null,
  data: null,
  active: false,
  _s: { aa: 0, ee: 0, ih: 0, oh: 0, ou: 0 }, // smoothed weights

  _init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.55;
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.connect(this.ctx.destination);
  },

  connect(audioEl) {
    this._init();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.source) { try { this.source.disconnect(); } catch (_) { } }
    try {
      this.source = this.ctx.createMediaElementSource(audioEl);
      this.source.connect(this.analyser);
      this.active = true;
    } catch (e) {
      console.warn('[AudioLipSync] connect failed:', e.message);
      this.active = false;
    }
  },

  stop() {
    this.active = false;
    const s = this._s;
    Object.keys(s).forEach(k => { s[k] = 0; });
  },

  getWeights() {
    const s = this._s;
    if (!this.active || !this.analyser) {
      Object.keys(s).forEach(k => { s[k] *= 0.7; });
      return s;
    }
    this.analyser.getByteFrequencyData(this.data);

    const band = (lo, hi) => {
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += this.data[i];
      return sum / ((hi - lo + 1) * 255);
    };

    // bin width ≈ 344 Hz for 44.1kHz/256-point FFT
    const bass = band(0, 3);    // 0–1.4 kHz
    const mid = band(4, 10);   // 1.4–3.8 kHz
    const high = band(11, 22);  // 3.8–8 kHz

    const loudness = (bass + mid + high) / 3;
    if (loudness < 0.018) {
      Object.keys(s).forEach(k => { s[k] *= 0.80; });
      return s;
    }

    const total = bass + mid + high + 1e-6;
    const bR = bass / total;
    const mR = mid / total;
    const hR = high / total;

    // Scale down the overall intensity. VRM blendshapes at 1.0 can be very extreme
    // and clip through the chin on many models.
    const SCALE = 0.5;
    const raw = {
      aa: loudness * Math.pow(bR, 0.45) * SCALE,
      oh: loudness * Math.pow(bR * 0.5 + mR * 0.5, 0.55) * SCALE,
      ou: loudness * Math.pow(mR, 0.60) * SCALE,
      ee: loudness * Math.pow(hR, 0.45) * SCALE,
      ih: loudness * Math.pow(mR * 0.35 + hR * 0.65, 0.60) * SCALE,
    };

    const RISE = 0.40, FALL = 0.22;
    Object.keys(s).forEach(k => {
      const tgt = Math.min(1, raw[k] ?? 0);
      s[k] += (tgt > s[k] ? RISE : FALL) * (tgt - s[k]);
    });

    return s;
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

// ── Advanced Feature: Track debug helpers for cleanup on model swap ───────
let _springBoneDebugHelpers = [];

function _cleanupSpringBoneHelpers() {
  _springBoneDebugHelpers.forEach(h => h.parent?.remove(h));
  _springBoneDebugHelpers = [];
}

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

      // ── ADVANCED FEATURE 1: FirstPerson Mesh Culling ─────────────────────
      // Reads VRM annotation data to set up layer masks for first/third person.
      if (vrm.firstPerson) {
        vrm.firstPerson.setup();
        console.log('[VRM] FirstPerson mesh culling layers set up.');

        // Fix for blank screen: FirstPerson moves third-person meshes to layer 10 by default!
        // We MUST tell the camera to render this layer, otherwise the model turns invisible.
        camera.layers.enable(vrm.firstPerson.thirdPersonOnlyLayer);

        // To enable first-person view instead in the future:
        //   camera.layers.disable(vrm.firstPerson.thirdPersonOnlyLayer);
        //   camera.layers.enable(vrm.firstPerson.firstPersonOnlyLayer);
      }

      // ── ADVANCED FEATURE 2: SpringBone Initialization + Debug Helpers ────
      if (vrm.springBoneManager) {
        vrm.springBoneManager.setInitState();
        console.log('[VRM] SpringBone physics initialized.');

        // Cleanup old debug helpers from previous model swap
        _cleanupSpringBoneHelpers();

        if (window.debugSpringBone) {
          // Visualize spring bone joints (shows the bone chain + hit radius spheres)
          vrm.springBoneManager.joints.forEach(joint => {
            const helper = new VRMSpringBoneJointHelper(joint);
            vrm.scene.add(helper);
            _springBoneDebugHelpers.push(helper);
          });
          // Visualize collider shapes (sphere/capsule/plane volumes)
          vrm.springBoneManager.colliderGroups.forEach(group => {
            group.colliders.forEach(collider => {
              const helper = new VRMSpringBoneColliderHelper(collider);
              vrm.scene.add(helper);
              _springBoneDebugHelpers.push(helper);
            });
          });
          console.log(`[VRM] SpringBone debug: ${_springBoneDebugHelpers.length} helpers added.`);
        }
      }

      // ── ADVANCED FEATURE 3: Node Constraint Initialization ──────────────
      // Constraints (Aim/Roll/Rotation) are loaded automatically by VRMLoaderPlugin.
      // They will be updated each frame in the render loop before vrm.update().
      if (vrm.nodeConstraintManager) {
        console.log('[VRM] Node Constraints loaded:', vrm.nodeConstraintManager.constraints.size, 'constraint(s).');
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

  // Expression presets — maps ALL emotions the LLM sends to VRM presets.
  // VRM available: happy, angry, sad, relaxed, surprised, neutral
  EXPR_NAMES: {
    // Positive
    happy: 'happy',
    excited: 'happy',
    love: 'happy',
    joy: 'happy',
    // Negative
    sad: 'sad',
    worried: 'sad',
    upset: 'sad',
    lonely: 'sad',
    // Angry
    angry: 'angry',
    annoyed: 'angry',
    frustrated: 'angry',
    stress: 'angry',    // closest VRM shape for stress
    // Calm / Relaxed
    relaxed: 'relaxed',
    thinking: 'relaxed',
    bored: 'relaxed',
    tired: 'relaxed',
    // Surprised
    surprised: 'surprised',
    shocked: 'surprised',
    confused: 'surprised',
    // Neutral baseline
    neutral: 'neutral',
    // Fallback for anything not mapped
    _default: 'neutral',
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
    const preset = this.EXPR_NAMES[key] ?? this.EXPR_NAMES['_default'] ?? 'neutral';
    if (preset === this._activeExpr) return;
    // Fade out previous expression
    Object.keys(this._exprTarget).forEach(n => { this._exprTarget[n] = 0; });
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
    console.log(`[Face] Emotion: ${key} → ${preset}`);
  },

  returnToNeutral() { this.setEmotion('neutral'); },

  // ── Start Speaking ──
  startSpeaking() {
    this._speaking = true;
  },

  stopSpeaking() {
    this._speaking = false;
    // Stop the audio analyser so weights decay to 0
    AudioLipSync.stop();
  },

  setHeadLook(x, y) {
    // Map abstract -1 to 1 into real world meters relative to her head (Z=3ish)
    this._tgX = -x * 1.5;
    this._tgY = 1.4 - y * 1.0;
  },

  // ── Ultra-Realistic Expressions (blink only — emotions cross-fade in update()) ──
  _handleExpressions(em, delta) {
    if (!em) return;

    // 1. Crisp Symmetrical Blinking
    this._blinkTimer -= delta;
    if (this._blinkTimer <= 0) {
      this._blinkState = 'closing';
      this._blinkTimer = 2 + Math.random() * 4;
      this._blinkDur = 0.08;
      this._blinkProg = 0;
    }

    if (this._blinkState !== 'idle') {
      this._blinkProg += delta / this._blinkDur;
      if (this._blinkState === 'closing') {
        if (this._blinkProg >= 1) { this._blinkProg = 1; this._blinkState = 'opening'; }
      } else {
        if (this._blinkProg >= 2) { this._blinkProg = 0; this._blinkState = 'idle'; }
      }
      const amt = this._blinkState === 'closing' ? this._blinkProg : (2 - this._blinkProg);
      em.setValue('blink', Math.max(0, Math.min(1, amt)));
    } else {
      em.setValue('blink', 0);
    }

    // 2. Pleasant Baseline: faint warmth when idle, but DO NOT override active emotions
    if (!this._speaking && this._activeExpr === 'neutral') {
      // Blend faint happy into neutral so she doesn't look dead
      const current = em.getValue('happy') ?? 0;
      const target = 0.12;
      em.setValue('happy', current + (target - current) * Math.min(1, delta * 3));
    }
  },

  // ── Main Update ──
  update(delta, elapsed) {
    if (!this.vrm) return;
    const em = this.vrm.expressionManager;
    const hum = this.vrm.humanoid;

    // ─ 1. Expression smooth cross-fade ─
    // We only drive the macro-emotion blendshapes here via setValue.
    // Blink and lip shapes are handled in SEPARATE steps below.
    // This avoids fighting with the expression manager's override system.
    const exprSpeed = Math.min(1, delta * 4.5); // slightly slower = smoother cross-fade
    for (const name of Object.keys(this._exprCurrent)) {
      // Skip lip / blink shapes — they are managed below
      if (this.LIP_SHAPES.includes(name) || this.BLINK_SHAPES.includes(name)) continue;
      const tgt = this._exprTarget[name] ?? 0;
      const cur = this._exprCurrent[name] ?? 0;
      if (Math.abs(tgt - cur) < 0.002) { this._exprCurrent[name] = tgt; }
      else { this._exprCurrent[name] = cur + (tgt - cur) * exprSpeed; }
      if (em) try { em.setValue(name, Math.max(0, Math.min(1, this._exprCurrent[name]))); } catch (_) { }
    }

    // ─ 2. REAL-TIME AUDIO LIP SYNC ─
    // AudioLipSync.getWeights() reads the live FFT every frame and returns
    // per-shape weights that naturally follow the actual audio signal.
    // When not speaking all weights decay to 0 automatically.
    // ─ 2. REAL-TIME AUDIO LIP SYNC ─
    // Only apply FFT weights when actually speaking. When silent, force all lip
    // shapes to zero so the mouth closes cleanly between words/sentences.
    if (em) {
      if (this._speaking) {
        const w = AudioLipSync.getWeights();
        for (const name of this.LIP_SHAPES) {
          const val = w[name] ?? 0;
          this._lipCurrent[name] = val;
          try { em.setValue(name, Math.max(0, Math.min(1, val))); } catch (_) { }
        }
      } else {
        // Not speaking — decay all lip shapes quickly to zero
        for (const name of this.LIP_SHAPES) {
          this._lipCurrent[name] = (this._lipCurrent[name] ?? 0) * 0.6;
          try { em.setValue(name, this._lipCurrent[name]); } catch (_) { }
        }
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

    // NOTE: Do NOT call em.update() here.
    // vrm.update(delta) in the render loop calls expressionManager.update() internally.
    // Calling it twice caused expression overrides to fight each other and showed wrong
    // emotion/vowel shapes. Let vrm.update() be the single authority for flushing.
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

    // Route audio through the Web Audio analyser for real-time FFT lip sync
    AudioLipSync.connect(audio);

    const onPlaying = () => {
      if (emotion) face.setEmotion(emotion);
      face.startSpeaking(); // just sets _speaking = true; actual lip weights come from AudioLipSync.getWeights()
    };
    audio.addEventListener('playing', onPlaying, { once: true });

    audio.addEventListener('ended', () => {
      face.stopSpeaking();         // sets _speaking=false → mouth closes
      URL.revokeObjectURL(objUrl);
      this._currentAudio = null;
      // Wait 200ms so the mouth is visibly closed before the next sentence starts.
      // This creates a natural breath/pause between sentences.
      setTimeout(() => this._playNext(), 200);
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
    // ── ADVANCED FEATURE 4: Node Constraints ─────────────────────────────
    // Must run BEFORE vrm.update() so constrained bones are ready when
    // the humanoid converts normalized→raw bone transforms.
    if (currentVRM.nodeConstraintManager) {
      currentVRM.nodeConstraintManager.update();
    }

    face.update(delta, elapsed);   // ← sets normalized bones + expressions
    currentVRM.update(delta);      // ← converts normalized→raw + SpringBone physics

    // ── ADVANCED FEATURE 5: MToon UV Animation ───────────────────────────
    // MToonMaterial supports animated scrolling/rotating UVs defined in the
    // VRM file (VRMC_materials_mtoon extension). Call updateUVAnimation each
    // frame so the texture offsets are ticked forward in time.
    currentVRM.scene.traverse((obj) => {
      if (obj.isMesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(mat => {
          if (mat && typeof mat.updateUVAnimation === 'function') {
            mat.updateUVAnimation(delta);
          }
        });
      }
    });

    // ── ADVANCED FEATURE 6: SpringBone Debug Helper per-frame update ──────
    // Helpers need their own update() to redraw the wireframes each frame.
    if (window.debugSpringBone) {
      _springBoneDebugHelpers.forEach(h => h.update?.());
    }
  }

  renderer.render(scene, camera);
}
animate();
