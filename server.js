const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const webpush = require("web-push");

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

/* ==================================================
   WEB PUSH
================================================== */

const VAPID_PUBLIC_KEY =
  String(
    process.env.VAPID_PUBLIC_KEY || ""
  );

const VAPID_PRIVATE_KEY =
  String(
    process.env.VAPID_PRIVATE_KEY || ""
  );

const VAPID_SUBJECT =
  String(
    process.env.VAPID_SUBJECT ||
    "https://couple-chat-8msk.onrender.com"
  );

if (
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  console.log("Web Push ready");
} else {
  console.warn(
    "Web Push VAPID keys are not configured."
  );
}

const pushSubscriptions = new Map();



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
// Public keys are now stored persistently in DB.
//
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
      "DATABASE_URL is not set. Chat history and persistent keys will not be saved."
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
      reply_to_id BIGINT,
      delivered_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS ciphertext TEXT;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS iv TEXT;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

    ALTER TABLE messages
      ALTER COLUMN message DROP NOT NULL;

    CREATE INDEX IF NOT EXISTS messages_room_created_idx
      ON messages(room_id, created_at);

    CREATE INDEX IF NOT EXISTS messages_reply_idx
      ON messages(reply_to_id);


    CREATE TABLE IF NOT EXISTS chat_public_keys (
      username VARCHAR(24) PRIMARY KEY,
      public_key JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS chat_presence (
      username VARCHAR(24) PRIMARY KEY,
      last_seen TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS chat_key_bundle (
      room_id VARCHAR(100) PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

/* ==================================================
   WEB PUSH HELPERS
================================================== */

function isValidPushSubscription(subscription) {

  return !!(
    subscription &&
    typeof subscription === "object" &&
    typeof subscription.endpoint === "string" &&
    subscription.endpoint.length > 0 &&
    subscription.keys &&
    typeof subscription.keys === "object" &&
    typeof subscription.keys.p256dh === "string" &&
    typeof subscription.keys.auth === "string"
  );

}

async function sendPushNotification(
  username,
  senderName
) {

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return;
  }

  const subscription =
    pushSubscriptions.get(
      String(username).toLowerCase()
    );

  if (!subscription) {
    return;
  }

  try {

    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: `${senderName} ❤️`,
        body: "You have a new message",
        icon: "/favicon.ico",
        url: "/"
      })
    );

  } catch (error) {

    console.error(
      "Push notification error:",
      error.statusCode,
      error.message
    );

    if (
      error.statusCode === 404 ||
      error.statusCode === 410
    ) {
      pushSubscriptions.delete(
        String(username).toLowerCase()
      );
    }

  }

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

  if (
    !data ||
    typeof data !== "object"
  ) {
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
// GET STORED PUBLIC KEY
// ==================================================

async function getStoredPublicKey(
  username
) {

  if (!pool) {
    return null;
  }


  const result =
    await pool.query(
      `
      SELECT
        username,
        public_key
      FROM chat_public_keys
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
    !result.rows.length
  ) {
    return null;
  }


  return result.rows[0].public_key;

}


// ==================================================
// SAVE PUBLIC KEY
// ==================================================

async function savePublicKey(
  username,
  publicKey
) {

  if (!pool) {
    return;
  }


  await pool.query(
    `
    INSERT INTO chat_public_keys
      (
        username,
        public_key,
        updated_at
      )
    VALUES
      (
        $1,
        $2::jsonb,
        NOW()
      )
    ON CONFLICT (username)
    DO UPDATE SET
      public_key = EXCLUDED.public_key,
      updated_at = NOW()
    `,
    [
      String(
        username
      ).toLowerCase(),

      JSON.stringify(
        publicKey
      )
    ]
  );

}


// ==================================================
// KEY BUNDLE HELPERS
// ==================================================

async function getKeyBundle(roomId) {

  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT
      ciphertext,
      iv
    FROM chat_key_bundle
    WHERE room_id = $1
    LIMIT 1
    `,
    [roomId]
  );

  if (!result.rows.length) {
    return null;
  }

  return {
    ciphertext: result.rows[0].ciphertext,
    iv: result.rows[0].iv
  };
}


async function saveKeyBundle(roomId, bundle) {

  if (!pool) {
    return false;
  }

  const result = await pool.query(
    `
    INSERT INTO chat_key_bundle
      (
        room_id,
        ciphertext,
        iv
      )
    VALUES
      (
        $1,
        $2,
        $3
      )
    ON CONFLICT (room_id)
    DO NOTHING
    `,
    [
      roomId,
      bundle.ciphertext,
      bundle.iv
    ]
  );

  return result.rowCount > 0;
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


    /* ==================================================
       SAVE PUSH SUBSCRIPTION
    ================================================== */

    socket.on(
      "pushSubscription",
      (subscription) => {

        if (!socket.data.authenticated) {
          return;
        }

        if (!isValidPushSubscription(subscription)) {
          return;
        }

        const username =
          String(socket.data.name).toLowerCase();

        pushSubscriptions.set(
          username,
          subscription
        );

        console.log(
          "Push subscription saved:",
          username
        );

      }
    );


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
        // SEND PEER PUBLIC KEY
        //
        // IMPORTANT:
        // This key comes from DB, so peer does NOT
        // need to be online.
        // ==================================================

        const peerName =
          getPeerName(
            name
          );


        if (peerName) {

          try {

            const peerKey =
              await getStoredPublicKey(
                peerName
              );


            if (peerKey) {

              socket.emit(
                "peerPublicKey",
                {
                  name:
                    peerName,

                  key:
                    peerKey
                }
              );

            }

          } catch (error) {

            console.error(
              "Public key load error:",
              error.message
            );

          }

        }


        // ==================================================
        // ASK CLIENT FOR ITS PUBLIC KEY
        // ==================================================

        socket.emit(
          "requestPublicKey"
        );


        // ==================================================
        // SEND SHARED KEY BUNDLE
        // ==================================================

        try {

          const keyBundle =
            await getKeyBundle(
              PRIVATE_ROOM_ID
            );

          socket.emit(
            "keyBundle",
            keyBundle
          );

        } catch (error) {

          console.error(
            "Key bundle load error:",
            error.message
          );

          socket.emit(
            "keyBundle",
            null
          );

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
      ciphertext,
      iv,
      reply_to_id,
      delivered_at,
      read_at,
      created_at
    FROM (
      SELECT
        id,
        sender,
        message,
        ciphertext,
        iv,
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
                      String(
                        row.id
                      ),

                    name:
                      row.sender,

                    ciphertext:
                      row.ciphertext,

                    iv:
                      row.iv,

                    replyToId:
                      row.reply_to_id
                        ? String(
                          row.reply_to_id
                        )
                        : null,

                    deliveredAt:
                      row.delivered_at
                        ? new Date(
                          row.delivered_at
                        ).toISOString()
                        : null,

                    readAt:
                      row.read_at
                        ? new Date(
                          row.read_at
                        ).toISOString()
                        : null,

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
    // PUBLIC KEY
    // ==================================================

    socket.on(
      "publicKey",
      async (data) => {

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
          "object" ||
          data.key === null
        ) {
          return;
        }


        // --------------------------------------------------
        // Basic JWK validation
        // --------------------------------------------------

        if (
          data.key.kty !==
          "EC" ||
          data.key.crv !==
          "P-256" ||
          typeof data.key.x !==
          "string" ||
          typeof data.key.y !==
          "string"
        ) {
          return;
        }


        try {

          // ==================================================
          // PERSIST PUBLIC KEY
          // ==================================================

          await savePublicKey(
            name,
            data.key
          );


          // ==================================================
          // SEND TO CURRENT PEER IF ONLINE
          // ==================================================

          socket.to(
            PRIVATE_ROOM_ID
          ).emit(
            "peerPublicKey",
            {
              name,
              key:
                data.key
            }
          );


        } catch (error) {

          console.error(
            "Public key save error:",
            error.message
          );

        }

      }
    );


    // ==================================================
    // REQUEST PEER PUBLIC KEY
    // ==================================================

    socket.on(
      "requestPeerKey",
      async () => {

        if (
          !socket.data.authenticated
        ) {
          return;
        }


        const currentName =
          socket.data.name;


        const peerName =
          getPeerName(
            currentName
          );


        if (!peerName) {
          return;
        }


        try {

          const peerKey =
            await getStoredPublicKey(
              peerName
            );


          if (peerKey) {

            socket.emit(
              "peerPublicKey",
              {
                name:
                  peerName,

                key:
                  peerKey
              }
            );

          }

        } catch (error) {

          console.error(
            "Peer key request error:",
            error.message
          );

        }

      }
    );


    // ==================================================
    // REQUEST SHARED KEY BUNDLE
    // ==================================================

    socket.on(
      "requestKeyBundle",
      async () => {

        if (
          !socket.data.authenticated
        ) {
          return;
        }

        try {

          const keyBundle =
            await getKeyBundle(
              PRIVATE_ROOM_ID
            );

          socket.emit(
            "keyBundle",
            keyBundle
          );

        } catch (error) {

          console.error(
            "Key bundle request error:",
            error.message
          );

          socket.emit(
            "keyBundle",
            null
          );

        }

      }
    );


    // ==================================================
    // SAVE SHARED KEY BUNDLE
    // ==================================================

    socket.on(
      "saveKeyBundle",
      async (data) => {

        console.log(
          "Key bundle save request received:",
          {
            user: socket.data.name,
            roomId: socket.data.roomId,
            hasCiphertext:
              typeof data?.ciphertext === "string" &&
              data.ciphertext.length > 0,
            hasIv:
              typeof data?.iv === "string" &&
              data.iv.length > 0
          }
        );

        if (
          !socket.data.authenticated
        ) {
          return;
        }

        if (
          !data ||
          typeof data !== "object" ||
          typeof data.ciphertext !== "string" ||
          typeof data.iv !== "string" ||
          !data.ciphertext.length ||
          !data.iv.length ||
          data.ciphertext.length > 10000 ||
          data.iv.length > 100
        ) {
          return;
        }

        try {

          const existing =
            await getKeyBundle(
              PRIVATE_ROOM_ID
            );

          if (existing) {

            socket.emit(
              "keyBundleSaved",
              {
                success: true,
                existing: true
              }
            );

            return;
          }

          const saved =
            await saveKeyBundle(
              PRIVATE_ROOM_ID,
              {
                ciphertext:
                  data.ciphertext,

                iv:
                  data.iv
              }
            );

          const bundle =
            saved
              ? {
                ciphertext:
                  data.ciphertext,

                iv:
                  data.iv
              }
              : await getKeyBundle(
                PRIVATE_ROOM_ID
              );

          console.log(
            "Key bundle save result:",
            {
              user: socket.data.name,
              saved,
              bundleExists: !!bundle
            }
          );

          socket.emit(
            "keyBundleSaved",
            {
              success: !!bundle,
              existing: !saved
            }
          );

          if (bundle) {

            socket.to(
              PRIVATE_ROOM_ID
            ).emit(
              "keyBundle",
              bundle
            );

          }

        } catch (error) {

          console.error(
            "Key bundle save error:",
            error.message
          );

          socket.emit(
            "keyBundleSaved",
            {
              success: false
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

        if (
          !socket.data.authenticated
        ) {
          return;
        }


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
                    iv,
                    reply_to_id,
                    delivered_at,
                    read_at
                  )
                VALUES
                  (
                    $1,
                    $2,
                    NULL,
                    $3,
                    $4,
                    $5,
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
                  data.ciphertext,
                  data.iv,
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
        // ENCRYPTED MESSAGE PAYLOAD
        // ==================================================

        const payload = {

          id:
            savedId,

          name,

          ciphertext:
            data.ciphertext,

          iv:
            data.iv,

          replyToId:
            replyToId
              ? String(
                replyToId
              )
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


        /* ==================================================
           SEND MOBILE PUSH NOTIFICATION
        ================================================== */

        const notificationPeer =
          getPeerName(name);

        if (notificationPeer) {

          await sendPushNotification(
            notificationPeer,
            name
          );

        }


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


          // Persist both delivery and read timestamps.
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

            activeSockets.delete(
              keyName
            );

          }


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


        if (!roomId) {
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
// SERVICE WORKER
// ==================================================

app.get(
  "/sw.js",
  (_, res) => {

    res.sendFile(
      path.join(
        clientDist,
        "assets",
        "sw.js"
      )
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