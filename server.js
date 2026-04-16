const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const TAG_DISTANCE_PCT = 8;
const ZOMBIE_TAG_DISTANCE_PCT = 4;
const GAME_DURATION_MS = 60000;
const ZOMBIE_GAME_DURATION_MS = 10 * 1000;
const ZOMBIE_TURNING_MS = 3000;
const COUNTDOWN_SECONDS = 3;
const TAG_IMMUNITY_MS = 3000;
const MAX_PLAYERS_CLASSIC = 12;
const MAX_PLAYERS_ZOMBIE = 12;
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
const ZOMBIE_SPEED_FACTOR = 0.7;
const TURNING_SPEED_FACTOR = 0.4;

const PLAYER_COLORS = [
  '#FF4B6E','#4BFFA5','#4B9FFF','#FFB74B',
  '#C84BFF','#FF4BC8','#4BFFE4','#FFE44B',
  '#FF8C4B','#B4FF4B','#FF4BFF','#4BFFB4',
];

const BOT_NAMES = [
  'Dizzy','Cheddar','Glitch','Turbo','Biscuit','Noodle','Zapper','Pudding',
  'Chaos','Wobble','Socks','Blip','Frenzy','Mochi','Zigzag','Crispy',
  'Doodle','Sparky','Pickle','Waffles','Bonkers','Fizz','Peanut','Rascal',
];

const DIFFICULTY = {
  easy:   { speed: 1.2,  accuracy: 0.4,  mistakeChance: 0.25, reactionTicks: 8 },
  medium: { speed: 2.5,  accuracy: 0.7,  mistakeChance: 0.12, reactionTicks: 4 },
  hard:   { speed: 6.5,  accuracy: 1.0,  mistakeChance: 0.01, reactionTicks: 1 },
};

// ─── Leaderboard ──────────────────────────────────────────────────────────────
function loadLeaderboard() {
  try { if (fs.existsSync(LEADERBOARD_FILE)) return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8')); } catch {}
  return [];
}
function saveLeaderboard(e) { try { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(e, null, 2)); } catch {} }
function updateLeaderboard(players) {
  const board = loadLeaderboard();
  players.filter(p => !p.isBot).forEach(p => {
    const ex = board.find(e => e.name.toLowerCase() === p.name.toLowerCase());
    if (ex) { ex.gamesPlayed=(ex.gamesPlayed||0)+1; ex.totalScore=(ex.totalScore||0)+p.score; ex.bestScore=Math.max(ex.bestScore||0,p.score); ex.wins=(ex.wins||0)+(p.rank===1?1:0); }
    else board.push({ name:p.name, gamesPlayed:1, totalScore:p.score, bestScore:p.score, wins:p.rank===1?1:0 });
  });
  board.sort((a,b) => b.bestScore-a.bestScore);
  saveLeaderboard(board.slice(0,100));
}

// ─── State ────────────────────────────────────────────────────────────────────
const rooms = new Map();
const clientToRoom = new Map();
const clientToPlayer = new Map();

function makePlayer(id, name, color, ws, isBot=false, difficulty=null) {
  return {
    id, name, color, ws, isBot, difficulty: difficulty||null,
    x: 20+Math.random()*60, y: 20+Math.random()*60, prevX: 50, prevY: 50,
    isIt:false, immune:false, immuneUntil:0,
    timeNotIt:0, tagsMade:0, fastestTag:null, becameItAt:null, wasEverIt:false,
    timesTagged:0, lastTaggerId:null, retags:0, totalDistance:0,
    cornerTime:0, edgeTime:0, itStreaks:[], currentItStart:null,
    opportunistTags:0, lastMoveTime:null, trackingActive:false,
    isZombie:false, isTurning:false, turningUntil:0,
    infectCount:0, infectedBy:null, infectedAt:null,
    eliminationRank:null, isPatientZero:false,
    botTargetX:50, botTargetY:50, botTickCounter:0,
    botWanderAngle: Math.random()*Math.PI*2,
    // velocity tracking for AI (smoothed rolling average)
    vx:0, vy:0,
    posHistory: [],  // last 5 positions for smoothed velocity
  };
}

function resetPlayer(p) {
  Object.assign(p, {
    isIt:false, immune:false, immuneUntil:0,
    timeNotIt:0, tagsMade:0, fastestTag:null, becameItAt:null, wasEverIt:false,
    timesTagged:0, lastTaggerId:null, retags:0, totalDistance:0,
    cornerTime:0, edgeTime:0, itStreaks:[], currentItStart:null,
    opportunistTags:0, lastMoveTime:null, trackingActive:false,
    isZombie:false, isTurning:false, turningUntil:0,
    infectCount:0, infectedBy:null, infectedAt:null,
    eliminationRank:null, isPatientZero:false,
    x:20+Math.random()*60, y:20+Math.random()*60,
    botTickCounter:0, botWanderAngle:Math.random()*Math.PI*2,
    vx:0, vy:0, posHistory:[],
  });
}

function createRoom(hostWs, hostName) {
  const roomCode = Math.random().toString(36).substring(2,7).toUpperCase();
  const playerId = uuidv4();
  const player = makePlayer(playerId, hostName, PLAYER_COLORS[0], hostWs);
  const room = {
    code:roomCode, state:'waiting', mode:'classic', hostId:playerId,
    isPublic: false,
    players: new Map([[playerId, player]]),
    itPlayerId:null, gameStartTime:null, gameTimer:null,
    stateInterval:null, lastTickTime:null, firstTaggedId:null,
    cleanupTimer:null, usedBotNames:new Set(),
    eliminationOrder:[], zombieGameDone:false,
  };
  rooms.set(roomCode, room);
  clientToRoom.set(hostWs, roomCode);
  clientToPlayer.set(hostWs, playerId);
  return { roomCode, playerId, player };
}

function addBot(room, difficulty) {
  const max = room.mode==='zombie' ? MAX_PLAYERS_ZOMBIE : MAX_PLAYERS_CLASSIC;
  if (room.players.size >= max) return null;
  const avail = BOT_NAMES.filter(n => !room.usedBotNames.has(n));
  const name = avail.length>0 ? avail[Math.floor(Math.random()*avail.length)] : 'Bot'+(room.players.size+1);
  room.usedBotNames.add(name);
  const botId = uuidv4();
  const bot = makePlayer(botId, name, PLAYER_COLORS[room.players.size % PLAYER_COLORS.length], null, true, difficulty);
  room.players.set(botId, bot);
  return bot;
}

