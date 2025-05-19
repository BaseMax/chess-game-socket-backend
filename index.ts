// index.ts
import { Server } from "socket.io";
import { Chess } from "chess.js";
import { db } from "./db";
import { games, moves, users } from "./schema";
import { eq } from "drizzle-orm";

const io = new Server(3000, {
  cors: { origin: "*" }
});

console.log("Socket server listening on ws://localhost:3000");

const activeGames = new Map<number, Chess>(); // gameId -> Chess instance

io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);

  socket.on("joinGame", async ({ gameId, userId }) => {
    const game = await db.query.games.findFirst({ where: eq(games.id, gameId) });
    if (!game) return socket.emit("error", "Game not found");

    socket.join(`game-${gameId}`);
    if (!activeGames.has(gameId)) activeGames.set(gameId, new Chess());

    io.to(`game-${gameId}`).emit("playerJoined", { userId });
  });

  socket.on("makeMove", async ({ gameId, userId, move }) => {
    const game = activeGames.get(gameId);
    if (!game) return socket.emit("error", "Game not loaded");

    const result = game.move(move); // e.g., { from: 'e2', to: 'e4' }
    if (!result) return socket.emit("invalidMove");

    await db.insert(moves).values({
      gameId,
      userId,
      color: game.turn() === "w" ? 2 : 1,
      move: result.san,
      createdAt: Date.now()
    });

    io.to(`game-${gameId}`).emit("moveMade", result);

    if (game.isGameOver()) {
      io.to(`game-${gameId}`).emit("gameOver", {
        winner: game.inCheckmate() ? (game.turn() === "w" ? 1 : 0) : null
      });
    }
  });

  socket.on("sendMessage", async ({ gameId, userId, message }) => {
    await db.insert(messages).values({
      gameId,
      userId,
      message,
      createdAt: Date.now()
    });

    io.to(`game-${gameId}`).emit("message", { userId, message });
  });
});
