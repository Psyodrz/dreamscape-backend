/**
 * DreamScape Multiplayer Backend Server
 *
 * Architecture: Hybrid Server-Authoritative + P2P Relay
 * - Server manages room state, player list, game events
 * - P2P primary for real-time position updates
 * - Socket.IO fallback when P2P fails
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ═══════════════════════════════════════════════════════════════
// ROOM STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const rooms = new Map(); // roomCode -> RoomState

/**
 * Create a new room state object
 */
function createRoomState(code, hostId, hostName, hostGender) {
  return {
    code,
    hostId,
    mazeSeed: Math.floor(Math.random() * 100000),
    stage: 1,
    state: "lobby", // lobby | playing | ended
    createdAt: Date.now(),
    players: new Map([
      [hostId, createPlayerState(hostId, hostName, hostGender, true)],
    ]),
  };
}

/**
 * Create a new player state object
 */
function createPlayerState(id, name, gender, isHost = false) {
  return {
    id,
    peerId: null,
    name: name || "Player",
    gender: gender || "male",
    isHost,
    isReady: isHost, // Host is always ready
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    animState: "idle",
    lastUpdate: Date.now(),
    connected: true,
  };
}

/**
 * Generate a unique room code
 */
function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

/**
 * Get room state as serializable object
 */
function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    mazeSeed: room.mazeSeed,
    stage: room.stage,
    state: room.state,
    players: Array.from(room.players.values()).map(serializePlayer),
  };
}

/**
 * Serialize player state
 */
function serializePlayer(player) {
  return {
    id: player.id,
    peerId: player.peerId,
    name: player.name,
    gender: player.gender,
    isHost: player.isHost,
    isReady: player.isReady,
    position: player.position,
    rotation: player.rotation,
    animState: player.animState,
  };
}

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════

io.on("connection", (socket) => {
  console.log(`[CONNECT] Client: ${socket.id}`);

  // Track which room this socket is in
  let currentRoom = null;

  // ─────────────────────────────────────────────────────────────
  // ROOM MANAGEMENT
  // ─────────────────────────────────────────────────────────────

  socket.on("create-room", ({ playerName, playerGender }) => {
    const roomCode = generateRoomCode();
    const room = createRoomState(roomCode, socket.id, playerName, playerGender);
    rooms.set(roomCode, room);
    currentRoom = roomCode;

    socket.join(roomCode);
    console.log(`[ROOM] Created: ${roomCode} by ${playerName}`);

    socket.emit("room-created", {
      roomCode,
      players: Array.from(room.players.values()).map(serializePlayer),
    });
  });

  socket.on("join-room", ({ roomCode, playerName, playerGender }) => {
    const code = roomCode.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    if (room.state !== "lobby") {
      socket.emit("error", { message: "Game already in progress" });
      return;
    }

    if (room.players.size >= 4) {
      socket.emit("error", { message: "Room is full" });
      return;
    }

    // Add player to room
    const player = createPlayerState(
      socket.id,
      playerName,
      playerGender,
      false
    );
    room.players.set(socket.id, player);
    currentRoom = code;

    socket.join(code);
    console.log(`[ROOM] ${playerName} joined ${code}`);

    // Notify everyone
    socket.emit("joined-room", {
      roomCode: code,
      players: Array.from(room.players.values()).map(serializePlayer),
      mazeSeed: room.mazeSeed,
    });

    socket.to(code).emit("player-joined", {
      player: serializePlayer(player),
      players: Array.from(room.players.values()).map(serializePlayer),
    });
  });

  // ─────────────────────────────────────────────────────────────
  // READY STATE
  // ─────────────────────────────────────────────────────────────

  socket.on("player-ready", ({ roomCode, isReady }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      player.isReady = isReady;
      io.to(roomCode).emit("player-ready-changed", {
        playerId: socket.id,
        isReady,
        players: Array.from(room.players.values()).map(serializePlayer),
      });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GAME START
  // ─────────────────────────────────────────────────────────────

  socket.on("start-game", ({ roomCode, mazeSeed }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    // Only host can start
    if (room.hostId !== socket.id) {
      socket.emit("error", { message: "Only host can start the game" });
      return;
    }

    // Update room state
    room.state = "playing";
    room.mazeSeed = mazeSeed || room.mazeSeed;
    room.startTime = Date.now();

    console.log(`[GAME] Started in ${roomCode} with seed ${room.mazeSeed}`);

    io.to(roomCode).emit("game-started", {
      mazeSeed: room.mazeSeed,
      players: Array.from(room.players.values()).map(serializePlayer),
    });
  });

  // ─────────────────────────────────────────────────────────────
  // P2P SIGNALING
  // ─────────────────────────────────────────────────────────────

  socket.on("share-peer-id", ({ roomCode, peerId }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      player.peerId = peerId;
      console.log(`[P2P] Peer ID from ${player.name}: ${peerId}`);

      // Broadcast to others
      socket.to(roomCode).emit("peer-id-shared", {
        socketId: socket.id,
        peerId,
        playerName: player.name,
        playerGender: player.gender,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POSITION SYNC (Socket.IO Fallback)
  // ─────────────────────────────────────────────────────────────

  socket.on("sync-position", ({ roomCode, position, rotation, animState }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      // Update server-side state
      player.position = position;
      player.rotation = rotation;
      player.animState = animState;
      player.lastUpdate = Date.now();

      // Broadcast to others (excluding sender)
      socket.to(roomCode).emit("player-state", {
        playerId: socket.id,
        position,
        rotation,
        animState,
        timestamp: player.lastUpdate,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // STATE REQUESTS
  // ─────────────────────────────────────────────────────────────

  socket.on("request-state", ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit("error", { message: "Room not found" });
      return;
    }

    console.log(`[STATE] Full state requested by ${socket.id}`);
    socket.emit("full-state", serializeRoom(room));
  });

  // ─────────────────────────────────────────────────────────────
  // GAME EVENTS
  // ─────────────────────────────────────────────────────────────

  socket.on("stage-change", ({ roomCode, stage }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    // Only host can change stage
    if (room.hostId === socket.id) {
      room.stage = stage;
      io.to(roomCode).emit("stage-changed", { stage });
      console.log(`[GAME] Stage changed to ${stage} in ${roomCode}`);
    }
  });

  socket.on("player-spawned", ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    console.log(`[SPAWN] Player ${socket.id} spawned in ${roomCode}`);
    socket.to(roomCode).emit("player-spawn-confirmed", {
      playerId: socket.id,
      timestamp: Date.now(),
    });
  });

  // ─────────────────────────────────────────────────────────────
  // DISCONNECT
  // ─────────────────────────────────────────────────────────────

  socket.on("disconnect", () => {
    console.log(`[DISCONNECT] Client: ${socket.id}`);

    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const wasHost = player.isHost;
    room.players.delete(socket.id);

    // Notify others
    io.to(currentRoom).emit("player-left", {
      playerId: socket.id,
      playerName: player.name,
    });

    // Host left - destroy room
    if (wasHost) {
      console.log(`[ROOM] Host left ${currentRoom}, destroying room`);
      io.to(currentRoom).emit("room-destroyed", {
        reason: "Host disconnected",
      });
      rooms.delete(currentRoom);
    }
    // Empty room - cleanup
    else if (room.players.size === 0) {
      console.log(`[ROOM] Empty room ${currentRoom}, deleting`);
      rooms.delete(currentRoom);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// SERVER START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🎮 DreamScape Multiplayer Server running on port ${PORT}`);
});
