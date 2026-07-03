import os
import whisper
import tempfile
import smtplib
from flask import Flask, request, jsonify
from flask_cors import CORS
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from dotenv import load_dotenv
import requests
import traceback


load_dotenv()

app = Flask(__name__)
CORS(app)

# ── Load Whisper model once at startup ──────────────────────────────────────
print("⏳ Loading Whisper small model...")
model = whisper.load_model("small")
print("✅ Whisper model loaded!")

# ── Config from .env ────────────────────────────────────────────────────────
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
BREVO_SMTP_USER    = os.getenv("BREVO_SMTP_USER")
BREVO_SMTP_PASS    = os.getenv("BREVO_SMTP_PASS")
SENDER_EMAIL       = os.getenv("SENDER_EMAIL")
SENDER_NAME        = os.getenv("SENDER_NAME", "Meeting Bot")


# ── 1. Transcribe ────────────────────────────────────────────────────────────
@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]

    # Save to a temp file
    suffix = os.path.splitext(audio_file.filename)[-1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        print(f"🎙️ Transcribing: {tmp_path}")
        # language=None → auto detect
        result = model.transcribe(tmp_path, language=None)
        transcript = result["text"].strip()
        detected_lang = result.get("language", "unknown")
        print(f"✅ Transcription done. Language detected: {detected_lang}")
        return jsonify({
            "transcript": transcript,
            "language": detected_lang
        })
    except Exception as e:
        traceback.print_exc()  # ← this prints full error in Railway logs
        return jsonify({"error": str(e)}), 500
    finally:
        os.remove(tmp_path)


# ── 2. Summarize ─────────────────────────────────────────────────────────────
@app.route("/summarize", methods=["POST"])
def summarize():
    data = request.get_json()
    transcript = data.get("transcript", "").strip()
    meeting_title = data.get("meeting_title", "Meeting")

    if not transcript:
        return jsonify({"error": "No transcript provided"}), 400

    prompt = f"""
You are an expert meeting analyst. Analyze the following meeting transcript and provide a structured summary.

Meeting Title: {meeting_title}

Transcript:
{transcript}

Provide your response in the following JSON format ONLY (no extra text):
{{
  "summary": "2-3 sentence overview of the meeting",
  "key_points": ["point 1", "point 2", "point 3"],
  "action_items": [
    {{"task": "task description", "owner": "person name or TBD", "deadline": "deadline or TBD"}}
  ],
  "sentiment": "Positive / Neutral / Mixed / Negative",
  "sentiment_note": "One sentence explaining the overall tone"
}}
"""

    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://meeting-bot.app",
                "X-Title": "Meeting Summary Bot"
            },
            json={
                "model": "google/gemma-3-27b-it:free",
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"}
            }
        )

        # ── DEBUG: print full OpenRouter response ──
        print("OpenRouter status:", response.status_code)
        print("OpenRouter response:", response.text)

        result = response.json()

        # ── Check for API-level error ──
        if "error" in result:
            print("OpenRouter API error:", result["error"])
            return jsonify({"error": result["error"]}), 500

        content = result["choices"][0]["message"]["content"]
        print("Raw content:", content)

        import json
        summary_data = json.loads(content)
        return jsonify(summary_data)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500



# ── 3. Send Email ─────────────────────────────────────────────────────────────
@app.route("/send-email", methods=["POST"])
def send_email():
    data        = request.get_json()
    recipients  = data.get("recipients", [])
    summary     = data.get("summary", {})
    meeting_title = data.get("meeting_title", "Meeting Summary")
    transcript  = data.get("transcript", "")

    if not recipients:
        return jsonify({"error": "No recipients provided"}), 400

    html = build_html_email(meeting_title, summary, transcript)

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"📋 Meeting Summary — {meeting_title}"
        msg["From"]    = f"{SENDER_NAME} <{SENDER_EMAIL}>"
        msg["To"]      = ", ".join(recipients)
        msg.attach(MIMEText(html, "html"))

        with smtplib.SMTP("smtp-relay.brevo.com", 587) as server:
            server.starttls()
            server.login(BREVO_SMTP_USER, BREVO_SMTP_PASS)
            server.sendmail(SENDER_EMAIL, recipients, msg.as_string())

        print(f"📧 Email sent to: {recipients}")
        return jsonify({"success": True, "sent_to": recipients})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── HTML Email Builder ────────────────────────────────────────────────────────
