const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'bookmania-live-data.json');
const OWNER_USERNAME = process.env.BOOKMANIA_OWNER_USERNAME || 'BookMania';
const OWNER_PASSWORD = process.env.BOOKMANIA_OWNER_PASSWORD || '020501';

let state = {
  stories: [],
  comments: {},
  bannedUsers: [],
  globalMessage: ''
};
const liveUsers = new Map();

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    }
  } catch (err) {
    console.warn('Could not load data file:', err.message);
  }
}
function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('Could not save data file:', err.message);
  }
}
function publicUsers() {
  return Array.from(liveUsers.values()).map(u => ({
    username: u.username,
    displayName: u.displayName,
    initials: u.initials,
    avatarUrl: u.avatarUrl,
    owner: !!u.owner,
    verified: !!u.verified
  }));
}
function isAdmin(user) {
  if (!user) return false;
  // Frontend sends owner:true only after logging into the hidden owner account.
  // For production, add real sessions/JWT. This is a local demo admin check.
  return user.owner === true || user.username === OWNER_USERNAME || user.displayName === OWNER_USERNAME;
}
function emitUsers() {
  io.emit('admin:users', { users: publicUsers(), bannedUsers: state.bannedUsers });
}
function safeText(v, max = 2000) {
  return String(v || '').trim().slice(0, max);
}

loadState();

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'BookMania_socketio_live.html')));

io.on('connection', socket => {
  socket.on('user:hello', user => {
    const username = safeText(user?.username || `Guest-${socket.id.slice(0, 5)}`, 60);
    const displayName = safeText(user?.displayName || username, 80);
    const normalized = {
      username,
      displayName,
      initials: safeText(user?.initials || displayName.slice(0, 2).toUpperCase(), 4),
      avatarUrl: safeText(user?.avatarUrl || '', 200000),
      owner: !!user?.owner || username === OWNER_USERNAME,
      verified: !!user?.verified || username === OWNER_USERNAME,
      socketId: socket.id
    };
    liveUsers.set(socket.id, normalized);
    socket.emit('state:init', { ...state, users: publicUsers() });
    if (state.bannedUsers.includes(username) && !normalized.owner) socket.emit('admin:banned');
    emitUsers();
  });

  socket.on('story:new', story => {
    const user = liveUsers.get(socket.id);
    if (user && state.bannedUsers.includes(user.username) && !user.owner) return socket.emit('admin:banned');
    const clean = {
      id: story?.id || Date.now(),
      user: safeText(story?.user || user?.displayName || 'Guest', 80),
      username: safeText(story?.username || user?.username || 'Guest', 60),
      ini: safeText(story?.ini || user?.initials || 'GU', 4),
      av: safeText(story?.av || 'av-a', 20),
      avatarUrl: safeText(story?.avatarUrl || user?.avatarUrl || '', 200000),
      title: safeText(story?.title || 'Untitled', 120),
      genre: safeText(story?.genre || 'fiction', 40),
      excerpt: safeText(story?.excerpt || '', 30000),
      pages: Array.isArray(story?.pages) ? story.pages.map(p => safeText(p, 30000)).slice(0, 80) : [],
      time: 'Just now',
      isPrem: !!story?.isPrem,
      price: Number(story?.price || 0),
      likes: 0,
      comments: 0,
      verified: !!story?.verified || !!user?.verified,
      owner: !!story?.owner || !!user?.owner
    };
    state.stories.unshift(clean);
    saveState();
    socket.broadcast.emit('story:new', clean);
  });

  socket.on('story:like', data => {
    const storyId = String(data?.storyId || '');
    const inServer = state.stories.find(s => String(s.id) === storyId);
    const likes = Math.max(Number(data?.likes || 0), inServer ? Number(inServer.likes || 0) + 1 : Number(data?.likes || 1));
    if (inServer) { inServer.likes = likes; saveState(); }
    io.emit('story:like', { storyId: data?.storyId, likes });
  });

  socket.on('comments:get', data => {
    const storyId = String(data?.storyId || '');
    socket.emit('comment:new', { storyId: data?.storyId, comments: state.comments[storyId] || [] });
  });

  socket.on('comment:new', data => {
    const user = liveUsers.get(socket.id);
    if (user && state.bannedUsers.includes(user.username) && !user.owner) return socket.emit('admin:banned');
    const storyId = String(data?.storyId || '');
    if (!storyId) return;
    const comment = {
      id: Date.now(),
      username: safeText(data?.user?.username || user?.username || 'Guest', 60),
      displayName: safeText(data?.user?.displayName || user?.displayName || 'Guest', 80),
      initials: safeText(data?.user?.initials || user?.initials || 'GU', 4),
      avatarUrl: safeText(data?.user?.avatarUrl || user?.avatarUrl || '', 200000),
      verified: !!data?.user?.verified || !!user?.verified,
      text: safeText(data?.text || '', 1000),
      time: Date.now()
    };
    if (!comment.text) return;
    state.comments[storyId] = state.comments[storyId] || [];
    state.comments[storyId].push(comment);
    const s = state.stories.find(x => String(x.id) === storyId);
    if (s) s.comments = state.comments[storyId].length;
    saveState();
    io.emit('comment:new', { storyId: data?.storyId, comments: state.comments[storyId] });
  });

  socket.on('admin:get-users', admin => { if (isAdmin(admin)) socket.emit('admin:users', { users: publicUsers(), bannedUsers: state.bannedUsers }); });

  socket.on('admin:global', data => {
    if (!isAdmin(data?.admin)) return;
    state.globalMessage = safeText(data?.message || '', 220);
    saveState();
    io.emit('admin:global', state.globalMessage);
  });
  socket.on('admin:global-clear', admin => {
    if (!isAdmin(admin)) return;
    state.globalMessage = '';
    saveState();
    io.emit('admin:global-clear');
  });
  socket.on('admin:restart', admin => {
    if (!isAdmin(admin)) return;
    io.emit('admin:restart');
    // This broadcasts the restart animation. To actually restart the backend,
    // run with nodemon or PM2 and restart from your terminal/process manager.
  });
  socket.on('admin:ban', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    if (username && username !== OWNER_USERNAME && !state.bannedUsers.includes(username)) state.bannedUsers.push(username);
    saveState();
    emitUsers();
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:banned');
  });
  socket.on('admin:unban', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    state.bannedUsers = state.bannedUsers.filter(u => u !== username);
    saveState();
    emitUsers();
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:unbanned');
  });

  socket.on('disconnect', () => {
    liveUsers.delete(socket.id);
    emitUsers();
  });
});

server.listen(PORT, () => {
  console.log(`BookMania live server running: http://localhost:${PORT}`);
  console.log('Owner password is read from BOOKMANIA_OWNER_PASSWORD env if set.');
});
