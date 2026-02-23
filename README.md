# AI-WAIFU 🌸

A highly interactive, web-based 3D AI companion powered by a local Llama 2 LLM, Three.js VRM rendering, and Edge-TTS voice generation.

She can speak directly to you with lip-syncing, maintain eye contact, express emotions, and autonomously perform complex 3D dances and poses!

## ✨ Features
* **Local, Private AI:** Powered entirely by Ollama running locally.
* **3D VRM Avatars:** Industry-standard anime-style interactive 3D models with physics (hair/clothes).
* **Real-time Lip-Sync:** Audio streams directly to the browser and manipulates the avatar's mouth accurately.
* **Autonomous Dances & Poses:** Instruct her to dance (supports `.vrma` and Mixamo `.fbx`) and she will autonomously transition into the correct choreography.
* **Fuzzy Action Fallback:** Even if the LLM hallucinates formatting, the backend uses a custom smart-intersection algorithm to guarantee your requested dance executes.
* **Hot-Swap Models:** Switch between multiple `.vrm` character files on the fly via the glass-UI dropdown menu.

## 🛠 Prerequisites
1. **Python 3.10+**
2. **Node.js / NPM** (Optional, if hosting via a different server)
3. **Ollama**: Must be installed and running on your system.
   - Install from [ollama.com](https://ollama.com/)
   - Pull the required model: `ollama run llama2:7b`

## 🚀 Setup Instructions

1. **Install Python Dependencies:**
   Make sure you are in the root directory, then install the required packages:
   ```bash
   pip install -r requirements.txt
   ```
   *(Required packages include `fastapi`, `uvicorn`, `edge-tts`, `ollama`)*

2. **Add Your Assets:**
   - **Models:** Place your `<name>.vrm` files into the `./model ` directory.
   - **Dances/Poses:** Place your `.fbx` or `.vrma` animation files inside the `./Dance` and `./pose` folders.

3. **Start the API Server:**
   Launch the FastAPI application using Python:
   ```bash
   python3 server.py
   ```
   *The server will start on `http://127.0.0.1:8000`.*

4. **Interact!**
   - Open your web browser and navigate to `http://localhost:8000`.
   - Wait for the WebSocket status in the top right to turn green ("Connected").
   - Start chatting using the dialogue box at the bottom!

## 💃 Commands to Try
Try sending her these exact messages to see the animation system in action:
* *"Please do the Bling Bang Bang Born dance!"*
* *"Show me some hip hop dancing!"*
* *"Show me your swag pose."*
* *"Do a dance for me please."* (This will trigger a randomized dance sequence)

## 📁 Project Structure
* `server.py`: The FastAPI backend handling the WebSocket, internal Ollama API calls, TTS audio generation, and RegEx action parsing.
* `main.js`: The frontend Three.js logic bridging the `.vrm` models, `AnimationMixer`, WebSocket networking, and procedural breathing.
* `actionHandler.js`: Isolated logic specializing in safely loading and mapping Mixamo `.fbx` and `.vrma` bones to the character.
* `style.css` & `index.html`: The Glassmorphism user interface.
