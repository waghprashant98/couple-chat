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

const PORT =
  process.env.PORT || 3000;


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
  String(
    process.env.CHAT_PASSCODE || ""
  );


// ==================================================
// PostgreSQL / Supabase
// ==================================================

const pool =
  process.env.DATABASE_URL
    ? new Pool({
      connectionString:
        process.env.DATABASE_URL,

      ssl: {
        rejectUnauthorized: false
      }
    })
    : null;


// ==================================================
// E2E PUBLIC KEYS
//
// Keys are kept only in server memory.
// They are NOT stored in Supabase.
//
// The server only relays public keys.
// Private keys never reach the server.
// ==================================================

const publicKeys = new Map();


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
      message TEXT,
      ciphertext TEXT,
      iv TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS ciphertext TEXT;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS iv TEXT;

    ALTER TABLE messages
      ALTER COLUMN message DROP NOT NULL;

    CREATE INDEX IF NOT EXISTS messages_room_created_idx
      ON messages(room_id, created_at);
  `);


  console.log(
    "PostgreSQL ready"
  );

}


// ==================================================
// STATIC ANGULAR FILES
// ==================================================

app.use(
  express.static(clientDist)
);


// ==================================================
// HELPERS
// ==================================================

function cleanRoom(value) {

  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9_-]/g,
      ""
    )
    .slice(0, 100);

}


function getAllowedName(value) {

  const normalized =
    String(value || "")
      .trim()
      .toLowerCase()
      .slice(0, 24);

  return (
    ALLOWED_NAMES[normalized] ||
    null
  );

}


// ==================================================
// PASSCODE CHECK
// ==================================================

function isValidPasscode(value) {

  if (!CHAT_PASSCODE) {
    return false;
  }


  const provided =
    Buffer.from(
      String(value || "")
    );


  const expected =
    Buffer.from(
      CHAT_PASSCODE
    );


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
// E2E PAYLOAD VALIDATION
// ==================================================

function isValidEncryptedMessage(data) {

  if (!data || typeof data !== "object") {
    return false;
  }


  if (
    typeof data.ciphertext !==
    "string"
  ) {
    return false;
  }


  if (
    typeof data.iv !==
    "string"
  ) {
    return false;
  }


  if (
    !data.ciphertext.length ||
    !data.iv.length
  ) {
    return false;
  }


  // Keep payload safely below
  // Socket.IO maxHttpBufferSize.
  if (
    data.ciphertext.length >
    9000
  ) {
    return false;
  }


  if (
    data.iv.length >
    100
  ) {
    return false;
  }


  return true;

}


// ==================================================
// SOCKET.IO
// ==================================================

io.on(
  "connection",
  (socket) => {


    // ==================================================
    // JOIN ROOM
    // ==================================================

    socket.on(
      "join",
      async (data) => {


        // --------------------------------------------------
        // Prevent joining twice
        // --------------------------------------------------

        if (
          socket.data.authenticated
        ) {
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
        // Validate name
        // --------------------------------------------------

        const name =
          getAllowedName(
            data?.name
          );


        if (!name) {

          socket.emit(
            "joinError",
            "Only Prashant or Manjushree can enter."
          );

          return;
        }


        // --------------------------------------------------
        // Validate passcode
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
        // Validate room
        // --------------------------------------------------

        const requestedRoom =
          cleanRoom(
            data?.roomId
          );


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
        // SEND EXISTING PEER PUBLIC KEY
        // ==================================================

        const existingPeer =
          Object.entries(
            Object.fromEntries(
              publicKeys
            )
          ).find(
            ([peerName]) =>
              peerName !== name
          );


        if (existingPeer) {

          const [
            peerName,
            peerKey
          ] = existingPeer;


          socket.emit(
            "peerPublicKey",
            {
              name: peerName,
              key: peerKey
            }
          );

        }


        // ==================================================
        // ASK THIS CLIENT FOR PUBLIC KEY
        // ==================================================

        socket.emit(
          "requestPublicKey"
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
                  ciphertext,
                  iv,
                  created_at
                FROM messages
                WHERE room_id = $1
                ORDER BY created_at ASC
                LIMIT 200
                `,
                [
                  PRIVATE_ROOM_ID
                ]
              );


            /*
             * Only encrypted messages are
             * sent to the E2E client.
             *
             * Old plaintext messages are
             * intentionally not sent because
             * they are not E2E encrypted.
             */

            const encryptedHistory =
              result.rows
                .filter(
                  row =>
                    row.ciphertext &&
                    row.iv
                )
                .map(
                  row => ({
                    id:
                      String(row.id),

                    name:
                      row.sender,

                    ciphertext:
                      row.ciphertext,

                    iv:
                      row.iv,

                    time:
                      new Date(
                        row.created_at
                      ).toISOString()
                  })
                );


            socket.emit(
              "history",
              encryptedHistory
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


      }
    );


    // ==================================================
    // PUBLIC KEY
    // ==================================================

    socket.on(
      "publicKey",
      (data) => {

        // Must be authenticated
        if (
          !socket.data.authenticated
        ) {
          return;
        }


        const name =
          socket.data.name;


        if (!name) {
          return;
        }


        if (
          !data ||
          typeof data !== "object"
        ) {
          return;
        }


        if (
          typeof data.key !==
          "object"
        ) {
          return;
        }


        // Store ONLY in server memory.
        // Never store private key.
        publicKeys.set(
          name.toLowerCase(),
          data.key
        );


        // Send this public key
        // to the other authenticated user.
        socket.to(
          PRIVATE_ROOM_ID
        ).emit(
          "peerPublicKey",
          {
            name,
            key: data.key
          }
        );

      }
    );


    // ==================================================
    // REQUEST PEER PUBLIC KEY
    // ==================================================

    socket.on(
      "requestPeerKey",
      () => {

        if (
          !socket.data.authenticated
        ) {
          return;
        }


        const currentName =
          socket.data.name
            ?.toLowerCase();


        if (!currentName) {
          return;
        }


        for (
          const [
            peerName,
            peerKey
          ] of publicKeys.entries()
        ) {

          if (
            peerName ===
            currentName
          ) {
            continue;
          }


          socket.emit(
            "peerPublicKey",
            {
              name:
                ALLOWED_NAMES[
                peerName
                ] || peerName,

              key:
                peerKey
            }
          );

        }

      }
    );


    // ==================================================
    // SEND ENCRYPTED MESSAGE
    // ==================================================

    socket.on(
      "message",
      async (data) => {


        // --------------------------------------------------
        // Must be authenticated
        // --------------------------------------------------

        if (
          !socket.data.authenticated
        ) {
          return;
        }


        // --------------------------------------------------
        // Validate encrypted payload
        // --------------------------------------------------

        if (
          !isValidEncryptedMessage(
            data
          )
        ) {
          return;
        }


        const roomId =
          socket.data.roomId;


        const name =
          socket.data.name;


        if (
          !roomId ||
          !name
        ) {
          return;
        }


        // ==================================================
        // MESSAGE ID / TIME
        // ==================================================

        let savedId =
          `${Date.now()}-${Math.random()
            .toString(16)
            .slice(2)}`;


        let messageTime =
          new Date().toISOString();


        // ==================================================
        // SAVE ENCRYPTED MESSAGE
        // ==================================================

        if (pool) {

          try {

            const result =
              await pool.query(
                `
                INSERT INTO messages
                  (
                    room_id,
                    sender,
                    message,
                    ciphertext,
                    iv
                  )
                VALUES
                  (
                    $1,
                    $2,
                    NULL,
                    $3,
                    $4
                  )
                RETURNING
                  id,
                  created_at
                `,
                [
                  roomId,
                  name,
                  data.ciphertext,
                  data.iv
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
        // SEND ENCRYPTED MESSAGE
        // ==================================================

        const payload = {

          id:
            savedId,

          name,

          ciphertext:
            data.ciphertext,

          iv:
            data.iv,

          time:
            messageTime

        };


        io.to(
          roomId
        ).emit(
          "message",
          payload
        );


      }
    );


    // ==================================================
    // TYPING
    // ==================================================

    socket.on(
      "typing",
      () => {

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

      }
    );


    // ==================================================
    // STOP TYPING
    // ==================================================

    socket.on(
      "stopTyping",
      () => {

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

      }
    );


    // ==================================================
    // DISCONNECT
    // ==================================================

    socket.on(
      "disconnect",
      () => {

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

      }
    );


  }
);


// ==================================================
// ANGULAR FALLBACK
// ==================================================

app.get(
  "*",
  (_, res) => {

    res.sendFile(
      path.join(
        clientDist,
        "index.html"
      )
    );

  }
);


// ==================================================
// START SERVER
// ==================================================

initDb()
  .then(
    () => {

      server.listen(
        PORT,
        () => {

          console.log(
            `Running on port ${PORT}`
          );

        }
      );

    }
  )
  .catch(
    (error) => {

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

    }
  );