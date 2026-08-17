const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const DIR        = __dirname;
const PORT       = process.env.PORT || 8765;
const TIME_LIMIT = 120;

const PAIRS = [
  [{ emoji:'🎸', name:'Guitar',     pair:'Microphone'  }, { emoji:'🎤', name:'Microphone',  pair:'Guitar'     }],
  [{ emoji:'🌈', name:'Rainbow',    pair:'Umbrella'    }, { emoji:'☔', name:'Umbrella',    pair:'Rainbow'    }],
  [{ emoji:'🦜', name:'Parrot',     pair:'Pirate'      }, { emoji:'🏴‍☠️', name:'Pirate',      pair:'Parrot'     }],
  [{ emoji:'🐉', name:'Dragon',     pair:'Fire'        }, { emoji:'🔥', name:'Fire',        pair:'Dragon'     }],
  [{ emoji:'🌵', name:'Cactus',     pair:'Desert'      }, { emoji:'🏜️', name:'Desert',      pair:'Cactus'     }],
  [{ emoji:'🦈', name:'Shark',      pair:'Swimmer'     }, { emoji:'🏊', name:'Swimmer',     pair:'Shark'      }],
  [{ emoji:'🧲', name:'Magnet',     pair:'Paperclip'   }, { emoji:'📎', name:'Paperclip',   pair:'Magnet'     }],
  [{ emoji:'🎃', name:'Pumpkin',    pair:'Spider'      }, { emoji:'🕷️', name:'Spider',      pair:'Pumpkin'    }],
  [{ emoji:'🌙', name:'Moon',       pair:'Wolf'        }, { emoji:'🐺', name:'Wolf',        pair:'Moon'       }],
  [{ emoji:'🏆', name:'Trophy',     pair:'Medal'       }, { emoji:'🥇', name:'Medal',       pair:'Trophy'     }],
  [{ emoji:'🦋', name:'Butterfly',  pair:'Flower'      }, { emoji:'🌸', name:'Flower',      pair:'Butterfly'  }],
  [{ emoji:'🎯', name:'Target',     pair:'Arrow'       }, { emoji:'🏹', name:'Arrow',       pair:'Target'     }],
  [{ emoji:'🔦', name:'Torch',      pair:'Bat'         }, { emoji:'🦇', name:'Bat',         pair:'Torch'      }],
  [{ emoji:'🍯', name:'Honey',      pair:'Bear'        }, { emoji:'🐻', name:'Bear',        pair:'Honey'      }],
  [{ emoji:'🌊', name:'Wave',       pair:'Surfer'      }, { emoji:'🏄', name:'Surfer',      pair:'Wave'       }],
  [{ emoji:'🎩', name:'Hat',        pair:'Wand'        }, { emoji:'🪄', name:'Wand',        pair:'Hat'        }],
];

const GIFTS = [
  { emoji:'📦', label:'Empty Box',   desc:'Better luck next time! 😅',          weight: 3 },
  { emoji:'💰', label:'₹10 Cash',    desc:'Collect from HR!',                   weight: 3 },
  { emoji:'💵', label:'₹20 Cash',    desc:'Collect from HR!',                   weight: 2 },
  { emoji:'🏖️', label:'1 Day Leave', desc:'Enjoy your well-deserved day off!',  weight: 1 },
];

function pickGift() {
  const total = GIFTS.reduce((s, g) => s + g.weight, 0);
  let r = Math.random() * total;
  for (const g of GIFTS) { r -= g.weight; if (r <= 0) return g; }
  return GIFTS[0];
}

const MAX_PLAYERS = 100;
let playerCounter = 0;

// ── Room management ───────────────────────────────────────────────────────────
const rooms = new Map(); // roomCode → room

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcastWaitingRoom(room) {
  const players = room.waitingRoom.map(p => ({ name: p.realName }));
  room.waitingRoom.forEach(p => send(p.ws, {
    type:     'pregame_update',
    players,
    isHost:   p === room.host,
    hostName: room.host ? room.host.realName : null,
    roomCode: room.code,
  }));
}

function broadcastLobby(room) {
  const count = room.lobby.length;
  room.lobby.forEach(p => send(p.ws, { type: 'lobby_update', count }));
}

function tryPair(room) {
  while (room.lobby.length >= 2) {
    const p1 = room.lobby.shift();
    const p2 = room.lobby.shift();
    startGame(room, p1, p2);
  }
  broadcastLobby(room);
}

function startGame(room, p1, p2) {
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)];
  const flip = Math.random() < 0.5;
  const obj1 = flip ? pair[0] : pair[1];
  const obj2 = flip ? pair[1] : pair[0];

  p1.object = obj1; p1.code = genCode(); p1.opponent = p2; p1.matched = false; p1.attemptsLeft = 3;
  p2.object = obj2; p2.code = genCode(); p2.opponent = p1; p2.matched = false; p2.attemptsLeft = 3;

  send(p1.ws, { type:'game_start', object:obj1, myCode:p1.code, oppLabel:p2.realName, timeLimit:TIME_LIMIT });
  send(p2.ws, { type:'game_start', object:obj2, myCode:p2.code, oppLabel:p1.realName, timeLimit:TIME_LIMIT });

  const timer = setTimeout(() => endGame(p1, p2, false), TIME_LIMIT * 1000);
  p1.gameTimer = timer;
  p2.gameTimer = timer;
}

