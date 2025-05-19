import { createServer } from "http";
import { Server } from "socket.io";
import { handleSocketEvents } from "./socket";

const PORT = 3000;

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  handleSocketEvents(socket, io);
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
