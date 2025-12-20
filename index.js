const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for simplicity (Mobile app/Web)
    methods: ["GET", "POST"]
  }
});

// Rooms state: { roomId: { players: [], state: 'lobby'|'playing', mazeSeed: number } }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // --- CREATE ROOM ---
  socket.on('create-room', ({ playerName, playerGender }) => {
    // Generate 6-char code
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Create room state
    rooms.set(roomCode, {
      id: roomCode,
      hostId: socket.id,
      state: 'lobby',
      mazeSeed: Math.floor(Math.random() * 1000000),
      players: [{
        id: socket.id,
        name: playerName,
        gender: playerGender,
        isHost: true,
        isReady: true // Host is always ready
      }]
    });
    
    socket.join(roomCode);
    
    console.log(`Room created: ${roomCode} by ${playerName}`);
    
    // Send room details back to host
    socket.emit('room-created', {
      roomCode,
      playerId: socket.id,
      players: rooms.get(roomCode).players
    });
  });

  // --- JOIN ROOM ---
  socket.on('join-room', ({ roomCode, playerName, playerGender }) => {
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    
    if (room.players.length >= 8) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    
    // Add player
    const newPlayer = {
      id: socket.id,
      name: playerName,
      gender: playerGender,
      isHost: false,
      isReady: false
    };
    
    room.players.push(newPlayer);
    socket.join(roomCode);
    
    console.log(`Player ${playerName} joined room ${roomCode}`);
    
    // Notify joining player
    socket.emit('joined-room', {
      roomCode,
      playerId: socket.id,
      players: room.players,
      mazeSeed: room.mazeSeed
    });
    
    // Notify others in room
    socket.to(roomCode).emit('player-joined', newPlayer);
  });

  // --- PLAYER READY (For Lobby UI) ---
  socket.on('player-ready', ({ roomCode, isReady }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.isReady = isReady;
      io.to(roomCode).emit('player-update', player);
    }
  });

  // --- START GAME ---
  socket.on('start-game', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    // Safety check: Only host can start
    if (room.hostId !== socket.id) return;
    
    room.state = 'playing';
    console.log(`Starting game in room ${roomCode}`);
    
    // Broadcast start to ALL players in room
    io.to(roomCode).emit('game-started', {
      mazeSeed: room.mazeSeed,
      players: room.players // Clients will use this to know who to connect to via PeerJS
    });
  });

  // --- EXCHANGE PEER ID ---
  // Once clients init PeerJS, they send their ID here to share with room
  socket.on('share-peer-id', ({ roomCode, peerId }) => {
    console.log(`Peer ID received from ${socket.id}: ${peerId}`);
    // Broadcast this peer ID to everyone else so they can connect
    socket.to(roomCode).emit('peer-id-shared', {
      socketId: socket.id,
      peerId: peerId
    });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Scan rooms to remove player
    rooms.forEach((room, roomCode) => {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        const wasHost = room.players[index].isHost;
        room.players.splice(index, 1);
        
        // Notify remaining players
        io.to(roomCode).emit('player-left', { playerId: socket.id });
        
        // Strict Phase 1 Requirement: Destroy room if host leaves
        if (wasHost) {
          console.log(`Host left room ${roomCode}. Destroying room.`);
          io.to(roomCode).emit('room-destroyed', { reason: 'Host disconnected' });
          rooms.delete(roomCode);
        } else if (room.players.length === 0) {
          rooms.delete(roomCode);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Lobby Server running on port ${PORT}`);
});