function joinRoom(ws, roomCode, playerName) {
  const room = rooms.get(roomCode);
  if (!room) return { error:'Room not found' };
  if (room.state!=='waiting') return { error:'Game already in progress' };
  const max = room.mode==='zombie' ? MAX_PLAYERS_ZOMBIE : MAX_PLAYERS_CLASSIC;
  if (room.players.size >= max) return { error:'Room is full' };
  const playerId = uuidv4();
  const player = makePlayer(playerId, playerName, PLAYER_COLORS[room.players.size % PLAYER_COLORS.length], ws);
  room.players.set(playerId, player);
  clientToRoom.set(ws, roomCode);
  clientToPlayer.set(ws, playerId);
  return { playerId, player };
}

function serializePlayer(p) {
  return {
    id:p.id, name:p.name, color:p.color, x:p.x, y:p.y,
    isIt:p.isIt, immune:p.immune, wasEverIt:p.wasEverIt,
    timeNotIt:p.timeNotIt, tagsMade:p.tagsMade, fastestTag:p.fastestTag,
    timesTagged:p.timesTagged, retags:p.retags, totalDistance:p.totalDistance,
    isBot:p.isBot, difficulty:p.difficulty,
    isZombie:p.isZombie, isTurning:p.isTurning, turningUntil:p.turningUntil,
    infectCount:p.infectCount, eliminationRank:p.eliminationRank, isPatientZero:p.isPatientZero,
  };
}

function broadcastToRoom(room, msg, excludeWs=null) {
  const data = JSON.stringify(msg);
  room.players.forEach(p => {
    if (!p.isBot && p.ws!==excludeWs && p.ws && p.ws.readyState===WebSocket.OPEN) p.ws.send(data);
  });
}

function getPlayers(room) { return Array.from(room.players.values()).map(serializePlayer); }

function getLiveScores(room) {
  const players = Array.from(room.players.values());
  if (room.mode==='zombie') {
    const now = Date.now();
    const maxGameSec = ZOMBIE_GAME_DURATION_MS / 1000;
    const gameDuration = (now - (room.gameStartTime || now)) / 1000;

    return players.map(p => {
      let score = 0;
      if (!p.isZombie && !p.isTurning) {
        // Ticks up 10pts/sec in real time — +200 bonus shown only when full game complete
        score = Math.round(gameDuration * 10);
      } else if (p.isPatientZero) {
        // Bleeds down from 600 in real time + infection jumps
        score = Math.max(0, Math.round(150 - gameDuration * 15) + p.infectCount * 40);
      } else {
        // Frozen at infection moment + 50 per infection caused
        const survivalSec = p.infectedAt ? (p.infectedAt - room.gameStartTime) / 1000 : 0;
        score = Math.round(survivalSec * 10) + (p.infectCount || 0) * 50;
      }
      return { id:p.id, name:p.name, color:p.color, score, isIt:false, isBot:p.isBot, isZombie:p.isZombie||p.isTurning, isTurning:p.isTurning };
    }).sort((a,b) => b.score - a.score);
  }
  return players.map(p=>({id:p.id,name:p.name,color:p.color,score:Math.floor(p.timeNotIt/100),isIt:p.isIt,isBot:p.isBot,isZombie:false,isTurning:false}))
    .sort((a,b)=>b.score-a.score);
}

// ─── Bot AI Helpers ────────────────────────────────────────────────────────────
function moveTo(bot, speed, dt) {
  const s=speed*(dt/100), dx=bot.botTargetX-bot.x, dy=bot.botTargetY-bot.y;
  const d=Math.sqrt(dx*dx+dy*dy);
  if(d>0.1){bot.x+=(dx/d)*Math.min(s,d);bot.y+=(dy/d)*Math.min(s,d);}
  bot.x=Math.max(0,Math.min(100,bot.x)); bot.y=Math.max(0,Math.min(100,bot.y));
}

function dist2(ax, ay, bx, by) {
  return Math.sqrt((ax-bx)**2 + (ay-by)**2);
}

// Find the human closest to this bot
function nearestHuman(bot, humans) {
  let nearest=null, nd=Infinity;
  humans.forEach(h=>{
    const d=dist2(h.x,h.y,bot.x,bot.y);
    if(d<nd){nd=d;nearest=h;}
  });
  return nearest;
}

// Predict where a human will be in `ticks` game ticks (100ms each)
function predictPos(human, ticks) {
  const px = human.x + human.vx * ticks;
  const py = human.y + human.vy * ticks;
  return {
    x: Math.max(5, Math.min(95, px)),
    y: Math.max(5, Math.min(95, py)),
  };
}

