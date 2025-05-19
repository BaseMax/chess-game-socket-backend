import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Chess } from 'chess.js';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { createClient } from '@libsql/client';

import { integer, text, timestamp } from 'drizzle-orm/pg-core';

function sqliteTableCreator(prefixFn) {
  return function createTable(name, columns) {
    return { name: prefixFn(name), columns };
  };
}

const PORT = 3000;

const createTable = sqliteTableCreator((name) => `chess_${name}`);

const users = createTable('users', {
  id: integer('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  rating: integer('rating').default(1200),
  createdAt: text('created_at').default(() => new Date().toISOString())
});

const games = createTable('games', {
  id: integer('id').primaryKey(),
  creatorId: integer('creator_id').notNull(),
  secondPlayerId: integer('second_player_id'),
  type: text('type').notNull(),
  timeLimit: integer('time_limit'),
  chooseColor: integer('choose_color'),
  createdAt: text('created_at').default(() => new Date().toISOString()),
  expireAt: timestamp('expire_at'),
  status: integer('status').default(0),
  winner: integer('winner'),
  rating: integer('rating').default(0),
  isPublic: integer('is_public').default(0),
});

const moves = createTable('moves', {
  id: integer('id').primaryKey(),
  gameId: integer('game_id').notNull(),
  userId: integer('user_id').notNull(),
  color: integer('color'),
  move: text('move').notNull(),
  createdAt: text('created_at').default(() => new Date().toISOString()),
});

const messages = createTable('messages', {
  id: integer('id').primaryKey(),
  gameId: integer('game_id').notNull(),
  userId: integer('user_id').notNull(),
  message: text('message').notNull(),
  createdAt: text('created_at').default(() => new Date().toISOString()),
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const JWT_SECRET = 'secret';

const client = createClient({
  url: 'file:./db.sqlite',
  authToken: '',
});

const db = drizzle(client);

// --- Auth APIs ---
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ username, passwordHash });
  res.json({ success: true });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(users.columns.username);
  const user = await db.select().from(users).where(users.username.equals(username)).get();
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET);
  res.json({ token });
});

// --- Socket Auth ---
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
});

// --- Socket Events ---
io.on('connection', (socket) => {
  const userId = socket.userId;

  socket.on('createGame', async ({ type, chooseColor, timeLimit, isPublic }) => {
    const newGame = await db.insert(games).values({
      creatorId: userId,
      type,
      chooseColor,
      timeLimit,
      isPublic,
    }).returning();
    socket.join(`game:${newGame[0].id}`);
    socket.emit('gameCreated', newGame[0]);
  });

  socket.on('joinGame', async ({ gameId }) => {
    const game = await db.select().from(games).where(games.id.equals(gameId)).get();
    if (!game || game.status !== 0) return socket.emit('error', 'Game not available');

    await db.update(games).set({ secondPlayerId: userId, status: 1 }).where(games.id.equals(gameId));
    io.to(`game:${gameId}`).emit('gameStarted');
  });

  socket.on('makeMove', async ({ gameId, move }) => {
    const game = await db.select().from(games).where(games.id.equals(gameId)).get();
    if (!game) return;

    const gameState = new Chess();
    const allMoves = await db.select().from(moves).where(moves.gameId.equals(gameId)).orderBy(moves.createdAt);
    allMoves.forEach((m) => gameState.move(m.move));
    
    const result = gameState.move(move);
    if (!result) return socket.emit('invalidMove');

    await db.insert(moves).values({
      gameId,
      userId,
      move,
      color: result.color === 'w' ? 1 : 2,
    });

    io.to(`game:${gameId}`).emit('moveMade', move);

    if (gameState.isGameOver()) {
      const winner = gameState.turn() === 'w' ? 1 : 0;
      await db.update(games).set({ status: 2, winner }).where(games.id.equals(gameId));
      io.to(`game:${gameId}`).emit('gameOver', winner);
    }
  });

  socket.on('sendMessage', async ({ gameId, message }) => {
    await db.insert(messages).values({ gameId, userId, message });
    io.to(`game:${gameId}`).emit('newMessage', { userId, message });
  });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
