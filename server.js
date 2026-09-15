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
// JOIN RATE LIMIT
//
// Maximum 3 failed login attempts per IP
// within 10 minutes.
// ==================================================

const MAX_FAILED_JOIN_ATTEMPTS = 3;
const JOIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const failedJoinAttempts =
  new Map();


// ==================================================
// MESSAGE RATE LIMIT
//
// Maximum 30 messages per 10 seconds and
// maximum 150 messages per minute per user.
// Each user has an independent limit.
// ==================================================

const MESSAGE_RATE_LIMIT_SHORT_MAX = 30;
const MESSAGE_RATE_LIMIT_SHORT_WINDOW_MS = 10 * 1000;
const MESSAGE_RATE_LIMIT_LONG_MAX = 150;
const MESSAGE_RATE_LIMIT_LONG_WINDOW_MS = 60 * 1000;

const messageRateLimits =
  new Map();


function isMessageRateLimited(username) {

  const key =
    String(username || "")
      .trim()
      .toLowerCase();

  const now = Date.now();

  let entry =
    messageRateLimits.get(key);

  if (!entry) {
    entry = {
      shortWindow: [],
      longWindow: []
    };

    messageRateLimits.set(key, entry);
  }

  entry.shortWindow =
    entry.shortWindow.filter(
      timestamp =>
        now - timestamp < MESSAGE_RATE_LIMIT_SHORT_WINDOW_MS
    );

  entry.longWindow =
    entry.longWindow.filter(
      timestamp =>
        now - timestamp < MESSAGE_RATE_LIMIT_LONG_WINDOW_MS
    );

  if (
    entry.shortWindow.length >= MESSAGE_RATE_LIMIT_SHORT_MAX ||
    entry.longWindow.length >= MESSAGE_RATE_LIMIT_LONG_MAX
  ) {
    return true;
  }

  entry.shortWindow.push(now);
  entry.longWindow.push(now);

  return false;
}



function getClientIp(socket) {

  const forwardedFor =
    socket.handshake.headers["x-forwarded-for"];

  if (
    typeof forwardedFor === "string" &&
    forwardedFor.length
  ) {
    return forwardedFor
      .split(",")[0]
      .trim();
  }

  return socket.handshake.address || "unknown";
}


function isJoinRateLimited(ip) {

  const entry =
    failedJoinAttempts.get(ip);

  if (!entry) {
    return false;
  }

  if (
    Date.now() - entry.firstAttemptAt >=
    JOIN_RATE_LIMIT_WINDOW_MS
  ) {
    failedJoinAttempts.delete(ip);
    return false;
  }

  return entry.attempts >= MAX_FAILED_JOIN_ATTEMPTS;
}


function recordFailedJoinAttempt(ip) {

  const now = Date.now();

  const entry =
    failedJoinAttempts.get(ip);

  if (
    !entry ||
    now - entry.firstAttemptAt >=
    JOIN_RATE_LIMIT_WINDOW_MS
  ) {

    failedJoinAttempts.set(
      ip,
      {
        attempts: 1,
        firstAttemptAt: now
      }
    );

    return;
  }

  entry.attempts += 1;
}


function clearFailedJoinAttempts(ip) {

  failedJoinAttempts.delete(ip);

}


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
// IN-MEMORY ONLINE SOCKETS
//
// Only presence information is kept in memory.
// username -> socket.id
// ==================================================

const activeSockets =
  new Map();


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
      reply_to_id BIGINT,
      delivered_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS messages_room_created_idx
      ON messages(room_id, created_at);

    CREATE INDEX IF NOT EXISTS messages_reply_idx
      ON messages(reply_to_id);


    CREATE TABLE IF NOT EXISTS chat_presence (
      username VARCHAR(24) PRIMARY KEY,
      last_seen TIMESTAMPTZ
    );

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


