const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const TAG_DISTANCE_PCT = 5;
const GAME_DURATION_MS = 60000;
const COUNTDOWN_SECONDS = 3;
const TAG_IMMUNITY_MS = 3000;
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');

const PLAYER_COLORS = [
  '#FF4B6E', '#4BFFA5', '#4B9FFF', '#FFB74B',
  '#C84BFF', '#FF4BC8', '#4BFFE4', '#FFE44B',
];

// ─── Leaderboard ─────────────────────────────────────────────────────────────
function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE))
      return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveLeaderboard(entries) {
  try { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(entries, null, 2)); } catch {}
}

function updateLeaderboard(players) {
  const board = loadLeaderboard();
  players.forEach(p => {
    const existing = board.find(e => e.name.toLowerCase() === p.name.toLowerCase());
    if (existing) {
      existing.gamesPlayed = (existing.gamesPlayed || 0) + 1;
      existing.totalScore = (existing.totalScore || 0) + p.score;
      existing.bestScore = Math.max(existing.bestScore || 0, p.score);
      existing.wins = (existing.wins || 0) + (p.rank === 1 ? 1 : 0);
    } else {
      board.push({ name: p.name, gamesPlayed: 1, totalScore: p.score, bestScore: p.score, wins: p.rank === 1 ? 1 : 0 });
    }
  });
  board.sort((a, b) => b.bestScore - a.bestScore);
  saveLeaderboard(board.slice(0, 100));
}

// ─── Room & player state ──────────────────────────────────────────────────────
const rooms = new Map();
const clientToRoom = new Map();
const clientToPlayer = new Map();

function createRoom(hostWs, hostName) {
  const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  const playerId = uuidv4();
  const player = makePlayer(playerId, hostName, PLAYER_COLORS[0], hostWs);
  const room = {
    code: roomCode,
    state: 'waiting',
    players: new Map([[playerId, player]]),
    itPlayerId: null,
    gameStartTime: null,
    gameTimer: null,
    stateInterval: null,
    lastTickTime: null,
    firstTaggedId: null,
  };
  rooms.set(roomCode, room);
  clientToRoom.set(hostWs, roomCode);
  clientToPlayer.set(hostWs, playerId);
  return { roomCode, playerId, player };
}

function makePlayer(id, name, color, ws) {
  return {
    id, name, color, ws,
    x: 20 + Math.random() * 60,
    y: 20 + Math.random() * 60,
    prevX: 50, prevY: 50,
    isIt: false,
    immune: false,
    immuneUntil: 0,
    // scoring stats
    timeNotIt: 0,
    tagsMade: 0,
    fastestTag: null,
    becameItAt: null,
    wasEverIt: false,
    timesTagged: 0,
    lastTaggerId: null,
    retags: 0,
    totalDistance: 0,
    cornerTime: 0,
    edgeTime: 0,
    itStreaks: [],        // array of ms durations for each IT stint
    currentItStart: null,
    opportunistTags: 0,
    lastMoveTime: null,
    trackingActive: false, // starts at countdown
  };
}

function joinRoom(ws, roomCode, playerName) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'Room not found' };
  if (room.state !== 'waiting') return { error: 'Game already in progress' };
  if (room.players.size >= 8) return { error: 'Room is full' };

  const playerId = uuidv4();
  const colorIndex = room.players.size % PLAYER_COLORS.length;
  const player = makePlayer(playerId, playerName, PLAYER_COLORS[colorIndex], ws);
  room.players.set(playerId, player);
  clientToRoom.set(ws, roomCode);
  clientToPlayer.set(ws, playerId);
  return { playerId, player };
}

function serializePlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: p.x, y: p.y,
    isIt: p.isIt, immune: p.immune,
    wasEverIt: p.wasEverIt,
    timeNotIt: p.timeNotIt,
    tagsMade: p.tagsMade,
    fastestTag: p.fastestTag,
    timesTagged: p.timesTagged,
    retags: p.retags,
    totalDistance: p.totalDistance,
  };
}

