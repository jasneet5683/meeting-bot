const BACKEND = "https://web-production-b8ca4.up.railway.app";

let mediaRecorder  = null;
let audioChunks    = [];
let timerInterval  = null;
let seconds        = 0;
let lastSummary    = {};
let lastTranscript = "";

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
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });

    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: "video/webm" });
      await processAudio(blob, "recording.webm");
    };

    mediaRecorder.start(1000);
    startTimer();

    document.getElementById("btnStart").disabled = true;
    document.getElementById("btnStop").disabled  = false;
    setStatus("🔴 Recording in progress...", true);

  } catch (err) {
    alert("❌ Could not start recording. Please allow screen sharing and ensure 'Share audio' is ticked.");
    console.error(err);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    stopTimer();
    document.getElementById("btnStart").disabled = false;
    document.getElementById("btnStop").disabled  = true;
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
    setTimeout(hideStatus, 2000); // ✅ hide after 2 sec
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