function getPeerName(name) {

  const normalized =
    String(name || "")
      .trim()
      .toLowerCase();


  if (
    normalized === "prashant"
  ) {
    return "Manjushree";
  }


  if (
    normalized === "manjushree"
  ) {
    return "Prashant";
  }


  return null;

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
// SAVE LAST SEEN
// ==================================================

async function saveLastSeen(
  username
) {

  if (!pool) {
    return;
  }


  await pool.query(
    `
    INSERT INTO chat_presence
      (
        username,
        last_seen
      )
    VALUES
      (
        $1,
        NOW()
      )
    ON CONFLICT (username)
    DO UPDATE SET
      last_seen = NOW()
    `,
    [
      String(
        username
      ).toLowerCase()
    ]
  );

}


// ==================================================
// GET LAST SEEN
// ==================================================

async function getLastSeen(
  username
) {

  if (!pool) {
    return null;
  }


  const result =
    await pool.query(
      `
      SELECT
        last_seen
      FROM chat_presence
      WHERE username = $1
      LIMIT 1
      `,
      [
        String(
          username
        ).toLowerCase()
      ]
    );


  if (
    !result.rows.length ||
    !result.rows[0].last_seen
  ) {
    return null;
  }


  return new Date(
    result.rows[0].last_seen
  ).toISOString();

}


// ==================================================
// GET ONLINE STATUS
// ==================================================

function isUserOnline(
  username
) {

  const socketId =
    activeSockets.get(
      String(
        username
      ).toLowerCase()
    );


  if (!socketId) {
    return false;
  }


  const socket =
    io.sockets.sockets.get(
      socketId
    );


  return !!(
    socket &&
    socket.data.authenticated &&
    socket.data.roomId ===
    PRIVATE_ROOM_ID
  );

}


// ==================================================
// SEND PRESENCE TO USER
// ==================================================

async function sendPeerPresence(
  socket
) {

  if (
    !socket.data.authenticated
  ) {
    return;
  }


  const peerName =
    getPeerName(
      socket.data.name
    );


  if (!peerName) {
    return;
  }


  const online =
    isUserOnline(
      peerName
    );


  let lastSeen =
    null;


  if (!online) {

    try {

      lastSeen =
        await getLastSeen(
          peerName
        );

    } catch (error) {

      console.error(
        "Last seen error:",
        error.message
      );

    }

  }


  socket.emit(
    "presence",
    {
      name:
        peerName,

      online,

      lastSeen
    }
  );

}


// ==================================================
// BROADCAST PEER PRESENCE
// ==================================================

async function broadcastPresence(
  username
) {

  const peerName =
    getPeerName(
      username
    );


  if (!peerName) {
    return;
  }


  const peerSocketId =
    activeSockets.get(
      peerName.toLowerCase()
    );


  if (!peerSocketId) {
    return;
  }


  const peerSocket =
    io.sockets.sockets.get(
      peerSocketId
    );


  if (
    !peerSocket ||
    !peerSocket.data.authenticated
  ) {
    return;
  }


  const online =
    isUserOnline(
      username
    );


  let lastSeen =
    null;


  if (!online) {

    try {

      lastSeen =
        await getLastSeen(
          username
        );

    } catch (error) {

      console.error(
        "Presence error:",
        error.message
      );

    }

  }


  peerSocket.emit(
    "presence",
    {
      name:
        username,

      online,

      lastSeen
    }
  );

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

        if (
          socket.data.authenticated
        ) {
          return;
        }


        const clientIp =
          getClientIp(socket);


        // --------------------------------------------------
        // RATE LIMIT
        // --------------------------------------------------

        if (
          isJoinRateLimited(clientIp)
        ) {

          socket.emit(
            "joinError",
            "Too many failed attempts. Try again in 10 minutes."
          );

          return;
        }


        // --------------------------------------------------
        // SECURITY CONFIG
        // --------------------------------------------------

        if (!CHAT_PASSCODE) {

          socket.emit(
            "joinError",
            "Chat security is not configured."
          );

          return;
        }


        // --------------------------------------------------
        // NAME
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
        // PASSCODE
        // --------------------------------------------------

        if (
          !isValidPasscode(
            data?.passcode
          )
        ) {

          recordFailedJoinAttempt(
            clientIp
          );

          socket.emit(
            "joinError",
            "Incorrect passcode."
          );

          return;
        }


        // Successful passcode clears
        // previous failed attempts.
        clearFailedJoinAttempts(
          clientIp
        );


        // --------------------------------------------------
        // ROOM
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


        // ==================================================
        // PREVENT SAME USER FROM HAVING MULTIPLE
        // ACTIVE SESSIONS
        // ==================================================

        const normalizedName =
          name.toLowerCase();


        const oldSocketId =
          activeSockets.get(
            normalizedName
          );


        if (
          oldSocketId &&
          oldSocketId !== socket.id
        ) {

          const oldSocket =
            io.sockets.sockets.get(
              oldSocketId
            );


          if (oldSocket) {

            oldSocket.emit(
              "system",
              "This account was opened in another tab/device."
            );

            oldSocket.disconnect(
              true
            );

          }

        }


        // ==================================================
        // AUTHENTICATE
        // ==================================================

        socket.data.roomId =
          PRIVATE_ROOM_ID;

        socket.data.name =
          name;

        socket.data.authenticated =
          true;


        socket.join(
          PRIVATE_ROOM_ID
        );


        activeSockets.set(
          normalizedName,
          socket.id
        );


        // ==================================================
        // UPDATE PRESENCE
        // ==================================================

        if (pool) {

          try {

            await pool.query(
              `
              INSERT INTO chat_presence
                (
                  username,
                  last_seen
                )
              VALUES
                (
                  $1,
                  NULL
                )
              ON CONFLICT (username)
              DO UPDATE SET
                last_seen = NULL
              `,
              [
                normalizedName
              ]
            );

          } catch (error) {

            console.error(
              "Presence save error:",
              error.message
            );

          }

        }


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
  reply_to_id,
  delivered_at,
  read_at,
  created_at
FROM (
  SELECT
    id,
    sender,
    message,
    reply_to_id,
    delivered_at,
    read_at,
    created_at
  FROM messages
      WHERE room_id = $1
      ORDER BY created_at DESC
      LIMIT 200
    ) AS latest_messages
    ORDER BY created_at ASC
    `,
                [
                  PRIVATE_ROOM_ID
                ]
              );

            const history =
              result.rows
                .map(
                  row => ({
                    id:
                      String(row.id),

                    name:
                      row.sender,

                    text:
                      row.message || "",

                    replyToId:
                      row.reply_to_id
                        ? String(row.reply_to_id)
                        : null,

                    deliveredAt:
                      row.delivered_at
                        ? new Date(row.delivered_at).toISOString()
                        : null,

                    readAt:
                      row.read_at
                        ? new Date(row.read_at).toISOString()
                        : null,

                    time:
                      new Date(row.created_at).toISOString()
                  })
                );

            socket.emit(
              "history",
              history
            );


          } catch (error) {

            console.error(
              "History error:",
              error.message
            );

          }

        }


        // ==================================================
        // PRESENCE FOR NEW USER
        // ==================================================

        await sendPeerPresence(
          socket
        );


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
            name,
            online: true,
            lastSeen: null
          }
        );


        // Also update peer's presence
        // directly from server state.
        await broadcastPresence(
          name
        );

      }
    );


    // ==================================================
    // SEND MESSAGE
    // ==================================================

    socket.on(
      "message",
      async (data) => {

        if (
          !socket.data.authenticated
        ) {
          return;
        }


        if (
          !data ||
          typeof data !== "object" ||
          typeof data.text !== "string" ||
          !data.text.trim() ||
          data.text.length > 2000
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


        // --------------------------------------------------
        // MESSAGE RATE LIMIT
        // --------------------------------------------------

        if (
          isMessageRateLimited(name)
        ) {
          return;
        }


        // ==================================================
        // OPTIONAL REPLY ID
        // ==================================================

        let replyToId =
          null;


        if (
          data.replyToId !==
          undefined &&
          data.replyToId !==
          null &&
          String(
            data.replyToId
          ).trim()
        ) {

          const parsedReplyId =
            Number(
              data.replyToId
            );


          if (
            Number.isSafeInteger(
              parsedReplyId
            ) &&
            parsedReplyId > 0
          ) {

            replyToId =
              parsedReplyId;

          }

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
        // SAVE MESSAGE
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
                    reply_to_id,
                    delivered_at,
                    read_at
                  )
                VALUES
                  (
                    $1,
                    $2,
                    $3,
                    $4,
                    NULL,
                    NULL
                  )
                RETURNING
                  id,
                  created_at
                `,
                [
                  roomId,
                  name,
                  data.text.trim(),
                  replyToId
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

            return;

          }

        }


        // ==================================================
        // MESSAGE PAYLOAD
        // ==================================================

        const payload = {

          id:
            savedId,

          name,

          text:
            data.text.trim(),

          replyToId:
            replyToId
              ? String(replyToId)
              : null,

          time:
            messageTime

        };


        // ==================================================
        // SEND TO ONLINE USERS ONLY
        //
        // IMPORTANT:
        // Offline user will receive it from history
        // after reconnecting.
        // ==================================================

        io.to(
          roomId
        ).emit(
          "message",
          payload
        );


        // ==================================================
        // SENDER GETS SENT RECEIPT
        // ==================================================

        socket.emit(
          "messageSent",
          {
            id:
              savedId
          }
        );


        // ==================================================
        // IF PEER IS ONLINE:
        // DELIVERED RECEIPT
        // ==================================================

        const peer =
          getPeerName(
            name
          );


        if (
          peer &&
          isUserOnline(
            peer
          )
        ) {

          const peerSocketId =
            activeSockets.get(
              peer.toLowerCase()
            );


          const peerSocket =
            io.sockets.sockets.get(
              peerSocketId
            );


          if (
            peerSocket
          ) {

            if (pool) {
              try {
                await pool.query(
                  `
                  UPDATE messages
                  SET delivered_at = COALESCE(delivered_at, NOW())
                  WHERE id = $1
                    AND room_id = $2
                    AND sender = $3
                  `,
                  [
                    Number(savedId),
                    PRIVATE_ROOM_ID,
                    name
                  ]
                );
              } catch (error) {
                console.error(
                  "Delivered timestamp save error:",
                  error.message
                );
              }
            }

            peerSocket.emit(
              "messageDelivered",
              {
                id:
                  savedId
              }
            );

          }

        }

      }
    );


    // ==================================================
    // MESSAGE DELIVERED
    // ==================================================

    socket.on(
      "messageDelivered",
      async (data) => {

        if (
          !socket.data.authenticated
        ) {
          return;
        }


        if (
          !data?.id
        ) {
          return;
        }


        const messageId =
          Number(
            data.id
          );


        if (
          !Number.isSafeInteger(
            messageId
          ) ||
          messageId <= 0
        ) {
          return;
        }


        if (!pool) {
          return;
        }


        try {

          const result =
            await pool.query(
              `
              SELECT
                sender,
                room_id
              FROM messages
              WHERE id = $1
                AND room_id = $2
              LIMIT 1
              `,
              [
                messageId,
                PRIVATE_ROOM_ID
              ]
            );


          if (
            !result.rows.length
          ) {
            return;
          }


          const sender =
            result.rows[0].sender;


          // Only the receiver can confirm
          // delivery of the sender's message.
          if (
            sender.toLowerCase() ===
            socket.data.name.toLowerCase()
          ) {
            return;
          }


          // Persist delivery timestamp.
          await pool.query(
            `
            UPDATE messages
            SET delivered_at = COALESCE(delivered_at, NOW())
            WHERE id = $1
              AND room_id = $2
              AND sender = $3
            `,
            [
              messageId,
              PRIVATE_ROOM_ID,
              sender
            ]
          );


          // Read status is handled separately by messageRead.
          // Delivery alone must not make the message read.


          // Notify original sender.
          const senderSocketId =
            activeSockets.get(
              sender.toLowerCase()
            );


          const senderSocket =
            io.sockets.sockets.get(
              senderSocketId
            );


          if (
            senderSocket &&
            senderSocket.data.authenticated
          ) {

            senderSocket.emit(
              "messageDelivered",
              {
                id:
                  String(
                    messageId
                  )
              }
            );

          }

        } catch (error) {

          console.error(
            "Delivered receipt error:",
            error.message
          );

        }

      }
    );


    // ==================================================
    // MESSAGE READ
    // ==================================================

    socket.on(
      "messageRead",
      async (data) => {

        if (
          !socket.data.authenticated
        ) {
          return;
        }


        if (
          !data?.id
        ) {
          return;
        }


        const messageId =
          Number(
            data.id
          );


        if (
          !Number.isSafeInteger(
            messageId
          ) ||
          messageId <= 0
        ) {
          return;
        }


        if (!pool) {
          return;
        }


        try {

          const result =
            await pool.query(
              `
              SELECT
                sender,
                room_id
              FROM messages
              WHERE id = $1
                AND room_id = $2
              LIMIT 1
              `,
              [
                messageId,
                PRIVATE_ROOM_ID
              ]
            );


          if (
            !result.rows.length
          ) {
            return;
          }


          const sender =
            result.rows[0].sender;


          // Receiver cannot mark their own
          // message as read.
          if (
            sender.toLowerCase() ===
            socket.data.name.toLowerCase()
          ) {
            return;
          }


          // Persist read timestamp.
          await pool.query(
            `
            UPDATE messages
            SET
              delivered_at = COALESCE(delivered_at, NOW()),
              read_at = COALESCE(read_at, NOW())
            WHERE id = $1
              AND room_id = $2
              AND sender = $3
            `,
            [
              messageId,
              PRIVATE_ROOM_ID,
              sender
            ]
          );


          // Notify original sender.
          const senderSocketId =
            activeSockets.get(
              sender.toLowerCase()
            );


          const senderSocket =
            io.sockets.sockets.get(
              senderSocketId
            );


          if (
            senderSocket &&
            senderSocket.data.authenticated
          ) {

            senderSocket.emit(
              "messageRead",
              {
                id:
                  String(
                    messageId
                  )
              }
            );

          }

        } catch (error) {

          console.error(
            "Read receipt error:",
            error.message
          );

        }

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
      async () => {

        if (
          !socket.data.authenticated
        ) {
          return;
        }


        const roomId =
          socket.data.roomId;


        const name =
          socket.data.name;


        // --------------------------------------------------
        // Remove active socket only if this
        // socket is still the current session.
        // --------------------------------------------------

        let isCurrentSession = false;

        if (name) {

          const keyName =
            name.toLowerCase();


          const currentSocketId =
            activeSockets.get(
              keyName
            );


          if (
            currentSocketId ===
            socket.id
          ) {

            isCurrentSession = true;

            activeSockets.delete(
              keyName
            );


            // ------------------------------------------------
            // SAVE LAST SEEN
            // ------------------------------------------------

            try {

              await saveLastSeen(
                keyName
              );

            } catch (error) {

              console.error(
                "Last seen save error:",
                error.message
              );

            }

          }

        }


        // An old session can disconnect after a new session
        // has already replaced it. Do not announce that old
        // session as offline.
        if (
          !roomId ||
          !isCurrentSession
        ) {
          return;
        }


        // --------------------------------------------------
        // NOTIFY OTHER USER
        // --------------------------------------------------

        if (name) {

          socket.to(
            roomId
          ).emit(
            "presence",
            {
              name,

              online:
                false,

              lastSeen:
                new Date().toISOString()
            }
          );


          socket.to(
            roomId
          ).emit(
            "system",
            `${name} left`
          );

        }


        // --------------------------------------------------
        // Update peer presence from DB/state.
        // --------------------------------------------------

        if (name) {

          await broadcastPresence(
            name
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