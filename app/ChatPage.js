"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./chat/chat.css";

// ✅ Use env var on Render, fallback to localhost for dev
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:4000";

export default function ChatPage() {
  const socketRef = useRef(null);
  const bottomRef = useRef(null);

  const typingTimeoutRef = useRef(null);
  const dotsIntervalRef = useRef(null);

  // WebRTC refs
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  // Audio refs
  const audioCtxRef = useRef(null);
  const prevPartnerTypingRef = useRef(false);
  const lastTypingTickAtRef = useRef(0);
  const lastMsgSoundAtRef = useRef(0);

  // UI state
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | waiting | matched | left
  const [roomId, setRoomId] = useState(null);
  const [partnerId, setPartnerId] = useState(null);

  const [darkMode, setDarkMode] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);

  // ✅ Restored: sound + mic/cam + typing UI
  const [soundOn, setSoundOn] = useState(true);

  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  const [partnerTyping, setPartnerTyping] = useState(false);
  const [typingDots, setTypingDots] = useState("");
  const [showTypingUi, setShowTypingUi] = useState(false);

  // ✅ Country + interest (filters)
  const [country, setCountry] = useState("any"); // "any" or "NG"/"US"/etc
  const [interest, setInterest] = useState(""); // free text

  // ✅ NSFW safety blur
  const [remoteBlurred, setRemoteBlurred] = useState(true);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);

  // ---- helpers to clean inputs (match backend behavior) ----
  function cleanCountry(c) {
    if (!c || c === "any") return "";
    return String(c).trim().toUpperCase().slice(0, 2);
  }
  function cleanInterest(i) {
    if (!i) return "";
    return String(i).trim().toLowerCase().slice(0, 40);
  }

  // ---------------- Audio helpers ----------------
  function getAudioCtx() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function playBeep({ freq = 740, durationMs = 70, volume = 0.05, type = "sine" }) {
    if (!soundOn) return;
    try {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.value = freq;

      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durationMs / 1000);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(t);
      osc.stop(t + durationMs / 1000 + 0.01);
    } catch {}
  }

  function playTypingTick() {
    const now = Date.now();
    if (now - lastTypingTickAtRef.current < 500) return;
    lastTypingTickAtRef.current = now;
    playBeep({ freq: 740, durationMs: 70, volume: 0.04, type: "sine" });
  }

  function playSendSound() {
    const now = Date.now();
    if (now - lastMsgSoundAtRef.current < 120) return;
    lastMsgSoundAtRef.current = now;
    playBeep({ freq: 880, durationMs: 85, volume: 0.06, type: "triangle" });
  }

  function playReceiveSound() {
    const now = Date.now();
    if (now - lastMsgSoundAtRef.current < 120) return;
    lastMsgSoundAtRef.current = now;
    playBeep({ freq: 660, durationMs: 95, volume: 0.06, type: "triangle" });
  }

  // ---------------- WebRTC helpers ----------------
  async function ensureLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localStreamRef.current = stream;

    // Apply current mic/cam toggles
    stream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    stream.getAudioTracks().forEach((t) => (t.enabled = micOn));

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
      if (e.candidate) socketRef.current?.emit("webrtc:ice", { candidate: e.candidate });
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

  async function startWebRTCAsCaller() {
    await ensureLocalMedia();
    const pc = createPeerConnection();

    const stream = localStreamRef.current;
    const existing = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean));

    stream.getTracks().forEach((t) => {
      if (!existing.has(t.id)) pc.addTrack(t, stream);
    });

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await pc.setLocalDescription(offer);
    socketRef.current?.emit("webrtc:offer", { sdp: pc.localDescription });
  }

  async function handleOffer(sdp) {
    await ensureLocalMedia();
    const pc = createPeerConnection();

    const stream = localStreamRef.current;
    const existing = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean));

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
      setPartnerTyping(false);
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
      setPartnerTyping(false);
      setRemoteBlurred(true);

      const myId = socket.id || "";
      const otherId = partnerId || "";

      try {
        if (myId && otherId && myId < otherId) {
          await startWebRTCAsCaller();
        }
      } catch {
        alert("Camera/Mic blocked. Allow permissions and try again.");
      }
    });

    socket.on("typing", ({ isTyping }) => setPartnerTyping(!!isTyping));

    socket.on("chat:message", (msg) => {
      const isMe = msg?.from && msg.from === socketRef.current?.id;
      if (!isMe) playReceiveSound();
      setMessages((prev) => [...prev, msg]);
    });

    socket.on("partner_left", () => {
      setStatus("left");
      setRoomId(null);
      setPartnerId(null);
      setPartnerTyping(false);
      setRemoteBlurred(true);
      cleanupVideo();
    });

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
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch {}
        audioCtxRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- Typing UI (dots + fade) ----------------
  useEffect(() => {
    const was = prevPartnerTypingRef.current;
    if (!was && partnerTyping) playTypingTick();
    prevPartnerTypingRef.current = partnerTyping;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerTyping]);

  useEffect(() => {
    if (partnerTyping) {
      setShowTypingUi(true);
      return;
    }
    const t = setTimeout(() => setShowTypingUi(false), 220);
    return () => clearTimeout(t);
  }, [partnerTyping]);

  useEffect(() => {
    if (dotsIntervalRef.current) {
      clearInterval(dotsIntervalRef.current);
      dotsIntervalRef.current = null;
    }

    if (partnerTyping) {
      let n = 0;
      dotsIntervalRef.current = setInterval(() => {
        n = (n + 1) % 4;
        setTypingDots(".".repeat(n));
      }, 350);
    } else {
      setTypingDots("");
    }

    return () => {
      if (dotsIntervalRef.current) {
        clearInterval(dotsIntervalRef.current);
        dotsIntervalRef.current = null;
      }
    };
  }, [partnerTyping]);

  // Auto-scroll chat
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---------------- Actions ----------------
  function emitTyping(isTyping) {
    socketRef.current?.emit("typing", { isTyping: !!isTyping });
  }

  function handleTyping() {
    if (!connected || status !== "matched") return;

    emitTyping(true);

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => emitTyping(false), 2500);
  }

  function sendMessage() {
    if (!roomId) return;
    const text = message.trim();
    if (!text) return;

    emitTyping(false);
    playSendSound();

    socketRef.current?.emit("chat:message", { roomId, message: text });
    setMessage("");
  }

  // ✅ IMPORTANT: send country + interest to backend
  function findPartner() {
    setRemoteBlurred(true);
    setPartnerTyping(false);
    emitTyping(false);
    cleanupVideo();
    setStatus("waiting");

    socketRef.current?.emit("find", {
      country: cleanCountry(country),
      interest: cleanInterest(interest),
    });
  }

  function next() {
    setRemoteBlurred(true);
    setPartnerTyping(false);
    emitTyping(false);
    cleanupVideo();

    socketRef.current?.emit("leave");

    setStatus("waiting");
    setRoomId(null);
    setPartnerId(null);
    setMessages([]);

    socketRef.current?.emit("find", {
      country: cleanCountry(country),
      interest: cleanInterest(interest),
    });
  }

  function stop() {
    setRemoteBlurred(true);
    setPartnerTyping(false);
    emitTyping(false);
    cleanupVideo();

    socketRef.current?.emit("leave");

    setStatus("idle");
    setRoomId(null);
    setPartnerId(null);
    setMessages([]);
  }

  function toggleMic() {
    const stream = localStreamRef.current;
    const next = !micOn;
    if (stream) stream.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  }

  function toggleCam() {
    const stream = localStreamRef.current;
    const next = !camOn;
    if (stream) stream.getVideoTracks().forEach((t) => (t.enabled = next));
    setCamOn(next);
  }

  return (
    <div className={`wrap ${darkMode ? "dark" : ""}`}>
      <div className="topbar">
        <h1 style={{ margin: 0 }}>Omegle-ish</h1>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="badge onlineBadge">Online: {onlineCount}</span>

          <span className={`badge ${connected ? "ok" : "bad"}`}>
            {connected ? "Connected ✅" : "Not connected ❌"}
          </span>

          <button className="btn secondary toggleBtn" onClick={() => setDarkMode((v) => !v)}>
            {darkMode ? "Light" : "Dark"} Mode
          </button>
        </div>
      </div>

      <div className="card">
        {/* ✅ Filters UI (country + interest) */}
        <div className="controls" style={{ gap: 10, flexWrap: "wrap" }}>
          <label className="badge" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            Country:
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="input"
              style={{ width: 140 }}
              disabled={status === "matched" || status === "waiting"}
              title="Pick a country (optional)"
            >
              <option value="any">Any</option>
              <option value="NG">NG</option>
              <option value="US">US</option>
              <option value="GB">GB</option>
              <option value="CA">CA</option>
              <option value="DE">DE</option>
              <option value="FR">FR</option>
              <option value="ZA">ZA</option>
              <option value="GH">GH</option>
              <option value="KE">KE</option>
            </select>
          </label>

          <label className="badge" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            Interest:
            <input
              className="input"
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
              placeholder="e.g. music, football..."
              style={{ width: 220 }}
              disabled={status === "matched" || status === "waiting"}
              title="Match by interest (optional)"
            />
          </label>

          {/* Main controls */}
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

              <button className="btn secondary" onClick={() => setSoundOn((v) => !v)}>
                Sound: {soundOn ? "On" : "Off"}
              </button>

              <button className="btn secondary" onClick={toggleMic}>
                Mic: {micOn ? "On" : "Off"}
              </button>

              <button className="btn secondary" onClick={toggleCam}>
                Cam: {camOn ? "On" : "Off"}
              </button>

              <button
                className="btn secondary"
                onClick={() => setRemoteBlurred((v) => !v)}
                title="Blur/unblur stranger video for safety"
              >
                {remoteBlurred ? "Reveal Video" : "Blur Video"}
              </button>
            </>
          )}
        </div>

        {/* Typing UI */}
        <div className="debugText" style={{ minHeight: 20, marginTop: 10 }}>
          {showTypingUi && <span className="typing">Stranger is typing{typingDots}</span>}
        </div>

        <div className="videoGrid" style={{ marginTop: 12 }}>
          <div className="videoCard">
            <div className="videoLabel">You</div>
            <video ref={localVideoRef} autoPlay playsInline muted className="videoEl" />
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
                <div className="nsfwText">Stranger video is blurred. Tap reveal if you want to view.</div>
                <button className="btn secondary nsfwBtn" onClick={() => setRemoteBlurred(false)}>
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
                <div className={`bubble ${isMe ? "me" : ""}`}>{m?.message || ""}</div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <div className="inputRow">
          <input
            className="input"
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              handleTyping();
            }}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder={status === "matched" ? "Type a message…" : "Match first…"}
            disabled={status !== "matched"}
          />
          <button className="btn" onClick={sendMessage} disabled={status !== "matched"}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}