function endGame(p1, p2, matched) {
  clearTimeout(p1.gameTimer);
  if (matched) {
    send(p1.ws, { type:'game_end', matched:true,  gift:pickGift(), myObject:p1.object, oppObject:p2.object });
    send(p2.ws, { type:'game_end', matched:true,  gift:pickGift(), myObject:p2.object, oppObject:p1.object });
  } else {
    send(p1.ws, { type:'game_end', matched:false, myObject:p1.object, oppObject:p2.object });
    send(p2.ws, { type:'game_end', matched:false, myObject:p2.object, oppObject:p1.object });
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' };

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/find-your-mate.html';
  const filePath = path.join(DIR, urlPath);
  const ext      = path.extname(filePath).toLowerCase();
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const num = ++playerCounter;
  const player = {
    ws, num,
    realName:  null,
    room:      null,
    object:    null, code:      null,
    matched:   false, opponent: null,
    gameTimer: null,
  };

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));

      // ── Host creates a room ────────────────────────────────────────────────
      if (msg.type === 'create_room') {
        if (!msg.name?.trim()) { send(ws, { type:'error', reason:'Name is required.' }); return; }
        player.realName = msg.name.trim();
        const code = genRoomCode();
        const room = { code, host: player, waitingRoom: [player], lobby: [], gameActive: false };
        rooms.set(code, room);
        player.room = room;
        send(ws, { type:'room_created', roomCode: code, playerName: player.realName });
        broadcastWaitingRoom(room);
        console.log(`[ROOM] ${code} created by ${player.realName}`);
      }

      // ── Player joins a room ────────────────────────────────────────────────
      if (msg.type === 'join_room') {
        if (!msg.name?.trim()) { send(ws, { type:'error', reason:'Name is required.' }); return; }
        const code = (msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, { type:'join_error', reason:'Room not found. Check your code.' }); return; }
        if (room.gameActive) { send(ws, { type:'join_error', reason:'Game already started. Ask host to run another round.' }); return; }
        if (room.waitingRoom.length >= MAX_PLAYERS) { send(ws, { type:'join_error', reason:'Room is full.' }); return; }

        player.realName = msg.name.trim();
        player.room = room;
        room.waitingRoom.push(player);
        send(ws, { type:'joined', playerName: player.realName, isHost: false, roomCode: code });
        broadcastWaitingRoom(room);
        console.log(`[JOIN] ${player.realName} → room ${code} | ${room.waitingRoom.length} waiting`);
      }

      // ── Host starts game ───────────────────────────────────────────────────
      if (msg.type === 'admin_start') {
        const room = player.room;
        if (!room || player !== room.host) return;
        const count = room.waitingRoom.length;
        if (count < 2 || count % 2 !== 0) {
          send(ws, { type:'start_error', reason: count < 2
            ? 'Need at least 2 players to start.'
            : `Need an even number of players (currently ${count}).` });
          return;
        }
        room.gameActive = true;
        room.waitingRoom.forEach(p => send(p.ws, { type:'game_starting' }));
        while (room.waitingRoom.length > 0) room.lobby.push(room.waitingRoom.shift());
        tryPair(room);
        console.log(`[START] Room ${room.code} started | ${room.lobby.length} players`);
      }

      // ── Verify match ───────────────────────────────────────────────────────
      if (msg.type === 'verify') {
        const opp = player.opponent;
        if (!opp || player.matched) return;
        if (player.attemptsLeft <= 0) { send(ws, { type:'no_attempts' }); return; }
        if (msg.code !== opp.code) {
          player.attemptsLeft--;
          send(ws, { type:'verify_fail', reason:'wrong_code',    attemptsLeft:player.attemptsLeft }); return;
        }
        if (opp.matched) {
          player.attemptsLeft--;
          send(ws, { type:'verify_fail', reason:'opp_matched',   attemptsLeft:player.attemptsLeft }); return;
        }
        if (player.object.pair !== opp.object.name) {
          player.attemptsLeft--;
          send(ws, { type:'verify_fail', reason:'wrong_object',  attemptsLeft:player.attemptsLeft }); return;
        }
        player.matched = true;
        send(ws,     { type:'verify_ok' });
        send(opp.ws, { type:'opp_matched' });
        setTimeout(() => endGame(player, opp, true), 3000);
      }

      // ── Play again ─────────────────────────────────────────────────────────
      if (msg.type === 'play_again') {
        const room = player.room;
        if (!room) return;
        player.object = null; player.code = null;
        player.matched = false; player.opponent = null; player.gameTimer = null;
        room.lobby.push(player);
        send(ws, { type:'back_to_lobby', lobbyCount: room.lobby.length });
        broadcastLobby(room);
        tryPair(room);
      }

    } catch(e) { console.error('msg error:', e.message); }
  });

  ws.on('close', () => {
    const room = player.room;
    if (!room) return;

    // Remove from waiting room
    const wi = room.waitingRoom.indexOf(player);
    if (wi > -1) {
      room.waitingRoom.splice(wi, 1);
      if (player === room.host) room.host = room.waitingRoom[0] || null;
      broadcastWaitingRoom(room);
    }

    // Remove from lobby
    const li = room.lobby.indexOf(player);
    if (li > -1) room.lobby.splice(li, 1);

    // Notify opponent
    if (player.opponent) {
      clearTimeout(player.gameTimer);
      send(player.opponent.ws, { type:'opp_left' });
      player.opponent.opponent = null;
    }

    // Clean up empty room
    if (room.waitingRoom.length === 0 && room.lobby.length === 0) {
      rooms.delete(room.code);
      console.log(`[ROOM] ${room.code} closed`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🎯 Find Your Mate — running on http://localhost:${PORT}\n`);
});
