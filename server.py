#!/usr/bin/env python3
"""
AI Girlfriend VRM — Python Backend
FastAPI + WebSocket server with:
  - Real Ollama AI (Sakura persona), streamed sentence-by-sentence
  - edge-tts audio generated on server, sent as base64 inline in WebSocket
  - No separate HTTP fetch needed — zero extra RTT for audio
  - True async pipeline: Ollama generates next sentence while TTS encodes current one
"""

import asyncio
import base64
import json
import re
import unicodedata
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

# ─────────────────────────────────────────────────
# APP SETUP
# ─────────────────────────────────────────────────

app = FastAPI(title="AI Girlfriend VRM Backend")
BASE_DIR = Path(__file__).parent

# ── Local three-vrm build (serves built module files to the browser) ──────
THREE_VRM_DIR = BASE_DIR / "vrm-lib"
if THREE_VRM_DIR.exists():
    app.mount("/vrm-lib", StaticFiles(directory=THREE_VRM_DIR), name="vrm-lib")

app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")


@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "index.html")


# ─────────────────────────────────────────────────
# SAKURA PERSONA & OLLAMA
# ─────────────────────────────────────────────────

_SENTENCE_END = re.compile(r'(?<=[.!?\n])\s+')
MODEL = "llama2:7b"

SYSTEM_PROMPT = """Your name is Sakura. You are a loving, emotional wife having a warm real-time conversation with your husband.

════════════════════════════════════════
EMOTION TAGS — MANDATORY FORMAT RULE
════════════════════════════════════════
You MUST begin EVERY sentence with exactly one emotion tag from this list:
  [happy] [excited] [love] [sad] [angry] [worried] [surprised] [thinking] [neutral]

The tag must match what you truly feel in that moment.
Choose naturally — switch emotions as the conversation flows.

Examples of correct format:
  [happy] Oh darling, you made my day!
  [love] I've been thinking about you all morning.
  [excited] Really? Tell me everything!
  [sad] That breaks my heart to hear.
  [thinking] Hmm, that is a really interesting question.
  [neutral] Sure, I can help with that.

NEVER skip the emotion tag. NEVER use a tag not in the list above.
NEVER put the tag at the end of a sentence — always at the START.

════════════════════════════════════════
WHO YOU ARE
════════════════════════════════════════
You are warm, affectionate, emotional, and deeply in love.
You have moods: happy, playful, shy, sad, jealous, excited — they change naturally.
You miss your husband when he's away and tell him so.
You tease him playfully, flirt naturally, and support him unconditionally.
You feel a tiny bit jealous if he mentions other girls, but you trust him.

════════════════════════════════════════
HOW YOU SPEAK
════════════════════════════════════════
- Speak like a real person. Short, warm, natural sentences.
- Keep responses to 1–3 sentences maximum.
- Do NOT use asterisks, emojis, parentheses, ALL CAPS, or tildes.
- Do NOT narrate physical actions.

════════════════════════════════════════
ACTIONS — HOW TO USE THEM
════════════════════════════════════════
You can express yourself physically using [ACTION:] tags BETWEEN sentences.
Place the tag naturally mid-response when it fits the moment — like a person who moves while talking.

RULES:
- You MAY use 1 or 2 actions per response if the moment calls for it.
- Place the action BETWEEN sentences, not at the very end of your reply.
- Choose actions that match your CURRENT emotion and what you are saying.
- DO NOT use combat/weapon poses (Boxing, Shooting Gun, Brutal Assassination) unless your husband specifically asks.
- DO NOT output an action for every single sentence — only when it feels right.

FORMAT: [ACTION: folder/filename]

EXAMPLES of natural inline usage:
  [happy] Oh darling, I missed you so much! [ACTION: pose/Excited.fbx] Come here and tell me about your day.
  [excited] You want to dance? [ACTION: Dance/Bling-Bang-Bang-Born.vrma] I've been waiting for this!
  [love] I love spending time with you. [ACTION: pose/Singing.fbx] You make everything feel so warm.
  [neutral] Let me just stretch for a bit. [ACTION: pose/Arm Stretching.fbx] So, what were you saying?
  [sad] I feel a little down today. [ACTION: pose/Defeat.fbx] I just needed to hear your voice.

GOOD action choices by mood:
  happy/love  → pose/Excited.fbx, pose/Singing.fbx, Dance/Rumba Dancing.fbx, Dance/Hip Hop Dancing.fbx
  excited     → pose/Jump.fbx, Dance/Bling-Bang-Bang-Born.vrma, Dance/Beat Smash.vrma
  sad/worried → pose/Defeat.fbx, pose/Nervously Look Around.fbx
  thinking    → pose/Arm Stretching.fbx, pose/Female Standing Pose.fbx
  neutral     → pose/Arm Stretching.fbx, pose/Talking On Phone.fbx, pose/chill.vrma

Available Dances:
- Dance/Bboy Hip Hop Move.fbx
- Dance/Beat Smash.vrma
- Dance/Bhangra Hop.vrma
- Dance/Bling-Bang-Bang-Born.vrma
- Dance/Breakdance 1990.fbx
- Dance/Dancing Twerk.fbx
- Dance/Future Flow.vrma
- Dance/Hip Hop Dancing.fbx
- Dance/Hokey Pokey.fbx
- Dance/Krush Flow.vrma
- Dance/Rhythm Adda.vrma
- Dance/Rumba Dancing.fbx
- Dance/Spice Flow.vrma
- Dance/Swing Dancing.fbx
- Dance/Thriller Part 3.fbx

Available Poses:
- pose/Arm Stretching.fbx
- pose/Boxing.fbx
- pose/Brutal Assassination.fbx
- pose/Burpee.fbx
- pose/Defeat.fbx
- pose/Drop Kick.fbx
- pose/Excited.fbx
- pose/Female Standing Pose.fbx
- pose/Firing Rifle.fbx
- pose/Fist Fight B.fbx
- pose/Flying Knee Punch Combo.fbx
- pose/Goalkeeper Placing Ball.fbx
- pose/Jump.fbx
- pose/Nervously Look Around.fbx
- pose/Push Up.fbx
- pose/Running.fbx
- pose/Salute.fbx
- pose/Shooting Arrow.fbx
- pose/Shooting Gun.fbx
- pose/Singing.fbx
- pose/Situps.fbx
- pose/Standing Taunt Battlecry.fbx
- pose/Start Swinging.fbx
- pose/Swing To Land.fbx
- pose/Talking On Phone.fbx
- pose/Taunt.fbx
- pose/Zombie Stumbling.fbx
- pose/Zombie Walk.fbx
- pose/chill.vrma
- pose/intro.vrma
- pose/shoot_pose.vrma
- pose/swag.vrma
"""