function broadcastToRoom(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN)
      p.ws.send(data);
  });
}

function getPlayers(room) {
  return Array.from(room.players.values()).map(serializePlayer);
}

// ─── Live score calculation ───────────────────────────────────────────────────
function calcLiveScore(p, room) {
  // 10 pts per second not IT
  const notItScore = Math.floor(p.timeNotIt / 100); // 10pts per sec = 1pt per 100ms
  return notItScore;
}

function getLiveScores(room) {
  return Array.from(room.players.values())
    .map(p => ({ id: p.id, name: p.name, color: p.color, score: calcLiveScore(p, room), isIt: p.isIt }))
    .sort((a, b) => b.score - a.score);
}

// ─── Personality awards ───────────────────────────────────────────────────────
const AWARDS = {
  panicMouse:       { emoji: '🐁', title: 'Panic Mouse',          desc: 'Most frantic movement' },
  escapeArtist:     { emoji: '🐇', title: 'Escape Artist',        desc: 'Never got tagged' },
  cornerRat:        { emoji: '🐀', title: 'Corner Rat',           desc: 'Most time hiding in corners' },
  revengeSeeker:    { emoji: '🔄', title: 'Revenge Seeker',       desc: 'Most re-tags' },
  magnetToDanger:   { emoji: '🧲', title: 'Magnet to Danger',     desc: 'Got tagged the most' },
  anchoredToWalls:  { emoji: '🪨', title: 'Anchored to Walls',    desc: 'Most time near edges' },
  sacrificialLamb:  { emoji: '🐑', title: 'Sacrificial Lamb',     desc: 'First to get tagged' },
  opportunist:      { emoji: '👀', title: 'Opportunist',          desc: 'Tagged the most idle players' },
};

function assignAwards(playerList, room) {
  const assigned = new Set();

  const maxBy = (key) => {
    let best = null, bestVal = -1;
    playerList.forEach(p => {
      if (!assigned.has(p.id) && p[key] > bestVal) {
        bestVal = p[key];
        best = p;
      }
    });
    return bestVal > 0 ? best : null;
  };

  const awards = {};

  // Escape Artist — never IT (check first, binary)
  playerList.forEach(p => {
    if (!p.wasEverIt && !assigned.has(p.id)) {
      awards[p.id] = AWARDS.escapeArtist;
      assigned.add(p.id);
    }
  });

  // Sacrificial Lamb — first tagged
  if (room.firstTaggedId && !assigned.has(room.firstTaggedId)) {
    awards[room.firstTaggedId] = AWARDS.sacrificialLamb;
    assigned.add(room.firstTaggedId);
  }

  // Panic Mouse — most distance
  const pm = maxBy('totalDistance');
  if (pm) { awards[pm.id] = AWARDS.panicMouse; assigned.add(pm.id); }

  // Revenge Seeker — most retags
  const rs = maxBy('retags');
  if (rs) { awards[rs.id] = AWARDS.revengeSeeker; assigned.add(rs.id); }

  // Magnet to Danger — most times tagged
  const md = maxBy('timesTagged');
  if (md) { awards[md.id] = AWARDS.magnetToDanger; assigned.add(md.id); }

  // Corner Rat — most corner time
  const cr = maxBy('cornerTime');
  if (cr) { awards[cr.id] = AWARDS.cornerRat; assigned.add(cr.id); }

  // Opportunist — most opportunist tags
  const op = maxBy('opportunistTags');
  if (op) { awards[op.id] = AWARDS.opportunist; assigned.add(op.id); }

  // Anchored to Walls — most edge time (anyone remaining)
  const aw = maxBy('edgeTime');
  if (aw) { awards[aw.id] = AWARDS.anchoredToWalls; assigned.add(aw.id); }

  // Anyone without an award gets the most fitting remaining
  playerList.forEach(p => {
    if (!awards[p.id]) {
      awards[p.id] = AWARDS.panicMouse; // fallback
    }
  });

  return awards;
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function startCountdown(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.players.size < 2) return;
  room.state = 'countdown';

  // Start tracking from countdown
  room.players.forEach(p => { p.trackingActive = true; });

  broadcastToRoom(room, { type: 'countdown', count: COUNTDOWN_SECONDS });

  let count = COUNTDOWN_SECONDS;
  const interval = setInterval(() => {
    count--;
    if (count > 0) {
      broadcastToRoom(room, { type: 'countdown', count });
    } else {
      clearInterval(interval);
      startGame(roomCode);
    }
  }, 1000);
}

function startGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const playerList = Array.from(room.players.values());
  const itPlayer = playerList[Math.floor(Math.random() * playerList.length)];
  itPlayer.isIt = true;
  itPlayer.wasEverIt = true;
  itPlayer.becameItAt = Date.now();
  itPlayer.currentItStart = Date.now();
  room.itPlayerId = itPlayer.id;
  room.state = 'playing';
  room.gameStartTime = Date.now();
  room.lastTickTime = Date.now();

  broadcastToRoom(room, {
    type: 'gameStarted',
    players: getPlayers(room),
    itPlayerId: itPlayer.id,
    duration: GAME_DURATION_MS,
  });

  room.stateInterval = setInterval(() => gameTick(roomCode), 100);
  room.gameTimer = setTimeout(() => endGame(roomCode), GAME_DURATION_MS);
}

function gameTick(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.state !== 'playing') return;

  const now = Date.now();
  const dt = now - room.lastTickTime;
  room.lastTickTime = now;
  const timeLeft = Math.max(0, GAME_DURATION_MS - (now - room.gameStartTime));

  const playerList = Array.from(room.players.values());

  playerList.forEach(p => {
    if (!p.isIt) p.timeNotIt += dt;
    if (p.immune && now >= p.immuneUntil) p.immune = false;

    // Track movement distance
    if (p.trackingActive) {
      const dx = p.x - p.prevX;
      const dy = p.y - p.prevY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      p.totalDistance += dist;
      p.prevX = p.x;
      p.prevY = p.y;

      // Corner time: within 10% of any corner
      const inCorner = (p.x < 10 || p.x > 90) && (p.y < 10 || p.y > 90);
      if (inCorner) p.cornerTime += dt;

      // Edge time: within 8% of any wall
      const onEdge = p.x < 8 || p.x > 92 || p.y < 8 || p.y > 92;
      if (onEdge) p.edgeTime += dt;
    }
  });

  // Tag collision check
  const itPlayer = room.players.get(room.itPlayerId);
  if (itPlayer && !itPlayer.immune) {
    for (const p of playerList) {
      if (p.id === itPlayer.id || p.immune) continue;
      const dx = itPlayer.x - p.x;
      const dy = itPlayer.y - p.y;
      if (Math.sqrt(dx * dx + dy * dy) < TAG_DISTANCE_PCT) {
        performTag(room, itPlayer, p, now);
        break;
      }
    }
  }

  broadcastToRoom(room, {
    type: 'gameState',
    players: getPlayers(room),
    itPlayerId: room.itPlayerId,
    timeLeft,
    liveScores: getLiveScores(room),
  });
}

