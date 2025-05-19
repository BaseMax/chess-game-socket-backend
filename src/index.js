import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Chess } from 'chess.js';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = 3000;
const JWT_SECRET = 'secret';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function initTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      rating INT DEFAULT 1200,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS games (
      id INT AUTO_INCREMENT PRIMARY KEY,
      creator_id INT NOT NULL,
      second_player_id INT DEFAULT NULL,
      type VARCHAR(50) NOT NULL,
      choose_color TINYINT NOT NULL,
      time_limit INT NOT NULL,
      is_public TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME DEFAULT NULL,
      status TINYINT NOT NULL DEFAULT 0, -- 0 = waiting, 1 = active, 2 = finished
      winner TINYINT DEFAULT NULL
    )
  `);
  // Determine winner: 1 = white, 2 = black, 0 = draw

  await query(`
    CREATE TABLE IF NOT EXISTS moves (
      id INT AUTO_INCREMENT PRIMARY KEY,
      game_id INT NOT NULL,
      user_id INT NOT NULL,
      move VARCHAR(10) NOT NULL,
      color TINYINT NOT NULL, -- 1 = white, 2 = black
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      game_id INT NOT NULL,
      user_id INT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

initTables()
  .then(() => {
    server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Error initializing database tables:', err);
    process.exit(1);
  });

async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// --- Routes ---
app.get('/', (req, res) => {
  const parentDir = path.join(__dirname, '..');
  const indexPath = path.join(parentDir, 'index.html');
  res.sendFile(indexPath);
});

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

  socket.emit('checkJoinGames');
  socket.emit('checkOpenGames');

  socket.on('getMyUser', async () => {
    try {
      const users = await query('SELECT * FROM users WHERE id = ?', [userId]);
      const user = users[0];
      if (!user) return socket.emit('myUser', 'User not found');
      socket.emit('myUser', { id: user.id, username: user.username, rating: user.rating });
    } catch (error) {
      console.error('GetMyUser error:', error);
      socket.emit('myUser', 'Could not fetch user');
    }
  });

  socket.on('availablePublicGamesToWatch', async () => {
    try {
      const games = await query(
        'SELECT * FROM games WHERE (creator_id != ? AND second_player_id != ? AND second_player_id IS NOT NULL) AND is_public = 1 AND status = 1 ORDER BY id DESC',
        [userId, userId]
      );
      socket.emit('availablePublicGamesToWatch', games);
      if (games.length === 0) {
        socket.emit('noAvailablePublicGamesToWatch');
      }
    } catch (error) {
      console.error('AvailablePublicGames error:', error);
      socket.emit('availablePublicGamesToWatch', 'Could not fetch available public games');
    }
  });

  socket.on('availablePublicGamesToJoin', async () => {
    try {
      const games = await query(
        'SELECT * FROM games WHERE (creator_id != ? AND second_player_id IS NULL) AND is_public = 1 AND status = 0 ORDER BY id DESC',
        [userId]
      );
      socket.emit('availablePublicGamesToJoin', games);
      if (games.length === 0) {
        socket.emit('noAvailablePublicGamesToJoin');
      }
    } catch (error) {
      console.error('AvailablePublicGames error:', error);
      socket.emit('availablePublicGamesToJoin', 'Could not fetch available public games');
    }
  });

  socket.on('myGames', async () => {
    try {
      const games = await query(
        'SELECT * FROM games WHERE creator_id = ? OR second_player_id = ? ORDER BY id DESC',
        [userId, userId]
      );
      socket.emit('myGamesList', games);
      if (games.length === 0) {
        socket.emit('myGamesList', 'No games found');
      }
    } catch (error) {
      console.error('MyGames error:', error);
      socket.emit('myGamesList', 'Could not fetch games');
    }
  });

  socket.on('checkJoinGames', async () => {
    try {
      const games = await query(
        'SELECT * FROM games WHERE (creator_id = ? OR second_player_id = ?) AND (status = 0 OR status = 1) ORDER BY id DESC',
        [userId, userId]
      );
      socket.emit('joinGames', games);
      if (games.length > 0) {
        games.forEach(game => {
          socket.join(`game:${game.id}`);
        });
      } else {
        socket.emit('noJoinGames');
      }
    } catch (error) {
      console.error('CheckOpenGames error:', error);
      socket.emit('joinGames', 'Could not check open games');
    }
  });

  socket.on('checkOpenGames', async () => {
    try {
      const games = await query(
        'SELECT * FROM games WHERE (creator_id = ? OR second_player_id = ?) AND (status = 0 OR status = 1) ORDER BY id DESC',
        [userId, userId]
      );
      if (games.length > 0) {
        const lastGame = games[0];
        socket.emit('openGame', { gameId: lastGame.id, status: lastGame.status });
      } else {
        socket.emit('openGame', 'No open games found');
        socket.emit('noOpenGames');
      }
    } catch (error) {
      console.error('CheckOpenGames error:', error);
      socket.emit('openGame', 'Could not check open games');
    }
  });

  socket.on('getGameInfo', async ({ gameId }) => {
    if (!gameId || typeof gameId !== 'number') {
      return socket.emit('gameInfo', 'Invalid game ID');
    }
    try {
      const games = await query('SELECT * FROM games WHERE id = ?', [gameId]);
      const game = games[0];
      if (!game) return socket.emit('gameInfo', 'Game not found');
      
      const moves = await query('SELECT * FROM moves WHERE game_id = ? ORDER BY created_at', [gameId]);
      const messages = await query('SELECT * FROM messages WHERE game_id = ? ORDER BY created_at', [gameId]);
      const gameInfo = {
        id: game.id,
        creatorId: game.creator_id,
        secondPlayerId: game.second_player_id,
        type: game.type,
        chooseColor: game.choose_color,
        timeLimit: game.time_limit,
        isPublic: game.is_public,
        status: game.status,
        moves,
        messages
      };
      socket.emit('gameInfo', gameInfo);
    } catch (error) {
      console.error('GetGameInfo error:', error);
      socket.emit('gameInfo', 'Could not get game info');
    }
  });

  socket.on('createGame', async ({ type, chooseColor, timeLimit, isPublic }) => {
    if (!type || typeof type !== 'string') {
      return socket.emit('gameCreated', 'Invalid game type');
    } else if (chooseColor === undefined || chooseColor === null || ![0, 1, 2].includes(chooseColor)) {
      return socket.emit('gameCreated', 'Invalid color choice');
    } else if (!timeLimit || typeof timeLimit !== 'number') {
      return socket.emit('gameCreated', 'Invalid time limit');
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
      socket.emit('gameCreated', 'Could not create game');
    }
  });

  socket.on('watchGame', async ({ gameId }) => {
    if (!gameId || typeof gameId !== 'number') {
      return socket.emit('watchGame', 'Invalid game ID');
    }

    try {
      const games = await query('SELECT * FROM games WHERE id = ?', [gameId]);
      const game = games[0];

      if (!game) return socket.emit('watchGame', 'Game not available');
      if (game.status === 2) return socket.emit('watchGame', 'Game already finished');
      if (game.creator_id === userId) return socket.emit('watchGame', 'You cannot watch your own game');
      if (game.second_player_id === userId) return socket.emit('watchGame', 'You cannot watch your own game');
      if (game.is_public === 0) return socket.emit('watchGame', 'Game is private');

      io.to(`game:${gameId}`).emit('gameWatcherJoin', { userId });
      socket.join(`game:${gameId}`);
      socket.emit('watchGame', { gameId, userId, game });

      socket.on('disconnect', () => {
        socket.leave(`game:${gameId}`);
        io.to(`game:${gameId}`).emit('gameWatcherLeft', { userId });
      });
    } catch (error) {
      console.error('watchGame error:', error);
      socket.emit('watchGame', 'Could not watch game');
    }
  });

  socket.on('joinGame', async ({ gameId }) => {
    if (!gameId || typeof gameId !== 'number') {
      return socket.emit('joinGame', 'Invalid game ID');
    }

    try {
      const games = await query('SELECT * FROM games WHERE id = ?', [gameId]);
      const game = games[0];

      if (!game) return socket.emit('joinGame', 'Game not available');
      if (game.status === 2) return socket.emit('joinGame', 'Game already finished');
      if (game.creator_id === userId) return socket.emit('joinGame', 'You cannot join your own game, next player must join');
      if (game.second_player_id && game.second_player_id !== userId) return socket.emit('joinGame', 'Game already has two players');

      await query('UPDATE games SET second_player_id = ?, status = 1 WHERE id = ?', [userId, gameId]);
      io.to(`game:${gameId}`).emit('gameStarted');
      socket.join(`game:${gameId}`);
      socket.emit('joinGame', { gameId, userId, game });
    } catch (error) {
      console.error('JoinGame error:', error);
      socket.emit('joinGame', 'Could not join game');
    }
  });

  socket.on('makeMove', async ({ gameId, move }) => {
    if (!gameId || typeof gameId !== 'number' || !move || typeof move !== 'string') {
      return socket.emit('moveMade', 'Invalid move parameters');
    }

    try {
      const games = await query('SELECT * FROM games WHERE id = ?', [gameId]);
      const game = games[0];
      if (!game) return socket.emit('moveMade', 'Game not found');
      if (game.status == 2) return socket.emit('moveMade', 'Game already finished');
      if (game.status !== 1) return socket.emit('moveMade', 'Game is not active');

      const movesRows = await query('SELECT * FROM moves WHERE game_id = ? ORDER BY created_at ASC', [gameId]);
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
        let winner;
        if (gameState.isDraw() || gameState.isStalemate() || gameState.isThreefoldRepetition()) {
          winner = 0;
        } else {
          winner = gameState.turn() === 'w' ? 2 : 1;
        }

        const finishedAt = new Date();
        await query('UPDATE games SET status = 2, winner = ?, finished_at = ? WHERE id = ?', [winner, gameId, finishedAt]);
        io.to(`game:${gameId}`).emit('gameOver', winner);
      }
    } catch (error) {
      console.error('MakeMove error:', error);
      socket.emit('invalidMove', 'Move failed');
    }
  });

  socket.on('sendMessage', async ({ gameId, message }) => {
    if (!gameId || typeof gameId !== 'number' || !message || typeof message !== 'string') {
      return socket.emit('newMessage', 'Invalid message parameters');
    }

    try {
      const games = await query('SELECT * FROM games WHERE id = ?', [gameId]);
      const game = games[0];
      if (!game) return socket.emit('newMessage', 'Game not found');

      if (game.status === 0) return socket.emit('newMessage', 'Game is not active - waiting for next player');

      // Check if game is finished and if the message is sent after 10 minutes (10 minutes is the threshold)
      if (game.status === 2 && game.finished_at) {
        const finishedTime = new Date(game.finished_at);
        const currentTime = new Date();
        const timeDiff = Math.abs(currentTime - finishedTime);
        const diffMinutes = Math.floor((timeDiff / 1000) / 60);
        if (diffMinutes > 10) {
          return socket.emit('newMessage', 'Game already finished');
        }
      }

      await query(
        'INSERT INTO messages (game_id, user_id, message, created_at) VALUES (?, ?, ?, NOW())',
        [gameId, userId, message]
      );
      io.to(`game:${gameId}`).emit('newMessage', { userId, message });
    } catch (error) {
      console.error('SendMessage error:', error);
      socket.emit('newMessage', 'Message sending failed');
    }
  });
});