// ─── Classic Bot AI ───────────────────────────────────────────────────────────
function updateClassicBot(bot, room, dt) {
  if(!bot.isBot||!bot.trackingActive)return;
  const diff=DIFFICULTY[bot.difficulty||'medium'];
  bot.botTickCounter++;
  if(bot.botTickCounter%diff.reactionTicks===0){
    const list=Array.from(room.players.values());
    if(bot.isIt){
      // Chase nearest non-immune player
      let nearest=null,nd=Infinity;
      list.forEach(p=>{if(p.id===bot.id||p.immune)return;const d=dist2(p.x,p.y,bot.x,bot.y);if(d<nd){nd=d;nearest=p;}});
      if(nearest){
        // Intercept based on accuracy — hard bots lead their target
        if(diff.accuracy > 0.8 && nearest.vx !== undefined){
          bot.botTargetX = nearest.x + (nearest.vx||0) * 8;
          bot.botTargetY = nearest.y + (nearest.vy||0) * 8;
        } else {
          const n=(1-diff.accuracy)*20;
          bot.botTargetX=nearest.x+(Math.random()-.5)*n;
          bot.botTargetY=nearest.y+(Math.random()-.5)*n;
        }
      }
    } else {
      const it=room.players.get(room.itPlayerId);
      if(it&&it.id!==bot.id){
        const dx=bot.x-it.x, dy=bot.y-it.y;
        const d=Math.sqrt(dx*dx+dy*dy);
        if(d < 60){
          // FLEE — aim for the corner furthest from IT
          const corners = [
            {x:10,y:10},{x:90,y:10},{x:10,y:90},{x:90,y:90}
          ];
          let bestCorner = corners[0];
          let bestDist = -1;
          corners.forEach(c => {
            const cd = dist2(c.x, c.y, it.x, it.y);
            if(cd > bestDist){ bestDist = cd; bestCorner = c; }
          });
          // Add juke — occasionally dart sideways before fleeing
          const juke = Math.random() < 0.2;
          if(juke){
            const perpX = -dy/Math.max(0.1,d);
            const perpY =  dx/Math.max(0.1,d);
            const side = Math.random() < 0.5 ? 1 : -1;
            bot.botTargetX = bot.x + perpX * side * 20;
            bot.botTargetY = bot.y + perpY * side * 20;
          } else {
            const n=(1-diff.accuracy)*8;
            bot.botTargetX = bestCorner.x + (Math.random()-.5)*n;
            bot.botTargetY = bestCorner.y + (Math.random()-.5)*n;
          }
          // Wall avoidance — don't trap in corners if IT is already there
          if(bot.x < 15) bot.botTargetX = Math.max(bot.botTargetX, 30);
          if(bot.x > 85) bot.botTargetX = Math.min(bot.botTargetX, 70);
          if(bot.y < 15) bot.botTargetY = Math.max(bot.botTargetY, 30);
          if(bot.y > 85) bot.botTargetY = Math.min(bot.botTargetY, 70);
        } else {
          // Wander naturally — more erratic than before
          bot.botWanderAngle += (Math.random()-.5) * 0.8;
          bot.botTargetX = bot.x + Math.cos(bot.botWanderAngle) * 12;
          bot.botTargetY = bot.y + Math.sin(bot.botWanderAngle) * 12;
          if(bot.botTargetX<10){bot.botTargetX=15;bot.botWanderAngle=0;}
          if(bot.botTargetX>90){bot.botTargetX=85;bot.botWanderAngle=Math.PI;}
          if(bot.botTargetY<10){bot.botTargetY=15;bot.botWanderAngle=Math.PI/2;}
          if(bot.botTargetY>90){bot.botTargetY=85;bot.botWanderAngle=-Math.PI/2;}
        }
      }
      if(Math.random()<diff.mistakeChance){bot.botTargetX=10+Math.random()*80;bot.botTargetY=10+Math.random()*80;}
    }
    bot.botTargetX=Math.max(5,Math.min(95,bot.botTargetX));
    bot.botTargetY=Math.max(5,Math.min(95,bot.botTargetY));
  }
  moveTo(bot,diff.speed,dt);
}

// ─── Zombie Bot AI — Smart Flanking & Herding ─────────────────────────────────
//
// Role assignment (reassigned every 5 ticks):
//   CHASER      — beelines directly at nearest human
//   INTERCEPTOR — predicts human velocity, targets ahead of them
//   FLANKER     — approaches from the side (perpendicular to human's movement)
//   HERDER      — repositions to block the escape route / nearest open corner
//
// Multiple zombies each pick a DIFFERENT primary target human so pressure
// spreads across the whole group rather than everyone dogpiling one.

// Role assignment — called every 20 ticks to let zombies commit to a strategy
function assignZombieRoles(botZombies, allHumans) {
  if(allHumans.length===0) return botZombies.map(b=>({bot:b,role:'chaser',target:null}));
  const n = botZombies.length;

  // Each zombie targets a different human to maximise spread pressure
  // Sort bots by x position so role assignment is spatially consistent
  const sorted = [...botZombies].sort((a,b)=>a.x-b.x);

  return sorted.map((bot, idx) => {
    // Assign primary target: each zombie picks the human it's currently closest to,
    // but offset the sort index so they don't all pick the same one
    const humansSorted = [...allHumans].sort((a,b)=>dist2(a.x,a.y,bot.x,bot.y)-dist2(b.x,b.y,bot.x,bot.y));
    const target = humansSorted[idx % humansSorted.length];

    let role = 'chaser';
    if(n >= 2 && idx === 1) role = 'interceptor';
    if(n >= 3 && idx === 2) role = 'flanker';
    if(n >= 4 && idx >= 3)  role = 'herder';

    return { bot, role, target };
  });
}

// Room-level zombie role cache — recompute every 20 ticks so zombies commit
const zombieRoleCache = new Map(); // roomCode -> { assignments }

// Apply inter-zombie repulsion: push zombies apart if they're too close
// This is the main fix for convergence — called after target is set
function applyZombieRepulsion(bot, botZombies) {
  const MIN_SPREAD = 22; // minimum distance zombies should maintain
  botZombies.forEach(other => {
    if(other.id === bot.id) return;
    const dx = bot.botTargetX - other.x;
    const dy = bot.botTargetY - other.y;
    const d = Math.sqrt(dx*dx + dy*dy);
    if(d < MIN_SPREAD && d > 0.1){
      // Push our target away from the other zombie
      const push = (MIN_SPREAD - d) / MIN_SPREAD;
      bot.botTargetX += (dx/d) * push * 15;
      bot.botTargetY += (dy/d) * push * 15;
    }
  });
}

