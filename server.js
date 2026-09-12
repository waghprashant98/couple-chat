const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);


// ==================================================
// SOCKET.IO
// ==================================================

const allowedOrigins = [
  "https://couple-chat-8msk.onrender.com",
  "http://localhost:4200"
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: false
  },

  maxHttpBufferSize: 10000
});


// ==================================================
// PORT
// ==================================================

const PORT = process.env.PORT || 3000;


// ==================================================
// ANGULAR BUILD
// ==================================================

const clientDist = path.join(
  __dirname,
  "client",
  "dist",
  "couple-chat",
  "browser"
);


// ==================================================
// PRIVATE CHAT SETTINGS
// ==================================================

const PRIVATE_ROOM_ID =
  "our-private-chat-9x7m2k8p";

const ALLOWED_NAMES = {
  prashant: "Prashant",
  manjushree: "Manjushree"
};

const CHAT_PASSCODE =
  String(process.env.CHAT_PASSCODE || "");


// ==================================================
// PostgreSQL / Supabase
// ==================================================

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,

      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;


// ==================================================
// DATABASE INITIALIZATION
// ==================================================

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


// ==================================================
// STATIC ANGULAR FILES
// ==================================================

app.use(express.static(clientDist));


// ==================================================
// HELPERS
// ==================================================

function cleanRoom(value) {

  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 100);
}


function getAllowedName(value) {

  const normalized =
    String(value || "")
      .trim()
      .toLowerCase()
      .slice(0, 24);

  return ALLOWED_NAMES[normalized] || null;
}


function cleanMessage(value) {

  return String(value || "")
    .trim()
    .slice(0, 2000);
}


// ==================================================
// PASSCODE CHECK
// ==================================================

function isValidPasscode(value) {

  if (!CHAT_PASSCODE) {
    return false;
  }


  const provided =
    Buffer.from(String(value || ""));

  const expected =
    Buffer.from(CHAT_PASSCODE);


  if (
    provided.length !==
    expected.length
  ) {
    return false;
  }


  return crypto.timingSafeEqual(
    provided,
    expected
  );
}


// ==================================================
// SOCKET.IO
// ==================================================

io.on("connection", (socket) => {

  // ==================================================
  // JOIN ROOM
  // ==================================================

  socket.on("join", async (data) => {

    // --------------------------------------------------
    // Prevent joining twice
    // --------------------------------------------------

    if (socket.data.authenticated) {
      return;
    }


    // --------------------------------------------------
    // Check passcode configuration
    // --------------------------------------------------

    if (!CHAT_PASSCODE) {

      socket.emit(
        "joinError",
        "Chat security is not configured."
      );

      return;
    }


    // --------------------------------------------------
    // Name
    // --------------------------------------------------

    const name =
      getAllowedName(data?.name);


    if (!name) {

      socket.emit(
        "joinError",
        "Only Prashant or Manjushree can enter."
      );

      return;
    }


    // --------------------------------------------------
    // Passcode
    // --------------------------------------------------

    if (
      !isValidPasscode(
        data?.passcode
      )
    ) {

      socket.emit(
        "joinError",
        "Incorrect passcode."
      );

      return;
    }


    // --------------------------------------------------
    // Room
    // --------------------------------------------------

    const requestedRoom =
      cleanRoom(data?.roomId);


    if (
      requestedRoom !==
      PRIVATE_ROOM_ID
    ) {

      socket.emit(
        "joinError",
        "Invalid private room."
      );

      return;
    }


    // --------------------------------------------------
    // Authenticate socket
    // --------------------------------------------------

    socket.data.roomId =
      PRIVATE_ROOM_ID;

    socket.data.name =
      name;

    socket.data.authenticated =
      true;


    socket.join(
      PRIVATE_ROOM_ID
    );


    // ==================================================
    // LOAD CHAT HISTORY
    // ==================================================

    if (pool) {

      try {

        const result =
          await pool.query(
            `
            SELECT
              id,
              sender,
              message,
              created_at
            FROM messages
            WHERE room_id = $1
            ORDER BY created_at ASC
            LIMIT 200
            `,
            [PRIVATE_ROOM_ID]
          );


        socket.emit(
          "history",

          result.rows.map((row) => ({
            id: String(row.id),

            name: row.sender,

            text: row.message,

            time:
              new Date(
                row.created_at
              ).toISOString()
          }))
        );


      } catch (error) {

        console.error(
          "History error:",
          error.message
        );

      }

    }


    // ==================================================
    // NOTIFY OTHER USER
    // ==================================================

    socket.to(
      PRIVATE_ROOM_ID
    ).emit(
      "system",
      `${name} joined the room ❤️`
    );


    socket.to(
      PRIVATE_ROOM_ID
    ).emit(
      "presence",
      {
        count:
          io.sockets.adapter.rooms
            .get(PRIVATE_ROOM_ID)
            ?.size || 1
      }
    );

  });


  // ==================================================
  // SEND MESSAGE
  // ==================================================

  socket.on("message", async (text) => {

    // --------------------------------------------------
    // Must be authenticated
    // --------------------------------------------------

    if (
      !socket.data.authenticated
    ) {
      return;
    }


    const roomId =
      socket.data.roomId;

    const name =
      socket.data.name;


    const cleanText =
      cleanMessage(text);


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


    // ==================================================
    // SAVE MESSAGE
    // ==================================================

    if (pool) {

      try {

        const result =
          await pool.query(
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
          String(
            result.rows[0].id
          );


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


    // ==================================================
    // SEND MESSAGE TO ROOM
    // ==================================================

    const payload = {

      id: savedId,

      name,

      text: cleanText,

      time: messageTime

    };


    io.to(
      roomId
    ).emit(
      "message",
      payload
    );

  });


  // ==================================================
  // TYPING
  // ==================================================

  socket.on("typing", () => {

    if (
      !socket.data.authenticated
    ) {
      return;
    }


    const roomId =
      socket.data.roomId;


    if (roomId) {

      socket.to(
        roomId
      ).emit(
        "typing",
        socket.data.name
      );

    }

  });


  // ==================================================
  // STOP TYPING
  // ==================================================

  socket.on("stopTyping", () => {

    if (
      !socket.data.authenticated
    ) {
      return;
    }


    const roomId =
      socket.data.roomId;


    if (roomId) {

      socket.to(
        roomId
      ).emit(
        "stopTyping"
      );

    }

  });


  // ==================================================
  // DISCONNECT
  // ==================================================

  socket.on("disconnect", () => {

    if (
      !socket.data.authenticated
    ) {
      return;
    }


    const roomId =
      socket.data.roomId;

    const name =
      socket.data.name;


    if (!roomId) {
      return;
    }


    socket.to(
      roomId
    ).emit(
      "presence",
      {
        count:
          io.sockets.adapter.rooms
            .get(roomId)
            ?.size || 0
      }
    );


    if (name) {

      socket.to(
        roomId
      ).emit(
        "system",
        `${name} left`
      );

    }

  });

});


// ==================================================
// ANGULAR FALLBACK
// ==================================================

app.get("*", (_, res) => {

  res.sendFile(
    path.join(
      clientDist,
      "index.html"
    )
  );

});


// ==================================================
// START SERVER
// ==================================================

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