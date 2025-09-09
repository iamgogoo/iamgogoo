// Game client logic
const canvas = document.getElementById('stageCanvas');
const ctx = canvas.getContext('2d');

function resize() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
  draw();
}
window.addEventListener('resize', resize);
resize();

const state = {
  players: [],
  roles: {},
  started: false
};

function draw() {
  ctx.clearRect(0,0,canvas.width, canvas.height);
  // simple stage layout: judge in center top, lawyer left, prosecutor right, audience bottom
  const W = canvas.width, H = canvas.height;
  const centerX = W/2;

  const judge = state.players.find(p => p.role === 'judge');
  const lawyer = state.players.find(p => p.role === 'lawyer');
  const prosecutor = state.players.find(p => p.role === 'prosecutor');
  const audience = state.players.filter(p => p.role === 'audience');

  drawAvatar(judge, centerX, 100);
  drawAvatar(lawyer, Math.max(120, W*0.2), H*0.5);
  drawAvatar(prosecutor, Math.min(W-120, W*0.8), H*0.5);

  const gap = Math.max(120, W / Math.max(1, audience.length+1));
  audience.forEach((p, i) => {
    const x = gap * (i+1);
    drawAvatar(p, x, H-120);
  });
}

function drawAvatar(p, x, y) {
  if (!p) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#2d2d2d';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0,0,40,0,Math.PI*2); // head
  ctx.fill(); ctx.stroke();

  // eyes follow p.eye (0..1)
  const ex = (p.eye?.x ?? 0.5 - 0.5) * 12;
  const ey = (p.eye?.y ?? 0.5 - 0.5) * 12;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(-12, -8, 10, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(+12, -8, 10, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(-12+ex, -8+ey, 5, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(+12+ex, -8+ey, 5, 0, Math.PI*2); ctx.fill();

  // name + role
  ctx.fillStyle = '#fff';
  ctx.font = '14px sans-serif';
  const label = (p.name || 'لاعب') + (p.accused ? ' (المتهم?)' : '') + ' - ' + (p.role || '');
  const w = ctx.measureText(label).width;
  ctx.fillText(label, -w/2, 64);
  ctx.restore();
}

const socket = io();

socket.emit('joinRoom', { roomId });

socket.on('playersUpdate', (players) => {
  state.players = players;
  updatePlayersList();
  draw();
});

socket.on('gameStarted', ({ roles, players }) => {
  state.roles = roles;
  state.players = players;
  state.started = true;
  document.getElementById('status').textContent = 'الجولة بدأت - ناقشوا عبر الميكروفون والقاضي يقرر!';
  updatePlayersList();
  draw();
  // start voice calls after we have list of sockets (approx via players length)
  startVoice();
});

document.getElementById('start').onclick = () => {
  socket.emit('startGame', { roomId });
};

function updatePlayersList() {
  const el = document.getElementById('players');
  el.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${p.name} — ${p.role}${p.accused ? ' (المتهم?)' : ''}`;
    el.appendChild(li);
  });
}

// Eye tracking
window.addEventListener('mousemove', (e) => {
  const x = Math.min(1, Math.max(0, e.clientX / window.innerWidth));
  const y = Math.min(1, Math.max(0, e.clientY / window.innerHeight));
  socket.emit('eyeMove', { roomId, x, y });
});

async function startVoice() {
  await WebRTCGame.initMedia();
  // after short delay, call all peers in the same room by their socket ids (from players list)
  const ids = [];
  const li = document.querySelectorAll('#players li');
  // We don't have socket ids on client, so we trigger offer to everyone via server echo:
  // Ask server to broadcast our presence so others send offers to us as well.
  const others = window.__lastPlayersIds || [];
  WebRTCGame.callAll(others);
}


socket.on('peerIds', (ids) => {
  window.__lastPlayersIds = ids;
});
