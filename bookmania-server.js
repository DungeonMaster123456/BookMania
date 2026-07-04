const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 2e6 });

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
  community: {
    friendships: {},
    friendRequests: [],
    directMessages: {},
    blocks: {},
    reports: [],
    communityStories: []
  }
};
const liveUsers = new Map();

function normalizeState() {
  state.stories = Array.isArray(state.stories) ? state.stories : [];
  state.comments = state.comments && typeof state.comments === 'object' ? state.comments : {};
  state.bannedUsers = Array.isArray(state.bannedUsers) ? state.bannedUsers : [];
  state.globalMessage = typeof state.globalMessage === 'string' ? state.globalMessage : '';
  state.profiles = state.profiles && typeof state.profiles === 'object' ? state.profiles : {};
  state.community = state.community && typeof state.community === 'object' ? state.community : {};
  state.community.friendships = state.community.friendships && typeof state.community.friendships === 'object' ? state.community.friendships : {};
  state.community.friendRequests = Array.isArray(state.community.friendRequests) ? state.community.friendRequests : [];
  state.community.directMessages = state.community.directMessages && typeof state.community.directMessages === 'object' ? state.community.directMessages : {};
  state.community.blocks = state.community.blocks && typeof state.community.blocks === 'object' ? state.community.blocks : {};
  state.community.reports = Array.isArray(state.community.reports) ? state.community.reports : [];
  state.community.communityStories = Array.isArray(state.community.communityStories) ? state.community.communityStories : [];
}
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    }
  } catch (err) {
    console.warn('Could not load data file:', err.message);
  }
  normalizeState();
}
function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('Could not save data file:', err.message);
  }
}
function safeText(v, max = 2000) {
  return String(v || '').trim().slice(0, max);
}
function profileFromUser(user, socketId = '') {
  const username = safeText(user?.username || user?.un || `Guest-${socketId.slice(0, 5)}`, 60);
  const displayName = safeText(user?.displayName || user?.name || username, 80);
  const owner = !!user?.owner || username === OWNER_USERNAME || displayName === OWNER_USERNAME;
  return {
    username,
    displayName: owner ? OWNER_USERNAME : displayName,
    initials: safeText(user?.initials || (owner ? 'BM' : displayName.slice(0, 2).toUpperCase()), 4),
    avatarUrl: safeText(user?.avatarUrl || user?.av || '', 200000),
    owner,
    verified: !!user?.verified || owner,
    socketId
  };
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
  return user.owner === true || user.username === OWNER_USERNAME || user.displayName === OWNER_USERNAME;
}
function isBanned(username, owner) {
  return state.bannedUsers.includes(username) && !owner;
}
function emitUsers() {
  io.emit('admin:users', { users: publicUsers(), bannedUsers: state.bannedUsers });
  emitCommunityState();
}
function emitCommunityState(target = io) {
  target.emit('community:state', { community: state.community, profiles: state.profiles });
}
function saveProfile(p) {
  if (!p.username) return;
  const old = state.profiles[p.username] || {};
  state.profiles[p.username] = {
    ...old,
    username: p.username,
    displayName: p.displayName || old.displayName || p.username,
    initials: p.initials || old.initials || p.username.slice(0, 2).toUpperCase(),
    avatarUrl: p.avatarUrl || old.avatarUrl || '',
    owner: !!p.owner || !!old.owner,
    verified: !!p.verified || !!old.verified || p.username === OWNER_USERNAME,
    lastSeen: Date.now()
  };
}
function storyExists(id) { return state.stories.some(s => String(s.id) === String(id)); }
function cleanStory(story, user, restored = false) {
  return {
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
    time: restored ? safeText(story?.time || 'Saved story', 40) : 'Just now',
    isPrem: !!story?.isPrem,
    price: Number(story?.price || 0),
    likes: Number(story?.likes || 0),
    comments: Number(story?.comments || 0),
    verified: !!story?.verified || !!user?.verified,
    owner: !!story?.owner || !!user?.owner
  };
}
function dmKey(a, b) { return [a, b].sort().join('::'); }
function addUnique(list, item) { if (!list.includes(item)) list.push(item); }
function removeFrom(list, item) { return (list || []).filter(x => x !== item); }

loadState();

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'BookMania_socketio_live.html')));

