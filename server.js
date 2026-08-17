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
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
let playerCounter = 0;

// ── Game state ────────────────────────────────────────────────────────────────
const waitingRoom = []; // players before game starts
const lobby       = []; // players waiting to be paired (game in progress)
const active      = new Set();
let   hostPlayer  = null;
let   gameActive  = false;

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcastWaitingRoom() {
  const players = waitingRoom.map(p => ({ name: p.realName || p.label }));
  waitingRoom.forEach(p => send(p.ws, {
    type:     'pregame_update',
    players,
    isHost:   p === hostPlayer,
    hostName: hostPlayer ? (hostPlayer.realName || hostPlayer.label) : null,
  }));
}

function broadcastLobby() {
  const count = lobby.length;
  lobby.forEach(p => send(p.ws, { type:'lobby_update', count }));
}

function tryPair() {
  while (lobby.length >= 2) {
    const p1 = lobby.shift();
    const p2 = lobby.shift();
    startGame(p1, p2);
  }
  broadcastLobby();
}

function startGame(p1, p2) {
  const pair = PAIRS[Math.floor(Math.random() * PAIRS.length)];
  const flip = Math.random() < 0.5;
  const obj1 = flip ? pair[0] : pair[1];
  const obj2 = flip ? pair[1] : pair[0];

  p1.object = obj1; p1.code = genCode(); p1.opponent = p2; p1.matched = false; p1.attemptsLeft = 3;
  p2.object = obj2; p2.code = genCode(); p2.opponent = p1; p2.matched = false; p2.attemptsLeft = 3;

  send(p1.ws, { type:'game_start', object:obj1, myCode:p1.code, oppLabel:p2.realName || p2.label, timeLimit:TIME_LIMIT });
  send(p2.ws, { type:'game_start', object:obj2, myCode:p2.code, oppLabel:p1.realName || p1.label, timeLimit:TIME_LIMIT });

  const timer = setTimeout(() => endGame(p1, p2, false), TIME_LIMIT * 1000);
  p1.gameTimer = timer;
  p2.gameTimer = timer;

  console.log(`[GAME] ${p1.realName} vs ${p2.realName} | ${obj1.name} ↔ ${obj2.name}`);
}

function endGame(p1, p2, matched) {
  clearTimeout(p1.gameTimer);
  if (matched) {
    const gift1 = pickGift();
    const gift2 = pickGift();
    send(p1.ws, { type:'game_end', matched:true,  gift:gift1, myObject:p1.object, oppObject:p2.object });
    send(p2.ws, { type:'game_end', matched:true,  gift:gift2, myObject:p2.object, oppObject:p1.object });
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
    label:       `Player ${num}`,
    realName:    null,
    object:      null, code:      null,
    matched:     false, opponent: null,
    gameTimer:   null,
  };

  active.add(player);

  if (active.size > MAX_PLAYERS) {
    send(ws, { type:'room_full', max: MAX_PLAYERS });
    ws.close();
    return;
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));

      // ── Join ────────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        player.realName = msg.name || player.label;

        if (!gameActive) {
          // Pre-game waiting room
          waitingRoom.push(player);
          if (!hostPlayer) hostPlayer = player;
          send(ws, { type:'joined', playerLabel:player.realName, isHost: player === hostPlayer });
          broadcastWaitingRoom();
          console.log(`[WAITING] ${player.realName} | ${waitingRoom.length} waiting`);
        } else {
          // Game already running — join pairing queue
          lobby.push(player);
          send(ws, { type:'joined', playerLabel:player.realName, isHost:false, lobbyCount:lobby.length });
          broadcastLobby();
          tryPair();
        }
      }

      // ── Host starts the game ────────────────────────────────────────────────
      if (msg.type === 'admin_start') {
        if (player !== hostPlayer) return;
        if (waitingRoom.length < 2 || waitingRoom.length % 2 !== 0) {
          send(ws, { type:'start_error', reason:`Need an even number of players to start (currently ${waitingRoom.length}).` });
          return;
        }
        gameActive = true;
        // Notify everyone game is starting
        waitingRoom.forEach(p => send(p.ws, { type:'game_starting' }));
        // Move all to pairing lobby
        while (waitingRoom.length > 0) lobby.push(waitingRoom.shift());
        hostPlayer = null;
        tryPair();
        console.log(`[START] Game started | ${lobby.length} players`);
      }

      // ── Verify match ────────────────────────────────────────────────────────
      if (msg.type === 'verify') {
        const opp = player.opponent;
        if (!opp || player.matched) return;
        if (player.attemptsLeft <= 0) { send(ws, { type:'no_attempts' }); return; }

        if (msg.code !== opp.code) {
          player.attemptsLeft--;
          send(ws, { type:'verify_fail', reason:'wrong_code',   attemptsLeft:player.attemptsLeft }); return;
        }
        if (opp.matched) {
          player.attemptsLeft--;
          send(ws, { type:'verify_fail', reason:'opp_matched',  attemptsLeft:player.attemptsLeft }); return;
        }
        if (player.object.pair !== opp.object.name) {
          player.attemptsLeft--;
          send(ws, { type:'verify_fail', reason:'wrong_object', attemptsLeft:player.attemptsLeft }); return;
        }

        player.matched = true;
        send(ws,     { type:'verify_ok' });
        send(opp.ws, { type:'opp_matched' });
        setTimeout(() => endGame(player, opp, true), 3000);
      }

      // ── Play again ──────────────────────────────────────────────────────────
      if (msg.type === 'play_again') {
        player.object = null; player.code = null;
        player.matched = false; player.opponent = null; player.gameTimer = null;
        lobby.push(player);
        send(ws, { type:'back_to_lobby', lobbyCount:lobby.length });
        broadcastLobby();
        tryPair();
      }

    } catch(e) { console.error('msg error:', e.message); }
  });

  ws.on('close', () => {
    active.delete(player);

    // Remove from waiting room
    const wi = waitingRoom.indexOf(player);
    if (wi > -1) {
      waitingRoom.splice(wi, 1);
      if (player === hostPlayer) hostPlayer = waitingRoom[0] || null;
      broadcastWaitingRoom();
    }

    // Remove from pairing lobby
    const li = lobby.indexOf(player);
    if (li > -1) lobby.splice(li, 1);

    // Handle in-game opponent
    if (player.opponent) {
      clearTimeout(player.gameTimer);
      send(player.opponent.ws, { type:'opp_left' });
      player.opponent.opponent = null;
    }

    console.log(`[GONE] ${player.realName || player.label} | total: ${active.size}`);
    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log(`\n🎯 Find Your Mate — running on http://localhost:${PORT}\n`);
});
