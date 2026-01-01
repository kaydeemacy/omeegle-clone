const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ✅ Render / production: set this on Render as your frontend URL
// Example: https://your-frontend.onrender.com
const FRONTEND_URL = process.env.FRONTEND_URL || "";

// ✅ Allow both dev + production origins
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  FRONTEND_URL,
].filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ✅ Simple health check (test backend online in browser)
app.get("/health", (req, res) => {
  res.json({ ok: true, online: io.of("/").sockets.size });
});

// --- Config ---
const BAN_MS = 10 * 60 * 1000; // 10 minutes
const shouldBanIp = process.env.NODE_ENV === "production";

// --- State ---
const partnerMap = new Map(); // socket.id -> partner socket.id
const ipBySocketId = new Map(); // socket.id -> ip
const bannedIpUntil = new Map(); // ip -> timestamp (ms)

// user prefs + waiting pools
const prefsBySocketId = new Map(); // socket.id -> { country, interest }
const waitingPools = new Map(); // key -> [socketId, ...]

// ✅ Broadcast online count to everyone
function broadcastOnlineCount() {
  const count = io.of("/").sockets.size;
  io.emit("online:count", count);
}

// Helpers
function cleanCountry(country) {
  if (typeof country !== "string") return "";
  return country.trim().toUpperCase().slice(0, 2); // ISO 2-letter code e.g. NG, US
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

  // online count
  socket.emit("online:count", io.of("/").sockets.size);
  broadcastOnlineCount();

  // ✅ Find partner with filters
  // client emits: socket.emit("find", { country, interest })
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

      // ✅ send partnerId + partner country to each side
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

    // no match yet -> enqueue
    alive.push(socket.id);
    waitingPools.set(key, alive);

    socket.emit("status", "waiting");
  });

  // Typing indicator
  socket.on("typing", ({ isTyping }) => {
    const partnerId = partnerMap.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) return;

    partnerSocket.emit("typing", { isTyping: !!isTyping });
  });

  // Chat messages
  socket.on("chat:message", ({ roomId, message }) => {
    if (typeof message !== "string") return;

    const clean = message.trim().slice(0, 300);
    if (!clean) return;

    io.to(roomId).emit("chat:message", { from: socket.id, message: clean });
  });

  // Leave chat
  socket.on("leave", () => {
    removeFromWaiting(socket.id);
    endChat(socket.id);
    socket.emit("status", "idle");
  });

  // Report partner
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

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    removeFromWaiting(socket.id);
    endChat(socket.id);

    prefsBySocketId.delete(socket.id);
    ipBySocketId.delete(socket.id);

    broadcastOnlineCount();
  });
});

// ✅ Render needs process.env.PORT
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  if (FRONTEND_URL) console.log("Allowed frontend:", FRONTEND_URL);
});