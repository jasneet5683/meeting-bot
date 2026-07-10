const BACKEND = "https://applied-athletes-heath-exp.trycloudflare.com";

let mediaRecorder  = null;
let audioChunks    = [];
let timerInterval  = null;
let seconds        = 0;
let lastSummary    = {};
let lastTranscript = "";
let audioContext   = null; // ✅ track AudioContext for cleanup

// ── Tab Switch ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("panelLive").classList.toggle("hidden", tab !== "live");
  document.getElementById("panelUpload").classList.toggle("hidden", tab !== "upload");
  document.getElementById("tabLive").classList.toggle("active", tab === "live");
  document.getElementById("tabUpload").classList.toggle("active", tab === "upload");
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  seconds = 0;
  timerInterval = setInterval(() => {
    seconds++;
    const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const s = String(seconds % 60).padStart(2, "0");
    document.getElementById("timer").textContent = `${h}:${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// ── Live Recording ────────────────────────────────────────────────────────────
async function startRecording() {
  try {

    // Step 1 — Capture screen + system/tab audio
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true  // system audio (tick "Share audio" in Chrome dialog)
    });

    // Step 2 — Capture microphone audio (optional, won't block if denied)
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      console.warn("⚠️ Mic not available — using screen/system audio only.", e);
    }

    // Step 3 — Mix screen audio + mic audio via Web Audio API
    audioContext        = new AudioContext();
    const destination  = audioContext.createMediaStreamDestination();

    const screenAudioTracks = screenStream.getAudioTracks();
    if (screenAudioTracks.length > 0) {
      const screenSource = audioContext.createMediaStreamSource(
        new MediaStream(screenAudioTracks)
      );
      screenSource.connect(destination);
    } else {
      console.warn("⚠️ No system audio track found. Make sure 'Share audio' was ticked.");
    }

    if (micStream && micStream.getAudioTracks().length > 0) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(destination);
    }

    // Step 4 — Record AUDIO ONLY stream (ffmpeg can process this cleanly)
    const audioOnlyStream = destination.stream;

    // Pick best supported audio MIME type
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "audio/ogg";

    audioChunks   = [];
    mediaRecorder = new MediaRecorder(audioOnlyStream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      // Cleanup all tracks and audio context
      screenStream.getTracks().forEach(t => t.stop());
      if (micStream) micStream.getTracks().forEach(t => t.stop());
      if (audioContext) { audioContext.close(); audioContext = null; }

      const blob = new Blob(audioChunks, { type: mimeType });
      const ext  = mimeType.includes("ogg") ? "ogg" : "webm";
      await processAudio(blob, `recording.${ext}`);
    };

    // Stop recording automatically if user closes screen share dialog
    screenStream.getVideoTracks()[0].addEventListener("ended", () => {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        stopRecording();
      }
    });

    mediaRecorder.start(1000);
    startTimer();

    document.getElementById("btnStart").disabled = true;
    document.getElementById("btnStop").disabled  = false;
    document.getElementById("timerDot").classList.add("active");
    setStatus("🔴 Recording in progress...", true);

  } catch (err) {
    console.error(err);
    alert(
      "❌ Could not start recording.\n\n" +
      "Please ensure:\n" +
      "1️⃣ You click 'Allow' for screen sharing\n" +
      "2️⃣ You tick 'Share audio' checkbox in Chrome\n" +
      "3️⃣ You are using Chrome on Windows/Mac"
    );
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    stopTimer();
    document.getElementById("btnStart").disabled = false;
    document.getElementById("btnStop").disabled  = true;
    document.getElementById("timerDot").classList.remove("active");
    setStatus("⏳ Processing your recording...", true);
  }
}

// ── File Upload ───────────────────────────────────────────────────────────────
async function uploadAndSummarize() {
  const file = document.getElementById("uploadFile").files[0];
  if (!file) return alert("Please select an audio/video file first.");
  await processAudio(file, file.name);
}

// ── Core Pipeline (Transcribe + Summarize only) ───────────────────────────────
async function processAudio(blob, filename) {
  const title = document.getElementById("meetingTitle").value.trim() || "Meeting";

  // Reset email status
  document.getElementById("emailStatus").textContent = "";
  document.getElementById("recipients").value = "";

  // Step 1 — Transcribe
  setStatus("🎙️ Transcribing audio with Whisper...", true);
  const formData = new FormData();
  formData.append("audio", blob, filename);

  try {
    const res  = await fetch(`${BACKEND}/transcribe`, { method: "POST", body: formData });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    lastTranscript = data.transcript;
    setStatus(`✅ Transcription done (Language: ${data.language}). Generating summary...`, true);
  } catch (err) {
    setStatus(`❌ Transcription failed: ${err.message}`, false);
    return;
  }

  // Step 2 — Summarize
  try {
    const res  = await fetch(`${BACKEND}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: lastTranscript, meeting_title: title })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    lastSummary = data;
    displayResults(lastSummary);
    setStatus("✅ Summary ready!", true);
    await saveSummary();            // ✅ auto-save to Railway
    setTimeout(hideStatus, 2000);
  } catch (err) {
    setStatus(`❌ Summarization failed: ${err.message}`, false);
    return;
  }
}

