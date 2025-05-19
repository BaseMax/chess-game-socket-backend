import { Socket, Server } from "socket.io";
import { createGame, joinGame, handleMove } from "./game/manager";

export function handleSocketEvents(socket: Socket, io: Server) {
  socket.on("create_game", (data) => createGame(socket, io, data));
  socket.on("join_game", (data) => joinGame(socket, io, data));
  socket.on("make_move", (data) => handleMove(socket, io, data));
}
