import { Router, type IRouter } from "express";
import fetch from "node-fetch";

const router: IRouter = Router();

// Read credentials from environment (populated from .env via dotenv/config in index.ts)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "";

// ── GET /api/voice/token ──────────────────────────────────────────────────────
// Returns a short-lived signed conversation token so the API key is NEVER
// exposed to the browser.  The @11labs/client SDK uses this token to open a
// WebSocket directly to ElevenLabs.
router.get("/token", async (req, res) => {
  try {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
      res.status(500).json({
        error:
          "ElevenLabs credentials not configured. Check ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in your .env file.",
      });
      return;
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("ElevenLabs token error:", response.status, errText);
      res.status(response.status).json({
        error: `ElevenLabs returned ${response.status}: ${errText}`,
      });
      return;
    }

    const data = (await response.json()) as { token: string };
    res.json({ token: data.token });
  } catch (err) {
    console.error("Token endpoint error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/voice/parse ─────────────────────────────────────────────────────
// Parses a transcript into a structured payment intent.
// Called by the ElevenLabs agent client tool after it gathers information.
router.post("/parse", async (req, res) => {
  const { transcript, contacts = [], languageCode = "en-IN" } = req.body;

  if (!transcript) {
    res.status(400).json({ error: "Missing transcript" });
    return;
  }

  const text = transcript.toLowerCase().trim();

  // Hindi/Hinglish number words
  const hindiNumbers: Record<string, number> = {
    ek: 1, do: 2, teen: 3, char: 4, paanch: 5, chhe: 6, saat: 7,
    aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, terah: 13,
    chaudah: 14, pandrah: 15, solah: 16, satrah: 17, atharah: 18,
    unnees: 19, bees: 20, pachees: 25, tees: 30, chalees: 40,
    pachas: 50, saath: 60, sattar: 70, assi: 80, nabbe: 90,
    sau: 100, hazaar: 1000, lakh: 100000,
  };

  // Detect action
  let action: "send" | "schedule" | "check_balance" | "history" | "unknown" =
    "unknown";
  let confidence = 0.5;

  if (/\b(send|pay|bhejo|bhej|transfer|de do|dedo|bhejdo)\b/.test(text)) {
    action = "send";
    confidence += 0.2;
  } else if (
    /\b(schedule|kal|parso|tomorrow|next|set|remind)\b/.test(text)
  ) {
    action = "schedule";
    confidence += 0.15;
  } else if (
    /\b(balance|bakiya|check|kitna|how much|paisa|paise)\b/.test(text)
  ) {
    action = "check_balance";
    confidence += 0.2;
  } else if (
    /\b(history|transactions|ledger|purana|past)\b/.test(text)
  ) {
    action = "history";
    confidence += 0.15;
  }

  // Extract amount
  let amount: number | null = null;
  const digitMatch = text.match(/\b(\d[\d,]*)\b/);
  if (digitMatch) {
    amount = parseInt(digitMatch[1].replace(/,/g, ""), 10);
    confidence += 0.2;
  } else {
    let extractedAmount = 0;
    let found = false;
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (hindiNumbers[word] !== undefined) {
        const val = hindiNumbers[word];
        if (val === 100) {
          extractedAmount = extractedAmount === 0 ? 100 : extractedAmount * 100;
          found = true;
        } else if (val === 1000) {
          extractedAmount =
            extractedAmount === 0 ? 1000 : extractedAmount * 1000;
          found = true;
        } else if (val === 100000) {
          extractedAmount =
            extractedAmount === 0 ? 100000 : extractedAmount * 100000;
          found = true;
        } else {
          extractedAmount += val;
          found = true;
        }
      }
    }
    if (found && extractedAmount > 0) {
      amount = extractedAmount;
      confidence += 0.2;
    }
  }

  // Match recipient from contacts list
  let recipient: string | null = null;
  let recipientUpiId: string | null = null;

  if (contacts.length > 0) {
    const words = text.split(/\s+/);
    let bestMatch: { name: string; upiId: string } | null = null;
    let bestScore = 0;

    for (const contact of contacts) {
      const nameParts = contact.name.toLowerCase().split(" ");
      let score = 0;
      for (const namePart of nameParts) {
        if (namePart.length < 3) continue;
        for (const word of words) {
          if (word === namePart) score += 2;
          else if (word.includes(namePart) || namePart.includes(word))
            score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = contact;
      }
    }

    if (bestMatch && bestScore > 0) {
      recipient = bestMatch.name;
      recipientUpiId = bestMatch.upiId;
      confidence += 0.1;
    }
  }

  // Extract scheduled date
  let scheduledDate: string | null = null;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date();
  dayAfter.setDate(dayAfter.getDate() + 2);

  if (/\b(tomorrow|kal|kl)\b/.test(text)) {
    scheduledDate = tomorrow.toISOString().split("T")[0];
  } else if (/\b(parso|day after)\b/.test(text)) {
    scheduledDate = dayAfter.toISOString().split("T")[0];
  } else {
    const days = [
      "sunday", "monday", "tuesday", "wednesday",
      "thursday", "friday", "saturday",
    ];
    for (let i = 0; i < days.length; i++) {
      if (text.includes(days[i])) {
        const now = new Date();
        const diff = ((i - now.getDay() + 7) % 7) || 7;
        const target = new Date(now);
        target.setDate(now.getDate() + diff);
        scheduledDate = target.toISOString().split("T")[0];
        if (action === "unknown") action = "schedule";
        break;
      }
    }
    const dateNumMatch = text.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
    if (dateNumMatch) {
      const day = parseInt(dateNumMatch[1]);
      const now = new Date();
      const target = new Date(now.getFullYear(), now.getMonth(), day);
      if (target < now) target.setMonth(target.getMonth() + 1);
      scheduledDate = target.toISOString().split("T")[0];
      if (action === "unknown") action = "schedule";
    }
  }

  if (scheduledDate && action === "send") action = "schedule";

  res.json({
    action,
    amount,
    recipient,
    recipientUpiId,
    scheduledDate,
    confidence: Math.min(confidence, 1.0),
    rawTranscript: transcript,
  });
});

export default router;