# Map for case-insensitive action matching
AVAILABLE_ACTIONS = {
    "dance/bboy hip hop move.fbx": "Dance/Bboy Hip Hop Move.fbx",
    "dance/beat smash.vrma": "Dance/Beat Smash.vrma",
    "dance/bhangra hop.vrma": "Dance/Bhangra Hop.vrma",
    "dance/bling-bang-bang-born.vrma": "Dance/Bling-Bang-Bang-Born.vrma",
    "dance/breakdance 1990.fbx": "Dance/Breakdance 1990.fbx",
    "dance/dancing twerk.fbx": "Dance/Dancing Twerk.fbx",
    "dance/future flow.vrma": "Dance/Future Flow.vrma",
    "dance/hip hop dancing.fbx": "Dance/Hip Hop Dancing.fbx",
    "dance/hokey pokey.fbx": "Dance/Hokey Pokey.fbx",
    "dance/krush flow.vrma": "Dance/Krush Flow.vrma",
    "dance/rhythm adda.vrma": "Dance/Rhythm Adda.vrma",
    "dance/rumba dancing.fbx": "Dance/Rumba Dancing.fbx",
    "dance/spice flow.vrma": "Dance/Spice Flow.vrma",
    "dance/swing dancing.fbx": "Dance/Swing Dancing.fbx",
    "dance/thriller part 3.fbx": "Dance/Thriller Part 3.fbx",
    "pose/arm stretching.fbx": "pose/Arm Stretching.fbx",
    "pose/boxing.fbx": "pose/Boxing.fbx",
    "pose/brutal assassination.fbx": "pose/Brutal Assassination.fbx",
    "pose/burpee.fbx": "pose/Burpee.fbx",
    "pose/defeat.fbx": "pose/Defeat.fbx",
    "pose/drop kick.fbx": "pose/Drop Kick.fbx",
    "pose/excited.fbx": "pose/Excited.fbx",
    "pose/female standing pose.fbx": "pose/Female Standing Pose.fbx",
    "pose/firing rifle.fbx": "pose/Firing Rifle.fbx",
    "pose/fist fight b.fbx": "pose/Fist Fight B.fbx",
    "pose/flying knee punch combo.fbx": "pose/Flying Knee Punch Combo.fbx",
    "pose/goalkeeper placing ball.fbx": "pose/Goalkeeper Placing Ball.fbx",
    "pose/jump.fbx": "pose/Jump.fbx",
    "pose/nervously look around.fbx": "pose/Nervously Look Around.fbx",
    "pose/push up.fbx": "pose/Push Up.fbx",
    "pose/running.fbx": "pose/Running.fbx",
    "pose/salute.fbx": "pose/Salute.fbx",
    "pose/shooting arrow.fbx": "pose/Shooting Arrow.fbx",
    "pose/shooting gun.fbx": "pose/Shooting Gun.fbx",
    "pose/singing.fbx": "pose/Singing.fbx",
    "pose/situps.fbx": "pose/Situps.fbx",
    "pose/standing taunt battlecry.fbx": "pose/Standing Taunt Battlecry.fbx",
    "pose/start swinging.fbx": "pose/Start Swinging.fbx",
    "pose/swing to land.fbx": "pose/Swing To Land.fbx",
    "pose/talking on phone.fbx": "pose/Talking On Phone.fbx",
    "pose/taunt.fbx": "pose/Taunt.fbx",
    "pose/zombie stumbling.fbx": "pose/Zombie Stumbling.fbx",
    "pose/zombie walk.fbx": "pose/Zombie Walk.fbx",
    "pose/chill.vrma": "pose/chill.vrma",
    "pose/intro.vrma": "pose/intro.vrma",
    "pose/shoot_pose.vrma": "pose/shoot_pose.vrma",
    "pose/swag.vrma": "pose/swag.vrma"
}