def build_html_email(title, summary, transcript):
    key_points_html = "".join(
        f"<li>{p}</li>" for p in summary.get("key_points", [])
    )
    action_items_html = "".join(
        f"""
        <tr>
          <td style='padding:8px;border:1px solid #e0e0e0'>{a.get('task','')}</td>
          <td style='padding:8px;border:1px solid #e0e0e0;text-align:center'>{a.get('owner','TBD')}</td>
          <td style='padding:8px;border:1px solid #e0e0e0;text-align:center'>{a.get('deadline','TBD')}</td>
        </tr>
        """
        for a in summary.get("action_items", [])
    )

    sentiment = summary.get("sentiment", "Neutral")
    sentiment_color = {
        "Positive": "#22c55e",
        "Neutral":  "#64748b",
        "Mixed":    "#f59e0b",
        "Negative": "#ef4444"
    }.get(sentiment, "#64748b")

    short_transcript = transcript[:1500] + "..." if len(transcript) > 1500 else transcript

    return f"""
<!DOCTYPE html>
<html>
<head><meta charset='UTF-8'></head>
<body style='margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif'>
  <table width='100%' cellpadding='0' cellspacing='0' style='background:#f1f5f9;padding:30px 0'>
    <tr><td align='center'>
      <table width='620' cellpadding='0' cellspacing='0' style='background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)'>

        <!-- Header -->
        <tr>
          <td style='background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:30px 40px;text-align:center'>
            <h1 style='color:#ffffff;margin:0;font-size:24px'>📋 Meeting Summary</h1>
            <p style='color:#bfdbfe;margin:8px 0 0'>{title}</p>
          </td>
        </tr>

        <!-- Summary -->
        <tr>
          <td style='padding:30px 40px'>
            <h2 style='color:#1e3a5f;font-size:16px;border-bottom:2px solid #2563eb;padding-bottom:8px'>🧾 Overview</h2>
            <p style='color:#374151;line-height:1.7'>{summary.get('summary','')}</p>

            <!-- Sentiment Badge -->
            <p style='margin-top:16px'>
              <span style='background:{sentiment_color};color:#fff;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:bold'>
                {sentiment} Sentiment
              </span>
              <span style='color:#6b7280;font-size:13px;margin-left:10px'>{summary.get('sentiment_note','')}</span>
            </p>

            <!-- Key Points -->
            <h2 style='color:#1e3a5f;font-size:16px;border-bottom:2px solid #2563eb;padding-bottom:8px;margin-top:28px'>🔑 Key Points</h2>
            <ul style='color:#374151;line-height:2;padding-left:20px'>
              {key_points_html}
            </ul>

            <!-- Action Items -->
            <h2 style='color:#1e3a5f;font-size:16px;border-bottom:2px solid #2563eb;padding-bottom:8px;margin-top:28px'>✅ Action Items</h2>
            <table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;font-size:14px'>
              <tr style='background:#eff6ff'>
                <th style='padding:10px;border:1px solid #e0e0e0;text-align:left'>Task</th>
                <th style='padding:10px;border:1px solid #e0e0e0'>Owner</th>
                <th style='padding:10px;border:1px solid #e0e0e0'>Deadline</th>
              </tr>
              {action_items_html}
            </table>

            <!-- Transcript Excerpt -->
            <h2 style='color:#1e3a5f;font-size:16px;border-bottom:2px solid #2563eb;padding-bottom:8px;margin-top:28px'>🎙️ Transcript Excerpt</h2>
            <div style='background:#f8fafc;border-left:4px solid #2563eb;padding:16px;border-radius:4px;color:#4b5563;font-size:13px;line-height:1.8'>
              {short_transcript}
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style='background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb'>
            <p style='color:#9ca3af;font-size:12px;margin:0'>
              Generated by <strong>Meeting Summary Bot</strong> · Powered by Whisper + Gemma 4
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
"""


# ── Health Check ──────────────────────────────────────────────────────────────
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": "whisper-small"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
