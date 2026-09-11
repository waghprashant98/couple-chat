const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const clientDist = path.join(
  __dirname,
  "client",
  "dist",
  "couple-chat",
  "browser"
);

app.use(express.static(clientDist));

io.on("connection", (socket) => {
  socket.on("join", (name) => {
    socket.data.name =
      String(name || "Someone").trim().slice(0, 24) || "Someone";

    socket.broadcast.emit(
      "system",
      `${socket.data.name} joined ❤️`
    );
  });

  socket.on("message", (text) => {
    const clean = String(text || "").trim().slice(0, 1000);

    if (!clean) return;

    io.emit("message", {
      name: socket.data.name || "Someone",
      text: clean,
      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })
    });
  });

  socket.on("typing", () => {
    socket.broadcast.emit(
      "typing",
      socket.data.name || "Someone"
    );
  });

  socket.on("stopTyping", () => {
    socket.broadcast.emit("stopTyping");
  });

  socket.on("disconnect", () => {
    if (socket.data.name) {
      socket.broadcast.emit(
        "system",
        `${socket.data.name} left`
      );
    }
  });
});

app.get("*", (_, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});