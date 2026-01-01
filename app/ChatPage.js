"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./chat/chat.css";

/**
 * 🔧 CHANGE THIS ONLY IF YOUR BACKEND URL CHANGES
 * This MUST be your Render backend URL
 */
const SOCKET_URL = "https://omeegle-clone.onrender.com";

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

  // UI state
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("idle");
  const [roomId, setRoomId] = useState(null);
  const [partnerId, setPartnerId] = useState(null);

  const [darkMode, setDarkMode] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);

  const [partnerTyping, setPartnerTyping] = useState(false);
  const [typingDots, setTypingDots] = useState("");

  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [videoReady, setVideoReady] = useState(false);

  // ✅ NSFW safety blur
  const [remoteBlurred, setRemoteBlurred] = useState(true);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);

  // ---------------- SOCKET SETUP ----------------
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      secure: true,
    });

    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => {
      setConnected(false);
      cleanupVideo();
      setRemoteBlurred(true);
    });

    socket.on("online:count", (n) => setOnlineCount(n));

    socket.on("status", (s) => setStatus(s));

    socket.on("matched", async ({ roomId, partnerId }) => {
      setRoomId(roomId);
      setPartnerId(partnerId);
      setStatus("matched");
      setMessages([]);
      setRemoteBlurred(true);
      await startWebRTC();
    });

    socket.on("typing", ({ isTyping }) => setPartnerTyping(isTyping));

    socket.on("chat:message", (msg) =>
      setMessages((prev) => [...prev, msg])
    );

    socket.on("partner_left", () => {
      setStatus("left");
      cleanupVideo();
      setRemoteBlurred(true);
    });

    socket.on("webrtc:offer", async ({ sdp }) => handleOffer(sdp));
    socket.on("webrtc:answer", async ({ sdp }) => handleAnswer(sdp));
    socket.on("webrtc:ice", async ({ candidate }) =>
      pcRef.current?.addIceCandidate(candidate)
    );

    return () => socket.disconnect();
  }, []);

  // ---------------- WEBRTC ----------------
  async function startWebRTC() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    localStreamRef.current = stream;
    localVideoRef.current.srcObject = stream;
    localVideoRef.current.muted = true;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pcRef.current = pc;

    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.ontrack = (e) => {
      remoteVideoRef.current.srcObject = e.streams[0];
      setVideoReady(true);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit("webrtc:ice", { candidate: e.candidate });
      }
    };

    if (socketRef.current.id < partnerId) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current.emit("webrtc:offer", { sdp: offer });
    }
  }

  async function handleOffer(sdp) {
    await startWebRTC();
    await pcRef.current.setRemoteDescription(sdp);
    const answer = await pcRef.current.createAnswer();
    await pcRef.current.setLocalDescription(answer);
    socketRef.current.emit("webrtc:answer", { sdp: answer });
  }

  async function handleAnswer(sdp) {
    await pcRef.current.setRemoteDescription(sdp);
  }

  function cleanupVideo() {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    remoteVideoRef.current.srcObject = null;
    localVideoRef.current.srcObject = null;
    setVideoReady(false);
  }

  // ---------------- CHAT ----------------
  function sendMessage() {
    if (!message.trim()) return;
    socketRef.current.emit("chat:message", {
      roomId,
      message: message.trim(),
    });
    setMessage("");
  }

  function findPartner() {
    cleanupVideo();
    socketRef.current.emit("find");
    setStatus("waiting");
  }

  function next() {
    cleanupVideo();
    socketRef.current.emit("leave");
    socketRef.current.emit("find");
    setStatus("waiting");
  }

  return (
    <div className={`wrap ${darkMode ? "dark" : ""}`}>
      <div className="topbar">
        <h1>Omegle-ish</h1>
        <span className="badge onlineBadge">Online: {onlineCount}</span>
      </div>

      <div className="card">
        <div className="controls">
          {status !== "matched" && (
            <button className="btn" onClick={findPartner}>
              Start
            </button>
          )}
          {status === "matched" && (
            <>
              <button className="btn" onClick={next}>Next</button>
              <button
                className="btn secondary"
                onClick={() => setRemoteBlurred((v) => !v)}
              >
                {remoteBlurred ? "Reveal Video" : "Blur Video"}
              </button>
            </>
          )}
        </div>

        <div className="videoGrid">
          <div className="videoCard">
            <div className="videoLabel">You</div>
            <video ref={localVideoRef} autoPlay playsInline />
          </div>

          <div className="videoCard">
            <div className="videoLabel">Stranger</div>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={remoteBlurred ? "nsfwBlur" : ""}
            />
          </div>
        </div>

        <div className="chatbox">
          {messages.map((m, i) => (
            <div key={i} className={`row ${m.from === socketRef.current.id ? "me" : "them"}`}>
              <div className="bubble">{m.message}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="inputRow">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Type a message…"
          />
          <button className="btn" onClick={sendMessage}>Send</button>
        </div>
      </div>
    </div>
  );
}
