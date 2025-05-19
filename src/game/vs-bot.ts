import { Socket } from "socket.io";
import { PrismaClient } from "../db/prisma";
import { validateAndApplyMove } from "./validation";
import { Chess } from "chess.js";

const prisma = new PrismaClient();

export async function newBotGame(socket: Socket, game: any) {
  const updated = await prisma.game.update({
    where: { id: game.id },
    data: { status: "in_progress" },
  });
  socket.emit("start_game", updated);
}

export async function handleBotMove(socket: Socket, game: any) {
  const chess = new Chess(game.fen);
  const moves = chess.moves();
  const move = moves[Math.floor(Math.random() * moves.length)];
  const result = chess.move(move);
  if (!result) return;

  const updated = await prisma.game.update({
    where: { id: game.id },
    data: {
      fen: chess.fen(),
      moves: [...game.moves, move],
    },
  });
  socket.emit("move_made", { move, fen: chess.fen() });
}
