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
  globalMessage: '',
  profiles: {},
  friendships: {},
  friendRequests: [],
  blocks: {},
  directMessages: {},
  communityStories: [],
  reports: []
};
const liveUsers = new Map();

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
      state.profiles = state.profiles || {};
      state.friendships = state.friendships || {};
      state.friendRequests = state.friendRequests || [];
      state.blocks = state.blocks || {};
      state.directMessages = state.directMessages || {};
      state.communityStories = state.communityStories || [];
      state.reports = state.reports || [];
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

function communityState() {
  return {
    friendships: state.friendships || {},
    friendRequests: state.friendRequests || [],
    blocks: state.blocks || {},
    directMessages: state.directMessages || {},
    communityStories: state.communityStories || [],
    reports: state.reports || []
  };
}
function emitCommunity(target) {
  const payload = { community: communityState(), profiles: state.profiles, users: publicUsers() };
  if (target) target.emit('community:state', payload);
  else io.emit('community:state', payload);
}
function socketsForUsername(username) {
  const ids = [];
  for (const [sid, u] of liveUsers.entries()) if (u.username === username) ids.push(sid);
  return ids;
}
function sendToUsername(username, event, payload) {
  socketsForUsername(username).forEach(sid => io.to(sid).emit(event, payload));
}
function dmKey(a, b) {
  return [a, b].sort().join('::');
}
function addFriend(a, b) {
  state.friendships[a] = state.friendships[a] || [];
  state.friendships[b] = state.friendships[b] || [];
  if (!state.friendships[a].includes(b)) state.friendships[a].push(b);
  if (!state.friendships[b].includes(a)) state.friendships[b].push(a);
}
function removeFriend(a, b) {
  state.friendships[a] = (state.friendships[a] || []).filter(x => x !== b);
  state.friendships[b] = (state.friendships[b] || []).filter(x => x !== a);
  state.friendRequests = (state.friendRequests || []).filter(r => !((r.from === a && r.to === b) || (r.from === b && r.to === a)));
}
function isBlockedEither(a, b) {
  return (state.blocks[a] || []).includes(b) || (state.blocks[b] || []).includes(a);
}
function isFriend(a, b) {
  return (state.friendships[a] || []).includes(b);
}

loadState();

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'BookMania_socketio_live.html')));

