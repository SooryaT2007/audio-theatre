/**
 * Audio Theatre - Ultra Low-Latency Multi-Device Cinema Audio
 * Dual WebRTC Cloud Streamer & Local WebSocket Player
 */

// State
let audioCtx = null;
let gainNode = null;
let analyserNode = null;
let peer = null;
let currentCall = null;
let ws = null;
let isPlaying = false;
let isHost = false;
let sampleRate = 48000;
let nextPlayTime = 0;
let syncOffsetMs = 0;
let speakerMode = 'stereo'; // 'stereo', 'left', 'right'
let wakeLock = null;
let animFrameId = null;
let hostMediaStream = null;
let hostPeer = null;

// DOM Elements
const remoteAudio = document.getElementById('remoteAudio');
const toggleBtn = document.getElementById('toggleBtn');
const btnIcon = document.getElementById('btnIcon');
const btnText = document.getElementById('btnText');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const statusSubtext = document.getElementById('statusSubtext');
const latencyVal = document.getElementById('latencyVal');
const cloudStatusVal = document.getElementById('cloudStatusVal');
const wakeLockVal = document.getElementById('wakeLockVal');
const volumeSlider = document.getElementById('volumeSlider');
const volumeVal = document.getElementById('volumeVal');
const syncSlider = document.getElementById('syncSlider');
const syncVal = document.getElementById('syncVal');
const resetSyncBtn = document.getElementById('resetSyncBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const serverHostInput = document.getElementById('serverHost');
const directConnectBtn = document.getElementById('directConnectBtn');
const visualizerCanvas = document.getElementById('visualizerCanvas');
const audioWavePulse = document.getElementById('audioWavePulse');
const channelLabel = document.getElementById('channelLabel');

// Tab Switching
const tabMobileBtn = document.getElementById('tabMobileBtn');
const tabHostBtn = document.getElementById('tabHostBtn');
const tabMobile = document.getElementById('tabMobile');
const tabHost = document.getElementById('tabHost');

// Host Elements
const hostRoomBadge = document.getElementById('hostRoomBadge');
const startScreenAudioBtn = document.getElementById('startScreenAudioBtn');
const hostLiveInfo = document.getElementById('hostLiveInfo');
const shareUrlText = document.getElementById('shareUrlText');
const copyShareUrlBtn = document.getElementById('copyShareUrlBtn');
const hostQrCodeDiv = document.getElementById('hostQrCode');

function switchTab(tab) {
  if (tab === 'mobile') {
    tabMobileBtn.classList.add('active');
    tabHostBtn.classList.remove('active');
    tabMobile.classList.add('active');
    tabHost.classList.remove('active');
  } else {
    tabHostBtn.classList.add('active');
    tabMobileBtn.classList.remove('active');
    tabHost.classList.add('active');
    tabMobile.classList.remove('active');
  }
}

tabMobileBtn.addEventListener('click', () => switchTab('mobile'));
tabHostBtn.addEventListener('click', () => switchTab('host'));

// Detect if running on local Python server (e.g. http://10.x.x.x:8000 or http://192.168.x.x:8000)
const isLocalServer = window.location.port === '8000' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// URL Params & Room Init
const urlParams = new URLSearchParams(window.location.search);
const initialRoom = urlParams.get('room') || localStorage.getItem('theatre_room') || generateRoomId();
roomCodeInput.value = initialRoom;
hostRoomBadge.textContent = initialRoom;

function generateRoomId() {
  return `THEATRE-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Auto-switch to Laptop Host tab on desktop if on public web and no ?room
const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
if (!isMobileDevice && !urlParams.has('room') && !isLocalServer) {
  switchTab('host');
}

// Auto-populate local host input
if (window.location.hostname) {
  serverHostInput.value = `${window.location.hostname}:8765`;
}

function updateStatus(state, message) {
  statusBadge.className = `badge ${state}`;
  statusText.textContent = message;
}

// Audio Engine
function initAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
    
    gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(volumeSlider.value) / 100;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 64;
    analyserNode.smoothingTimeConstant = 0.8;

    gainNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    sampleRate = audioCtx.sampleRate || 48000;
  }
  
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLockVal.textContent = 'Active 🛡️';
      wakeLockVal.className = 'stat-val active-text';
      wakeLock.addEventListener('release', () => {
        wakeLockVal.textContent = 'Inactive';
        wakeLockVal.className = 'stat-val';
      });
    } catch (err) {
      wakeLockVal.textContent = 'Unsupported';
    }
  } else {
    wakeLockVal.textContent = 'Unsupported';
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ============================================================================
// 1. CLOUD RECEIVER ENGINE (WebRTC via PeerJS)
// ============================================================================
function connectCloudRoom(roomId) {
  initAudioContext();

  // If on local Python server, connect directly via local WebSocket
  if (isLocalServer) {
    connectLocalWebSocket(window.location.hostname);
    return;
  }

  const cleanRoom = (roomId || roomCodeInput.value).trim().toUpperCase();
  localStorage.setItem('theatre_room', cleanRoom);

  updateStatus('connecting', 'Connecting...');
  statusSubtext.textContent = `Connecting to Cloud Room: ${cleanRoom}...`;

  if (peer) {
    peer.destroy();
  }

  peer = new Peer({
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    }
  });

  const hostPeerId = `at-room-${cleanRoom.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;

  peer.on('open', (id) => {
    const dummyStream = createSilentStream();
    const call = peer.call(hostPeerId, dummyStream);
    currentCall = call;

    call.on('stream', (remoteStream) => {
      onAudioStreamReceived(remoteStream);
    });

    call.on('error', (err) => {
      console.warn('Call error:', err);
      tryLocalFallback(cleanRoom);
    });

    setTimeout(() => {
      if (!isPlaying) {
        tryLocalFallback(cleanRoom);
      }
    }, 3500);
  });

  peer.on('error', (err) => {
    console.warn('Peer error:', err);
    tryLocalFallback(cleanRoom);
  });
}

function createSilentStream() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const dst = osc.connect(ctx.createMediaStreamDestination());
  osc.start();
  const track = dst.stream.getAudioTracks()[0];
  return new MediaStream([track]);
}

function onAudioStreamReceived(stream) {
  isPlaying = true;
  updateStatus('connected', 'Live Sound');
  statusSubtext.textContent = `Receiving movie audio from Room: ${roomCodeInput.value}`;
  cloudStatusVal.textContent = 'WebRTC ⚡';
  btnText.textContent = 'STOP LISTENING';
  btnIcon.textContent = '⏹';
  toggleBtn.classList.add('playing');
  requestWakeLock();

  if (remoteAudio) {
    remoteAudio.srcObject = stream;
    remoteAudio.volume = 1.0;
    remoteAudio.play().catch(e => console.log('Audio play error:', e));
  }

  try {
    initAudioContext();
    const sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(gainNode);
  } catch (e) {
    console.warn('Web Audio pipe error:', e);
  }
}

function tryLocalFallback(roomId) {
  const host = serverHostInput.value.trim() || window.location.hostname;
  if (host) {
    connectLocalWebSocket(host);
  } else {
    updateStatus('disconnected', 'Waiting for Host');
    statusSubtext.textContent = `No broadcaster found for Room ${roomId}. Make sure laptop is broadcasting.`;
  }
}

// ============================================================================
// 2. LOCAL WEBSOCKET ENGINE (For Python Server)
// ============================================================================
function connectLocalWebSocket(host) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  initAudioContext();
  let cleanHost = (host || window.location.hostname || '127.0.0.1').replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').trim();
  let hostname = cleanHost.split(':')[0] || '127.0.0.1';
  let wsPort = 8765;

  const wsUrl = `ws://${hostname}:${wsPort}`;

  updateStatus('connecting', 'Connecting...');
  statusSubtext.textContent = `Connecting to laptop audio on port ${wsPort}...`;

  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      isPlaying = true;
      updateStatus('connected', 'Local Live');
      statusSubtext.textContent = 'Streaming movie sound from laptop';
      cloudStatusVal.textContent = 'Wi-Fi 🏠';
      btnText.textContent = 'STOP LISTENING';
      btnIcon.textContent = '⏹';
      toggleBtn.classList.add('playing');
      nextPlayTime = 0;
      requestWakeLock();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') return;
      if (event.data instanceof ArrayBuffer && isPlaying && audioCtx) {
        processAudioChunk(event.data);
      }
    };

    ws.onerror = (err) => {
      console.warn('WebSocket error:', err);
      updateStatus('disconnected', 'Offline');
      statusSubtext.textContent = 'Make sure python main.py is running on your laptop!';
    };

    ws.onclose = () => {
      stopAudio(false);
    };
  } catch (e) {
    updateStatus('disconnected', 'Error');
  }
}