io.on('connection', socket => {
  socket.on('user:hello', user => {
    const normalized = profileFromUser(user, socket.id);
    liveUsers.set(socket.id, normalized);
    saveProfile(normalized);
    saveState();
    socket.emit('state:init', { ...state, users: publicUsers() });
    if (isBanned(normalized.username, normalized.owner)) socket.emit('admin:banned');
    emitUsers();
  });

  socket.on('profile:update', data => {
    const user = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    if (!user.username) return;
    const avatarUrl = safeText(data?.avatarUrl || data?.user?.avatarUrl || '', 200000);
    user.avatarUrl = avatarUrl;
    saveProfile({ ...user, avatarUrl });
    state.stories.forEach(s => { if (s.username === user.username) s.avatarUrl = avatarUrl; });
    Object.values(state.comments).forEach(list => (list || []).forEach(c => { if (c.username === user.username) c.avatarUrl = avatarUrl; }));
    state.community.communityStories.forEach(s => { if (s.username === user.username) s.avatarUrl = avatarUrl; });
    saveState();
    socket.emit('profile:sync', state.profiles[user.username]);
    io.emit('profile:update', state.profiles[user.username]);
    emitUsers();
  });

  socket.on('story:new', story => {
    const user = liveUsers.get(socket.id) || profileFromUser(story?.user, socket.id);
    if (isBanned(user.username, user.owner)) return socket.emit('admin:banned');
    const clean = cleanStory(story, user, false);
    if (!storyExists(clean.id)) state.stories.unshift(clean);
    saveState();
    io.emit('story:new', clean);
  });

  socket.on('story:restore', story => {
    const user = liveUsers.get(socket.id) || profileFromUser(story?.user, socket.id);
    if (isBanned(user.username, user.owner)) return socket.emit('admin:banned');
    const clean = cleanStory(story, user, true);
    if (!storyExists(clean.id)) {
      state.stories.unshift(clean);
      saveState();
      io.emit('story:new', clean);
    }
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
    const user = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    if (isBanned(user.username, user.owner)) return socket.emit('admin:banned');
    const storyId = String(data?.storyId || '');
    if (!storyId) return;
    const comment = {
      id: Date.now(),
      username: safeText(data?.user?.username || user.username, 60),
      displayName: safeText(data?.user?.displayName || user.displayName, 80),
      initials: safeText(data?.user?.initials || user.initials, 4),
      avatarUrl: safeText(data?.user?.avatarUrl || user.avatarUrl, 200000),
      verified: !!data?.user?.verified || !!user.verified,
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
  socket.on('admin:get-reports', admin => { if (isAdmin(admin)) socket.emit('admin:report', { reports: state.community.reports }); });
  socket.on('admin:global', data => {
    if (!isAdmin(data?.admin)) return;
    state.globalMessage = safeText(data?.message || '', 220);
    saveState(); io.emit('admin:global', state.globalMessage);
  });
  socket.on('admin:global-clear', admin => {
    if (!isAdmin(admin)) return;
    state.globalMessage = ''; saveState(); io.emit('admin:global-clear');
  });
  socket.on('admin:restart', admin => { if (isAdmin(admin)) io.emit('admin:restart'); });
  socket.on('admin:ban', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    if (username && username !== OWNER_USERNAME && !state.bannedUsers.includes(username)) state.bannedUsers.push(username);
    saveState(); emitUsers();
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:banned');
  });
  socket.on('admin:unban', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    state.bannedUsers = state.bannedUsers.filter(u => u !== username);
    saveState(); emitUsers();
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:unbanned');
  });

  socket.on('friend:request', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const to = safeText(data?.toUsername, 60);
    if (!to || to === me.username || isBanned(me.username, me.owner)) return;
    const exists = state.community.friendRequests.some(r => r.from === me.username && r.to === to && r.status === 'pending');
    if (!exists) state.community.friendRequests.push({ from: me.username, to, fromDisplay: me.displayName, status: 'pending', time: Date.now() });
    saveState(); emitCommunityState();
    for (const [sid, u] of liveUsers.entries()) if (u.username === to) io.to(sid).emit('friend:request', { fromUsername: me.username, fromDisplay: me.displayName });
  });

  socket.on('friend:respond', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const from = safeText(data?.fromUsername, 60);
    const accept = !!data?.accept;
    state.community.friendRequests = state.community.friendRequests.filter(r => !(r.from === from && r.to === me.username && r.status === 'pending'));
    if (accept) {
      state.community.friendships[me.username] = state.community.friendships[me.username] || [];
      state.community.friendships[from] = state.community.friendships[from] || [];
      addUnique(state.community.friendships[me.username], from);
      addUnique(state.community.friendships[from], me.username);
    }
    saveState(); emitCommunityState(); io.emit('friend:update', { community: state.community });
  });

  socket.on('friend:remove', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const other = safeText(data?.username, 60);
    state.community.friendRequests = state.community.friendRequests.filter(r => !((r.from === me.username && r.to === other) || (r.from === other && r.to === me.username)));
    state.community.friendships[me.username] = removeFrom(state.community.friendships[me.username], other);
    state.community.friendships[other] = removeFrom(state.community.friendships[other], me.username);
    saveState(); emitCommunityState(); io.emit('friend:update', { community: state.community });
  });

  socket.on('friend:block', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const other = safeText(data?.username, 60);
    state.community.blocks[me.username] = state.community.blocks[me.username] || [];
    addUnique(state.community.blocks[me.username], other);
    state.community.friendships[me.username] = removeFrom(state.community.friendships[me.username], other);
    state.community.friendships[other] = removeFrom(state.community.friendships[other], me.username);
    state.community.friendRequests = state.community.friendRequests.filter(r => !((r.from === me.username && r.to === other) || (r.from === other && r.to === me.username)));
    saveState(); emitCommunityState(); io.emit('friend:update', { community: state.community });
  });

  socket.on('friend:unblock', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const other = safeText(data?.username, 60);
    state.community.blocks[me.username] = removeFrom(state.community.blocks[me.username], other);
    saveState(); emitCommunityState(); io.emit('friend:update', { community: state.community });
  });

  socket.on('dm:send', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const to = safeText(data?.toUsername, 60);
    const text = safeText(data?.text, 1200);
    if (!to || !text) return;
    if (!((state.community.friendships[me.username] || []).includes(to))) return;
    const key = dmKey(me.username, to);
    state.community.directMessages[key] = state.community.directMessages[key] || [];
    state.community.directMessages[key].push({ from: me.username, to, fromDisplay: me.displayName, text, time: Date.now() });
    state.community.directMessages[key] = state.community.directMessages[key].slice(-250);
    saveState(); emitCommunityState(); io.emit('dm:new', { community: state.community, from: me.username, fromDisplay: me.displayName, to });
  });

  socket.on('community:story:new', data => {
    const sent = profileFromUser(data?.user, socket.id);
    const live = liveUsers.get(socket.id);
    const me = (sent.owner || sent.verified || sent.username === OWNER_USERNAME) ? sent : (live || sent);
    if (isBanned(me.username, me.owner)) return socket.emit('admin:banned');
    const verified = !!me.verified || !!me.owner || me.username === OWNER_USERNAME || me.displayName === OWNER_USERNAME || !!data?.verified || !!data?.owner;
    const story = {
      id: Date.now(),
      username: verified ? OWNER_USERNAME : me.username,
      displayName: verified ? OWNER_USERNAME : me.displayName,
      initials: verified ? 'BM' : me.initials,
      avatarUrl: me.avatarUrl,
      verified,
      owner: !!me.owner || verified,
      title: safeText(data?.title, 120),
      text: safeText(data?.text, 5000),
      time: Date.now()
    };
    if (!story.title || !story.text) return;
    state.community.communityStories.unshift(story);
    state.community.communityStories = state.community.communityStories.slice(0, 200);
    saveState(); emitCommunityState(); io.emit('community:story:new', { community: state.community, story });
  });

  socket.on('report:user', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const report = {
      id: Date.now(),
      reporterUsername: me.username,
      reporterDisplay: me.displayName,
      reportedUsername: safeText(data?.reportedUsername, 60),
      why: safeText(data?.why, 1200),
      time: Date.now()
    };
    if (!report.reportedUsername || !report.why) return;
    state.community.reports.push(report);
    state.community.reports = state.community.reports.slice(-200);
    saveState(); emitCommunityState();
    for (const [sid, u] of liveUsers.entries()) if (u.owner) io.to(sid).emit('admin:report', { reports: state.community.reports, ...report });
  });

  socket.on('disconnect', () => { liveUsers.delete(socket.id); emitUsers(); });
});

server.listen(PORT, () => {
  console.log(`BookMania live server running: http://localhost:${PORT}`);
  console.log('Owner password is read from BOOKMANIA_OWNER_PASSWORD env if set.');
});