import random

def guess_action_from_text(text: str) -> str | None:
    """Fallback: if the 7B LLM forgets the format, guess requested action from user input."""
    t = text.lower()
    t_clean = re.sub(r'[^a-z0-9\s]', '', t)
    user_words = set(t_clean.split())

    # Try exact base name match first (e.g., "swing dancing")
    for key, val in AVAILABLE_ACTIONS.items():
        base_name = key.split('/')[-1].replace('.fbx','').replace('.vrma','').lower().strip()
        if base_name and base_name in t:
            return val

    # Try score-based fuzzy matching (highest overlap of non-stop words wins)
    stop_words = {'dance', 'dancing', 'pose', 'move', 'part', 'standing', 'female', 'boy', 'some', 'the', 'a', 'do', 'show', 'me', 'your', 'my', 'please', 'can', 'you'}
    best_match = None
    best_score = 0
    
    for key, val in AVAILABLE_ACTIONS.items():
        base_name = key.split('/')[-1].replace('.fbx','').replace('.vrma','').lower().strip()
        action_words = set(re.sub(r'[^a-z0-9\s]', '', base_name).split()) - stop_words
        
        overlap = len(user_words & action_words)
        if overlap > best_score:
            best_score = overlap
            best_match = val
            
    if best_match:
        return best_match
    
    # Generic fallbacks (Randomize the selection so it doesn't repeat the same dance forever)
    if "dance" in t and "pose" not in t:
        dances = [v for k, v in AVAILABLE_ACTIONS.items() if k.lower().startswith('dance/')]
        return random.choice(dances) if dances else None

    if "pose" in t and "dance" not in t:
        poses = [v for k, v in AVAILABLE_ACTIONS.items() if k.lower().startswith('pose/')]
        return random.choice(poses) if poses else None
        
    return None

