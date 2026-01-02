"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./chat/chat.css";

// ✅ Use env var on Render, fallback to your Render backend, then localhost
const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ||
  "https://omeegle-backend.onrender.com" ||
  "http://localhost:4000";

function flagEmojiFromCode(code) {
  if (!code || typeof code !== "string") return "🌍";
  const cc = code.trim().toUpperCase();
  if (cc.length !== 2) return "🌍";
  const A = 0x1f1e6;
  const base = "A".charCodeAt(0);
  const c1 = A + (cc.charCodeAt(0) - base);
  const c2 = A + (cc.charCodeAt(1) - base);
  return String.fromCodePoint(c1, c2);
}

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

  // ✅ NEW: country + interests
  const [myCountry, setMyCountry] = useState("NG"); // default Nigeria (change if you want)
  const [interest, setInterest] = useState("");
  const [partnerCountry, setPartnerCountry] = useState("");

  // ✅ bring back mic/cam/sound + typing UI
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [typingDots, setTypingDots] = useState("");

  // ✅ NSFW safety blur
  const [remoteBlurred, setRemoteBlurred] = useState(true);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);

  // -------------------- FULL SCREEN DARK MODE --------------------
  // Instead of only styling .wrap, we also theme the whole page
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  // dots animation for typing
  useEffect(() => {
    let t = null;
    if (partnerTyping) {
      let n = 0;
      t = setInterval(() => {
        n = (n + 1) % 4;
        setTypingDots(".".repeat(n));
      }, 350);
    } else {
      setTypingDots("");
    }
    return () => t && clearInterval(t);
  }, [partnerTyping]);

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

    // apply toggles
    stream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    stream.getAudioTracks().forEach((t) => (t.enabled = micOn));

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

  async function startWebRTCAsCaller() {
    await ensureLocalMedia();
    const pc = createPeerConnection();

    const stream = localStreamRef.current;
    const existing = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean));
    stream.getTracks().forEach((t) => {
      if (!existing.has(t.id)) pc.addTrack(t, stream);
    });

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
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
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => {
      setConnected(false);
      setStatus("idle");
      setRoomId(null);
      setPartnerId(null);
      setPartnerCountry("");
      setPartnerTyping(false);
      setRemoteBlurred(true);
      cleanupVideo();
    });

    socket.on("online:count", (n) => setOnlineCount(Number(n) || 0));
    socket.on("status", (s) => setStatus(s));

    socket.on("matched", async ({ roomId, partnerId, partnerCountry }) => {
      setRoomId(roomId);
      setPartnerId(partnerId || null);
      setPartnerCountry((partnerCountry || "").toUpperCase());
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
      setMessages((prev) => [...prev, msg]);
      if (!msg?.from || msg.from !== socket.id) {
        if (soundOn) {
          try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = 660;
            g.gain.value = 0.03;
            o.connect(g);
            g.connect(ctx.destination);
            o.start();
            setTimeout(() => {
              o.stop();
              ctx.close();
            }, 90);
          } catch {}
        }
      }
    });

    socket.on("partner_left", () => {
      setStatus("left");
      setRoomId(null);
      setPartnerId(null);
      setPartnerCountry("");
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundOn, camOn, micOn]);

  // Auto-scroll chat
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---------------- Actions ----------------
  function emitTyping(isTyping) {
    if (status !== "matched") return;
    socketRef.current?.emit("typing", { isTyping: !!isTyping });
  }

  function sendMessage() {
    if (!roomId) return;
    const text = message.trim();
    if (!text) return;

    socketRef.current?.emit("chat:message", { roomId, message: text });
    emitTyping(false);
    setMessage("");
  }

  function findPartner() {
    setRemoteBlurred(true);
    cleanupVideo();
    setStatus("waiting");
    setMessages([]);
    setPartnerCountry("");
    setPartnerTyping(false);

    socketRef.current?.emit("find", {
      country: myCountry,
      interest: interest.trim(),
    });
  }

  function next() {
    setRemoteBlurred(true);
    cleanupVideo();
    socketRef.current?.emit("leave");
    setStatus("waiting");
    setRoomId(null);
    setPartnerId(null);
    setPartnerCountry("");
    setPartnerTyping(false);
    setMessages([]);
    socketRef.current?.emit("find", { country: myCountry, interest: interest.trim() });
  }

  function stop() {
    setRemoteBlurred(true);
    cleanupVideo();
    socketRef.current?.emit("leave");
    setStatus("idle");
    setRoomId(null);
    setPartnerId(null);
    setPartnerCountry("");
    setPartnerTyping(false);
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

  const myFlag = useMemo(() => flagEmojiFromCode(myCountry), [myCountry]);
  const partnerFlag = useMemo(() => flagEmojiFromCode(partnerCountry), [partnerCountry]);

  return (
    <div className="page">
      {/* ✅ Anti-gravity background FX */}
      <div className="bgFx" aria-hidden="true">
        <span className="orb o1" />
        <span className="orb o2" />
        <span className="orb o3" />
        <span className="orb o4" />
        <span className="star s1" />
        <span className="star s2" />
        <span className="star s3" />
        <span className="star s4" />
      </div>

      <div className={`wrap ${darkMode ? "dark" : ""}`}>
        <div className="topbar">
          <h1 style={{ margin: 0 }}>Omegle-ish</h1>

          <div className="topRight">
            <span className="badge onlineBadge">Online: <b>{onlineCount}</b></span>

            <span className={`badge ${connected ? "ok" : "bad"}`}>
              {connected ? "Connected ✅" : "Not connected ❌"}
            </span>

            <button className="btn secondary toggleBtn" onClick={() => setDarkMode((v) => !v)}>
              {darkMode ? "Light" : "Dark"} Mode
            </button>
          </div>
        </div>

        {/* ✅ Country + Interest */}
        <div className="filters">
          <div className="filterBox">
            <div className="filterLabel">Your country</div>
            <div className="filterRow">
              <span className="flagBig">{myFlag}</span>
              <input
                className="input small"
                value={myCountry}
                onChange={(e) => setMyCountry(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="NG"
                maxLength={2}
              />
            </div>
          </div>

          <div className="filterBox">
            <div className="filterLabel">Interest (optional)</div>
            <input
              className="input small"
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
              placeholder="music, games, anime..."
              maxLength={40}
            />
          </div>

          <div className="filterBox">
            <div className="filterLabel">Match</div>
            <button className="btn" onClick={findPartner} disabled={!connected || status === "waiting"}>
              {status === "waiting" ? "Matching…" : "Start"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="controls">
            {status === "idle" && (
              <button className="btn" onClick={findPartner}>Start</button>
            )}

            {status === "waiting" && (
              <>
                <button className="btn" onClick={findPartner}>Matching…</button>
                <button className="btn secondary" onClick={stop}>Stop</button>
              </>
            )}

            {status === "left" && (
              <>
                <button className="btn" onClick={next}>Next</button>
                <button className="btn secondary" onClick={stop}>Stop</button>
              </>
            )}

            {status === "matched" && (
              <>
                <button className="btn" onClick={next}>Next</button>
                <button className="btn secondary" onClick={stop}>Stop</button>

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
                  title="Blur/unblur stranger video"
                >
                  {remoteBlurred ? "Reveal Video" : "Blur Video"}
                </button>
              </>
            )}
          </div>

          <p className="statusText">
            {status === "idle" && "Click Start to find someone."}
            {status === "waiting" && "Looking for someone…"}
            {status === "matched" && "Matched! Video should connect 👇"}
            {status === "left" && "Your partner left 😢"}
          </p>

          {/* ✅ flags */}
          {status === "matched" && (
            <div className="flagsRow">
              <span className="flagPill">You: {myFlag} <b>{myCountry}</b></span>
              <span className="flagPill">Stranger: {partnerFlag} <b>{partnerCountry || "??"}</b></span>
            </div>
          )}

          <div className="typingLine">
            {status === "matched" && partnerTyping ? (
              <span className="typing">Stranger is typing{typingDots}</span>
            ) : (
              <span className="typing muted"> </span>
            )}
          </div>

          {/* VIDEO */}
          <div className="videoGrid">
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

          {/* CHAT */}
          <div className="chatbox">
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
              placeholder={status === "matched" ? "Type a message…" : "Match first…"}
              disabled={status !== "matched"}
              onChange={(e) => {
                setMessage(e.target.value);
                emitTyping(true);
              }}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            />
            <button className="btn" onClick={sendMessage} disabled={status !== "matched"}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}