import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Chess } from 'chess.js';
import mysql from 'mysql2/promise';

const PORT = 3000;
const JWT_SECRET = 'secret';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'mychess',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// --- Auth APIs ---
app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Invalid or missing username (min 3 characters)' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Invalid or missing password (min 6 characters)' });
  }

  try {
    const existingUsers = await query('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await query(
      'INSERT INTO users (username, password_hash, rating, created_at) VALUES (?, ?, 1200, NOW())',
      [username, passwordHash]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Missing username or password' });
  }

  try {
    const users = await query(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );
    const user = users[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.json({ token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- Socket Auth ---
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized: No token provided'));

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch (err) {
    next(new Error('Unauthorized: Invalid token'));
  }
});

// --- Socket Events ---
io.on('connection', (socket) => {
  const userId = socket.userId;

  socket.on('createGame', async ({ type, chooseColor, timeLimit, isPublic }) => {
    // Validate inputs
    if (!type || typeof type !== 'string' || ![0,1,2].includes(chooseColor) === false || typeof timeLimit !== 'number') {
      return socket.emit('error', 'Invalid game creation parameters');
    }

    try {
      const result = await query(
        'INSERT INTO games (creator_id, type, choose_color, time_limit, is_public, created_at, status) VALUES (?, ?, ?, ?, ?, NOW(), 0)',
        [userId, type, chooseColor, timeLimit, isPublic ? 1 : 0]
      );
      const gameId = result.insertId;
      socket.join(`game:${gameId}`);
      socket.emit('gameCreated', { id: gameId, creatorId: userId, type, chooseColor, timeLimit, isPublic });
    } catch (error) {
      console.error('CreateGame error:', error);
      socket.emit('error', 'Could not create game');
    }
  });

  socket.on('joinGame', async ({ gameId }) => {
    if (!gameId || typeof gameId !== 'number') {
      return socket.emit('error', 'Invalid game ID');
    }

    try {
      const games = await query('SELECT * FROM games WHERE id = ?', [gameId]);
      const game = games[0];
      if (!game || game.status !== 0) return socket.emit('error', 'Game not available');

      await query('UPDATE games SET second_player_id = ?, status = 1 WHERE id = ?', [userId, gameId]);
      io.to(`game:${gameId}`).emit('gameStarted');
      socket.join(`game:${gameId}`);
    } catch (error) {
      console.error('JoinGame error:', error);
      socket.emit('error', 'Could not join game');
    }
  });

  socket.on('makeMove', async ({ gameId, move }) => {
    if (!gameId || typeof gameId !== 'number' || !move || typeof move !== 'string') {
      return socket.emit('error', 'Invalid move parameters');
    }

    try {
      const games = await query('SELECT * FROM games WHERE id = ?', [gameId]);
      const game = games[0];
      if (!game) return socket.emit('error', 'Game not found');

      const movesRows = await query('SELECT * FROM moves WHERE game_id = ? ORDER BY created_at', [gameId]);
      const gameState = new Chess();
      movesRows.forEach(m => gameState.move(m.move));

      const result = gameState.move(move);
      if (!result) return socket.emit('invalidMove');

      await query(
        'INSERT INTO moves (game_id, user_id, move, color, created_at) VALUES (?, ?, ?, ?, NOW())',
        [gameId, userId, move, result.color === 'w' ? 1 : 2]
      );

      io.to(`game:${gameId}`).emit('moveMade', move);

      if (gameState.isGameOver()) {
        // Determine winner: 1 = white, 2 = black, 0 = draw
        let winner;
        if (gameState.isDraw() || gameState.isStalemate() || gameState.isThreefoldRepetition()) {
          winner = 0;
        } else {
          winner = gameState.turn() === 'w' ? 2 : 1; // The opposite of who's turn it is, because game is over
        }

        await query('UPDATE games SET status = 2, winner = ? WHERE id = ?', [winner, gameId]);
        io.to(`game:${gameId}`).emit('gameOver', winner);
      }
    } catch (error) {
      console.error('MakeMove error:', error);
      socket.emit('error', 'Move failed');
    }
  });

  socket.on('sendMessage', async ({ gameId, message }) => {
    if (!gameId || typeof gameId !== 'number' || !message || typeof message !== 'string') {
      return socket.emit('error', 'Invalid message parameters');
    }

    try {
      await query(
        'INSERT INTO messages (game_id, user_id, message, created_at) VALUES (?, ?, ?, NOW())',
        [gameId, userId, message]
      );
      io.to(`game:${gameId}`).emit('newMessage', { userId, message });
    } catch (error) {
      console.error('SendMessage error:', error);
      socket.emit('error', 'Message sending failed');
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