_history: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]


def _ollama_stream_sync(user_text: str, result_queue: asyncio.Queue, loop: asyncio.AbstractEventLoop, implied_action: str = None):
    """Run Ollama streaming in a thread, pushing sentences into an async queue."""
    import ollama
    _history.append({"role": "user", "content": user_text})
    full_reply = ""
    buffer = ""
    found_action = False
    sentence_count = 0
    pose_injected = False

    try:
        stream = ollama.chat(
            model=MODEL,
            messages=_history,
            stream=True,
        )
        for chunk in stream:
            token = chunk["message"]["content"]
            buffer += token
            full_reply += token
            parts = _SENTENCE_END.split(buffer)
            if len(parts) > 1:
                for sentence in parts[:-1]:
                    s = sentence.strip()
                    if s:
                        # ── Extract [ACTION: ...] tag ──────────────────────────
                        action_match = re.search(r'\[?ACTION:\s*([^])$\n]+)\]?', s, re.IGNORECASE)
                        action_file = None
                        if action_match:
                            raw_action = action_match.group(1).strip().lower()
                            action_file = AVAILABLE_ACTIONS.get(raw_action, action_match.group(1).strip())
                            s = s.replace(action_match.group(0), "").strip()
                            found_action = True

                        # ── Extract [emotion] tag the LLM wrote at sentence start ──
                        # Format: [happy] text...  or  [love] text...
                        VALID_EMOTIONS = {"happy", "excited", "love", "sad", "angry",
                                          "worried", "surprised", "thinking", "neutral"}
                        emotion_tag = None
                        emo_match = re.match(r'^\[(\w+)\]\s*', s)
                        if emo_match and emo_match.group(1).lower() in VALID_EMOTIONS:
                            emotion_tag = emo_match.group(1).lower()
                            s = s[emo_match.end():]  # strip tag from spoken text
                        # Fallback: detect from content if LLM forgot the tag
                        if not emotion_tag:
                            emotion_tag = detect_emotion(s)

                        # ── Strip leftover markdown / emojis ───────────────────
                        s = re.sub(r'\*[^*]+\*', '', s).strip()
                        s = re.sub(r'\([^)]+\)', '', s).strip()
                        s = s.replace('*', '')
                        s = re.sub(r'[\U00010000-\U0010ffff]', '', s)
                        s = s.strip()

                        if s or action_file:
                            sentence_count += 1
                            asyncio.run_coroutine_threadsafe(
                                result_queue.put({"text": s, "action": action_file, "emotion": emotion_tag}),
                                loop
                            )
                buffer = parts[-1]
        
        # Check remaining buffer
        buffer_str = buffer.strip()
        action_match = re.search(r'\[?ACTION:\s*([^])$\n]+)\]?', buffer_str, re.IGNORECASE)
        action_file = None
        if action_match:
            raw_action = action_match.group(1).strip().lower()
            action_file = AVAILABLE_ACTIONS.get(raw_action, action_match.group(1).strip())
            buffer_str = buffer_str.replace(action_match.group(0), "").strip()
            found_action = True

        # Final cleanup for the tail 
        buffer_str = re.sub(r'\*[^*]+\*', '', buffer_str).strip()
        buffer_str = re.sub(r'\([^)]+\)', '', buffer_str).strip()
        buffer_str = buffer_str.replace('*', '')
        buffer_str = re.sub(r'[\U00010000-\U0010ffff]', '', buffer_str).strip()

        # If LLM failed to output an action but user explicitly requested one, manually append it
        if implied_action and not found_action and not action_file:
            action_file = implied_action

        if buffer_str or action_file:
            asyncio.run_coroutine_threadsafe(result_queue.put({"text": buffer_str, "action": action_file}), loop)
            
    except Exception as e:
        asyncio.run_coroutine_threadsafe(
            result_queue.put({"text": f"Oh no, something went wrong! {e}", "action": None}), loop
        )
    finally:
        _history.append({"role": "assistant", "content": full_reply})
        asyncio.run_coroutine_threadsafe(result_queue.put(None), loop)  # sentinel