function processAudioChunk(arrayBuffer) {
  const int16View = new Int16Array(arrayBuffer);
  const totalSamples = int16View.length;
  if (totalSamples === 0) return;

  const channels = 2;
  const frameCount = Math.floor(totalSamples / channels);
  if (frameCount === 0) return;

  const audioBuffer = audioCtx.createBuffer(2, frameCount, sampleRate);
  const channelDataL = audioBuffer.getChannelData(0);
  const channelDataR = audioBuffer.getChannelData(1);

  for (let i = 0; i < frameCount; i++) {
    const idx = i * 2;
    const leftVal = int16View[idx] / 32768.0;
    const rightVal = int16View[idx + 1] / 32768.0;

    if (speakerMode === 'left') {
      channelDataL[i] = leftVal;
      channelDataR[i] = leftVal;
    } else if (speakerMode === 'right') {
      channelDataL[i] = rightVal;
      channelDataR[i] = rightVal;
    } else {
      channelDataL[i] = leftVal;
      channelDataR[i] = rightVal;
    }
  }

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(gainNode);

  const currentTime = audioCtx.currentTime;
  const offset = syncOffsetMs / 1000.0;
  const targetStartTime = currentTime + 0.025 + offset;

  if (nextPlayTime < currentTime || nextPlayTime > currentTime + 0.2) {
    nextPlayTime = targetStartTime;
  }

  source.start(nextPlayTime);
  nextPlayTime += audioBuffer.duration;
  latencyVal.textContent = `~${Math.max(10, Math.round((nextPlayTime - currentTime) * 1000))} ms`;
}