// ── Send Email (manual button) ────────────────────────────────────────────────
async function sendEmail() {
  const title      = document.getElementById("meetingTitle").value.trim() || "Meeting";
  const recipInput = document.getElementById("recipients").value.trim();
  const recipients = recipInput.split(",").map(e => e.trim()).filter(Boolean);
  const statusEl   = document.getElementById("emailStatus");

  if (!recipients.length) {
    statusEl.textContent = "⚠️ Please enter at least one recipient email.";
    statusEl.style.color = "#f59e0b";
    return;
  }

  if (!lastSummary || !Object.keys(lastSummary).length) {
    statusEl.textContent = "⚠️ No summary available. Please summarize a meeting first.";
    statusEl.style.color = "#f59e0b";
    return;
  }

  statusEl.textContent = "📤 Sending email...";
  statusEl.style.color = "#2563eb";

  try {
    const res  = await fetch(`${BACKEND}/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipients,
        summary: lastSummary,
        meeting_title: title,
        transcript: lastTranscript
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    statusEl.textContent = `✅ Email sent to: ${recipients.join(", ")}`;
    statusEl.style.color = "#22c55e";
  } catch (err) {
    statusEl.textContent = `❌ Email failed: ${err.message}`;
    statusEl.style.color = "#ef4444";
  }
}

// ── Display Results ───────────────────────────────────────────────────────────
function displayResults(summary) {
  document.getElementById("resSummary").textContent = summary.summary || "";

  const badge = document.getElementById("resSentimentBadge");
  badge.textContent = summary.sentiment || "Neutral";
  const colors = { Positive: "#22c55e", Neutral: "#64748b", Mixed: "#f59e0b", Negative: "#ef4444" };
  badge.style.background = colors[summary.sentiment] || "#64748b";

  document.getElementById("resSentimentNote").textContent = summary.sentiment_note || "";

  const kpList = document.getElementById("resKeyPoints");
  kpList.innerHTML = (summary.key_points || []).map(p => `<li>${p}</li>`).join("");

  const tbody = document.getElementById("resActionBody");
  tbody.innerHTML = (summary.action_items || []).map(a => `
    <tr>
      <td>${a.task || ""}</td>
      <td>${a.owner || "TBD"}</td>
      <td>${a.deadline || "TBD"}</td>
    </tr>
  `).join("");

  document.getElementById("resultCard").classList.remove("hidden");
}

// ── Status Helpers ────────────────────────────────────────────────────────────
function setStatus(msg, show) {
  const box = document.getElementById("statusBox");
  document.getElementById("statusText").textContent = msg;
  box.style.display = show ? "flex" : "none";
}

function hideStatus() {
  document.getElementById("statusBox").style.display = "none";
}

// ── Save Summary to Railway ───────────────────────────────────────────────────
async function saveSummary() {
  const title = document.getElementById("meetingTitle").value.trim() || "Meeting";
  try {
    const res  = await fetch(`${BACKEND}/save-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meeting_title: title,
        summary:       lastSummary,
        transcript:    lastTranscript
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    console.log(`✅ Summary saved. Total on server: ${data.total_saved}`);
  } catch (err) {
    console.warn("⚠️ Could not save summary:", err.message);
  }
}

// ── Load Saved Summaries ──────────────────────────────────────────────────────
async function loadHistory() {
  try {
    const res       = await fetch(`${BACKEND}/get-summaries`);
    const summaries = await res.json();
    const container = document.getElementById("historyList");

    if (!summaries.length) {
      container.innerHTML = "<p style='color:#64748b'>No saved summaries yet.</p>";
      return;
    }

    container.innerHTML = summaries.reverse().map((s, i) => `
      <div class="history-card" onclick="loadFromHistory(${summaries.length - 1 - i})">
        <div class="history-title">📋 ${s.meeting_title}</div>
        <div class="history-date">🕐 ${s.saved_at}</div>
        <div class="history-preview">${(s.summary?.summary || "").slice(0, 100)}...</div>
      </div>
    `).join("");

  } catch (err) {
    console.warn("⚠️ Could not load history:", err.message);
  }
}

// ── Load a Specific Summary from History ─────────────────────────────────────
async function loadFromHistory(index) {
  try {
    const res       = await fetch(`${BACKEND}/get-summaries`);
    const summaries = await res.json();
    const entry     = summaries[index];
    if (!entry) return;

    lastSummary    = entry.summary;
    lastTranscript = entry.transcript;
    document.getElementById("meetingTitle").value = entry.meeting_title;
    displayResults(lastSummary);
    setStatus(`📂 Loaded: ${entry.meeting_title}`, true);
    setTimeout(hideStatus, 2000);
  } catch (err) {
    console.warn("⚠️ Could not load from history:", err.message);
  }
}

function updateUploadLabel(input) {
  const label = document.getElementById("uploadFilename");
  if (input.files && input.files[0]) {
    label.textContent = "📎 " + input.files[0].name;
  }
}