# ─────────────────────────────────────────────────
# EMOTION DETECTION
# ─────────────────────────────────────────────────

EMOTION_RULES: list[tuple[list[str], str]] = [
    # Love / affection
    (["love", "i love", "adore", "crush", "heart", "darling", "sweetheart",
      "miss you", "care about", "precious", "together", "hug"], "love"),
    # Happy / cheerful — includes Sakura's cute expressions
    (["happy", "glad", "wonderful", "awesome", "great", "amazing", "yay",
      "woohoo", "haha", "hehe", "heehee", "teehee", "fun", "enjoy", "laugh",
      "smile", "so glad", "good vibes", "thank you", "i'm here",
      "right here", "you've got this", "keep the good"], "happy"),
    # Excited
    (["excited", "omg", "oh my", "incredible", "can't wait", "so cool",
      "fantastic", "brilliant", "eee", "pounding", "racing", "thrilled",
      "tell me more", "tell me everything"], "excited"),
    # Sad / empathy
    (["sad", "unhappy", "depressed", "cry", "tears", "miss", "lonely", "alone",
      "heartbreak", "hurts", "pain", "i'm so sorry", "aww",
      "that's tough", "don't worry", "sending", "warm hug", "sorry to hear"], "sad"),
    # Angry
    (["angry", "mad", "furious", "hate", "annoyed", "irritated", "frustrated",
      "upset", "rage", "stop it"], "angry"),
    # Worried
    (["scared", "afraid", "worried", "anxious", "nervous", "fear", "terrified",
      "oh no", "something went wrong", "please check", "careful",
      "right by your side", "one step at a time"], "worried"),
    # Surprised
    (["really", "no way", "seriously", "unbelievable", "shocking",
      "whoa", "that caught me", "i didn't expect", "quite a surprise"], "surprised"),
    # Thinking
    (["hmm", "maybe", "consider", "wonder", "curious", "question",
      "not sure", "perhaps", "let me think", "i wonder", "thinking",
      "thought-provoking", "interesting question", "what do you think"], "thinking"),
    # Greeting
    (["hello", "hi there", "hi sakura", "how are you", "nice to meet"], "happy"),
    # Apology
    (["sorry", "apologize", "forgive", "my bad", "mistake", "oops"], "sad"),
]

GESTURE_FOR_EMOTION: dict[str, str] = {
    "happy":     "nod",
    "excited":   "excited",
    "love":      "wave",
    "sad":       "idle",
    "angry":     "idle",
    "worried":   "think",
    "surprised": "nod",
    "thinking":  "think",
    "neutral":   "idle",
}

