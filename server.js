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
const OWNER_EMAIL = (process.env.BOOKMANIA_OWNER_EMAIL || 'owner@bookmania.local').toLowerCase();

// Optional SMTP email delivery for one-time login codes.
// Configure via environment variables: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM.
// Without them, codes are printed to the server console (dev mode) and echoed back to the requester
// so you can still test signup/login locally before wiring up real email.
let mailTransport = null;
try {
  if (process.env.SMTP_HOST) {
    const nodemailer = require('nodemailer');
    mailTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
} catch (e) {
  console.warn('nodemailer not installed — run `npm install nodemailer` to enable real email delivery. Falling back to dev mode.');
  mailTransport = null;
}
async function sendOtpEmail(email, code) {
  if (!mailTransport) {
    console.log(`[BookMania OTP - DEV MODE, no SMTP configured] Code for ${email}: ${code} (expires in 20 min)`);
    return { devMode: true };
  }
  try {
    await mailTransport.sendMail({
      from: process.env.SMTP_FROM || 'BookMania <no-reply@bookmania.app>',
      to: email,
      subject: 'Your BookMania sign-in code',
      text: `Your BookMania verification code is ${code}. It expires in 20 minutes. If you didn't request this, ignore this email.`,
      html: `<div style="font-family:Georgia,serif;padding:24px;background:#12100d;color:#f0e8d8;"><h2 style="color:#e9a84c;margin:0 0 12px;">BookMania</h2><p style="margin:0 0 18px;">Your verification code is:</p><div style="font-size:34px;letter-spacing:9px;font-weight:700;color:#e9a84c;">${code}</div><p style="color:#9c9488;font-size:13px;margin-top:20px;">This code expires in 20 minutes. If you didn't request this, you can safely ignore this email.</p></div>`
    });
    return { devMode: false };
  } catch (e) {
    console.error('OTP email send failed:', e.message);
    console.log(`[BookMania OTP fallback] Code for ${email}: ${code}`);
    return { devMode: true, error: true };
  }
}
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }

let state = {
  stories: [],
  comments: {},
  bans: {},
  mutes: {},
  globalMessage: '',
  profiles: {},
  auditLog: [],
  emailIndex: {},
  otps: {},
  verifiedEmails: {},
  community: {
    friendships: {},
    friendRequests: [],
    directMessages: {},
    blocks: {},
    reports: [],
    communityStories: [],
    groups: [],
    groupMessages: {}
  }
};
const liveUsers = new Map();
const BAD_WORDS = ['fuck','shit','bitch','asshole','bastard','dick','pussy','cunt','whore','slut','dumbass','twat','wanker','bollocks'];
function countBadWords(text) {
  if (!text) return 0;
  const lower = String(text).toLowerCase();
  let count = 0;
  for (const w of BAD_WORDS) {
    const re = new RegExp('\\b' + w + '\\w*', 'g');
    const m = lower.match(re);
    if (m) count += m.length;
  }
  return count;
}
function moderateMessage(username, owner, text) {
  if (owner || !username) return { action: null };
  const hits = countBadWords(text);
  if (!hits) return { action: null };
  const profile = state.profiles[username] = state.profiles[username] || { username };
  profile.badWordHits = (Number(profile.badWordHits) || 0) + hits;
  let action = null;
  if (profile.badWordHits >= 5 && !isBanned(username, false)) {
    state.bans[username] = {
      reason: 'Automated moderation: repeated use of inappropriate language',
      until: Date.now() + 7 * 24 * 60 * 60 * 1000,
      bannedAt: Date.now(),
      by: 'AI Moderator'
    };
    action = 'banned';
  } else if (profile.badWordHits >= 3 && !profile.warned) {
    profile.warned = true;
    action = 'warned';
  }
  return { action, hits: profile.badWordHits };
}

function logAudit(admin, action, target, detail) {
  state.auditLog = state.auditLog || [];
  state.auditLog.unshift({ admin: admin || OWNER_USERNAME, action, target: target || null, detail: detail || null, time: Date.now() });
  state.auditLog = state.auditLog.slice(0, 500);
}

