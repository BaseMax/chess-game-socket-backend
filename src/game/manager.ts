import { Socket, Server } from "socket.io";
import { PrismaClient } from "../db/prisma";
import { newFriendGame, joinFriendGame } from "./vs-friend";
import { newBotGame, handleBotMove } from "./vs-bot";
import { validateAndApplyMove } from "./validation";

const prisma = new PrismaClient();

export async function createGame(socket: Socket, io: Server, data: any) {
  const { mode, color } = data;
  const game = await prisma.game.create({
    data: {
      mode,
      fen: "start",
      moves: [],
      status: "waiting",
      playerWhite: color === "white" ? socket.id : null,
      playerBlack: color === "black" ? socket.id : null,
    },
  });
  socket.join(game.id);
  socket.emit("game_created", game);
  if (mode === "bot") newBotGame(socket, game);
}

export async function joinGame(socket: Socket, io: Server, data: any) {
  const { gameId } = data;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game || game.status !== "waiting") return socket.emit("error", "Invalid game");
  const updatedGame = await joinFriendGame(socket, game);
  io.to(gameId).emit("start_game", updatedGame);
}

export async function handleMove(socket: Socket, io: Server, data: any) {
  const { gameId, move } = data;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game || game.status !== "in_progress") return;

  const result = validateAndApplyMove(game.fen, move);
  if (!result.valid) return socket.emit("invalid_move", move);

  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      fen: result.fen,
      moves: [...game.moves, move],
    },
  });
  io.to(gameId).emit("move_made", { move, fen: result.fen });

  if (game.mode === "bot") handleBotMove(socket, updated);
}
