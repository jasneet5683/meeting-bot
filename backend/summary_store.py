# summary_store.py — Handles saving/loading last 5 meeting summaries on Railway disk

import os
import json
import traceback
from datetime import datetime
from flask import Blueprint, request, jsonify

# ── Config ────────────────────────────────────────────────────────────────────
SUMMARIES_FILE = "/app/data/summaries.json"
MAX_SUMMARIES  = 5

# ── Blueprint (registers routes into app.py) ──────────────────────────────────
store_bp = Blueprint("store", __name__)

# ── Helpers ───────────────────────────────────────────────────────────────────
def load_summaries():
    os.makedirs("/app/data", exist_ok=True)
    if not os.path.exists(SUMMARIES_FILE):
        return []
    try:
        with open(SUMMARIES_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return []

def save_summaries(summaries):
    os.makedirs("/app/data", exist_ok=True)
    with open(SUMMARIES_FILE, "w") as f:
        json.dump(summaries, f, indent=2)

# ── Route: Save Summary ───────────────────────────────────────────────────────
@store_bp.route("/save-summary", methods=["POST"])
def save_summary():
    try:
        data      = request.json
        summaries = load_summaries()

        entry = {
            "id":            len(summaries) + 1,
            "saved_at":      datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
            "meeting_title": data.get("meeting_title", "Untitled Meeting"),
            "summary":       data.get("summary", {}),
            "transcript":    data.get("transcript", "")
        }

        summaries.append(entry)

        # ✅ Keep only last 5
        if len(summaries) > MAX_SUMMARIES:
            summaries = summaries[-MAX_SUMMARIES:]

        save_summaries(summaries)
        return jsonify({
            "message":     "Summary saved!",
            "total_saved": len(summaries)
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── Route: Get All Summaries ──────────────────────────────────────────────────
@store_bp.route("/get-summaries", methods=["GET"])
def get_summaries():
    try:
        summaries = load_summaries()
        return jsonify(summaries)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
