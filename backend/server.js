const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

/* -------------------- Health endpoints -------------------- */
app.get("/", (req, res) => res.send("Socket backend is running ✅"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

const server = http.createServer(app);

/* -------------------- CORS (Frontend allowlist) --------------------
Render ENV you should set:

FRONTEND_URL=https://omeegle-clone-1.onrender.com

(Optional) if you have more than one frontend:
FRONTEND_URLS=https://omeegle-clone-1.onrender.com,https://another.onrender.com
------------------------------------------------------------------- */

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const FRONTEND_URLS = process.env.FRONTEND_URLS || "";

const extra = FRONTEND_URLS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  FRONTEND_URL,
  ...extra,
];

console.log("✅ Allowed CORS origins:", ALLOWED_ORIGINS);

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin), false);
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

/* -------------------- App logic -------------------- */

// --- Config ---
const BAN_MS = 10 * 60 * 1000; // 10 minutes
const shouldBanIp = process.env.NODE_ENV === "production";

// --- State ---
const partnerMap = new Map(); // socket.id -> partner socket.id
const ipBySocketId = new Map(); // socket.id -> ip
const bannedIpUntil = new Map(); // ip -> timestamp (ms)
const prefsBySocketId = new Map(); // socket.id -> { country, interest }
const waitingPools = new Map(); // key -> [socketId, ...]

function broadcastOnlineCount() {
  const count = io.of("/").sockets.size;
  io.emit("online:count", count);
}

function cleanCountry(country) {
  if (typeof country !== "string") return "";
  return country.trim().toUpperCase().slice(0, 2);
}
function cleanInterest(interest) {
  if (typeof interest !== "string") return "";
  return interest.trim().toLowerCase().slice(0, 40);
}
function poolKey(country, interest) {
  const c = cleanCountry(country);
  const i = cleanInterest(interest);
  return `${c || "any"}|${i || "any"}`;
}

function removeFromWaiting(socketId) {
  for (const [key, arr] of waitingPools.entries()) {
    const idx = arr.indexOf(socketId);
    if (idx !== -1) {
      arr.splice(idx, 1);
      if (arr.length === 0) waitingPools.delete(key);
      return;
    }
  }
}

function endChat(socketId) {
  const partnerId = partnerMap.get(socketId);
  if (partnerId) {
    partnerMap.delete(socketId);
    partnerMap.delete(partnerId);

    const partnerSocket = io.sockets.sockets.get(partnerId);
    partnerSocket?.emit("partner_left");
  }
}

// ✅ helper: get partner socket quickly
function getPartnerSocket(socketId) {
  const partnerId = partnerMap.get(socketId);
  if (!partnerId) return null;
  return io.sockets.sockets.get(partnerId) || null;
}

io.on("connection", (socket) => {
  const ip =
    socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    socket.handshake.address;

  ipBySocketId.set(socket.id, ip);

  // Ban check (production only)
  if (shouldBanIp) {
    const banUntil = bannedIpUntil.get(ip);
    if (banUntil && Date.now() < banUntil) {
      socket.emit("banned", { until: banUntil });
      socket.disconnect(true);
      return;
    }
  }

  console.log("User connected:", socket.id, "ip:", ip);

  socket.emit("online:count", io.of("/").sockets.size);
  broadcastOnlineCount();

  /* -------------------- MATCHING -------------------- */
  socket.on("find", ({ country, interest } = {}) => {
    removeFromWaiting(socket.id);
    endChat(socket.id);

    const c = cleanCountry(country);
    const i = cleanInterest(interest);
    prefsBySocketId.set(socket.id, { country: c, interest: i });

    const key = poolKey(c, i);
    const pool = waitingPools.get(key) || [];
    const alive = pool.filter((id) => io.sockets.sockets.get(id));
    waitingPools.set(key, alive);

    while (alive.length) {
      const partnerId = alive.shift();
      if (!partnerId || partnerId === socket.id) continue;

      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (!partnerSocket) continue;

      waitingPools.set(key, alive);

      partnerMap.set(socket.id, partnerId);
      partnerMap.set(partnerId, socket.id);

      const roomId = `${socket.id}#${partnerId}`;

      socket.join(roomId);
      partnerSocket.join(roomId);

      const myPrefs = prefsBySocketId.get(socket.id) || {};
      const partnerPrefs = prefsBySocketId.get(partnerId) || {};

      socket.emit("matched", {
        roomId,
        partnerId,
        partnerCountry: partnerPrefs.country || "",
      });

      partnerSocket.emit("matched", {
        roomId,
        partnerId: socket.id,
        partnerCountry: myPrefs.country || "",
      });

      return;
    }

    alive.push(socket.id);
    waitingPools.set(key, alive);
    socket.emit("status", "waiting");
  });

  socket.on("typing", ({ isTyping }) => {
    const partnerSocket = getPartnerSocket(socket.id);
    partnerSocket?.emit("typing", { isTyping: !!isTyping });
  });

  socket.on("chat:message", ({ roomId, message }) => {
    if (typeof message !== "string") return;

    const clean = message.trim().slice(0, 300);
    if (!clean) return;

    io.to(roomId).emit("chat:message", { from: socket.id, message: clean });
  });

  socket.on("leave", () => {
    removeFromWaiting(socket.id);
    endChat(socket.id);
    socket.emit("status", "idle");
  });

  socket.on("report", ({ roomId, reason }) => {
    console.log("REPORT RECEIVED 🚨", { from: socket.id, roomId, reason });

    const partnerId = partnerMap.get(socket.id);
    if (!partnerId) return;

    endChat(socket.id);

    const partnerSocket = io.sockets.sockets.get(partnerId);
    const partnerIp = ipBySocketId.get(partnerId);

    if (shouldBanIp && partnerIp) {
      const until = Date.now() + BAN_MS;
      bannedIpUntil.set(partnerIp, until);
      partnerSocket?.emit("banned", { until });
      console.log("BANNED IP 🚫", { partnerIp, until });
    } else {
      console.log("Ban disabled in dev mode");
    }

    partnerSocket?.disconnect(true);
  });

  /* -------------------- ✅ WEBRTC SIGNALING (THIS FIXES VIDEO) -------------------- */
  socket.on("webrtc:offer", ({ sdp }) => {
    const partnerSocket = getPartnerSocket(socket.id);
    if (!partnerSocket) return;
    partnerSocket.emit("webrtc:offer", { sdp });
  });

  socket.on("webrtc:answer", ({ sdp }) => {
    const partnerSocket = getPartnerSocket(socket.id);
    if (!partnerSocket) return;
    partnerSocket.emit("webrtc:answer", { sdp });
  });

  socket.on("webrtc:ice", ({ candidate }) => {
    const partnerSocket = getPartnerSocket(socket.id);
    if (!partnerSocket) return;
    partnerSocket.emit("webrtc:ice", { candidate });
  });

  socket.on("webrtc:hangup", () => {
    const partnerSocket = getPartnerSocket(socket.id);
    partnerSocket?.emit("webrtc:hangup");
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    removeFromWaiting(socket.id);
    endChat(socket.id);

    prefsBySocketId.delete(socket.id);
    ipBySocketId.delete(socket.id);

    broadcastOnlineCount();
  });
});

/* -------------------- Render PORT -------------------- */
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log("✅ Socket server running on port", PORT);
});