function updateZombieBot(bot, room, dt, allZombies, allHumans, roomCode) {
  if(!bot.isBot||!bot.trackingActive)return;
  const diff = DIFFICULTY[bot.difficulty||'medium'];
  const spd  = diff.speed * (bot.isTurning ? TURNING_SPEED_FACTOR : bot.isZombie ? ZOMBIE_SPEED_FACTOR : 1.0);
  bot.botTickCounter++;

  if(bot.botTickCounter % diff.reactionTicks !== 0){
    moveTo(bot, spd, dt);
    return;
  }

  // ── Human flee AI (not yet a zombie) ──────────────────────────────────────
  if(!bot.isZombie && !bot.isTurning){
    const activeZ = allZombies.filter(z=>z.isZombie&&!z.isTurning);
    if(activeZ.length>0){
      let nearest=null, nd=Infinity;
      activeZ.forEach(z=>{const d=dist2(z.x,z.y,bot.x,bot.y);if(d<nd){nd=d;nearest=z;}});
      if(nearest && nd<60){
        const dx=bot.x-nearest.x, dy=bot.y-nearest.y, d=Math.max(0.1,Math.sqrt(dx*dx+dy*dy));
        // Flee to furthest corner from nearest zombie
        const corners = [{x:10,y:10},{x:90,y:10},{x:10,y:90},{x:90,y:90}];
        let bestCorner = corners[0], bestDist = -1;
        corners.forEach(c=>{const cd=dist2(c.x,c.y,nearest.x,nearest.y);if(cd>bestDist){bestDist=cd;bestCorner=c;}});
        // Juke occasionally
        if(Math.random() < 0.15){
          const perpX = -dy/d, perpY = dx/d, side = Math.random()<0.5?1:-1;
          bot.botTargetX = bot.x + perpX*side*25;
          bot.botTargetY = bot.y + perpY*side*25;
        } else {
          bot.botTargetX = bestCorner.x + (Math.random()-.5)*8;
          bot.botTargetY = bestCorner.y + (Math.random()-.5)*8;
        }
        // Wall avoidance
        if(bot.x < 15) bot.botTargetX = Math.max(bot.botTargetX, 30);
        if(bot.x > 85) bot.botTargetX = Math.min(bot.botTargetX, 70);
        if(bot.y < 15) bot.botTargetY = Math.max(bot.botTargetY, 30);
        if(bot.y > 85) bot.botTargetY = Math.min(bot.botTargetY, 70);
      } else {
        bot.botWanderAngle += (Math.random()-.5)*0.6;
        bot.botTargetX = Math.max(10, Math.min(90, bot.x + Math.cos(bot.botWanderAngle)*12));
        bot.botTargetY = Math.max(10, Math.min(90, bot.y + Math.sin(bot.botWanderAngle)*12));
      }
    }
    bot.botTargetX = Math.max(5,Math.min(95,bot.botTargetX));
    bot.botTargetY = Math.max(5,Math.min(95,bot.botTargetY));
    moveTo(bot, spd, dt);
    return;
  }

  // ── Turning — barely moves ─────────────────────────────────────────────────
  if(bot.isTurning){ moveTo(bot, spd, dt); return; }

  // ── Active zombie — role-based movement with repulsion ────────────────────
  if(allHumans.length===0){ moveTo(bot,spd,dt); return; }

  const botZombies = allZombies.filter(z=>z.isZombie&&!z.isTurning&&z.isBot);

  // Rebuild role cache every 20 ticks — commit to strategy
  const cache = zombieRoleCache.get(roomCode) || { assignments:[] };
  let assignments = cache.assignments;
  if(bot.botTickCounter % 20 === 0 || assignments.length !== botZombies.length){
    assignments = assignZombieRoles(botZombies, allHumans);
    zombieRoleCache.set(roomCode, { assignments });
  }

  const myAssign = assignments.find(a=>a.bot.id===bot.id);
  const role   = myAssign ? myAssign.role   : 'chaser';
  const target = myAssign ? myAssign.target : nearestHuman(bot, allHumans);

  if(!target){ moveTo(bot,spd,dt); return; }

  const noise = (1-diff.accuracy)*10;

  switch(role){
    case 'chaser': {
      // Direct pursuit — no prediction, just relentless
      bot.botTargetX = target.x + (Math.random()-.5)*noise;
      bot.botTargetY = target.y + (Math.random()-.5)*noise;
      break;
    }
    case 'interceptor': {
      // Predict where target will be ahead using smoothed velocity
      const lookAhead = 18;
      const pred = predictPos(target, lookAhead);
      bot.botTargetX = pred.x + (Math.random()-.5)*noise;
      bot.botTargetY = pred.y + (Math.random()-.5)*noise;
      break;
    }
    case 'flanker': {
      // Come from the side perpendicular to target's movement
      const spd2 = Math.sqrt(target.vx**2 + target.vy**2);
      if(spd2 > 0.1){
        const perpX = -target.vy / spd2;
        const perpY =  target.vx / spd2;
        const sideA = { x: target.x + perpX*25, y: target.y + perpY*25 };
        const sideB = { x: target.x - perpX*25, y: target.y - perpY*25 };
        const side = dist2(bot.x,bot.y,sideA.x,sideA.y) < dist2(bot.x,bot.y,sideB.x,sideB.y) ? sideA : sideB;
        bot.botTargetX = side.x + (Math.random()-.5)*noise;
        bot.botTargetY = side.y + (Math.random()-.5)*noise;
      } else {
        bot.botTargetX = target.x + (Math.random()-.5)*noise;
        bot.botTargetY = target.y + (Math.random()-.5)*noise;
      }
      break;
    }
    case 'herder': {
      // Rush to the nearest wall/corner on the far side of the human
      // — cuts off the escape route rather than following from behind
      const wallCandidates = [
        { x: target.x > 50 ? 95 : 5,  y: target.y },   // nearest side wall
        { x: target.x,                  y: target.y > 50 ? 95 : 5 }, // nearest top/bottom wall
        { x: target.x > 50 ? 95 : 5,  y: target.y > 50 ? 95 : 5 }, // nearest corner
      ];
      // Pick the wall point that this bot can reach before the human can change direction
      let best = wallCandidates[0];
      let bestScore = Infinity;
      wallCandidates.forEach(w => {
        const myDist  = dist2(bot.x, bot.y, w.x, w.y);
        const humDist = dist2(target.x, target.y, w.x, w.y);
        // Prefer walls where we're closer (or close to as fast) as the human
        const score = myDist - humDist * 0.6;
        if(score < bestScore){ bestScore = score; best = w; }
      });
      bot.botTargetX = best.x + (Math.random()-.5)*noise;
      bot.botTargetY = best.y + (Math.random()-.5)*noise;
      break;
    }
  }

  // Apply inter-zombie repulsion — physically push zombies apart
  applyZombieRepulsion(bot, botZombies);

  // Random mistake (difficulty-scaled)
  if(Math.random() < diff.mistakeChance){
    bot.botTargetX = 10+Math.random()*80;
    bot.botTargetY = 10+Math.random()*80;
  }

  bot.botTargetX = Math.max(5,Math.min(95,bot.botTargetX));
  bot.botTargetY = Math.max(5,Math.min(95,bot.botTargetY));
  moveTo(bot, spd, dt);
}