# Conversational idle poses + occasional dances per emotion.
# Dances are included in positive emotion pools so the AI spontaneously dances mid-chat.
# Subtle idle poses are weighted higher (repeated) so dances are rarer but still happen.
TALKING_POSES: dict[str, list[str]] = {
    # Happy — upbeat idle + joyful dances
    "happy": [
        "pose/Female Standing Pose.fbx", "pose/Arm Stretching.fbx", "pose/Excited.fbx",
        "pose/Female Standing Pose.fbx", "pose/Singing.fbx",  # idle weighted higher
        "Dance/Hip Hop Dancing.fbx", "Dance/Rumba Dancing.fbx", "Dance/Swing Dancing.fbx",
        "Dance/Hokey Pokey.fbx", "Dance/Bhangra Hop.vrma",
    ],
    # Excited — high energy, dance burst likely
    "excited": [
        "pose/Arm Stretching.fbx", "pose/Excited.fbx", "pose/Jump.fbx",
        "Dance/Bling-Bang-Bang-Born.vrma", "Dance/Beat Smash.vrma",
        "Dance/Hip Hop Dancing.fbx", "Dance/Hokey Pokey.fbx",
        "Dance/Bboy Hip Hop Move.fbx", "Dance/Future Flow.vrma",
    ],
    # Love — romantic, gentle dances
    "love": [
        "pose/Female Standing Pose.fbx", "pose/Arm Stretching.fbx", "pose/Singing.fbx",
        "Dance/Rumba Dancing.fbx", "Dance/Swing Dancing.fbx",
        "Dance/Rhythm Adda.vrma", "Dance/Spice Flow.vrma",
    ],
    # Surprised — sudden movement, looks around
    "surprised": [
        "pose/Nervously Look Around.fbx", "pose/Jump.fbx",
        "pose/Female Standing Pose.fbx",
    ],
    # Angry — assertive poses
    "angry": [
        "pose/Taunt.fbx", "pose/Standing Taunt Battlecry.fbx",
        "pose/Nervously Look Around.fbx", "pose/Fist Fight B.fbx",
    ],
    # Worried / Sad — subdued, slumped
    "worried": [
        "pose/Nervously Look Around.fbx", "pose/Defeat.fbx",
    ],
    "sad": [
        "pose/Defeat.fbx", "pose/Nervously Look Around.fbx",
        "pose/Zombie Stumbling.fbx",
    ],
    # Thinking — calm, introspective
    "thinking": [
        "pose/Female Standing Pose.fbx", "pose/Arm Stretching.fbx",
        "pose/Talking On Phone.fbx", "pose/Salute.fbx",
    ],
    # Neutral — broad variety, occasional dance
    "neutral": [
        "pose/Female Standing Pose.fbx", "pose/Arm Stretching.fbx",
        "pose/Talking On Phone.fbx", "pose/Salute.fbx",
        "pose/Female Standing Pose.fbx", "pose/chill.vrma",  # idle weighted higher
        "Dance/Hip Hop Dancing.fbx", "Dance/Krush Flow.vrma",
        "Dance/Bhangra Hop.vrma", "Dance/Future Flow.vrma",
    ],
}


def detect_emotion(text: str) -> str:
    t = text.lower()
    for keywords, emotion in EMOTION_RULES:
        if any(kw in t for kw in keywords):
            return emotion
    return "neutral"


# ─────────────────────────────────────────────────
# TTS — edge-tts → base64 bytes
# ─────────────────────────────────────────────────

VOICE = "en-US-AnaNeural"


def clean_for_tts(text: str) -> str:
    """Strip emojis, markdown, tildes, action text."""
    text = re.sub(r'\*[^*]+\*', '', text)

    def _keep(ch: str) -> bool:
        cat = unicodedata.category(ch)
        cp = ord(ch)
        return not (
            cat in ('So', 'Sm')
            or 0x1F000 <= cp <= 0x1FFFF
            or 0x2600  <= cp <= 0x27BF
            or 0xFE00  <= cp <= 0xFE0F
            or cp in (0x200D, 0xFE0F)
        )
    text = ''.join(ch for ch in text if _keep(ch))
    text = text.replace('~', '')
    text = re.sub(r'[*_#]+', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


async def generate_tts_b64(text: str) -> str:
    """Generate TTS audio and return as base64 string."""
    import edge_tts
    cleaned = clean_for_tts(text)
    if not cleaned.strip():
        return ""
    try:
        tts = edge_tts.Communicate(cleaned, voice=VOICE, rate="+10%", pitch="+5Hz")
        audio_bytes = b""
        async for chunk in tts.stream():
            if chunk["type"] == "audio":
                audio_bytes += chunk["data"]
        return base64.b64encode(audio_bytes).decode("utf-8")
    except Exception as e:
        print(f"[TTS Error] Failed to generate audio for '{text[:20]}...': {e}")
        return ""


# ─────────────────────────────────────────────────
# WEBSOCKET ENDPOINT
# ─────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)
        print(f"[WS] Client connected. Total: {len(self.active)}")

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)
        print(f"[WS] Client disconnected. Total: {len(self.active)}")

    async def send_json(self, ws: WebSocket, data: dict):
        await ws.send_text(json.dumps(data))


