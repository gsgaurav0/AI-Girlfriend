#!/usr/bin/env python3
"""
AI Girlfriend VRM — Python Backend
FastAPI + WebSocket server that processes dialogue text,
maps it to emotions, and sends animation commands to the browser.

For testing: uses keyword-based emotion analysis.
Run:  python server.py
Then open: http://localhost:8000
"""

import asyncio
import json
import os
import random
import re
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

# ─────────────────────────────────────────────────
# APP SETUP
# ─────────────────────────────────────────────────

app = FastAPI(title="AI Girlfriend VRM Backend")

# Serve static files from the same directory as this script
BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR), name="static")


@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "index.html")


# Serve all files in the project directory
@app.get("/{filename:path}")
async def serve_file(filename: str):
    filepath = BASE_DIR / filename
    if filepath.exists() and filepath.is_file():
        return FileResponse(filepath)
    return HTMLResponse("Not found", status_code=404)


# ─────────────────────────────────────────────────
# EMOTION ANALYZER (keyword-based for testing)
# ─────────────────────────────────────────────────

EMOTION_RULES: list[tuple[list[str], str]] = [
    # (keywords, emotion)
    (["love", "i love", "adore", "crush", "heart", "darling", "sweetheart", "miss you"], "love"),
    (["happy", "glad", "wonderful", "awesome", "great", "amazing", "yay", "woohoo",
      "haha", "lol", "hehe", "fun", "enjoy", "laugh"], "happy"),
    (["excited", "wow", "omg", "oh my", "incredible", "can't wait", "so cool",
      "fantastic", "brilliant"], "excited"),
    (["sad", "unhappy", "depressed", "cry", "tears", "miss", "lonely", "alone",
      "heartbreak", "broke", "hurts", "pain"], "sad"),
    (["angry", "mad", "furious", "hate", "annoyed", "irritated", "frustrated",
      "upset", "rage", "stop it"], "angry"),
    (["scared", "afraid", "worried", "anxious", "nervous", "fear", "terrified",
      "oh no", "please"], "worried"),
    (["surprise", "what", "really", "no way", "seriously", "unbelievable",
      "unexpected", "shocked", "wait"], "surprised"),
    (["think", "hmm", "maybe", "consider", "wonder", "curious", "question",
      "not sure", "perhaps", "let me", "i wonder"], "thinking"),
    (["hello", "hi", "hey", "howdy", "greet", "good morning", "good evening",
      "how are you", "what's up", "yo"], "happy"),
    (["sorry", "apologize", "forgive", "my bad", "mistake", "oops", "i'm sorry"], "sad"),
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

# ─────────────────────────────────────────────────
# RESPONSE GENERATOR (template-based for testing)
# ─────────────────────────────────────────────────

RESPONSES: dict[str, list[str]] = {
    "love": [
        "Aww, you make me so happy! 💜",
        "I feel the same way about you~",
        "You're so sweet! My heart is racing…",
        "Hehe, I was hoping you'd say that!",
    ],
    "happy": [
        "Yay! I'm so glad to hear that!",
        "That makes me smile~",
        "Heehee, you're in a good mood today!",
        "Wonderful! Let's keep the good vibes going!",
    ],
    "excited": [
        "Oh wow, that sounds amazing!!",
        "I'm getting excited just hearing about it!",
        "Eeee!! Tell me more~",
        "That's incredible! My heart is pounding!",
    ],
    "sad": [
        "Aw, I'm so sorry to hear that… 🥺",
        "Don't worry, I'm here for you.",
        "It's okay to feel sad. Want to talk about it?",
        "Sending you a warm hug right now~",
    ],
    "angry": [
        "Oh no, did something happen? Tell me about it.",
        "I understand your frustration…",
        "Take a deep breath. I'm here to listen.",
        "That sounds really tough. I'm sorry.",
    ],
    "worried": [
        "It's going to be okay, I'm right here.",
        "Don't worry too much. You've got this!",
        "I'll be right by your side, okay?",
        "Take it one step at a time~",
    ],
    "surprised": [
        "Oh really?! I didn't expect that!",
        "Whoa, that caught me off guard!",
        "No way! Tell me everything!",
        "Wow… that's quite a surprise!",
    ],
    "thinking": [
        "Hmm, that's a really interesting question~",
        "Let me think about that… 🤔",
        "Ooh, that's thought-provoking!",
        "I wonder… what do YOU think?",
    ],
    "neutral": [
        "I'm listening~ Tell me more!",
        "That's interesting!",
        "Oh? How so?",
        "Hehe, go on~",
    ],
}


class EmotionAnalyzer:
    def analyze(self, text: str) -> str:
        text_lower = text.lower()
        for keywords, emotion in EMOTION_RULES:
            if any(kw in text_lower for kw in keywords):
                return emotion
        return "neutral"


class ResponseGenerator:
    def generate(self, text: str, emotion: str) -> str:
        options = RESPONSES.get(emotion, RESPONSES["neutral"])
        return random.choice(options)


analyzer = EmotionAnalyzer()
generator = ResponseGenerator()


def build_command(user_text: str) -> dict:
    """Process user text → animation command dict."""
    emotion = analyzer.analyze(user_text)
    response_text = generator.generate(user_text, emotion)
    gesture = GESTURE_FOR_EMOTION.get(emotion, "idle")

    return {
        "type": "dialogue",
        "text": response_text,
        "emotion": emotion,
        "gesture": gesture,
        "lipSync": True,
        "userText": user_text,
    }


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
        self.active.remove(ws)
        print(f"[WS] Client disconnected. Total: {len(self.active)}")

    async def send_json(self, ws: WebSocket, data: dict):
        await ws.send_text(json.dumps(data))

    async def broadcast(self, data: dict):
        for ws in self.active:
            try:
                await ws.send_text(json.dumps(data))
            except Exception:
                pass


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
                user_text = msg.get("text", "").strip()
                if not user_text:
                    continue

                # Small delay to feel more natural
                await asyncio.sleep(0.6)

                command = build_command(user_text)
                print(f"[WS] Sending: {command}")
                await manager.send_json(websocket, command)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        print(f"[WS] Error: {e}")
        manager.disconnect(websocket)


# ─────────────────────────────────────────────────
# STARTUP + MAIN
# ─────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    print("=" * 50)
    print("  AI Girlfriend VRM Backend")
    print("  http://localhost:8000")
    print("  WebSocket: ws://localhost:8000/ws")
    print("=" * 50)


if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
