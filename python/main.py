#!/usr/bin/env python3
"""
Audio Theatre - Laptop Audio Sender (Cloud & Local Support)
Captures laptop movie audio (loopback) and streams it in real-time to mobile phones.

Works across different networks, mobile data (4G/5G), or local Wi-Fi!

Usage:
    pip install -r requirements.txt
    python main.py
"""

import asyncio
import json
import random
import socket
import sys
import threading
import time
import webbrowser
import numpy as np
import qrcode
import soundcard as sc
import websockets

PORT = 8000
SAMPLE_RATE = 48000
BLOCK_SIZE = 1024  # ~21ms buffer for ultra-low latency
CHANNELS = 2

connected_clients = set()
clients_lock = threading.Lock()

# Generate a random 6-character cloud room ID
ROOM_ID = f"THEATRE-{random.randint(1000, 9999)}"

def get_local_ip():
    """Find the laptop's local LAN IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

def get_loopback_microphone():
    """Find the default speaker loopback device on Windows."""
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
    """Handle incoming client connections (local phones or browser cloud bridge)."""
    client_addr = websocket.remote_address
    print(f"\n[+] 📱 Device Connected: {client_addr[0]}:{client_addr[1]}")
    
    with clients_lock:
        connected_clients.add(websocket)
        print(f"[*] Total active listeners: {len(connected_clients)}")

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
            print(f"\n[-] 📱 Device Disconnected: {client_addr[0]}")
            print(f"[*] Total active listeners: {len(connected_clients)}")

def audio_capture_loop(loop):
    """Continuously record loopback audio from the laptop speaker and broadcast."""
    mic, dev_name = get_loopback_microphone()
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

                int16_data = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16)
                raw_bytes = int16_data.tobytes()

                for client in clients:
                    try:
                        asyncio.run_coroutine_threadsafe(client.send(raw_bytes), loop)
                    except Exception:
                        pass
    except Exception as e:
        print(f"\n[!] Audio capture error: {e}")
        print("[!] Tip: Ensure your audio is playing and not muted.")

def print_banner(local_ip, room_id):
    """Display connection info, cloud room code, and ASCII QR code."""
    cloud_url = f"https://audio-theatre.vercel.app/?room={room_id}"
    local_url = f"http://{local_ip}:{PORT}"

    print("=" * 64)
    print("        🎬 AUDIO THEATRE - LAPTOP AUDIO SENDER (CLOUD) 🎬        ")
    print("=" * 64)
    print(f"\n🔑 CLOUD ROOM CODE : {room_id}")
    print(f"🌐 CLOUD RECEIVER  : {cloud_url}")
    print(f"🏠 LOCAL WI-FI     : {local_url}")
    print("\nScan the QR code below on your mobile phones (works on 4G/5G/Wi-Fi):")
    print("-" * 64)
    
    qr = qrcode.QRCode(border=1)
    qr.add_data(cloud_url)
    qr.make(fit=True)
    qr.print_ascii(invert=True)
    
    print("-" * 64)
    print(">>> 1. Play any movie/video on this laptop.")
    print(f">>> 2. Open {cloud_url} on any phone anywhere.")
    print(">>> 3. Tap 'LISTEN' and place phones around the room!")
    print(">>> Press Ctrl+C in this terminal to stop.")
    print("=" * 64 + "\n")

async def main():
    local_ip = get_local_ip()
    print_banner(local_ip, ROOM_ID)

    loop = asyncio.get_running_loop()

    capture_thread = threading.Thread(target=audio_capture_loop, args=(loop,), daemon=True)
    capture_thread.start()

    async with websockets.serve(ws_handler, "0.0.0.0", PORT):
        print(f"[*] Server listening on port {PORT}. Ready for devices (Cloud & Local)...")
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[!] Audio Theatre stopped.")
        sys.exit(0)
