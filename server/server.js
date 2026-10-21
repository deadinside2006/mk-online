const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
app.get("/", (_req, res) => res.type("text").send("Mortal Kombat multiplayer server is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function roomFor(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function leaveRoom(socket, notify = true) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.data.role = null;
  socket.leave(code);
  if (!room) return;
  room.players.delete(socket.id);
  if (notify && room.players.size) {
    io.to(code).emit("room:peer-left", { message: "Второй игрок отключился." });
  }
  if (room.players.size === 0) rooms.delete(code);
}

io.on("connection", socket => {
  socket.on("room:create", (_payload, ack) => {
    leaveRoom(socket);
    const code = makeCode();
    const room = { code, players: new Map([[socket.id, "host"]]), started: false };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "host";
    if (typeof ack === "function") ack({ ok: true, code, role: "host" });
  });

  socket.on("room:join", (payload, ack) => {
    const code = String(payload?.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return typeof ack === "function" && ack({ ok: false, error: "Комната не найдена. Проверь код." });
    if (room.players.size >= 2) return typeof ack === "function" && ack({ ok: false, error: "В комнате уже два игрока." });
    if (room.started) return typeof ack === "function" && ack({ ok: false, error: "Этот бой уже начался." });
    leaveRoom(socket);
    room.players.set(socket.id, "guest");
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "guest";
    if (typeof ack === "function") ack({ ok: true, code, role: "guest" });
    socket.to(code).emit("room:peer-joined", { role: "guest" });
  });

  socket.on("player:character", payload => {
    const room = roomFor(socket);
    if (!room || room.started || !payload || !["host", "guest"].includes(socket.data.role)) return;
    // The server relays the selected fighter; it does not trust client data for room access.
    socket.to(room.code).emit("player:character", {
      role: socket.data.role,
      character: payload.character
    });
  });

  // Гость может подключиться после того, как хост уже выбрал персонажа.
  socket.on("player:request-character", () => {
    const room = roomFor(socket);
    if (!room || room.started || socket.data.role !== "guest") return;
    const hostEntry = [...room.players.entries()].find(([, role]) => role === "host");
    if (hostEntry) io.to(hostEntry[0]).emit("player:request-character");
  });

  socket.on("room:start", () => {
    const room = roomFor(socket);
    if (!room || socket.data.role !== "host" || room.players.size !== 2 || room.started) return;
    room.started = true;
    io.to(room.code).emit("room:start");
  });

  socket.on("room:rematch", () => {
    const room = roomFor(socket);
    if (!room || socket.data.role !== "host" || room.players.size !== 2) return;
    room.started = true;
    io.to(room.code).emit("room:rematch");
  });

  socket.on("player:input", payload => {
    const room = roomFor(socket);
    if (!room || !room.started || !payload || typeof payload !== "object") return;
    const i = payload.input || {};
    const clean = {
      left: !!i.left, right: !!i.right, up: !!i.up, down: !!i.down,
      punch: !!i.punch, kick: !!i.kick
    };
    socket.to(room.code).emit("player:input", { role: socket.data.role, input: clean });
  });

  socket.on("room:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => console.log(`MK multiplayer server listening on ${port}`));
