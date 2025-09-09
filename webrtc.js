// Minimal WebRTC mesh using Socket.IO for signaling
const socket = io();
const peers = {}; // peerId -> RTCPeerConnection
let localStream = null;

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    alert('فشل الوصول إلى الميكروفون: ' + e.message);
  }
}

function createPeerConnection(targetId) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { roomId, targetId, data: { type: 'candidate', candidate: e.candidate } });
    }
  };
  pc.ontrack = (e) => {
    // create audio element per remote
    let el = document.getElementById('audio-' + targetId);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'audio-' + targetId;
      el.autoplay = true;
      document.body.appendChild(el);
    }
    el.srcObject = e.streams[0];
  };
  peers[targetId] = pc;
  return pc;
}

socket.on('signal', async ({ from, data }) => {
  let pc = peers[from];
  if (!pc) pc = createPeerConnection(from);
  if (data.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { roomId, targetId: from, data: { type: 'answer', answer } });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  } else if (data.type === 'candidate' && data.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
});

async function callAll(others) {
  for (const pid of others) {
    if (pid === socket.id) continue;
    const pc = createPeerConnection(pid);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { roomId, targetId: pid, data: { type: 'offer', offer } });
  }
}

window.WebRTCGame = { initMedia, callAll };