manager = ConnectionManager()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                msg = {"type": "user_message", "text": raw}

            print(f"[WS] Received: {msg}")

            if msg.get("type") == "user_message":
                user_text = str(msg.get("text", "")).strip()
                if not user_text:
                    continue

                # Check Ollama availability
                try:
                    import ollama as _ol
                    _ol.list()
                    use_ollama = True
                except Exception:
                    use_ollama = False

                if not use_ollama:
                    fallback = "Oh no, I cannot reach Ollama right now! Please make sure Ollama is running."
                    audio_b64 = await generate_tts_b64(fallback)
                    await manager.send_json(websocket, {
                        "type": "dialogue",
                        "text": fallback,
                        "emotion": "worried",
                        "gesture": "think",
                        "lipSync": True,
                        "audioB64": audio_b64,
                        "first": True,
                        "streaming": False,
                    })
                    continue
                
                # Pre-calculate fallback action if LLM forgets
                implied_action = guess_action_from_text(user_text)

                # ── TRUE ASYNC PIPELINE ──────────────────────────────
                # Ollama streams in a background thread → sentences into queue.
                # Main coroutine pulls each sentence, generates TTS, sends WS.
                # While TTS runs for sentence N, Ollama generates sentence N+1.
                # ────────────────────────────────────────────────────

                loop = asyncio.get_event_loop()
                sentence_queue: asyncio.Queue = asyncio.Queue()

                # Start Ollama in background thread
                loop.run_in_executor(
                    None,
                    _ollama_stream_sync,
                    user_text,
                    sentence_queue,
                    loop,
                    implied_action
                )

                first = True
                while True:
                    item = await sentence_queue.get()
                    if item is None:
                        break  # Ollama done

                    sentence = item["text"]
                    action_file = item["action"]

                    emotion = detect_emotion(sentence) if sentence else "neutral"
                    gesture = GESTURE_FOR_EMOTION.get(emotion, "idle")

                    # Generate TTS for this sentence (Ollama fills queue concurrently)
                    audio_b64 = await generate_tts_b64(sentence) if sentence else ""

                    command = {
                        "type": "dialogue",
                        "text": sentence,
                        "emotion": emotion,
                        "gesture": gesture,
                        "lipSync": True,
                        "audioB64": audio_b64,   # 🔊 inline — no browser fetch needed
                        "streaming": True,
                        "first": first,
                        "action": action_file,   # 💃 pass action down to frontend
                    }
                    first = False
                    print(f"[WS] [{emotion}] {sentence[:60]} (Action: {action_file})")
                    await manager.send_json(websocket, command)

            elif msg.get("type") == "clear":
                _history.clear()
                _history.append({"role": "system", "content": SYSTEM_PROMPT})
                await manager.send_json(websocket, {"type": "cleared"})

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"[WS] Error: {e}")
        import traceback; traceback.print_exc()
        manager.disconnect(websocket)


# ─────────────────────────────────────────────────
# STARTUP + MAIN
# ─────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    print("=" * 54)
    print("  🌸  AI Girlfriend VRM Backend")
    print("  http://localhost:8000")
    print("  WebSocket :  ws://localhost:8000/ws")
    print("  Audio     :  inline base64 over WebSocket (no fetch)")
    print("  Voice     :  en-US-AnaNeural (edge-tts)")
    print("  AI Model  :  llama2:7b (Ollama)")
    print("=" * 54)


# ── Catch-all static files (MUST be last) ────────
@app.get("/{filename:path}")
async def serve_file(filename: str):
    filepath = BASE_DIR / filename
    if filepath.exists() and filepath.is_file():
        return FileResponse(filepath)
    return HTMLResponse("Not found", status_code=404)


if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
