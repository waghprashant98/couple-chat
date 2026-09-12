const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: false
  }
});

const PORT = process.env.PORT || 3000;

const clientDist = path.join(
  __dirname,
  "client",
  "dist",
  "couple-chat"
);

// =========================
// PostgreSQL / Supabase
// =========================

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

async function initDb() {
  if (!pool) {
    console.warn(
      "DATABASE_URL is not set. Chat history will not be saved."
    );
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      room_id VARCHAR(100) NOT NULL,
      sender VARCHAR(24) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS messages_room_created_idx
      ON messages(room_id, created_at);
  `);

  console.log("PostgreSQL ready");
}

// =========================
// Static Angular files
// =========================

app.use(express.static(clientDist));

// =========================
// Helpers
// =========================

function cleanRoom(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 100);
}

function cleanName(value) {
  return (
    String(value || "")
      .trim()
      .slice(0, 24) || "Someone"
  );
}

// =========================
// Socket.IO
// =========================

io.on("connection", (socket) => {

  // =========================
  // Join Room
  // =========================

  socket.on("join", async (data) => {

    const roomId = cleanRoom(data?.roomId);
    const name = cleanName(data?.name);

    if (!roomId) {
      socket.emit(
        "joinError",
        "Please enter a room code."
      );
      return;
    }

    socket.data.roomId = roomId;
    socket.data.name = name;

    socket.join(roomId);

    // =========================
    // Load Chat History
    // =========================

    if (pool) {
      try {

        const result = await pool.query(
          `
          SELECT id, sender, message, created_at
          FROM messages
          WHERE room_id = $1
          ORDER BY created_at ASC
          LIMIT 200
          `,
          [roomId]
        );

        socket.emit(
          "history",
          result.rows.map((row) => ({
            id: String(row.id),
            name: row.sender,
            text: row.message,

            // Send ISO timestamp.
            // Browser will convert it to local time.
            time: new Date(row.created_at).toISOString()
          }))
        );

      } catch (error) {

        console.error(
          "History error:",
          error.message
        );

      }
    }

    // =========================
    // Notify Other User
    // =========================

    socket.to(roomId).emit(
      "system",
      `${name} joined the room ❤️`
    );

    socket.to(roomId).emit(
      "presence",
      {
        count:
          io.sockets.adapter.rooms.get(roomId)?.size || 1
      }
    );

  });


  // =========================
  // Send Message
  // =========================

  socket.on("message", async (text) => {

    const roomId = socket.data.roomId;
    const name = socket.data.name;

    const cleanText = String(text || "")
      .trim()
      .slice(0, 2000);

    if (
      !roomId ||
      !name ||
      !cleanText
    ) {
      return;
    }

    let savedId =
      `${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;

    let messageTime =
      new Date().toISOString();


    // =========================
    // Save Message to Database
    // =========================

    if (pool) {

      try {

        const result = await pool.query(
          `
          INSERT INTO messages
            (room_id, sender, message)
          VALUES
            ($1, $2, $3)
          RETURNING id, created_at
          `,
          [
            roomId,
            name,
            cleanText
          ]
        );

        savedId =
          String(result.rows[0].id);

        messageTime =
          new Date(
            result.rows[0].created_at
          ).toISOString();

      } catch (error) {

        console.error(
          "Save error:",
          error.message
        );

      }

    }


    // =========================
    // Send Message to Room
    // =========================

    const payload = {
      id: savedId,
      name,
      text: cleanText,

      // ISO timestamp.
      // Frontend converts this to local time.
      time: messageTime
    };

    io.to(roomId).emit(
      "message",
      payload
    );

  });


  // =========================
  // Typing
  // =========================

  socket.on("typing", () => {

    const roomId =
      socket.data.roomId;

    if (roomId) {

      socket.to(roomId).emit(
        "typing",
        socket.data.name
      );

    }

  });


  // =========================
  // Stop Typing
  // =========================

  socket.on("stopTyping", () => {

    const roomId =
      socket.data.roomId;

    if (roomId) {

      socket.to(roomId).emit(
        "stopTyping"
      );

    }

  });


  // =========================
  // Disconnect
  // =========================

  socket.on("disconnect", () => {

    const roomId =
      socket.data.roomId;

    const name =
      socket.data.name;

    if (!roomId) {
      return;
    }

    socket.to(roomId).emit(
      "presence",
      {
        count:
          io.sockets.adapter.rooms.get(roomId)?.size || 0
      }
    );

    if (name) {

      socket.to(roomId).emit(
        "system",
        `${name} left`
      );

    }

  });

});


// =========================
// Angular Fallback
// =========================

app.get("*", (_, res) => {

  res.sendFile(
    path.join(
      clientDist,
      "index.html"
    )
  );

});


// =========================
// Start Server
// =========================

initDb()
  .then(() => {

    server.listen(
      PORT,
      () => {
        console.log(
          `Running on port ${PORT}`
        );
      }
    );

  })
  .catch((error) => {

    console.error(
      "Database initialization failed:",
      error.message
    );

    server.listen(
      PORT,
      () => {

        console.log(
          `Running on port ${PORT} without database`
        );

      }
    );

  });