function normalizeState() {
  state.stories = Array.isArray(state.stories) ? state.stories : [];
  state.auditLog = Array.isArray(state.auditLog) ? state.auditLog : [];
  state.emailIndex = state.emailIndex && typeof state.emailIndex === 'object' ? state.emailIndex : {};
  state.otps = state.otps && typeof state.otps === 'object' ? state.otps : {};
  state.verifiedEmails = state.verifiedEmails && typeof state.verifiedEmails === 'object' ? state.verifiedEmails : {};
  state.comments = state.comments && typeof state.comments === 'object' ? state.comments : {};
  state.bans = state.bans && typeof state.bans === 'object' ? state.bans : {};
  state.mutes = state.mutes && typeof state.mutes === 'object' ? state.mutes : {};
  if (Array.isArray(state.bannedUsers)) {
    state.bannedUsers.forEach(u => {
      if (u && !state.bans[u]) state.bans[u] = { reason: 'Legacy ban', until: null, bannedAt: Date.now(), by: OWNER_USERNAME };
    });
    delete state.bannedUsers;
  }
  state.globalMessage = typeof state.globalMessage === 'string' ? state.globalMessage : '';
  state.profiles = state.profiles && typeof state.profiles === 'object' ? state.profiles : {};
  state.community = state.community && typeof state.community === 'object' ? state.community : {};
  state.community.friendships = state.community.friendships && typeof state.community.friendships === 'object' ? state.community.friendships : {};
  state.community.friendRequests = Array.isArray(state.community.friendRequests) ? state.community.friendRequests : [];
  state.community.directMessages = state.community.directMessages && typeof state.community.directMessages === 'object' ? state.community.directMessages : {};
  state.community.blocks = state.community.blocks && typeof state.community.blocks === 'object' ? state.community.blocks : {};
  state.community.reports = Array.isArray(state.community.reports) ? state.community.reports : [];
  state.community.communityStories = Array.isArray(state.community.communityStories) ? state.community.communityStories : [];
  state.community.groups = Array.isArray(state.community.groups) ? state.community.groups : [];
  state.community.groupMessages = state.community.groupMessages && typeof state.community.groupMessages === 'object' ? state.community.groupMessages : {};
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
  if (owner) return false;
  const b = state.bans[username];
  if (!b) return false;
  if (b.until && Date.now() > b.until) { delete state.bans[username]; return false; }
  return true;
}
function banInfo(username) { return state.bans[username] || null; }
function isMuted(username, owner) {
  if (owner) return false;
  const m = state.mutes[username];
  if (!m) return false;
  if (Date.now() > m.until) { delete state.mutes[username]; return false; }
  return true;
}
function muteInfo(username) { return state.mutes[username] || null; }
function emitUsers() {
  io.emit('admin:users', { users: publicUsers(), bannedUsers: Object.keys(state.bans), mutedUsers: Object.keys(state.mutes) });
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
    email: p.email || old.email || '',
    owner: !!p.owner || !!old.owner,
    verified: !!p.verified || !!old.verified || p.username === OWNER_USERNAME,
    lastSeen: Date.now()
  };
}
function setVerified(username, verified) {
  if (!username || username === OWNER_USERNAME) return;
  const old = state.profiles[username] || {};
  state.profiles[username] = {
    ...old,
    username,
    displayName: old.displayName || username,
    initials: old.initials || username.slice(0, 2).toUpperCase(),
    avatarUrl: old.avatarUrl || '',
    owner: !!old.owner,
    verified: !!verified,
    lastSeen: Date.now()
  };
  for (const u of liveUsers.values()) if (u.username === username) u.verified = !!verified;
  state.stories.forEach(s => { if (s.username === username) s.verified = !!verified; });
  Object.values(state.comments).forEach(list => (list || []).forEach(c => { if (c.username === username) c.verified = !!verified; }));
  state.community.communityStories.forEach(s => { if (s.username === username) s.verified = !!verified; });
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

function renameUsernameEverywhere(oldU, newU) {
  if (state.profiles[oldU]) {
    const p = state.profiles[oldU];
    p.username = newU;
    state.profiles[newU] = p;
    delete state.profiles[oldU];
  }
  if (state.bans[oldU]) { state.bans[newU] = state.bans[oldU]; delete state.bans[oldU]; }
  if (state.mutes[oldU]) { state.mutes[newU] = state.mutes[oldU]; delete state.mutes[oldU]; }
  const c = state.community;
  if (c.friendships[oldU]) { c.friendships[newU] = c.friendships[oldU]; delete c.friendships[oldU]; }
  Object.keys(c.friendships).forEach(k => {
    c.friendships[k] = (c.friendships[k] || []).map(f => f === oldU ? newU : f);
  });
  c.friendRequests.forEach(r => { if (r.from === oldU) r.from = newU; if (r.to === oldU) r.to = newU; });
  const dmKeys = Object.keys(c.directMessages);
  dmKeys.forEach(k => {
    if (!k.includes(oldU)) return;
    const parts = k.split('::');
    const newKeyParts = parts.map(p => p === oldU ? newU : p);
    const newKey = dmKey(newKeyParts[0], newKeyParts[1]);
    const msgs = (c.directMessages[k] || []).map(m => ({ ...m, from: m.from === oldU ? newU : m.from, to: m.to === oldU ? newU : m.to }));
    delete c.directMessages[k];
    c.directMessages[newKey] = msgs;
  });
  if (c.blocks[oldU]) { c.blocks[newU] = c.blocks[oldU]; delete c.blocks[oldU]; }
  Object.keys(c.blocks).forEach(k => {
    c.blocks[k] = (c.blocks[k] || []).map(b => b === oldU ? newU : b);
  });
  c.reports.forEach(r => { if (r.reportedUsername === oldU) r.reportedUsername = newU; if (r.byUsername === oldU) r.byUsername = newU; });
  c.communityStories.forEach(s => { if (s.username === oldU) s.username = newU; });
  c.groups.forEach(g => {
    if (Array.isArray(g.members)) g.members = g.members.map(m => m === oldU ? newU : m);
    if (g.owner === oldU) g.owner = newU;
  });
  Object.values(c.groupMessages || {}).forEach(arr => {
    (arr || []).forEach(m => { if (m.from === oldU) m.from = newU; });
  });
  state.stories.forEach(s => { if (s.username === oldU) s.username = newU; if (s.user === oldU) s.user = newU; });
  logAudit(oldU, 'username-changed-self', newU, null);
}

loadState();

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'BookMania_socketio_live.html')));