// ─── Awards ───────────────────────────────────────────────────────────────────
const AWARDS = {
  panicMouse:{emoji:'🐁',title:'Panic Mouse',desc:'Most frantic movement'},
  escapeArtist:{emoji:'🐇',title:'Escape Artist',desc:'Never got tagged'},
  cornerRat:{emoji:'🐀',title:'Corner Rat',desc:'Most time hiding in corners'},
  revengeSeeker:{emoji:'🔄',title:'Revenge Seeker',desc:'Most re-tags'},
  magnetToDanger:{emoji:'🧲',title:'Magnet to Danger',desc:'Got tagged the most'},
  anchoredToWalls:{emoji:'🪨',title:'Anchored to Walls',desc:'Most time near edges'},
  sacrificialLamb:{emoji:'🐑',title:'Sacrificial Lamb',desc:'First to get tagged'},
  opportunist:{emoji:'👀',title:'Opportunist',desc:'Tagged the most idle players'},
};
const ZOMBIE_AWARDS = {
  lastSurvivor:{emoji:'🏆',title:'Last Survivor',desc:'Final human standing'},
  speedRunner:{emoji:'💨',title:'Speed Runner',desc:'Survived the longest before turning'},
  superSpreader:{emoji:'🦠',title:'Super Spreader',desc:'Infected the most players'},
  patientZero:{emoji:'🧟',title:'Patient Zero',desc:'Started the outbreak'},
  earlyVictim:{emoji:'😵',title:'Early Victim',desc:'First human infected'},
  herdImmunity:{emoji:'🛡️',title:'Herd Immunity',desc:'Survived to the time limit'},
  turnedZombie:{emoji:'🩸',title:'Turned',desc:'Joined the horde'},
};

function assignAwards(list,room){
  const assigned=new Set(),awards={};
  const maxBy=k=>{let b=null,bv=-1;list.forEach(p=>{if(!assigned.has(p.id)&&p[k]>bv){bv=p[k];b=p;}});return bv>0?b:null;};
  list.forEach(p=>{if(!p.wasEverIt&&!assigned.has(p.id)){awards[p.id]=AWARDS.escapeArtist;assigned.add(p.id);}});
  if(room.firstTaggedId&&!assigned.has(room.firstTaggedId)){awards[room.firstTaggedId]=AWARDS.sacrificialLamb;assigned.add(room.firstTaggedId);}
  const pm=maxBy('totalDistance');if(pm){awards[pm.id]=AWARDS.panicMouse;assigned.add(pm.id);}
  const rs=maxBy('retags');if(rs){awards[rs.id]=AWARDS.revengeSeeker;assigned.add(rs.id);}
  const md=maxBy('timesTagged');if(md){awards[md.id]=AWARDS.magnetToDanger;assigned.add(md.id);}
  const cr=maxBy('cornerTime');if(cr){awards[cr.id]=AWARDS.cornerRat;assigned.add(cr.id);}
  const op=maxBy('opportunistTags');if(op){awards[op.id]=AWARDS.opportunist;assigned.add(op.id);}
  const aw=maxBy('edgeTime');if(aw){awards[aw.id]=AWARDS.anchoredToWalls;assigned.add(aw.id);}
  list.forEach(p=>{if(!awards[p.id])awards[p.id]=AWARDS.panicMouse;});
  return awards;
}

function assignZombieAwards(list){
  const awards={};
  const survivors=list.filter(p=>!p.isZombie&&!p.isTurning);
  const zombies=list.filter(p=>p.isZombie||p.isTurning);
  if(survivors.length===1)awards[survivors[0].id]=ZOMBIE_AWARDS.lastSurvivor;
  else survivors.forEach(p=>{awards[p.id]=ZOMBIE_AWARDS.herdImmunity;});
  const pz=list.find(p=>p.isPatientZero);
  if(pz&&!awards[pz.id])awards[pz.id]=ZOMBIE_AWARDS.patientZero;
  const top=[...zombies].sort((a,b)=>b.infectCount-a.infectCount)[0];
  if(top&&!awards[top.id])awards[top.id]=ZOMBIE_AWARDS.superSpreader;
  const fv=zombies.filter(p=>!p.isPatientZero&&p.infectedAt).sort((a,b)=>a.infectedAt-b.infectedAt)[0];
  if(fv&&!awards[fv.id])awards[fv.id]=ZOMBIE_AWARDS.earlyVictim;
  const ls=zombies.filter(p=>p.infectedAt).sort((a,b)=>b.infectedAt-a.infectedAt)[0];
  if(ls&&!awards[ls.id])awards[ls.id]=ZOMBIE_AWARDS.speedRunner;
  list.forEach(p=>{
    if(!awards[p.id]){
      awards[p.id] = (p.isZombie || p.isTurning)
        ? ZOMBIE_AWARDS.turnedZombie
        : ZOMBIE_AWARDS.herdImmunity;
    }
  });
  return awards;
}

// ─── Countdown ────────────────────────────────────────────────────────────────
function startCountdown(roomCode){
  const room=rooms.get(roomCode);if(!room||room.players.size<2)return;
  room.state='countdown';
  room.players.forEach(p=>{p.trackingActive=true;});
  broadcastToRoom(room,{type:'countdown',count:COUNTDOWN_SECONDS});
  let count=COUNTDOWN_SECONDS;
  const iv=setInterval(()=>{
    count--;
    if(count>0)broadcastToRoom(room,{type:'countdown',count});
    else{clearInterval(iv);room.mode==='zombie'?startZombieGame(roomCode):startClassicGame(roomCode);}
  },1000);
}

// ─── Classic ──────────────────────────────────────────────────────────────────
function startClassicGame(roomCode){
  const room=rooms.get(roomCode);if(!room)return;
  const list=Array.from(room.players.values());
  const it=list[Math.floor(Math.random()*list.length)];
  it.isIt=true;it.wasEverIt=true;it.becameItAt=Date.now();it.currentItStart=Date.now();
  room.itPlayerId=it.id;room.state='playing';room.gameStartTime=Date.now();room.lastTickTime=Date.now();
  broadcastToRoom(room,{type:'gameStarted',players:getPlayers(room),itPlayerId:it.id,duration:GAME_DURATION_MS,tagDistance:TAG_DISTANCE_PCT,mode:'classic'});
  room.stateInterval=setInterval(()=>classicTick(roomCode),100);
  room.gameTimer=setTimeout(()=>endClassicGame(roomCode),GAME_DURATION_MS);
}

