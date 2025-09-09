
/**
 * 4D Justice Game - Server
 * Auth: Steam (passport-steam), Rooms: Socket.IO, Voice: WebRTC signaling via Socket.IO
 * Admin approval: allowlist.json; Admin panel at /admin
 */
require('dotenv').config();
const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const helmet = require('helmet');
const morgan = require('morgan');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_STEAM_IDS = (process.env.ADMIN_STEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.use(flash());

// ===== Passport Steam =====
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

if (!process.env.STEAM_API_KEY) {
  console.warn('WARNING: STEAM_API_KEY غير مضبوط. تسجيل الدخول عبر ستيم لن يعمل حتى تضبطه في .env');
}

passport.use(new SteamStrategy({
  returnURL: `${BASE_URL}/auth/steam/return`,
  realm: BASE_URL,
  apiKey: process.env.STEAM_API_KEY || 'MISSING'
}, function(identifier, profile, done) {
  // Steam profile + id
  profile.identifier = identifier;
  return done(null, profile);
}));

app.use(passport.initialize());
app.use(passport.session());

// ===== Simple in-file allowlist storage =====
const dataDir = path.join(__dirname, 'data');
const allowlistPath = path.join(dataDir, 'allowlist.json');
const pendingPath = path.join(dataDir, 'pending.json');
fse.ensureDirSync(dataDir);
if (!fs.existsSync(allowlistPath)) fs.writeFileSync(allowlistPath, JSON.stringify([]));
if (!fs.existsSync(pendingPath)) fs.writeFileSync(pendingPath, JSON.stringify([]));

const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2));

// ===== Middleware =====
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

function ensureApproved(req, res, next) {
  const allowlist = readJSON(allowlistPath);
  const steamId = req.user?.id;
  if (steamId && allowlist.includes(steamId)) return next();
  // If not approved, push to pending
  if (steamId) {
    const pending = readJSON(pendingPath);
    if (!pending.find(p => p.id === steamId)) {
      pending.push({ id: steamId, name: req.user.displayName || 'Unknown', at: Date.now() });
      writeJSON(pendingPath, pending);
    }
  }
  res.render('pending', { user: req.user });
}

function ensureAdmin(req, res, next) {
  const id = req.user?.id;
  if (id && ADMIN_STEAM_IDS.includes(id)) return next();
  return res.status(403).send('Forbidden: Admins only');
}

// ===== Routes =====
app.get('/', (req, res) => res.render('index', { user: req.user }));
app.get('/login', (req, res) => res.render('login', { user: req.user, message: req.flash('error') }));
app.get('/logout', (req, res) => { req.logout(() => {}); res.redirect('/'); });

app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/login' }), (req, res) => {});
app.get('/auth/steam/return',
  passport.authenticate('steam', { failureRedirect: '/login', failureFlash: true }),
  (req, res) => res.redirect('/')
);

// Game lobby & room
app.get('/lobby', ensureAuth, ensureApproved, (req, res) => {
  res.render('lobby', { user: req.user });
});

app.get('/room/:roomId', ensureAuth, ensureApproved, (req, res) => {
  res.render('game', { user: req.user, roomId: req.params.roomId });
});

// Admin panel
app.get('/admin', ensureAuth, ensureAdmin, (req, res) => {
  const allow = readJSON(allowlistPath);
  const pending = readJSON(pendingPath);
  res.render('admin', { user: req.user, allow, pending });
});

app.post('/admin/approve', ensureAuth, ensureAdmin, (req, res) => {
  const { id } = req.body;
  const allow = readJSON(allowlistPath);
  if (!allow.includes(id)) {
    allow.push(id);
    writeJSON(allowlistPath, allow);
  }
  // remove from pending
  const pending = readJSON(pendingPath).filter(p => p.id !== id);
  writeJSON(pendingPath, pending);
  res.redirect('/admin');
});

app.post('/admin/reject', ensureAuth, ensureAdmin, (req, res) => {
  const { id } = req.body;
  const pending = readJSON(pendingPath).filter(p => p.id !== id);
  writeJSON(pendingPath, pending);
  res.redirect('/admin');
});

// ===== Socket.IO: rooms, roles, WebRTC signaling =====
const rooms = {}; // roomId -> { host, players: Map(socketId -> playerInfo), started, roles }
const MAX_AUDIENCE = 6;
const MAX_SPECTATORS = 6;

io.on('connection', (socket) => {
  socket.on('joinLobby', (user) => {
    socket.data.user = user;
  });

  socket.on('createRoom', () => {
    const roomId = uuidv4().slice(0,8);
    rooms[roomId] = { host: socket.id, players: new Map(), started: false, roles: {} };
    socket.emit('roomCreated', roomId);
  });

  socket.on('joinRoom', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', 'الغرفة غير موجودة');
    socket.join(roomId);
    // classify as player (audience) until roles assigned
    room.players.set(socket.id, {
      steamId: socket.data?.user?.id || 'guest',
      name: socket.data?.user?.displayName || 'Player',
      role: 'audience',
      eye: { x: 0.5, y: 0.5 }
    });
    io.to(roomId).emit('playersUpdate', Array.from(room.players.values()));
  });

  socket.on('leaveRoom', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(roomId);
    io.to(roomId).emit('playersUpdate', Array.from(room.players.values()));
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.host !== socket.id) return socket.emit('errorMsg', 'فقط منشئ الغرفة يمكنه البدء');
    const ids = Array.from(room.players.keys());
    if (ids.length < 3) return socket.emit('errorMsg', 'يلزم 3 لاعبين على الأقل');
    // Assign core roles
    const shuffle = ids.slice().sort(() => Math.random()-0.5);
    const judge = shuffle[0];
    const lawyer = shuffle[1];
    const prosecutor = shuffle[2];
    const accused = shuffle[Math.floor(Math.random()*shuffle.length)];
    room.roles = { judge, lawyer, prosecutor, accused };
    ids.forEach(id => {
      const p = room.players.get(id);
      if (!p) return;
      if (id === judge) p.role = 'judge';
      else if (id === lawyer) p.role = 'lawyer';
      else if (id === prosecutor) p.role = 'prosecutor';
      else p.role = 'audience';
      p.accused = (id === accused);
    });
    room.started = true;
    io.to(roomId).emit('gameStarted', { roles: room.roles, players: Array.from(room.players.values()) });
  });

  // Eye tracking via mouse (normalized 0..1)
  socket.on('eyeMove', ({ roomId, x, y }) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.eye = { x, y };
    socket.to(roomId).emit('eyeMove', { id: socket.id, x, y });
  });

  // WebRTC signaling
  socket.on('signal', ({ roomId, targetId, data }) => {
    io.to(targetId).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        io.to(roomId).emit('playersUpdate', Array.from(room.players.values()));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
