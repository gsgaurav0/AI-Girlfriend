# Product Requirements Document (PRD)
**Project Name:** AI-WAIFU (Interactive AI Companion V1)
**Date:** February 2026

## 1. Project Overview
**Objective:**
To build a highly interactive, web-based, 3D AI companion ("Sakura") that can speak, emote, maintain eye contact, and perform complex body animations (dances and poses) autonomously driven by a Local LLM.

**Target Audience:**
Users looking for a private, immersive, and interactive AI experience that goes beyond text by incorporating full 3D visual feedback and spoken voice acting.

## 2. Core Features & Requirements

### 2.1. 3D Avatar Rendering & Procedural Animation
- **Requirement:** Render industry-standard `.vrm` (Virtual Reality Model) anime-style avatars in the browser.
- **Requirement:** Implement procedural "idle" animations (breathing, slight body swaying) so the model feels alive even when not speaking.
- **Requirement:** Implement 'Smooth Pursuit' eye-tracking, allowing the model's eyes and neck to naturally follow a focal point or simulate looking at the user.

### 2.2. Conversational AI & Persona
- **Requirement:** Integrate a local Large Language Model (Llama 2 7B via Ollama) to ensure privacy and low latency.
- **Requirement:** Enforce a strict persona ("Sakura", a loving and enthusiastic partner) using system prompting.
- **Requirement:** The AI must output concise responses (2-4 sentences max) to keep conversations snappy and prevent long audio generation delays.

### 2.3. Dynamic Audio & Lip-Sync
- **Requirement:** Convert LLM text outputs into speech using `edge-tts` (Microsoft Bing Speech API).
- **Requirement:** Analyze the streaming audio buffer and dynamically manipulate the 3D model's blendshapes (visemes) to create accurate, real-time lip-syncing.
- **Requirement:** Handle network volatility gracefully (catch `ConnectionResetError`) without crashing the application.

### 2.4. Autonomous Expressions & Actions
- **Requirement:** The LLM must be able to autonomously express emotions (e.g., `[happy]`, `[sad]`) and physical actions (`[ACTION: Dance/beat smash.vrma]`).
- **Requirement:** Backend must parse these commands, strip them from the spoken text, and forward them to the frontend.
- **Requirement:** Frontend must execute `.fbx` (Mixamo) and `.vrma` (VRM Animation) files seamlessly, cross-fading from the procedural idle state to the requested action, and smoothly cross-fading back to idle when finished.

### 2.5. Smart Action Fallback System
- **Requirement:** As smaller 7B models can hallucinate structural syntax, implement a fuzzy string-matching fallback system (Word Intersection Score) on the backend to trigger animations if the user implicitly asked for one (e.g., "dance hip hop" or "strike a pose") but the LLM failed to format it.

### 2.6. User Interface & Experience
- **Requirement:** A modern, semi-transparent "Glassmorphism" UI.
- **Requirement:** Provide WebSocket connection status indicators.
- **Requirement:** Provide a real-time UI Model Switcher dropdown to dynamically hot-swap `.vrm` files safely without page reloads.

## 3. Architecture & Tech Stack
**Frontend:**
- **Core:** HTML5, Vanilla CSS, Vanilla JavaScript.
- **3D Engine:** `Three.js`
- **VRM Handling:** `@pixiv/three-vrm` (v3) and `@pixiv/three-vrm-animation` (v3) via ESM CDN.

**Backend:**
- **Server:** Python 3 with `FastAPI` and `uvicorn`.
- **Communication:** WebSockets for bidirectional, low-latency streaming of text chunks, audio payloads, and action commands.
- **AI Brain:** `ollama` (Local Llama 2).
- **Voice Engine:** `edge-tts` (Asynchronous streaming).

## 4. Future Scope (V2 Ideas)
- **Voice Input:** Implement Whisper API or local Speech-to-Text so the user can speak via a microphone instead of typing.
- **Memory/RAG:** Add a vector database (e.g., ChromaDB) to allow Sakura to remember past conversations over long periods.
- **Environment Interaction:** Allow the character to navigate a 3D room or interact with 3D props during actions.