function classicTick(roomCode){
  const room=rooms.get(roomCode);if(!room||room.state!=='playing')return;
  const now=Date.now(),dt=now-room.lastTickTime;room.lastTickTime=now;
  const timeLeft=Math.max(0,GAME_DURATION_MS-(now-room.gameStartTime));
  const list=Array.from(room.players.values());
  list.forEach(p=>{if(p.isBot)updateClassicBot(p,room,dt);});
  list.forEach(p=>{
    if(!p.isIt)p.timeNotIt+=dt;
    if(p.immune&&now>=p.immuneUntil)p.immune=false;
    if(p.trackingActive){
      const dx=p.x-p.prevX,dy=p.y-p.prevY;p.totalDistance+=Math.sqrt(dx*dx+dy*dy);p.prevX=p.x;p.prevY=p.y;
      if((p.x<10||p.x>90)&&(p.y<10||p.y>90))p.cornerTime+=dt;
      if(p.x<8||p.x>92||p.y<8||p.y>92)p.edgeTime+=dt;
    }
  });
  const it=room.players.get(room.itPlayerId);
  if(it&&!it.immune){
    for(const p of list){
      if(p.id===it.id||p.immune)continue;
      const dx=it.x-p.x,dy=it.y-p.y;
      const mIX=(it.x+(it.prevX||it.x))/2,mIY=(it.y+(it.prevY||it.y))/2;
      const mPX=(p.x+(p.prevX||p.x))/2,mPY=(p.y+(p.prevY||p.y))/2;
      if(Math.sqrt(dx*dx+dy*dy)<TAG_DISTANCE_PCT||Math.sqrt((mIX-mPX)**2+(mIY-mPY)**2)<TAG_DISTANCE_PCT){
        performClassicTag(room,it,p,now);break;
      }
    }
  }
  broadcastToRoom(room,{type:'gameState',players:getPlayers(room),itPlayerId:room.itPlayerId,timeLeft,liveScores:getLiveScores(room),mode:'classic'});
}

function performClassicTag(room,tagger,target,now){
  if(tagger.becameItAt){
    const e=now-tagger.becameItAt;if(tagger.fastestTag===null||e<tagger.fastestTag)tagger.fastestTag=e;
    tagger.tagsMade++;if(tagger.currentItStart){tagger.itStreaks.push(now-tagger.currentItStart);tagger.currentItStart=null;}
  }
  const tdx=target.x-target.prevX,tdy=target.y-target.prevY;
  if(Math.sqrt(tdx*tdx+tdy*tdy)<0.5)tagger.opportunistTags++;
  if(tagger.lastTaggerId===target.id)tagger.retags++;
  if(!room.firstTaggedId)room.firstTaggedId=target.id;
  tagger.isIt=false;tagger.immune=true;tagger.immuneUntil=now+TAG_IMMUNITY_MS;
  target.isIt=true;target.wasEverIt=true;target.becameItAt=now;target.currentItStart=now;
  target.timesTagged++;target.lastTaggerId=tagger.id;room.itPlayerId=target.id;
  broadcastToRoom(room,{type:'tagged',newItId:target.id,taggerId:tagger.id});
}

function endClassicGame(roomCode){
  const room=rooms.get(roomCode);if(!room)return;
  clearInterval(room.stateInterval);clearTimeout(room.gameTimer);room.state='ended';
  const list=Array.from(room.players.values()),now=Date.now();
  list.forEach(p=>{if(p.isIt&&p.currentItStart)p.itStreaks.push(now-p.currentItStart);});
  const maxDist=Math.max(...list.map(p=>p.totalDistance));
  const maxR=Math.max(...list.map(p=>p.retags));
  const itP=list.filter(p=>p.itStreaks.length>0);
  const minS=itP.length>0?Math.min(...itP.map(p=>Math.min(...p.itStreaks))):Infinity;
  const awards=assignAwards(list,room);
  const scored=list.map(p=>{
    let s=Math.floor(p.timeNotIt/100);
    if(!p.wasEverIt)s+=10;
    if(p.itStreaks.length>0&&Math.min(...p.itStreaks)===minS)s+=10;
    if(p.retags>0&&p.retags===maxR)s+=10;
    if(p.totalDistance>0&&p.totalDistance===maxDist)s+=10;
    if(p.id===room.itPlayerId)s=Math.max(0,s-20);
    return{...serializePlayer(p),score:s,isLoser:p.id===room.itPlayerId,award:awards[p.id]||null,isSurvivor:false,
      stats:{timeNotIt:Math.round(p.timeNotIt/1000),tagsMade:p.tagsMade,
        fastestTag:p.fastestTag?Math.round(p.fastestTag/100)/10:null,
        survivedUntagged:!p.wasEverIt,itAtEnd:p.id===room.itPlayerId,
        timesTagged:p.timesTagged,retags:p.retags,totalDistance:Math.round(p.totalDistance),
        opportunistTags:p.opportunistTags,
        shortestItStreak:p.itStreaks.length>0?Math.round(Math.min(...p.itStreaks)/100)/10:null}};
  });
  scored.sort((a,b)=>b.score-a.score);scored.forEach((p,i)=>{p.rank=i+1;});
  updateLeaderboard(scored);
  broadcastToRoom(room,{type:'gameEnded',players:scored,mode:'classic'});
  room.cleanupTimer=setTimeout(()=>rooms.delete(roomCode),5*60*1000);
}

// ─── Zombie ───────────────────────────────────────────────────────────────────
function startZombieGame(roomCode){
  const room=rooms.get(roomCode);if(!room)return;
  const list=Array.from(room.players.values());
  const bots=list.filter(p=>p.isBot),humans=list.filter(p=>!p.isBot);
  const pz=bots.length>0?bots[Math.floor(Math.random()*bots.length)]:humans[Math.floor(Math.random()*humans.length)];
  pz.isZombie=true;pz.isPatientZero=true;pz.infectedAt=Date.now();
  room.state='playing';room.gameStartTime=Date.now();room.lastTickTime=Date.now();
  room.eliminationOrder=[];room.zombieGameDone=false;
  zombieRoleCache.delete(roomCode);
  broadcastToRoom(room,{type:'gameStarted',players:getPlayers(room),itPlayerId:pz.id,duration:ZOMBIE_GAME_DURATION_MS,tagDistance:ZOMBIE_TAG_DISTANCE_PCT,mode:'zombie',patientZeroId:pz.id});
  room.stateInterval=setInterval(()=>zombieTick(roomCode),100);
  room.gameTimer=setTimeout(()=>endZombieGame(roomCode,'timeout'),ZOMBIE_GAME_DURATION_MS);
}

