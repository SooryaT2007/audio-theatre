/**
 * Audio Theatre - Dual Receiver & Host Web App
 * Web Audio API engine + Laptop script distribution
 */

// State
let audioCtx = null;
let gainNode = null;
let analyserNode = null;
let ws = null;
let isPlaying = false;
let sampleRate = 48000;
let numChannels = 2;
let nextPlayTime = 0;
let syncOffsetMs = 0;
let speakerMode = 'stereo'; // 'stereo', 'left', 'right'
let wakeLock = null;
let reconnectTimer = null;
let isConnecting = false;
let animFrameId = null;

// DOM Elements
const toggleBtn = document.getElementById('toggleBtn');
const btnIcon = document.getElementById('btnIcon');
const btnText = document.getElementById('btnText');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const statusSubtext = document.getElementById('statusSubtext');
const latencyVal = document.getElementById('latencyVal');
const sampleRateVal = document.getElementById('sampleRateVal');
const wakeLockVal = document.getElementById('wakeLockVal');
const volumeSlider = document.getElementById('volumeSlider');
const volumeVal = document.getElementById('volumeVal');
const syncSlider = document.getElementById('syncSlider');
const syncVal = document.getElementById('syncVal');
const resetSyncBtn = document.getElementById('resetSyncBtn');
const serverHostInput = document.getElementById('serverHost');
const saveConnectBtn = document.getElementById('saveConnectBtn');
const autoReconnectCheck = document.getElementById('autoReconnect');
const visualizerCanvas = document.getElementById('visualizerCanvas');
const audioWavePulse = document.getElementById('audioWavePulse');
const channelLabel = document.getElementById('channelLabel');

// Tab Switching
const tabMobileBtn = document.getElementById('tabMobileBtn');
const tabHostBtn = document.getElementById('tabHostBtn');
const tabMobile = document.getElementById('tabMobile');
const tabHost = document.getElementById('tabHost');

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

// Auto-switch to Laptop Host tab if user is on Desktop PC without host params
const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const urlParams = new URLSearchParams(window.location.search);
if (!isMobileDevice && !urlParams.has('host') && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  switchTab('host');
}

function getDefaultHost() {
  if (urlParams.has('host')) {
    return urlParams.get('host');
  }
  const savedHost = localStorage.getItem('audio_theatre_host');
  if (savedHost) {
    return savedHost;
  }
  if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return `${window.location.hostname}:${window.location.port || 8000}`;
  }
  return '192.168.1.100:8000';
}

serverHostInput.value = getDefaultHost();

function updateStatus(state, message) {
  statusBadge.className = `badge ${state}`;
  statusText.textContent = message;
}

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
    sampleRateVal.textContent = `${Math.round(sampleRate / 1000)} kHz`;
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
      console.warn('Wake Lock error:', err);
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

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const host = serverHostInput.value.trim().replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
  localStorage.setItem('audio_theatre_host', host);

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${host}/ws`;

  updateStatus('connecting', 'Connecting...');
  statusSubtext.textContent = `Connecting to ${host}...`;
  isConnecting = true;

  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      isConnecting = false;
      isPlaying = true;
      updateStatus('connected', 'Live Audio');
      statusSubtext.textContent = 'Streaming movie audio in real-time';
      btnText.textContent = 'STOP LISTENING';
      btnIcon.textContent = '⏹';
      toggleBtn.classList.add('playing');
      nextPlayTime = 0;
      requestWakeLock();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const config = JSON.parse(event.data);
          if (config.sample_rate) {
            sampleRate = config.sample_rate;
            sampleRateVal.textContent = `${Math.round(sampleRate / 1000)} kHz`;
          }
          if (config.channels) {
            numChannels = config.channels;
          }
        } catch (e) {}
        return;
      }

      if (event.data instanceof ArrayBuffer && isPlaying && audioCtx) {
        processAudioChunk(event.data);
      }
    };

    ws.onerror = (error) => {
      console.warn('WebSocket error:', error);
      updateStatus('disconnected', 'Connection Error');
      statusSubtext.textContent = 'Cannot reach laptop. Check IP & Wi-Fi connection.';
    };

    ws.onclose = () => {
      isConnecting = false;
      if (isPlaying && autoReconnectCheck.checked) {
        updateStatus('connecting', 'Reconnecting...');
        statusSubtext.textContent = 'Connection dropped, trying to reconnect...';
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWebSocket, 1500);
      } else {
        stopAudio(false);
      }
    };
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    updateStatus('disconnected', 'Offline');
  }
}

function processAudioChunk(arrayBuffer) {
  const int16View = new Int16Array(arrayBuffer);
  const totalSamples = int16View.length;
  
  if (totalSamples === 0) return;

  const channels = numChannels >= 2 ? 2 : 1;
  const frameCount = Math.floor(totalSamples / channels);
  if (frameCount === 0) return;

  const audioBuffer = audioCtx.createBuffer(2, frameCount, sampleRate);
  const channelDataL = audioBuffer.getChannelData(0);
  const channelDataR = audioBuffer.getChannelData(1);

  if (channels === 2) {
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
  } else {
    for (let i = 0; i < frameCount; i++) {
      const val = int16View[i] / 32768.0;
      channelDataL[i] = val;
      channelDataR[i] = val;
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

  const currentLatency = Math.max(10, Math.round((nextPlayTime - currentTime) * 1000));
  latencyVal.textContent = `~${currentLatency} ms`;
}

function stopAudio(userInitiated = true) {
  isPlaying = false;
  isConnecting = false;
  clearTimeout(reconnectTimer);
  
  if (ws) {
    ws.onclose = null;
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

toggleBtn.addEventListener('click', () => {
  initAudioContext();
  if (isPlaying || isConnecting) {
    stopAudio(true);
  } else {
    connectWebSocket();
  }
});

saveConnectBtn.addEventListener('click', (e) => {
  e.preventDefault();
  initAudioContext();
  stopAudio(false);
  connectWebSocket();
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
      channelLabel.textContent = 'Stereo (Center / Both)';
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

function copySourceCode() {
  const code = document.getElementById('pythonSourceCode').innerText;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('copyCodeBtn');
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy Code'; }, 2000);
  });
}

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