function performTag(room, tagger, target, now) {
  // Fastest tag stat
  if (tagger.becameItAt) {
    const elapsed = now - tagger.becameItAt;
    if (tagger.fastestTag === null || elapsed < tagger.fastestTag)
      tagger.fastestTag = elapsed;
    tagger.tagsMade++;

    // IT streak
    if (tagger.currentItStart) {
      tagger.itStreaks.push(now - tagger.currentItStart);
      tagger.currentItStart = null;
    }
  }

  // Opportunist: target hasn't moved much recently
  const idleThreshold = 0.5;
  const tdx = target.x - target.prevX;
  const tdy = target.y - target.prevY;
  if (Math.sqrt(tdx * tdx + tdy * tdy) < idleThreshold) {
    tagger.opportunistTags++;
  }

  // Revengetag: tagger is tagging back the person who last tagged them
  if (tagger.lastTaggerId === target.id) {
    tagger.retags++;
  }

  // First tagged
  if (!room.firstTaggedId) {
    room.firstTaggedId = target.id;
  }

  // Transfer IT
  tagger.isIt = false;
  tagger.immune = true;
  tagger.immuneUntil = now + TAG_IMMUNITY_MS;

  target.isIt = true;
  target.wasEverIt = true;
  target.becameItAt = now;
  target.currentItStart = now;
  target.timesTagged++;
  target.lastTaggerId = tagger.id;
  room.itPlayerId = target.id;

  broadcastToRoom(room, { type: 'tagged', newItId: target.id, taggerId: tagger.id });
}