function zombieTick(roomCode){
  const room=rooms.get(roomCode);if(!room||room.state!=='playing')return;
  const now=Date.now(),dt=now-room.lastTickTime;room.lastTickTime=now;
  const timeLeft=Math.max(0,ZOMBIE_GAME_DURATION_MS-(now-room.gameStartTime));
  const list=Array.from(room.players.values());

  // Update smoothed velocity on all players (rolling avg of last 5 ticks)
  list.forEach(p=>{
    if(!p.posHistory) p.posHistory = [];
    p.posHistory.push({ x: p.x, y: p.y });
    if(p.posHistory.length > 5) p.posHistory.shift();
    if(p.posHistory.length >= 2){
      const oldest = p.posHistory[0];
      const newest = p.posHistory[p.posHistory.length - 1];
      const span = p.posHistory.length - 1;
      p.vx = (newest.x - oldest.x) / span;
      p.vy = (newest.y - oldest.y) / span;
    } else {
      p.vx = 0; p.vy = 0;
    }
  });

  const allZombies=list.filter(p=>p.isZombie||p.isTurning);
  const allHumans=list.filter(p=>!p.isZombie&&!p.isTurning);

  list.forEach(p=>{if(p.isBot)updateZombieBot(p,room,dt,allZombies,allHumans,roomCode);});

  list.forEach(p=>{
    if(p.isTurning&&now>=p.turningUntil){p.isTurning=false;p.isZombie=true;broadcastToRoom(room,{type:'zombieFullyTurned',playerId:p.id});}
  });

  list.forEach(p=>{
    if(p.trackingActive){const dx=p.x-p.prevX,dy=p.y-p.prevY;p.totalDistance+=Math.sqrt(dx*dx+dy*dy);p.prevX=p.x;p.prevY=p.y;}
    if(!p.isZombie&&!p.isTurning)p.timeNotIt+=dt;
  });

  const activeZ=list.filter(p=>p.isZombie&&!p.isTurning);
  const curH=list.filter(p=>!p.isZombie&&!p.isTurning);
  for(const z of activeZ){
    for(const h of curH){
      const dx=z.x-h.x,dy=z.y-h.y;
      const mZX=(z.x+(z.prevX||z.x))/2,mZY=(z.y+(z.prevY||z.y))/2;
      const mHX=(h.x+(h.prevX||h.x))/2,mHY=(h.y+(h.prevY||h.y))/2;
      if(Math.sqrt(dx*dx+dy*dy)<ZOMBIE_TAG_DISTANCE_PCT||Math.sqrt((mZX-mHX)**2+(mZY-mHY)**2)<ZOMBIE_TAG_DISTANCE_PCT){
        infectHuman(room,z,h,now);
      }
    }
  }

  const remaining=list.filter(p=>!p.isZombie&&!p.isTurning);
  if(remaining.length===0&&!room.zombieGameDone){
    room.zombieGameDone=true;clearInterval(room.stateInterval);clearTimeout(room.gameTimer);
    setTimeout(()=>endZombieGame(roomCode,'allInfected'),500);return;
  }
  broadcastToRoom(room,{type:'gameState',players:getPlayers(room),itPlayerId:null,timeLeft,liveScores:getLiveScores(room),mode:'zombie',humansLeft:remaining.length});
}

function infectHuman(room,zombie,human,now){
  if(human.isTurning||human.isZombie)return;
  human.isTurning=true;human.turningUntil=now+ZOMBIE_TURNING_MS;
  human.infectedBy=zombie.id;human.infectedAt=now;
  zombie.infectCount++;
  room.eliminationOrder.push({id:human.id,time:now});
  broadcastToRoom(room,{type:'infected',victimId:human.id,zombieId:zombie.id});
}

function endZombieGame(roomCode,reason){
  const room=rooms.get(roomCode);if(!room)return;
  clearInterval(room.stateInterval);clearTimeout(room.gameTimer);room.state='ended';
  zombieRoleCache.delete(roomCode);
  const list=Array.from(room.players.values()),now=Date.now();
  const gameDuration=now-room.gameStartTime;
  const maxGameSec = ZOMBIE_GAME_DURATION_MS / 1000;
  const awards=assignZombieAwards(list);
  const scored=list.map(p=>{
    let score=0;
    if(!p.isZombie&&!p.isTurning){
      // Survivor: 10pts/sec survived + 200 bonus for lasting the full game
      const survived = gameDuration / 1000;
      score = Math.round(survived * 10);
      if(survived >= maxGameSec - 1) score += 300; // full game bonus
    } else if(p.isPatientZero){
      // Patient Zero: starts at 600, bleeds 8pts/sec, +120 per infection
      // Infect fast and often to win — do nothing and you end up low
      const elapsed = gameDuration / 1000;
      score = Math.max(0, Math.round(150 - elapsed * 15) + p.infectCount * 40);
    } else {
      // Infected: score freezes at infection moment (survivalSecs × 10) + 50 per infection caused
      const survivalSec = p.infectedAt ? (p.infectedAt - room.gameStartTime) / 1000 : 0;
      score = Math.round(survivalSec * 10) + (p.infectCount || 0) * 50;
    }
    return{...serializePlayer(p),score,isLoser:false,award:awards[p.id]||null,
      isSurvivor:!p.isZombie&&!p.isTurning,
      stats:{timeNotIt:Math.round(p.timeNotIt/1000),infectCount:p.infectCount,
        survivalTime:p.infectedAt?Math.round((p.infectedAt-room.gameStartTime)/1000):Math.round(gameDuration/1000),
        isPatientZero:p.isPatientZero,survived:!p.isZombie&&!p.isTurning,totalDistance:Math.round(p.totalDistance)}};
  });
  scored.sort((a,b)=>b.score-a.score);
  scored.forEach((p,i)=>{p.rank=i+1;});
  broadcastToRoom(room,{type:'gameEnded',players:scored,mode:'zombie',reason});
  room.cleanupTimer=setTimeout(()=>rooms.delete(roomCode),5*60*1000);
}

