#!/usr/bin/env python3
"""
Audio Theatre - Laptop Audio Loopback Streamer
Captures movie sound from laptop speakers and serves the mobile web player directly over Wi-Fi!

Usage:
    pip install -r requirements.txt
    python main.py
"""

import asyncio
import http
import json
import mimetypes
import os
import random
import socket
import sys
import threading
import time
import numpy as np
import qrcode
import soundcard as sc
import websockets

PORT = 8000
SAMPLE_RATE = 48000
BLOCK_SIZE = 1024  # ~21ms low-latency audio chunk
CHANNELS = 2

connected_clients = set()
clients_lock = threading.Lock()
ROOM_ID = f"THEATRE-{random.randint(1000, 9999)}"

# Locate the vercel static web folder
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, '..', 'vercel'))
if not os.path.exists(WEB_DIR):
    WEB_DIR = SCRIPT_DIR

def get_local_ip():
    """Get local Wi-Fi / LAN IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

def get_loopback_mic():
    """Get default speaker loopback microphone on Windows."""
    try:
        speaker = sc.default_speaker()
        mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        return mic, speaker.name
    except Exception:
        mics = [m for m in sc.all_microphones(include_loopback=True) if getattr(m, 'isloopback', False)]
        if mics:
            return mics[0], mics[0].name
        return sc.default_microphone(), "Default Microphone"

async def ws_handler(websocket):
    """Handle incoming WebSocket audio connection from mobile phones."""
    client_addr = websocket.remote_address
    print(f"\n[+] 📱 Phone Connected: {client_addr[0]}:{client_addr[1]}")
    
    with clients_lock:
        connected_clients.add(websocket)
        print(f"[*] Total active mobile speakers: {len(connected_clients)}")

    init_msg = json.dumps({
        "type": "config",
        "room": ROOM_ID,
        "sample_rate": SAMPLE_RATE,
        "channels": CHANNELS,
        "block_size": BLOCK_SIZE
    })
    
    try:
        await websocket.send(init_msg)
        await websocket.wait_closed()
    except Exception:
        pass
    finally:
        with clients_lock:
            connected_clients.discard(websocket)
            print(f"\n[-] 📱 Phone Disconnected: {client_addr[0]}")
            print(f"[*] Total active mobile speakers: {len(connected_clients)}")

def process_http_request(connection, request):
    """Serve the static web receiver files directly over HTTP so phones can load it with zero 404s."""
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None  # Pass through to WebSocket handler

    # Parse requested path
    raw_path = request.path.split('?')[0]
    if raw_path in ('/', ''):
        raw_path = '/index.html'

    file_path = os.path.join(WEB_DIR, raw_path.lstrip('/'))
    
    if os.path.exists(file_path) and os.path.isfile(file_path):
        mime_type, _ = mimetypes.guess_type(file_path)
        with open(file_path, 'rb') as f:
            content = f.read()
        return connection.respond(
            http.HTTPStatus.OK,
            content,
            headers=[
                ("Content-Type", mime_type or "text/plain"),
                ("Access-Control-Allow-Origin", "*"),
                ("Cache-Control", "no-cache")
            ]
        )
    return connection.respond(http.HTTPStatus.NOT_FOUND, b"<h1>404 Not Found</h1>")

def audio_capture_loop(loop):
    """Capture loopback audio from Windows speaker output and stream to phones."""
    mic, dev_name = get_loopback_mic()
    print(f"[*] Audio Device: {dev_name}")
    print(f"[*] Capturing movie sound at {SAMPLE_RATE} Hz, {CHANNELS} channels...\n")

    try:
        with mic.recorder(samplerate=SAMPLE_RATE, channels=CHANNELS, blocksize=BLOCK_SIZE) as recorder:
            while True:
                data = recorder.record(numframes=BLOCK_SIZE)
                
                with clients_lock:
                    if not connected_clients:
                        time.sleep(0.01)
                        continue
                    clients = list(connected_clients)

                # Convert float32 audio [-1.0, 1.0] to 16-bit PCM bytes
                int16_data = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16)
                raw_bytes = int16_data.tobytes()

                for client in clients:
                    try:
                        asyncio.run_coroutine_threadsafe(client.send(raw_bytes), loop)
                    except Exception:
                        pass
    except Exception as e:
        print(f"\n[!] Audio capture notice: {e}")

def print_banner(local_ip):
    """Print ASCII QR Code and direct URL."""
    url = f"http://{local_ip}:{PORT}"
    print("=" * 64)
    print("        🎬 AUDIO THEATRE - LAPTOP AUDIO SENDER 🎬        ")
    print("=" * 64)
    print(f"\n🌐 Mobile URL : {url}")
    print(f"🔑 Room Code : {ROOM_ID}")
    print("\nScan the QR code below on your mobile phones to connect instantly:")
    print("-" * 64)
    
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.make(fit=True)
    qr.print_ascii(invert=True)
    
    print("-" * 64)
    print(">>> 1. Play your movie / video on this laptop.")
    print(">>> 2. Scan the QR code with your mobile phones.")
    print(">>> 3. Tap 'LISTEN' on each phone & place them around the room!")
    print(">>> Press Ctrl+C to stop.")
    print("=" * 64 + "\n")

async def main():
    local_ip = get_local_ip()
    print_banner(local_ip)

    loop = asyncio.get_running_loop()
    threading.Thread(target=audio_capture_loop, args=(loop,), daemon=True).start()

    async with websockets.serve(ws_handler, "0.0.0.0", PORT, process_request=process_http_request):
        print(f"[*] Server running on port {PORT}. Ready for mobile devices!")
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[!] Stopped.")
        sys.exit(0)
