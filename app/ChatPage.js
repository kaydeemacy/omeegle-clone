"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./chat/chat.css";

// ✅ Use env var on Render, fallback to localhost for dev
const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

export default function ChatPage() {
  const socketRef = useRef(null);
  const bottomRef = useRef(null);

  // WebRTC refs
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  // UI state
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | waiting | matched | left
  const [roomId, setRoomId] = useState(null);
  const [partnerId, setPartnerId] = useState(null);

  const [darkMode, setDarkMode] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);

  // ✅ NSFW safety blur
  const [remoteBlurred, setRemoteBlurred] = useState(true);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);

  // ---------------- WebRTC helpers ----------------
  async function ensureLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localStreamRef.current = stream;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.muted = true;
      await localVideoRef.current.play?.().catch(() => {});
    }

    return stream;
  }

  function createPeerConnection() {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current?.emit("webrtc:ice", { candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const remoteStream = e.streams?.[0];
      if (remoteStream && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
        remoteVideoRef.current.play?.().catch(() => {});
      }
    };

    pcRef.current = pc;
    return pc;
  }

  async function startWebRTCAsCaller(myPartnerId) {
    await ensureLocalMedia();
    const pc = createPeerConnection();

    // Add tracks once
    const stream = localStreamRef.current;
    const existing = new Set(
      pc.getSenders().map((s) => s.track?.id).filter(Boolean)
    );

    stream.getTracks().forEach((t) => {
      if (!existing.has(t.id)) pc.addTrack(t, stream);
    });

    // Caller creates offer
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await pc.setLocalDescription(offer);
    socketRef.current?.emit("webrtc:offer", { sdp: pc.localDescription });
  }

  async function handleOffer(sdp) {
    // Callee path
    await ensureLocalMedia();
    const pc = createPeerConnection();

    // Add tracks once
    const stream = localStreamRef.current;
    const existing = new Set(
      pc.getSenders().map((s) => s.track?.id).filter(Boolean)
    );

    stream.getTracks().forEach((t) => {
      if (!existing.has(t.id)) pc.addTrack(t, stream);
    });

    await pc.setRemoteDescription(sdp);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socketRef.current?.emit("webrtc:answer", { sdp: pc.localDescription });
  }

  async function handleAnswer(sdp) {
    const pc = pcRef.current;
    if (!pc) return;
    await pc.setRemoteDescription(sdp);
  }

  async function handleIce(candidate) {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      await pc.addIceCandidate(candidate);
    } catch {}
  }

  function cleanupVideo() {
    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;

    try {
      localStreamRef.current?.getTracks()?.forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;

    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }

  // ---------------- Socket setup ----------------
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => {
      setConnected(false);
      setStatus("idle");
      setRoomId(null);
      setPartnerId(null);
      setRemoteBlurred(true);
      cleanupVideo();
    });

    socket.on("online:count", (n) => setOnlineCount(Number(n) || 0));
    socket.on("status", (s) => setStatus(s));

    socket.on("matched", async ({ roomId, partnerId }) => {
      setRoomId(roomId);
      setPartnerId(partnerId || null);
      setStatus("matched");
      setMessages([]);
      setRemoteBlurred(true);

      // Decide caller by socket id string compare
      const myId = socket.id || "";
      const otherId = partnerId || "";

      try {
        if (myId && otherId && myId < otherId) {
          await startWebRTCAsCaller(otherId);
        }
        // else: wait for offer
      } catch {
        // If cam/mic blocked
        alert("Camera/Mic blocked. Allow permissions and try again.");
      }
    });

    socket.on("chat:message", (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    socket.on("partner_left", () => {
      setStatus("left");
      setRoomId(null);
      setPartnerId(null);
      setRemoteBlurred(true);
      cleanupVideo();
    });

    // WebRTC signaling
    socket.on("webrtc:offer", async ({ sdp }) => handleOffer(sdp));
    socket.on("webrtc:answer", async ({ sdp }) => handleAnswer(sdp));
    socket.on("webrtc:ice", async ({ candidate }) => handleIce(candidate));
    socket.on("webrtc:hangup", () => {
      setRemoteBlurred(true);
      cleanupVideo();
    });

    socket.on("banned", ({ until }) => {
      alert("You are blocked until: " + new Date(until).toLocaleString());
      setRemoteBlurred(true);
      cleanupVideo();
      socket.disconnect();
    });

    return () => {
      socket.disconnect();
      cleanupVideo();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---------------- Actions ----------------
  function sendMessage() {
    if (!roomId) return;
    const text = message.trim();
    if (!text) return;

    socketRef.current?.emit("chat:message", { roomId, message: text });
    setMessage("");
  }

  function findPartner() {
    setRemoteBlurred(true);
    cleanupVideo();
    setStatus("waiting");
    socketRef.current?.emit("find");
  }

  function next() {
    setRemoteBlurred(true);
    cleanupVideo();
    socketRef.current?.emit("leave");
    setStatus("waiting");
    setRoomId(null);
    setPartnerId(null);
    setMessages([]);
    socketRef.current?.emit("find");
  }

  function stop() {
    setRemoteBlurred(true);
    cleanupVideo();
    socketRef.current?.emit("leave");
    setStatus("idle");
    setRoomId(null);
    setPartnerId(null);
    setMessages([]);
  }

  return (
    <div className={`wrap ${darkMode ? "dark" : ""}`}>
      <div className="topbar">
        <h1 style={{ margin: 0 }}>Omegle-ish</h1>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="badge onlineBadge">Online: {onlineCount}</span>

          <span className={`badge ${connected ? "ok" : "bad"}`}>
            {connected ? "Connected ✅" : "Not connected ❌"}
          </span>

          <button
            className="btn secondary toggleBtn"
            onClick={() => setDarkMode((v) => !v)}
          >
            {darkMode ? "Light" : "Dark"} Mode
          </button>
        </div>
      </div>

      <div className="card">
        <div className="controls">
          {status === "idle" && (
            <button className="btn" onClick={findPartner}>
              Start
            </button>
          )}

          {status === "waiting" && (
            <>
              <button className="btn" onClick={findPartner}>
                Matching…
              </button>
              <button className="btn secondary" onClick={stop}>
                Stop
              </button>
            </>
          )}

          {status === "left" && (
            <>
              <button className="btn" onClick={next}>
                Next
              </button>
              <button className="btn secondary" onClick={stop}>
                Stop
              </button>
            </>
          )}

          {status === "matched" && (
            <>
              <button className="btn" onClick={next}>
                Next
              </button>

              <button className="btn secondary" onClick={stop}>
                Stop
              </button>

              <button
                className="btn secondary"
                onClick={() => setRemoteBlurred((v) => !v)}
              >
                {remoteBlurred ? "Reveal Video" : "Blur Video"}
              </button>
            </>
          )}
        </div>

        <div className="videoGrid" style={{ marginTop: 12 }}>
          <div className="videoCard">
            <div className="videoLabel">You</div>
            <video ref={localVideoRef} autoPlay playsInline className="videoEl" />
          </div>

          <div className="videoCard">
            <div className="videoLabel">Stranger</div>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={`videoEl ${remoteBlurred ? "nsfwBlur" : ""}`}
            />

            {remoteBlurred && (
              <div className="nsfwOverlay">
                <div className="nsfwTitle">⚠️ Safety Blur</div>
                <div className="nsfwText">
                  Stranger video is blurred. Tap reveal if you want to view.
                </div>
                <button
                  className="btn secondary nsfwBtn"
                  onClick={() => setRemoteBlurred(false)}
                >
                  Reveal Video
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="chatbox" style={{ marginTop: 12 }}>
          {messages.map((m, i) => {
            const isMe = m?.from && m.from === socketRef.current?.id;
            return (
              <div key={i} className={`row ${isMe ? "me" : "them"}`}>
                <div className={`bubble ${isMe ? "me" : ""}`}>
                  {m?.message || ""}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div className="inputRow">
          <input
            className="input"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder={status === "matched" ? "Type a message…" : "Match first…"}
            disabled={status !== "matched"}
          />
          <button
            className="btn"
            onClick={sendMessage}
            disabled={status !== "matched"}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}