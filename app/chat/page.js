"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./chat.css";

export default function ChatPage() {
  const socketRef = useRef(null);
  const bottomRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const dotsIntervalRef = useRef(null);

  // WebRTC refs
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  // Audio refs
  const audioCtxRef = useRef(null);
  const prevPartnerTypingRef = useRef(false);
  const lastTypingTickAtRef = useRef(0);
  const lastMsgSoundAtRef = useRef(0);

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | waiting | matched | left
  const [roomId, setRoomId] = useState(null);
  const [partnerId, setPartnerId] = useState(null);

  // Dark mode
  const [darkMode, setDarkMode] = useState(false);

  // online count
  const [onlineCount, setOnlineCount] = useState(0);
  const prevOnlineCountRef = useRef(0);
  const [onlineBump, setOnlineBump] = useState(false);
  const [onlineGlow, setOnlineGlow] = useState(false);

  // typing UI
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [lastTypingEvent, setLastTypingEvent] = useState("none");
  const [typingDots, setTypingDots] = useState("");
  const [showTypingUi, setShowTypingUi] = useState(false);

  const [soundOn, setSoundOn] = useState(true);

  // Video UI states
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [videoReady, setVideoReady] = useState(false);

  // ✅ NEW: NSFW safety blur (remote video starts blurred)
  const [remoteBlurred, setRemoteBlurred] = useState(true);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);

  // ---- dark mode save/load ----
  useEffect(() => {
    try {
      const saved = localStorage.getItem("darkMode");
      if (saved === "true") setDarkMode(true);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("darkMode", String(darkMode));
    } catch {}
  }, [darkMode]);

  // ---------- Audio helpers ----------
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

  // ---------- WebRTC helpers ----------
  function closePeer() {
    try {
      if (pcRef.current) {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.close();
      }
    } catch {}
    pcRef.current = null;

    remoteStreamRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    setVideoReady(false);
  }

  function stopLocalMedia() {
    try {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    } catch {}
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
  }

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
      if (e.candidate) socketRef.current?.emit("webrtc:ice", { candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      const remoteStream = e.streams?.[0];
      if (remoteStream) {
        remoteStreamRef.current = remoteStream;
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStream;
          remoteVideoRef.current.play?.().catch(() => {});
        }
        setVideoReady(true);
      }
    };

    pcRef.current = pc;
    return pc;
  }

  async function startWebRTC() {
    if (!partnerId) return;

    await ensureLocalMedia();

    const pc = createPeerConnection();

    const stream = localStreamRef.current;
    const already = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean));
    stream.getTracks().forEach((track) => {
      if (!already.has(track.id)) pc.addTrack(track, stream);
    });

    const myId = socketRef.current?.id || "";
    const iAmCaller = myId && partnerId ? myId < partnerId : false;

    if (iAmCaller) {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("webrtc:offer", { sdp: pc.localDescription });
    }
  }

  async function handleOffer(sdp) {
    await ensureLocalMedia();
    const pc = createPeerConnection();

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

  function hangupWebRTC() {
    socketRef.current?.emit("webrtc:hangup");
    closePeer();
    stopLocalMedia();
  }

  // ---------- Socket setup ----------
  useEffect(() => {
    const socket = io("http://localhost:4000", {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => {
      setConnected(false);
      setPartnerTyping(false);
      setLastTypingEvent("none");
      closePeer();
      stopLocalMedia();
      setRemoteBlurred(true);
    });

    socket.on("status", (s) => setStatus(s));

    socket.on("matched", async ({ roomId, partnerId }) => {
      setRoomId(roomId);
      setPartnerId(partnerId || null);
      setStatus("matched");
      setMessages([]);
      setPartnerTyping(false);
      setLastTypingEvent("matched (reset)");

      // ✅ NSFW blur ON at the start of every match
      setRemoteBlurred(true);

      try {
        await startWebRTC();
      } catch {
        alert("Camera/Mic blocked. Allow permissions and click Retry Video.");
      }
    });

    socket.on("online:count", (count) => {
      const next = Number(count) || 0;
      const prev = prevOnlineCountRef.current;

      if (prev !== next) {
        setOnlineBump(true);
        setTimeout(() => setOnlineBump(false), 220);
      }
      if (next > prev) {
        setOnlineGlow(true);
        setTimeout(() => setOnlineGlow(false), 520);
      }

      prevOnlineCountRef.current = next;
      setOnlineCount(next);
    });

    socket.on("typing", ({ isTyping }) => {
      const stamp = `${new Date().toLocaleTimeString()} -> ${String(isTyping)}`;
      setLastTypingEvent(stamp);
      setPartnerTyping(!!isTyping);
    });

    socket.on("chat:message", (data) => {
      const isMe = data?.from && data.from === socketRef.current?.id;
      if (!isMe) playReceiveSound();
      setMessages((prev) => [...prev, data]);
    });

    socket.on("partner_left", () => {
      setStatus("left");
      setRoomId(null);
      setPartnerId(null);
      setPartnerTyping(false);
      setLastTypingEvent("partner_left (reset)");
      closePeer();
      stopLocalMedia();
      setRemoteBlurred(true);
    });

    socket.on("webrtc:offer", async ({ sdp }) => handleOffer(sdp));
    socket.on("webrtc:answer", async ({ sdp }) => handleAnswer(sdp));
    socket.on("webrtc:ice", async ({ candidate }) => handleIce(candidate));
    socket.on("webrtc:hangup", () => {
      closePeer();
      stopLocalMedia();
      setRemoteBlurred(true);
    });

    socket.on("banned", ({ until }) => {
      alert("You are blocked until: " + new Date(until).toLocaleString());
      closePeer();
      stopLocalMedia();
      setRemoteBlurred(true);
    });

    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (dotsIntervalRef.current) clearInterval(dotsIntervalRef.current);
      socket.disconnect();

      closePeer();
      stopLocalMedia();

      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch {}
        audioCtxRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Typing tick only on false -> true
  useEffect(() => {
    const was = prevPartnerTypingRef.current;
    if (!was && partnerTyping) playTypingTick();
    prevPartnerTypingRef.current = partnerTyping;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerTyping]);

  // fade typing UI
  useEffect(() => {
    if (partnerTyping) {
      setShowTypingUi(true);
      return;
    }
    const t = setTimeout(() => setShowTypingUi(false), 220);
    return () => clearTimeout(t);
  }, [partnerTyping]);

  // dots
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

  // auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function emitTyping(isTyping) {
    socketRef.current?.emit("typing", { isTyping: !!isTyping });
  }

  function findPartner() {
    setPartnerTyping(false);
    setLastTypingEvent("findPartner (reset)");
    emitTyping(false);

    closePeer();
    stopLocalMedia();
    setRemoteBlurred(true);

    setStatus("waiting");
    socketRef.current?.emit("find");
  }

  function next() {
    emitTyping(false);
    setPartnerTyping(false);
    setLastTypingEvent("next (reset)");

    hangupWebRTC();
    setRemoteBlurred(true);

    socketRef.current?.emit("leave");
    setStatus("waiting");
    setRoomId(null);
    setPartnerId(null);
    setMessages([]);

    socketRef.current?.emit("find");
  }

  function stop() {
    emitTyping(false);
    setPartnerTyping(false);
    setLastTypingEvent("stop (reset)");

    hangupWebRTC();
    setRemoteBlurred(true);

    socketRef.current?.emit("leave");
    setStatus("idle");
    setRoomId(null);
    setPartnerId(null);
    setMessages([]);
  }

  function handleTyping() {
    if (!connected || status !== "matched") return;

    emitTyping(true);

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    typingTimeoutRef.current = setTimeout(() => {
      emitTyping(false);
    }, 2500);
  }

  function sendMessage() {
    if (!roomId) return;

    const text = message.trim().slice(0, 300);
    if (!text) return;

    emitTyping(false);
    setPartnerTyping(false);

    playSendSound();
    socketRef.current?.emit("chat:message", { roomId, message: text });
    setMessage("");
  }

  function report() {
    if (!roomId) return;
    socketRef.current?.emit("report", { roomId, reason: "abuse" });
    alert("Report sent. Thank you.");
  }

  function toggleMic() {
    const stream = localStreamRef.current;
    if (!stream) return setMicOn((v) => !v);

    const next = !micOn;
    stream.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  }

  function toggleCam() {
    const stream = localStreamRef.current;
    if (!stream) return setCamOn((v) => !v);

    const next = !camOn;
    stream.getVideoTracks().forEach((t) => (t.enabled = next));
    setCamOn(next);
  }

  async function retryVideo() {
    try {
      await startWebRTC();
    } catch {
      alert("Camera/Mic blocked. Allow permissions then try again.");
    }
  }

  return (
    <div className={`wrap ${darkMode ? "dark" : ""}`}>
      <div className="topbar">
        <h1 style={{ margin: 0 }}>Omegle-ish (Video + Text)</h1>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className={`badge onlineBadge ${onlineGlow ? "onlineGlow" : ""}`}>
            Online:{" "}
            <b className={onlineBump ? "onlineNumber bump" : "onlineNumber"}>{onlineCount}</b>
          </span>

          <span className={`badge ${connected ? "ok" : "bad"}`}>
            {connected ? "Connected ✅" : "Not connected ❌"}
          </span>

          <button
            className="btn secondary toggleBtn"
            onClick={() => setDarkMode((v) => !v)}
            title="Toggle dark mode"
          >
            {darkMode ? "Light" : "Dark"} Mode
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
              <button className="btn secondary" onClick={report}>Report</button>

              <button className="btn secondary" onClick={() => setSoundOn((v) => !v)}>
                Sound: {soundOn ? "On" : "Off"}
              </button>

              <button className="btn secondary" onClick={toggleMic}>
                Mic: {micOn ? "On" : "Off"}
              </button>

              <button className="btn secondary" onClick={toggleCam}>
                Cam: {camOn ? "On" : "Off"}
              </button>

              <button className="btn secondary" onClick={retryVideo}>Retry Video</button>

              {/* ✅ NEW: NSFW safety blur toggle for remote video */}
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

        <p className="statusText" style={{ marginTop: 10, marginBottom: 10 }}>
          {status === "idle" && "Click Start to find someone."}
          {status === "waiting" && "Looking for someone…"}
          {status === "matched" && "Matched! Video should connect 👇"}
          {status === "left" && "Your partner left 😢"}
        </p>

        {/* VIDEO AREA */}
        <div className="videoGrid" style={{ marginBottom: 12 }}>
          <div className="videoCard">
            <div className="videoLabel">You</div>
            <video ref={localVideoRef} autoPlay playsInline muted className="videoEl" />
          </div>

          <div className="videoCard">
            <div className="videoLabel">Stranger</div>

            {/* ✅ Blur is applied via class */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={`videoEl ${remoteBlurred ? "nsfwBlur" : ""}`}
            />

            {/* ✅ Overlay hint + quick reveal */}
            {remoteBlurred && (
              <div className="nsfwOverlay">
                <div className="nsfwTitle">⚠️ Safety Blur</div>
                <div className="nsfwText">Stranger video is blurred. Tap reveal if you want to view.</div>
                <button className="btn secondary nsfwBtn" onClick={() => setRemoteBlurred(false)}>
                  Reveal Video
                </button>
              </div>
            )}

            <div className="videoHint">
              {status === "matched" && !videoReady ? "Connecting video…" : ""}
            </div>
          </div>
        </div>

        {/* typing indicator */}
        <div className="debugText" style={{ minHeight: 20, marginBottom: 8 }}>
          <span>
            partnerTyping: <b>{String(partnerTyping)}</b>
          </span>

          <span style={{ marginLeft: 10 }}>
            lastTypingEvent: <b>{lastTypingEvent}</b>
          </span>

          {showTypingUi && (
            <span className={`typingWrap ${partnerTyping ? "show" : ""}`}>
              <span className="typing">Stranger is typing{typingDots}</span>
            </span>
          )}
        </div>

        {/* chat */}
        <div className="chatbox">
          {messages.map((m, i) => {
            const isMe = m.from === socketRef.current?.id;
            return (
              <div key={i} className={`row ${isMe ? "me" : "them"}`}>
                <div className={`bubble ${isMe ? "me" : ""}`}>
                  <div className="floaty">{m.message}</div>
                  <div className="meta">{isMe ? "Me" : "Them"}</div>
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
            placeholder={status === "matched" ? "Type a message…" : "Match first…"}
            disabled={status !== "matched"}
            onChange={(e) => {
              setMessage(e.target.value);
              handleTyping();
            }}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          />

          <button className="btn" onClick={sendMessage} disabled={status !== "matched"}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}