io.on('connection', socket => {
  socket.on('user:hello', user => {
    const username = safeText(user?.username || `Guest-${socket.id.slice(0, 5)}`, 60);
    const displayName = safeText(user?.displayName || username, 80);
    const savedProfile = state.profiles[username] || {};
    const incomingAvatar = safeText(user?.avatarUrl || '', 200000);
    const avatarUrl = incomingAvatar || safeText(savedProfile.avatarUrl || '', 200000);
    const normalized = {
      username,
      displayName,
      initials: safeText(user?.initials || savedProfile.initials || displayName.slice(0, 2).toUpperCase(), 4),
      avatarUrl,
      owner: !!user?.owner || username === OWNER_USERNAME,
      verified: !!user?.verified || username === OWNER_USERNAME,
      socketId: socket.id
    };
    state.profiles[username] = {
      username,
      displayName: normalized.displayName,
      initials: normalized.initials,
      avatarUrl: normalized.avatarUrl,
      owner: normalized.owner,
      verified: normalized.verified,
      updatedAt: Date.now()
    };
    saveState();
    liveUsers.set(socket.id, normalized);
    socket.emit('state:init', { ...state, users: publicUsers(), myProfile: state.profiles[username] });
    socket.emit('profile:sync', state.profiles[username]);
    emitCommunity(socket);
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


  socket.on('profile:update', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const avatarUrl = safeText(data?.avatarUrl || '', 200000);
    const profile = {
      username: user.username,
      displayName: user.displayName,
      initials: user.initials,
      avatarUrl,
      owner: !!user.owner,
      verified: !!user.verified,
      updatedAt: Date.now()
    };
    state.profiles[user.username] = profile;
    user.avatarUrl = avatarUrl;
    // Update old posts/comments too, so a changed profile picture appears everywhere.
    state.stories.forEach(st => {
      if (st.username === user.username || st.user === user.displayName) st.avatarUrl = avatarUrl;
    });
    Object.values(state.comments).forEach(list => {
      (list || []).forEach(c => { if (c.username === user.username) c.avatarUrl = avatarUrl; });
    });
    saveState();
    socket.emit('profile:sync', profile);
    io.emit('profile:update', profile);
    emitUsers();
    emitCommunity();
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


  socket.on('community:get', () => emitCommunity(socket));

  socket.on('friend:request', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const toUsername = safeText(data?.toUsername, 60);
    if (!toUsername || toUsername === user.username) return;
    if (isBlockedEither(user.username, toUsername)) return;
    if (isFriend(user.username, toUsername)) return;
    const exists = (state.friendRequests || []).some(r => r.status === 'pending' && ((r.from === user.username && r.to === toUsername) || (r.from === toUsername && r.to === user.username)));
    if (!exists) {
      state.friendRequests.push({ from: user.username, to: toUsername, status: 'pending', time: Date.now() });
      saveState();
    }
    const payload = { fromUsername: user.username, fromDisplay: user.displayName, toUsername, community: communityState() };
    sendToUsername(toUsername, 'friend:request', payload);
    sendToUsername(user.username, 'friend:update', payload);
    emitCommunity();
  });

  socket.on('friend:respond', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const fromUsername = safeText(data?.fromUsername, 60);
    const accept = !!data?.accept;
    const req = (state.friendRequests || []).find(r => r.from === fromUsername && r.to === user.username && r.status === 'pending');
    if (!req) return;
    req.status = accept ? 'accepted' : 'declined';
    req.respondedAt = Date.now();
    if (accept) addFriend(user.username, fromUsername);
    saveState();
    const payload = { fromUsername, toUsername: user.username, accept, community: communityState() };
    sendToUsername(fromUsername, 'friend:update', payload);
    sendToUsername(user.username, 'friend:update', payload);
    emitCommunity();
  });

  socket.on('friend:remove', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const username = safeText(data?.username, 60);
    removeFriend(user.username, username);
    saveState();
    const payload = { username, community: communityState() };
    sendToUsername(username, 'friend:update', payload);
    sendToUsername(user.username, 'friend:update', payload);
    emitCommunity();
  });

  socket.on('friend:block', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const username = safeText(data?.username, 60);
    if (!username || username === OWNER_USERNAME) return;
    state.blocks[user.username] = state.blocks[user.username] || [];
    if (!state.blocks[user.username].includes(username)) state.blocks[user.username].push(username);
    removeFriend(user.username, username);
    saveState();
    emitCommunity();
  });

  socket.on('friend:unblock', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const username = safeText(data?.username, 60);
    state.blocks[user.username] = (state.blocks[user.username] || []).filter(x => x !== username);
    saveState();
    emitCommunity();
  });

  socket.on('dm:send', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const toUsername = safeText(data?.toUsername, 60);
    const text = safeText(data?.text, 1000);
    if (!toUsername || !text) return;
    if (!isFriend(user.username, toUsername) || isBlockedEither(user.username, toUsername)) return;
    const key = dmKey(user.username, toUsername);
    state.directMessages[key] = state.directMessages[key] || [];
    const msg = { id: Date.now(), from: user.username, fromDisplay: user.displayName, to: toUsername, text, time: Date.now() };
    state.directMessages[key].push(msg);
    state.directMessages[key] = state.directMessages[key].slice(-200);
    saveState();
    const payload = { ...msg, community: communityState() };
    sendToUsername(user.username, 'dm:new', payload);
    sendToUsername(toUsername, 'dm:new', payload);
  });

  socket.on('community:story:new', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    if (state.bannedUsers.includes(user.username) && !user.owner) return socket.emit('admin:banned');
    const story = { id: Date.now(), username: user.username, displayName: user.displayName, initials: user.initials, avatarUrl: user.avatarUrl, verified: user.verified, title: safeText(data?.title, 120), text: safeText(data?.text, 5000), time: Date.now() };
    if (!story.title || !story.text) return;
    state.communityStories.unshift(story);
    state.communityStories = state.communityStories.slice(0, 100);
    saveState();
    io.emit('community:story:new', { story, community: communityState() });
  });

  socket.on('report:user', data => {
    const user = liveUsers.get(socket.id);
    if (!user) return;
    const report = { id: Date.now(), reporterUsername: user.username, reporterDisplay: user.displayName, reportedUsername: safeText(data?.reportedUsername, 60), why: safeText(data?.why, 1200), time: Date.now() };
    if (!report.reportedUsername || !report.why) return;
    state.reports.push(report);
    saveState();
    for (const [sid, u] of liveUsers.entries()) if (isAdmin(u)) io.to(sid).emit('admin:report', { ...report, reports: state.reports });
  });

  socket.on('admin:get-reports', admin => {
    if (!isAdmin(admin)) return;
    socket.emit('admin:report', { reports: state.reports });
  });

  socket.on('disconnect', () => {
    liveUsers.delete(socket.id);
    emitUsers();
    emitCommunity();
  });
});

server.listen(PORT, () => {
  console.log(`BookMania live server running: http://localhost:${PORT}`);
  console.log('Owner password is read from BOOKMANIA_OWNER_PASSWORD env if set.');
});