function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  clearInterval(room.stateInterval);
  clearTimeout(room.gameTimer);
  room.state = 'ended';

  const playerList = Array.from(room.players.values());
  const now = Date.now();

  // Close any open IT streak
  playerList.forEach(p => {
    if (p.isIt && p.currentItStart) {
      p.itStreaks.push(now - p.currentItStart);
    }
  });

  // Bonus calculations
  const maxDistance = Math.max(...playerList.map(p => p.totalDistance));
  const maxRetags = Math.max(...playerList.map(p => p.retags));
  const minItStreak = Math.min(...playerList.filter(p => p.itStreaks.length > 0).map(p => Math.min(...p.itStreaks)));

  // Personality awards
  const awards = assignAwards(playerList, room);

  const scoredPlayers = playerList.map(p => {
    let score = 0;

    // 10 pts per second not IT (600 max)
    score += Math.floor(p.timeNotIt / 100);

    // Bonus: never IT = +10
    if (!p.wasEverIt) score += 10;

    // Bonus: shortest IT streak = +10 (only one player gets this)
    if (p.itStreaks.length > 0 && Math.min(...p.itStreaks) === minItStreak) score += 10;

    // Bonus: most retags = +10
    if (p.retags > 0 && p.retags === maxRetags) score += 10;

    // Bonus: most frantic = +10
    if (p.totalDistance > 0 && p.totalDistance === maxDistance) score += 10;

    // Penalty: IT at end
    if (p.id === room.itPlayerId) score = Math.max(0, score - 20);

    return {
      ...serializePlayer(p),
      score,
      isLoser: p.id === room.itPlayerId,
      award: awards[p.id] || null,
      stats: {
        timeNotIt: Math.round(p.timeNotIt / 1000),
        tagsMade: p.tagsMade,
        fastestTag: p.fastestTag ? Math.round(p.fastestTag / 1000 * 10) / 10 : null,
        survivedUntagged: !p.wasEverIt,
        itAtEnd: p.id === room.itPlayerId,
        timesTagged: p.timesTagged,
        retags: p.retags,
        totalDistance: Math.round(p.totalDistance),
        opportunistTags: p.opportunistTags,
        shortestItStreak: p.itStreaks.length > 0 ? Math.round(Math.min(...p.itStreaks) / 100) / 10 : null,
      },
    };
  });

  scoredPlayers.sort((a, b) => b.score - a.score);
  scoredPlayers.forEach((p, i) => { p.rank = i + 1; });

  updateLeaderboard(scoredPlayers);
  const leaderboard = loadLeaderboard().slice(0, 10);

  broadcastToRoom(room, { type: 'gameEnded', players: scoredPlayers, leaderboard });
  setTimeout(() => rooms.delete(roomCode), 30000);
}

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Cursor Tag server is running');
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
  console.log('Client connected');

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const roomCode = clientToRoom.get(ws);
    const playerId = clientToPlayer.get(ws);
    const room = roomCode ? rooms.get(roomCode) : null;
    const player = room && playerId ? room.players.get(playerId) : null;

    switch (msg.type) {
      case 'createRoom': {
        const { roomCode: rc, playerId: pid, player: p } = createRoom(ws, msg.name);
        ws.send(JSON.stringify({
          type: 'roomCreated', roomCode: rc, playerId: pid,
          players: [serializePlayer(p)], color: p.color,
          leaderboard: loadLeaderboard().slice(0, 10),
        }));
        break;
      }

      case 'joinRoom': {
        const result = joinRoom(ws, msg.roomCode.toUpperCase(), msg.name);
        if (result.error) {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
          return;
        }
        const r = rooms.get(msg.roomCode.toUpperCase());
        ws.send(JSON.stringify({
          type: 'roomJoined', roomCode: msg.roomCode.toUpperCase(),
          playerId: result.playerId, players: getPlayers(r), color: result.player.color,
        }));
        broadcastToRoom(r, { type: 'playerJoined', players: getPlayers(r) }, ws);
        break;
      }

      case 'startGame': {
        if (!room || (room.state !== 'waiting' && room.state !== 'ended')) return;
        const firstPlayer = Array.from(room.players.values())[0];
        if (firstPlayer.id !== playerId) return;
        if (room.players.size < 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Need at least 2 players to start' }));
          return;
        }
        startCountdown(roomCode);
        break;
      }

      case 'playAgain': {
        if (!room || room.state !== 'ended') return;
        room.state = 'waiting';
        room.itPlayerId = null;
        room.firstTaggedId = null;
        room.players.forEach(p => {
          Object.assign(p, {
            isIt: false, immune: false, immuneUntil: 0,
            timeNotIt: 0, tagsMade: 0, fastestTag: null,
            becameItAt: null, wasEverIt: false,
            timesTagged: 0, lastTaggerId: null, retags: 0,
            totalDistance: 0, cornerTime: 0, edgeTime: 0,
            itStreaks: [], currentItStart: null, opportunistTags: 0,
            trackingActive: false, lastMoveTime: null,
            x: 20 + Math.random() * 60, y: 20 + Math.random() * 60,
          });
        });
        broadcastToRoom(room, { type: 'playAgain', players: getPlayers(room) });
        break;
      }

      case 'move': {
        if (!player || !room || (room.state !== 'playing' && room.state !== 'countdown')) return;
        player.x = Math.max(0, Math.min(100, msg.x));
        player.y = Math.max(0, Math.min(100, msg.y));
        player.lastMoveTime = Date.now();
        break;
      }

      case 'getLeaderboard': {
        ws.send(JSON.stringify({ type: 'leaderboard', leaderboard: loadLeaderboard().slice(0, 10) }));
        break;
      }
    }
  });

  ws.on('close', () => {
    const roomCode = clientToRoom.get(ws);
    const playerId = clientToPlayer.get(ws);
    if (roomCode && playerId) {
      const room = rooms.get(roomCode);
      if (room) {
        room.players.delete(playerId);
        if (room.players.size === 0) {
          clearInterval(room.stateInterval);
          clearTimeout(room.gameTimer);
          rooms.delete(roomCode);
        } else {
          if (room.state === 'playing' && room.itPlayerId === playerId) {
            const remaining = Array.from(room.players.values());
            const newIt = remaining[Math.floor(Math.random() * remaining.length)];
            newIt.isIt = true;
            newIt.wasEverIt = true;
            newIt.becameItAt = Date.now();
            newIt.currentItStart = Date.now();
            room.itPlayerId = newIt.id;
          }
          broadcastToRoom(room, { type: 'playerLeft', players: getPlayers(room) });
        }
      }
    }
    clientToRoom.delete(ws);
    clientToPlayer.delete(ws);
    console.log('Client disconnected');
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Cursor Tag server running on port ${PORT}`);
});