function stopAudio(userInitiated = true) {
  isPlaying = false;
  
  if (remoteAudio) {
    remoteAudio.pause();
    remoteAudio.srcObject = null;
  }
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  if (peer) {
    peer.destroy();
    peer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }

  releaseWakeLock();
  btnText.textContent = 'TAP TO LISTEN';
  btnIcon.textContent = '▶';
  toggleBtn.classList.remove('playing');
  
  if (userInitiated) {
    updateStatus('disconnected', 'Stopped');
    statusSubtext.textContent = 'Tap button to resume listening';
  }
}

// ============================================================================
// 3. LAPTOP BROWSER AUDIO BROADCASTER (Zero-Install Screen/System Audio Share)
// ============================================================================
async function startLaptopBroadcaster() {
  const roomId = roomCodeInput.value.trim().toUpperCase() || generateRoomId();
  const hostPeerId = `at-room-${roomId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      alert("⚠️ No audio detected! When sharing your screen/tab, make sure to check the 'Share audio' or 'Share tab audio' checkbox.");
      return;
    }

    hostMediaStream = stream;

    if (hostPeer) hostPeer.destroy();
    hostPeer = new Peer(hostPeerId, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    hostPeer.on('open', () => {
      isHost = true;
      hostLiveInfo.style.display = 'flex';
      
      const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
      shareUrlText.textContent = shareUrl;
      
      startScreenAudioBtn.innerHTML = '<span>🟢 Movie Audio Broadcasting Live!</span>';
      startScreenAudioBtn.style.background = 'linear-gradient(135deg, #00ff88 0%, #00aa55 100%)';

      if (hostQrCodeDiv) {
        hostQrCodeDiv.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
          new QRCode(hostQrCodeDiv, {
            text: shareUrl,
            width: 140,
            height: 140,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
        }
      }
    });

    hostPeer.on('call', (call) => {
      call.answer(hostMediaStream);
    });

    audioTracks[0].onended = () => {
      if (hostPeer) hostPeer.destroy();
      hostLiveInfo.style.display = 'none';
      startScreenAudioBtn.innerHTML = '<span>🖥️ Click to Share Movie Audio</span>';
      startScreenAudioBtn.style.background = '';
    };

  } catch (err) {
    console.error('Screen audio share error:', err);
  }
}

startScreenAudioBtn.addEventListener('click', startLaptopBroadcaster);

copyShareUrlBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shareUrlText.textContent).then(() => {
    copyShareUrlBtn.textContent = '✅ Copied!';
    setTimeout(() => { copyShareUrlBtn.textContent = '📋 Copy'; }, 2000);
  });
});

// Event Listeners
toggleBtn.addEventListener('click', () => {
  if (isPlaying) {
    stopAudio(true);
  } else {
    connectCloudRoom(roomCodeInput.value);
  }
});

joinRoomBtn.addEventListener('click', () => {
  stopAudio(false);
  connectCloudRoom(roomCodeInput.value);
});

directConnectBtn.addEventListener('click', (e) => {
  e.preventDefault();
  initAudioContext();
  stopAudio(false);
  connectLocalWebSocket(serverHostInput.value);
});

function setVolume(val) {
  volumeSlider.value = val;
  volumeVal.textContent = `${val}%`;
  if (gainNode) {
    gainNode.gain.value = val / 100;
  }
}

volumeSlider.addEventListener('input', (e) => {
  setVolume(e.target.value);
});

syncSlider.addEventListener('input', (e) => {
  syncOffsetMs = parseInt(e.target.value, 10);
  syncVal.textContent = `${syncOffsetMs > 0 ? '+' : ''}${syncOffsetMs} ms`;
});

resetSyncBtn.addEventListener('click', () => {
  syncSlider.value = 0;
  syncOffsetMs = 0;
  syncVal.textContent = '0 ms';
});

document.querySelectorAll('.channel-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.channel-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    speakerMode = btn.dataset.channel;
    
    if (speakerMode === 'left') {
      channelLabel.textContent = 'Left Channel (Left Speaker)';
    } else if (speakerMode === 'right') {
      channelLabel.textContent = 'Right Channel (Right Speaker)';
    } else {
      channelLabel.textContent = 'Stereo (Center / All)';
    }
  });
});

function copyCommand() {
  const cmd = document.getElementById('terminalCmd').innerText;
  navigator.clipboard.writeText(cmd).then(() => {
    const btn = document.getElementById('copyCmdBtn');
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
  });
}

// Canvas Visualizer
function renderVisualizer() {
  animFrameId = requestAnimationFrame(renderVisualizer);

  const canvas = visualizerCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  if (canvas.width !== canvas.clientWidth * dpr || canvas.height !== canvas.clientHeight * dpr) {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
  }

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  if (!analyserNode || !isPlaying) {
    const time = Date.now() * 0.003;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
    ctx.lineWidth = 2 * dpr;
    for (let x = 0; x < width; x += 4) {
      const y = (height / 2) + Math.sin(x * 0.02 + time) * 6 * dpr;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    audioWavePulse.classList.remove('active');
    return;
  }

  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyserNode.getByteFrequencyData(dataArray);

  let sum = 0;
  for (let i = 0; i < bufferLength; i++) {
    sum += dataArray[i];
  }
  const averageVolume = sum / bufferLength;

  if (averageVolume > 15) {
    audioWavePulse.classList.add('active');
  } else {
    audioWavePulse.classList.remove('active');
  }

  const barCount = 28;
  const barWidth = (width / barCount) - (3 * dpr);
  let x = 2 * dpr;

  for (let i = 0; i < barCount; i++) {
    const dataIndex = Math.floor((i / barCount) * bufferLength);
    const value = dataArray[dataIndex] || 0;
    const barHeight = Math.max(4 * dpr, (value / 255) * height * 0.85);

    const gradient = ctx.createLinearGradient(0, height - barHeight, 0, height);
    gradient.addColorStop(0, '#00f0ff');
    gradient.addColorStop(0.5, '#0077fe');
    gradient.addColorStop(1, 'rgba(0, 119, 254, 0.2)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, height - barHeight, Math.max(2, barWidth), barHeight, [4 * dpr, 4 * dpr, 0, 0]);
    ctx.fill();

    x += barWidth + (3 * dpr);
  }
}

renderVisualizer();