// ─── HTTP + WS ────────────────────────────────────────────────────────────────
const httpServer=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.end('Cursor Tag server running');});
const wss=new WebSocket.Server({server:httpServer});

wss.on('connection',ws=>{
  console.log('Client connected');
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    const roomCode=clientToRoom.get(ws),playerId=clientToPlayer.get(ws);
    const room=roomCode?rooms.get(roomCode):null;
    const player=room&&playerId?room.players.get(playerId):null;
    switch(msg.type){
      case 'createRoom':{
        const{roomCode:rc,playerId:pid,player:p}=createRoom(ws,msg.name);
        ws.send(JSON.stringify({type:'roomCreated',roomCode:rc,playerId:pid,players:[serializePlayer(p)],color:p.color,mode:'classic',isPublic:false}));
        break;
      }
      case 'joinRoom':{
        const result=joinRoom(ws,msg.roomCode.toUpperCase(),msg.name);
        if(result.error){ws.send(JSON.stringify({type:'error',message:result.error}));return;}
        const r=rooms.get(msg.roomCode.toUpperCase());
        ws.send(JSON.stringify({type:'roomJoined',roomCode:msg.roomCode.toUpperCase(),playerId:result.playerId,players:getPlayers(r),color:result.player.color,mode:r.mode}));
        broadcastToRoom(r,{type:'playerJoined',players:getPlayers(r)},ws);
        break;
      }
      case 'setMode':{
        if(!room||room.state!=='waiting'||room.hostId!==playerId)return;
        if(msg.mode==='classic'||msg.mode==='zombie'){
          room.mode=msg.mode;
          broadcastToRoom(room,{type:'modeChanged',mode:room.mode,players:getPlayers(room)});
        }
        break;
      }
      case 'setVisibility':{
        if(!room||room.state!=='waiting'||room.hostId!==playerId)return;
        room.isPublic = !!msg.isPublic;
        broadcastToRoom(room,{type:'visibilityChanged',isPublic:room.isPublic});
        ws.send(JSON.stringify({type:'visibilityChanged',isPublic:room.isPublic}));
        break;
      }
      case 'browseRooms':{
        const publicRooms=[];
        rooms.forEach((r,code)=>{
          if(!r.isPublic||r.state!=='waiting')return;
          const max=r.mode==='zombie'?MAX_PLAYERS_ZOMBIE:MAX_PLAYERS_CLASSIC;
          const humanCount=Array.from(r.players.values()).filter(p=>!p.isBot).length;
          const botCount=Array.from(r.players.values()).filter(p=>p.isBot).length;
          if(humanCount>=max)return;
          const host=r.players.get(r.hostId);
          publicRooms.push({
            code,
            hostName: host?host.name:'Unknown',
            mode: r.mode,
            playerCount: r.players.size,
            humanCount,
            botCount,
            maxPlayers: max,
            openSlots: max - r.players.size,
          });
        });
        ws.send(JSON.stringify({type:'roomList',rooms:publicRooms}));
        break;
      }
      case 'addBot':{
        if(!room||room.state!=='waiting'||room.hostId!==playerId)return;
        const diff=['easy','medium','hard'].includes(msg.difficulty)?msg.difficulty:'medium';
        const bot=addBot(room,diff);
        if(!bot){ws.send(JSON.stringify({type:'error',message:'Room is full'}));return;}
        broadcastToRoom(room,{type:'playerJoined',players:getPlayers(room)});
        break;
      }
      case 'removeBot':{
        if(!room||room.state!=='waiting'||room.hostId!==playerId)return;
        const bot=room.players.get(msg.botId);
        if(bot&&bot.isBot){room.usedBotNames.delete(bot.name);room.players.delete(msg.botId);broadcastToRoom(room,{type:'playerJoined',players:getPlayers(room)});}
        break;
      }
      case 'startGame':{
        if(!room||(room.state!=='waiting'&&room.state!=='ended')||room.hostId!==playerId)return;
        if(room.players.size<2){ws.send(JSON.stringify({type:'error',message:'Need at least 2 players to start'}));return;}
        startCountdown(roomCode);break;
      }
      case 'playAgain':{
        if(!room||room.state!=='ended')return;
        if(room.cleanupTimer){clearTimeout(room.cleanupTimer);room.cleanupTimer=null;}
        room.state='waiting';room.itPlayerId=null;room.firstTaggedId=null;
        room.eliminationOrder=[];room.zombieGameDone=false;
        room.players.forEach(p=>resetPlayer(p));
        broadcastToRoom(room,{type:'playAgain',players:getPlayers(room),mode:room.mode});
        break;
      }
      case 'move':{
        if(!player||!room||(room.state!=='playing'&&room.state!=='countdown'))return;
        player.x=Math.max(0,Math.min(100,msg.x));player.y=Math.max(0,Math.min(100,msg.y));player.lastMoveTime=Date.now();
        break;
      }
    }
  });
  ws.on('close',()=>{
    const roomCode=clientToRoom.get(ws),playerId=clientToPlayer.get(ws);
    if(roomCode&&playerId){
      const room=rooms.get(roomCode);
      if(room){
        room.players.delete(playerId);
        if(room.players.size===0||Array.from(room.players.values()).every(p=>p.isBot)){
          clearInterval(room.stateInterval);clearTimeout(room.gameTimer);rooms.delete(roomCode);
        } else {
          if(room.state==='playing'&&room.mode==='classic'&&room.itPlayerId===playerId){
            const rem=Array.from(room.players.values());
            const ni=rem[Math.floor(Math.random()*rem.length)];
            ni.isIt=true;ni.wasEverIt=true;ni.becameItAt=Date.now();ni.currentItStart=Date.now();room.itPlayerId=ni.id;
          }
          broadcastToRoom(room,{type:'playerLeft',players:getPlayers(room)});
        }
      }
    }
    clientToRoom.delete(ws);clientToPlayer.delete(ws);console.log('Client disconnected');
  });
});

httpServer.listen(PORT,'0.0.0.0',()=>console.log(`Cursor Tag server running on port ${PORT}`));