io.on('connection', socket => {
  // ---- Email one-time-code auth ----
  socket.on('auth:request-code', async data => {
    const email = safeText(data?.email, 100).toLowerCase().trim();
    if (!isValidEmail(email)) { socket.emit('auth:code-error', { message: 'Enter a valid email address.' }); return; }
    const now = Date.now();
    const existing = state.otps[email];
    if (existing && existing.lastSentAt && now - existing.lastSentAt < 45000) {
      socket.emit('auth:code-error', { message: 'Please wait before requesting another code.', cooldown: Math.ceil((45000 - (now - existing.lastSentAt)) / 1000) });
      return;
    }
    if (email === OWNER_EMAIL) {
      socket.emit('auth:code-sent', { email, devMode: false, expiresInSeconds: 1200, owner: true });
      return;
    }
    const code = genCode();
    state.otps[email] = { code, expiresAt: now + 20 * 60 * 1000, attempts: 0, lastSentAt: now };
    const result = await sendOtpEmail(email, code);
    socket.emit('auth:code-sent', { email, devMode: !!result.devMode, devCode: result.devMode ? code : undefined, expiresInSeconds: 1200 });
  });

  socket.on('auth:verify-code', data => {
    const email = safeText(data?.email, 100).toLowerCase().trim();
    const code = safeText(data?.code, 10).trim();
    if (!isValidEmail(email) || !code) { socket.emit('auth:code-error', { message: 'Missing email or code.' }); return; }
    if (email === OWNER_EMAIL) {
      if (code !== OWNER_PASSWORD) { socket.emit('auth:code-error', { message: 'Incorrect code.' }); return; }
      state.verifiedEmails[email] = Date.now() + 15 * 60 * 1000;
      const existingUsername = state.emailIndex[email] || OWNER_USERNAME;
      if (!state.profiles[OWNER_USERNAME]) saveProfile({ username: OWNER_USERNAME, displayName: OWNER_USERNAME, email, owner: true, verified: true });
      state.emailIndex[email] = OWNER_USERNAME;
      socket.emit('auth:verified', { email, existingUsername, profile: state.profiles[existingUsername] || null, owner: true });
      return;
    }
    const rec = state.otps[email];
    if (!rec) { socket.emit('auth:code-error', { message: 'Request a new code first.' }); return; }
    if (Date.now() > rec.expiresAt) { delete state.otps[email]; socket.emit('auth:code-error', { message: 'That code expired. Request a new one.' }); return; }
    rec.attempts = (rec.attempts || 0) + 1;
    if (rec.attempts > 6) { delete state.otps[email]; socket.emit('auth:code-error', { message: 'Too many attempts. Request a new code.' }); return; }
    if (rec.code !== code) { socket.emit('auth:code-error', { message: 'Incorrect code.', attemptsLeft: Math.max(0, 6 - rec.attempts) }); return; }
    delete state.otps[email];
    state.verifiedEmails[email] = Date.now() + 15 * 60 * 1000;
    const existingUsername = state.emailIndex[email] || null;
    socket.emit('auth:verified', { email, existingUsername, profile: existingUsername ? state.profiles[existingUsername] : null });
  });

  // Client sends the decoded Google ID-token payload (email, name, picture). Google already
  // verified the email address, so we treat it as pre-verified and skip the OTP step.
  socket.on('auth:google', data => {
    const email = safeText(data?.email, 100).toLowerCase().trim();
    if (!isValidEmail(email)) { socket.emit('auth:code-error', { message: 'That Google account has no usable email.' }); return; }
    state.verifiedEmails[email] = Date.now() + 15 * 60 * 1000;
    const existingUsername = state.emailIndex[email] || null;
    socket.emit('auth:verified', {
      email, existingUsername, profile: existingUsername ? state.profiles[existingUsername] : null,
      google: true, suggestedName: safeText(data?.name, 80), suggestedAvatar: data?.picture ? String(data.picture).slice(0, 500) : null
    });
  });

  socket.on('auth:finish-signup', data => {
    const email = safeText(data?.email, 100).toLowerCase().trim();
    const exp = state.verifiedEmails[email];
    if (!exp || Date.now() > exp) { socket.emit('auth:code-error', { message: 'Please verify your email again.' }); return; }
    const username = safeText(data?.username, 30).replace(/[^a-zA-Z0-9_]/g, '');
    if (!username || username.length < 3) { socket.emit('auth:code-error', { message: 'Username must be at least 3 characters (letters, numbers, underscore).' }); return; }
    if (state.profiles[username] && state.emailIndex[email] !== username) { socket.emit('auth:code-error', { message: 'That username is taken.' }); return; }
    const displayName = safeText(data?.displayName, 60) || username;
    const avatarUrl = data?.avatarUrl ? String(data.avatarUrl).slice(0, 400000) : '';
    saveProfile({ username, displayName, email, avatarUrl });
    state.emailIndex[email] = username;
    delete state.verifiedEmails[email];
    saveState(); emitUsers();
    socket.emit('auth:signup-complete', { profile: state.profiles[username] });
  });

  socket.on('auth:change-username', data => {
    const email = safeText(data?.email, 100).toLowerCase().trim();
    const oldUsername = safeText(data?.oldUsername, 60);
    const newUsername = safeText(data?.newUsername, 30).replace(/[^a-zA-Z0-9_]/g, '');
    if (!email || !oldUsername || !newUsername) { socket.emit('auth:code-error', { message: 'Missing information.' }); return; }
    if (state.emailIndex[email] !== oldUsername) { socket.emit('auth:code-error', { message: 'Account mismatch — please sign in again.' }); return; }
    if (oldUsername === OWNER_USERNAME) { socket.emit('auth:code-error', { message: 'The owner username cannot be changed.' }); return; }
    if (newUsername.length < 3) { socket.emit('auth:code-error', { message: 'Username must be at least 3 characters.' }); return; }
    if (newUsername === oldUsername) { socket.emit('auth:code-error', { message: 'That is already your username.' }); return; }
    if (state.profiles[newUsername]) { socket.emit('auth:code-error', { message: 'That username is taken.' }); return; }
    renameUsernameEverywhere(oldUsername, newUsername);
    state.emailIndex[email] = newUsername;
    const u = liveUsers.get(socket.id);
    if (u && u.username === oldUsername) { u.username = newUsername; liveUsers.set(socket.id, u); }
    saveState(); emitUsers(); emitCommunityState(io);
    socket.emit('auth:username-changed', { profile: state.profiles[newUsername] });
  });

  socket.on('user:hello', user => {
    const normalized = profileFromUser(user, socket.id);
    liveUsers.set(socket.id, normalized);
    saveProfile(normalized);
    saveState();
    socket.emit('state:init', { ...state, users: publicUsers() });
    if (isBanned(normalized.username, normalized.owner)) socket.emit('admin:banned', banInfo(normalized.username));
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
    if (isBanned(user.username, user.owner)) return socket.emit('admin:banned', banInfo(user.username));
    const clean = cleanStory(story, user, false);
    if (!storyExists(clean.id)) state.stories.unshift(clean);
    saveState();
    io.emit('story:new', clean);
  });

  socket.on('story:restore', story => {
    const user = liveUsers.get(socket.id) || profileFromUser(story?.user, socket.id);
    if (isBanned(user.username, user.owner)) return socket.emit('admin:banned', banInfo(user.username));
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
    if (isBanned(user.username, user.owner)) return socket.emit('admin:banned', banInfo(user.username));
    if (isMuted(user.username, user.owner)) return socket.emit('moderation:muted', muteInfo(user.username));
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
    const mod = moderateMessage(user.username, user.owner, comment.text);
    state.comments[storyId] = state.comments[storyId] || [];
    state.comments[storyId].push(comment);
    const s = state.stories.find(x => String(x.id) === storyId);
    if (s) s.comments = state.comments[storyId].length;
    saveState();
    io.emit('comment:new', { storyId: data?.storyId, comments: state.comments[storyId] });
    if (mod.action === 'warned') socket.emit('moderation:warning', { hits: mod.hits });
    if (mod.action === 'banned') { emitUsers(); socket.emit('admin:banned', banInfo(user.username)); }
  });

  socket.on('admin:get-users', admin => { if (isAdmin(admin)) socket.emit('admin:users', { users: publicUsers(), bannedUsers: Object.keys(state.bans), mutedUsers: Object.keys(state.mutes) }); });
  socket.on('admin:get-reports', admin => { if (isAdmin(admin)) socket.emit('admin:report', { reports: state.community.reports }); });
  socket.on('admin:get-audit', admin => { if (isAdmin(admin)) socket.emit('admin:audit', { log: (state.auditLog || []).slice(0, 200) }); });
  socket.on('admin:get-stats', admin => {
    if (!isAdmin(admin)) return;
    socket.emit('admin:stats', {
      totalUsers: Object.keys(state.profiles).length,
      liveUsers: liveUsers.size,
      banned: Object.keys(state.bans).length,
      muted: Object.keys(state.mutes).length,
      stories: state.stories.length,
      reports: state.community.reports.length,
      groups: state.community.groups.length,
      friendships: Object.keys(state.community.friendships).length
    });
  });
  socket.on('admin:global', data => {
    if (!isAdmin(data?.admin)) return;
    state.globalMessage = safeText(data?.message || '', 220);
    saveState(); io.emit('admin:global', state.globalMessage);
    logAudit(data.admin?.username, 'global-message', null, state.globalMessage);
  });
  socket.on('admin:global-clear', admin => {
    if (!isAdmin(admin)) return;
    state.globalMessage = ''; saveState(); io.emit('admin:global-clear');
    logAudit(admin?.username, 'global-message-clear', null, null);
  });
  socket.on('admin:restart', admin => { if (isAdmin(admin)) { io.emit('admin:restart'); logAudit(admin?.username, 'restart-broadcast', null, null); } });
  socket.on('admin:ban', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    if (!username || username === OWNER_USERNAME) return;
    const reason = safeText(data?.reason || 'Violation of community guidelines', 300);
    const permanent = !!data?.permanent;
    const days = permanent ? null : Math.max(1, Number(data?.days) || 7);
    const until = days ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
    state.bans[username] = { reason, until, bannedAt: Date.now(), by: data.admin.username || OWNER_USERNAME };
    saveState(); emitUsers();
    logAudit(data.admin.username, 'ban', username, reason);
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:banned', state.bans[username]);
  });
  socket.on('admin:unban', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    delete state.bans[username];
    saveState(); emitUsers();
    logAudit(data.admin?.username, 'unban', username, null);
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:unbanned');
  });
  socket.on('admin:unban-all', data => {
    if (!isAdmin(data?.admin)) return;
    const usernames = Object.keys(state.bans);
    state.bans = {};
    saveState(); emitUsers();
    logAudit(data.admin?.username, 'unban-all', null, usernames.length + ' user(s)');
    for (const [sid, u] of liveUsers.entries()) if (usernames.includes(u.username)) io.to(sid).emit('admin:unbanned');
    socket.emit('admin:unban-all-done', { count: usernames.length });
  });
  socket.on('admin:verify', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    setVerified(username, true);
    saveState(); emitUsers();
    logAudit(data.admin?.username, 'verify', username, null);
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:verify-update', { verified: true });
  });
  socket.on('admin:unverify', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    setVerified(username, false);
    saveState(); emitUsers();
    logAudit(data.admin?.username, 'unverify', username, null);
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('admin:verify-update', { verified: false });
  });

  socket.on('group:create', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    if (isBanned(me.username, me.owner)) return socket.emit('admin:banned', banInfo(me.username));
    const name = safeText(data?.name || 'New Group', 60);
    let members = Array.isArray(data?.members) ? data.members.map(m => safeText(m, 60)).filter(Boolean) : [];
    members = Array.from(new Set([me.username, ...members]));
    const friends = state.community.friendships[me.username] || [];
    members = members.filter(m => m === me.username || friends.includes(m));
    if (members.length < 3) return socket.emit('group:error', 'Pick at least 2 friends to start a group (3 people total).');
    const group = { id: 'g' + Date.now(), name, members, createdBy: me.username, time: Date.now() };
    state.community.groups.push(group);
    state.community.groupMessages[group.id] = [];
    saveState(); emitCommunityState();
    members.forEach(m => { for (const [sid, u] of liveUsers.entries()) if (u.username === m) io.to(sid).emit('group:created', group); });
  });

  socket.on('group:message', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    if (isBanned(me.username, me.owner)) return socket.emit('admin:banned', banInfo(me.username));
    if (isMuted(me.username, me.owner)) return socket.emit('moderation:muted', muteInfo(me.username));
    const groupId = safeText(data?.groupId, 60);
    const text = safeText(data?.text, 1200);
    const group = state.community.groups.find(g => g.id === groupId);
    if (!group || !group.members.includes(me.username) || !text) return;
    const mod = moderateMessage(me.username, me.owner, text);
    const msg = { from: me.username, fromDisplay: me.displayName, text, time: Date.now() };
    state.community.groupMessages[groupId] = state.community.groupMessages[groupId] || [];
    state.community.groupMessages[groupId].push(msg);
    state.community.groupMessages[groupId] = state.community.groupMessages[groupId].slice(-250);
    saveState(); emitCommunityState();
    group.members.forEach(m => { for (const [sid, u] of liveUsers.entries()) if (u.username === m) io.to(sid).emit('group:message', { groupId, msg }); });
    if (mod.action === 'warned') socket.emit('moderation:warning', { hits: mod.hits });
    if (mod.action === 'banned') { emitUsers(); socket.emit('admin:banned', banInfo(me.username)); }
  });

  socket.on('group:leave', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const groupId = safeText(data?.groupId, 60);
    const group = state.community.groups.find(g => g.id === groupId);
    if (!group) return;
    group.members = group.members.filter(m => m !== me.username);
    if (group.members.length < 2) { state.community.groups = state.community.groups.filter(g => g.id !== groupId); delete state.community.groupMessages[groupId]; }
    saveState(); emitCommunityState();
  });

  socket.on('admin:mute', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    if (!username || username === OWNER_USERNAME) return;
    const minutes = Math.max(1, Number(data?.minutes) || 10);
    state.mutes[username] = { until: Date.now() + minutes * 60000, by: data.admin.username || OWNER_USERNAME };
    saveState(); emitUsers();
    logAudit(data.admin.username, 'mute', username, minutes + ' min');
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('moderation:muted', state.mutes[username]);
  });
  socket.on('admin:unmute', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    delete state.mutes[username];
    saveState(); emitUsers();
    logAudit(data.admin?.username, 'unmute', username, null);
    for (const [sid, u] of liveUsers.entries()) if (u.username === username) io.to(sid).emit('moderation:unmuted');
  });
  socket.on('admin:kick', data => {
    if (!isAdmin(data?.admin)) return;
    const username = safeText(data?.username, 60);
    if (!username || username === OWNER_USERNAME) return;
    logAudit(data.admin.username, 'kick', username, null);
    for (const [sid, u] of liveUsers.entries()) {
      if (u.username === username) {
        io.to(sid).emit('admin:kicked');
        const s = io.sockets.sockets.get(sid);
        if (s) s.disconnect(true);
      }
    }
  });

  socket.on('typing', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const to = safeText(data?.toUsername, 60);
    const groupId = safeText(data?.groupId, 60);
    if (groupId) {
      const group = state.community.groups.find(g => g.id === groupId);
      if (!group || !group.members.includes(me.username)) return;
      group.members.forEach(m => { if (m !== me.username) for (const [sid, u] of liveUsers.entries()) if (u.username === m) io.to(sid).emit('typing', { groupId, from: me.username, fromDisplay: me.displayName }); });
    } else if (to) {
      for (const [sid, u] of liveUsers.entries()) if (u.username === to) io.to(sid).emit('typing', { from: me.username, fromDisplay: me.displayName });
    }
  });

  socket.on('dm:read', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    const peer = safeText(data?.peer, 60);
    if (!peer) return;
    const key = dmKey(me.username, peer);
    const list = state.community.directMessages[key];
    if (!list || !list.length) return;
    let changed = false;
    list.forEach(m => { if (m.to === me.username && !m.seen) { m.seen = true; changed = true; } });
    if (changed) {
      saveState(); emitCommunityState();
      for (const [sid, u] of liveUsers.entries()) if (u.username === peer) io.to(sid).emit('dm:seen', { peer: me.username });
    }
  });

  socket.on('community:react', data => {
    const me = liveUsers.get(socket.id) || profileFromUser(data?.user, socket.id);
    if (isBanned(me.username, me.owner)) return;
    const storyId = safeText(data?.storyId, 60);
    const emoji = safeText(data?.emoji, 8);
    if (!['❤️','😂','👍','🔥','😮'].includes(emoji)) return;
    const story = state.community.communityStories.find(s => String(s.id) === storyId);
    if (!story) return;
    story.reactions = story.reactions || {};
    story.reactions[emoji] = story.reactions[emoji] || [];
    const idx = story.reactions[emoji].indexOf(me.username);
    if (idx === -1) story.reactions[emoji].push(me.username); else story.reactions[emoji].splice(idx, 1);
    saveState(); emitCommunityState();
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
    if (isBanned(me.username, me.owner)) return socket.emit('admin:banned', banInfo(me.username));
    if (isMuted(me.username, me.owner)) return socket.emit('moderation:muted', muteInfo(me.username));
    const to = safeText(data?.toUsername, 60);
    const text = safeText(data?.text, 1200);
    if (!to || !text) return;
    if (!((state.community.friendships[me.username] || []).includes(to))) return;
    const mod = moderateMessage(me.username, me.owner, text);
    const key = dmKey(me.username, to);
    state.community.directMessages[key] = state.community.directMessages[key] || [];
    state.community.directMessages[key].push({ from: me.username, to, fromDisplay: me.displayName, text, time: Date.now(), seen: false });
    state.community.directMessages[key] = state.community.directMessages[key].slice(-250);
    saveState(); emitCommunityState(); io.emit('dm:new', { community: state.community, from: me.username, fromDisplay: me.displayName, to });
    if (mod.action === 'warned') socket.emit('moderation:warning', { hits: mod.hits });
    if (mod.action === 'banned') { emitUsers(); socket.emit('admin:banned', banInfo(me.username)); }
  });

  socket.on('community:story:new', data => {
    const sent = profileFromUser(data?.user, socket.id);
    const live = liveUsers.get(socket.id);
    const me = (sent.owner || sent.verified || sent.username === OWNER_USERNAME) ? sent : (live || sent);
    if (isBanned(me.username, me.owner)) return socket.emit('admin:banned', banInfo(me.username));
    if (isMuted(me.username, me.owner)) return socket.emit('moderation:muted', muteInfo(me.username));
    const owner = !!me.owner || me.username === OWNER_USERNAME || me.displayName === OWNER_USERNAME || !!data?.owner;
    const verified = owner || !!me.verified || !!data?.verified;
    const story = {
      id: Date.now(),
      username: owner ? OWNER_USERNAME : me.username,
      displayName: owner ? OWNER_USERNAME : me.displayName,
      initials: owner ? 'BM' : me.initials,
      avatarUrl: me.avatarUrl,
      verified,
      owner,
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

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [uname, b] of Object.entries(state.bans)) {
    if (b.until && now > b.until) {
      delete state.bans[uname];
      changed = true;
      for (const [sid, u] of liveUsers.entries()) if (u.username === uname) io.to(sid).emit('admin:unbanned');
    }
  }
  for (const [uname, m] of Object.entries(state.mutes)) {
    if (now > m.until) { delete state.mutes[uname]; changed = true; }
  }
  if (changed) { saveState(); emitUsers(); }
}, 30000);
