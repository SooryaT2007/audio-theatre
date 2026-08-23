# 🎬 Audio Theatre

Turn your smartphones into synchronized auxiliary surround sound speakers for movies playing on your laptop!

When watching a movie on a laptop with weak speakers, Audio Theatre captures the laptop's audio in real-time and streams it across all mobile phones in the room with ultra-low latency (<25ms).

---

## 📁 Repository Structure

```
audio-theatre/
├── python/                 # Laptop Audio Sender
│   ├── main.py             # Loopback audio capture & WebSocket streamer
│   └── requirements.txt    # soundcard, websockets, qrcode, numpy
│
└── vercel/                 # Vercel Web App (Receiver + Laptop Script Hub)
    ├── index.html          # Mobile Receiver UI & Laptop File Downloader Tabs
    ├── style.css           # Dark cinema neon design & visualizers
    ├── app.js              # Low-latency Web Audio API player & tab manager
    ├── main.py             # Downloadable copy of Python script for web visitors
    ├── requirements.txt    # Downloadable copy of requirements for web visitors
    ├── package.json        # Web metadata
    └── vercel.json         # Vercel static deployment config
```

---

## 🚀 Quick Start Guide

### 1. On Your Laptop (Sender)
1. Open a terminal in the `python/` folder:
   ```bash
   pip install -r requirements.txt
   python main.py
   ```
2. The terminal will print your **Laptop IP** and a scannable **QR Code**.

### 2. On Your Mobile Phones (Auxiliary Speakers)
1. Scan the QR code or open your deployed Vercel URL (e.g. `https://your-audio-theatre.vercel.app`).
2. Tap **"TAP TO LISTEN"**.
3. Place your phones around the room (e.g. one on the left, one on the right, or on the center table).
4. Play your movie on the laptop and enjoy room-filling sound!

---

## ✨ Features

- **⚡ Ultra-Low Latency (<25ms)**: Real-time 16-bit PCM streaming for lip-sync accuracy.
- **🔊 Volume Booster (Up to 300%)**: Amplify soft movie dialogue on phone speakers.
- **🎭 Surround Speaker Placement**: Set individual phones to Left Channel, Right Channel, or Stereo.
- **⏱️ Video-Audio Sync Slider**: Fine-tune delay (-200ms to +200ms) for movie dialogue alignment.
- **🛡️ Screen Wake Lock**: Keeps phones from sleeping during the movie.
- **💻 Web Download Hub**: PC users visiting the Vercel app can download or copy the Python script in 1-click.
