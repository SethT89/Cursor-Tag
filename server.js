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

// ─── Leaderboard persistence ────────────────────────────────────────────────
function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function saveLeaderboard(entries) {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.error('Failed to save leaderboard:', e.message);
  }
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
      board.push({
        name: p.name,
        gamesPlayed: 1,
        totalScore: p.score,
        bestScore: p.score,
        wins: p.rank === 1 ? 1 : 0,
      });
    }
  });
  board.sort((a, b) => b.bestScore - a.bestScore);
  saveLeaderboard(board.slice(0, 100));
}

// ─── Room & player state ─────────────────────────────────────────────────────
const rooms = new Map();
const clientToRoom = new Map();
const clientToPlayer = new Map();

function createRoom(hostWs, hostName) {
  const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  const playerId = uuidv4();
  const player = {
    id: playerId,
    name: hostName,
    color: PLAYER_COLORS[0],
    x: 50, y: 50,
    isIt: false,
    immune: false,
    immuneUntil: 0,
    ws: hostWs,
    timeNotIt: 0,
    tagsMade: 0,
    fastestTag: null,
    becameItAt: null,
    wasEverIt: false,
  };
  const room = {
    code: roomCode,
    state: 'waiting',
    players: new Map([[playerId, player]]),
    itPlayerId: null,
    gameStartTime: null,
    gameTimer: null,
    stateInterval: null,
    lastTickTime: null,
  };
  rooms.set(roomCode, room);
  clientToRoom.set(hostWs, roomCode);
  clientToPlayer.set(hostWs, playerId);
  return { roomCode, playerId, player };
}

function joinRoom(ws, roomCode, playerName) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'Room not found' };
  if (room.state !== 'waiting') return { error: 'Game already in progress' };
  if (room.players.size >= 8) return { error: 'Room is full' };

  const playerId = uuidv4();
  const colorIndex = room.players.size % PLAYER_COLORS.length;
  const player = {
    id: playerId,
    name: playerName,
    color: PLAYER_COLORS[colorIndex],
    x: 20 + Math.random() * 60,
    y: 20 + Math.random() * 60,
    isIt: false,
    immune: false,
    immuneUntil: 0,
    ws,
    timeNotIt: 0,
    tagsMade: 0,
    fastestTag: null,
    becameItAt: null,
    wasEverIt: false,
  };
  room.players.set(playerId, player);
  clientToRoom.set(ws, roomCode);
  clientToPlayer.set(ws, playerId);
  return { playerId, player };
}

function serializePlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    x: p.x,
    y: p.y,
    isIt: p.isIt,
    immune: p.immune,
    wasEverIt: p.wasEverIt,
    timeNotIt: p.timeNotIt,
    tagsMade: p.tagsMade,
    fastestTag: p.fastestTag,
  };
}

function broadcastToRoom(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  });
}

function getPlayers(room) {
  return Array.from(room.players.values()).map(p => serializePlayer(p));
}

// ─── Game logic ──────────────────────────────────────────────────────────────
function startCountdown(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.players.size < 2) return;
  room.state = 'countdown';
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
  });

  const itPlayer = room.players.get(room.itPlayerId);
  if (itPlayer && !itPlayer.immune) {
    for (const p of playerList) {
      if (p.id === itPlayer.id || p.immune) continue;
      const dx = itPlayer.x - p.x;
      const dy = itPlayer.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < TAG_DISTANCE_PCT) {
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
  });
}

function performTag(room, tagger, target, now) {
  if (tagger.becameItAt) {
    const elapsed = now - tagger.becameItAt;
    if (tagger.fastestTag === null || elapsed < tagger.fastestTag) {
      tagger.fastestTag = elapsed;
    }
    tagger.tagsMade++;
  }

  tagger.isIt = false;
  tagger.immune = true;
  tagger.immuneUntil = now + TAG_IMMUNITY_MS;

  target.isIt = true;
  target.wasEverIt = true;
  target.becameItAt = now;
  room.itPlayerId = target.id;

  broadcastToRoom(room, {
    type: 'tagged',
    newItId: target.id,
    taggerId: tagger.id,
  });
}

function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  clearInterval(room.stateInterval);
  clearTimeout(room.gameTimer);
  room.state = 'ended';

  const playerList = Array.from(room.players.values());
  const totalTime = GAME_DURATION_MS;

  const scoredPlayers = playerList.map(p => {
    let score = 0;
    const notItPct = p.timeNotIt / totalTime;
    score += Math.round(notItPct * 1000);
    if (!p.wasEverIt) score += 500;
    if (p.fastestTag !== null) {
      score += Math.max(0, 300 - Math.round(p.fastestTag / 100));
    }
    if (p.id === room.itPlayerId) score = Math.max(0, score - 200);

    return {
      ...serializePlayer(p),
      score,
      isLoser: p.id === room.itPlayerId,
      stats: {
        timeNotIt: Math.round(p.timeNotIt / 1000),
        tagsMade: p.tagsMade,
        fastestTag: p.fastestTag ? Math.round(p.fastestTag / 1000 * 10) / 10 : null,
        survivedUntagged: !p.wasEverIt,
        itAtEnd: p.id === room.itPlayerId,
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

// ─── HTTP + WebSocket server ─────────────────────────────────────────────────
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
          type: 'roomCreated',
          roomCode: rc,
          playerId: pid,
          players: [serializePlayer(p)],
          color: p.color,
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
          type: 'roomJoined',
          roomCode: msg.roomCode.toUpperCase(),
          playerId: result.playerId,
          players: getPlayers(r),
          color: result.player.color,
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
  // Reset room back to waiting
  room.state = 'waiting';
  room.itPlayerId = null;
  room.players.forEach(p => {
    p.isIt = false;
    p.immune = false;
    p.immuneUntil = 0;
    p.timeNotIt = 0;
    p.tagsMade = 0;
    p.fastestTag = null;
    p.becameItAt = null;
    p.wasEverIt = false;
    p.x = 20 + Math.random() * 60;
    p.y = 20 + Math.random() * 60;
  });
  broadcastToRoom(room, {
    type: 'playAgain',
    players: getPlayers(room),
  });
  break;
}
      case 'move': {
        if (!player || !room || room.state !== 'playing') return;
        player.x = Math.max(0, Math.min(100, msg.x));
        player.y = Math.max(0, Math.min(100, msg.y));
        break;
      }

      case 'getLeaderboard': {
        ws.send(JSON.stringify({
          type: 'leaderboard',
          leaderboard: loadLeaderboard().slice(0, 10),
        }));
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
