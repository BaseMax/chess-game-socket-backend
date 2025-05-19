mport { Socket } from "socket.io";
import { PrismaClient } from "../db/prisma";

const prisma = new PrismaClient();

export async function newFriendGame(socket: Socket, color: string) {
  return prisma.game.create({
    data: {
      mode: "friend",
      fen: "start",
      moves: [],
      status: "waiting",
      playerWhite: color === "white" ? socket.id : null,
      playerBlack: color === "black" ? socket.id : null,
    },
  });
}

export async function joinFriendGame(socket: Socket, game: any) {
  const updated = await prisma.game.update({
    where: { id: game.id },
    data: {
      playerWhite: game.playerWhite ?? socket.id,
      playerBlack: game.playerBlack ?? socket.id,
      status: "in_progress",
    },
  });
  socket.join(game.id);
  return updated;
}
