import { Router, type IRouter } from "express";
import FormData from "form-data";
import fetch from "node-fetch";

const router: IRouter = Router();

const SARVAM_API_KEY = process.env.SARVAM_API_KEY || "";
const SARVAM_BASE = "https://api.sarvam.ai";

// POST /api/voice/stt
router.post("/stt", async (req, res) => {
  try {
    const { audio, languageCode } = req.body;
    if (!audio || !languageCode) {
      res.status(400).json({ error: "Missing audio or languageCode" });
      return;
    }

    const audioBuffer = Buffer.from(audio, "base64");
    const rawMime = (req.body.mimeType as string) || "audio/wav";
    // Strip codec qualifier — Sarvam rejects "audio/webm;codecs=opus" but accepts "audio/webm"
    const mimeType = rawMime.split(";")[0].trim();
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp3") ? "mp3" : "wav";
    const form = new FormData();
    form.append("file", audioBuffer, {
      filename: `audio.${ext}`,
      contentType: mimeType,
    });
    form.append("language_code", languageCode);
    form.append("model", "saarika:v2.5");

    const response = await fetch(`${SARVAM_BASE}/speech-to-text`, {
      method: "POST",
      headers: {
        "api-subscription-key": SARVAM_API_KEY,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Sarvam STT error:", errText);
      res.status(500).json({ error: "STT service failed" });
      return;
    }

    const data = (await response.json()) as { transcript: string };
    res.json({ transcript: data.transcript || "" });
  } catch (err) {
    console.error("STT error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/voice/parse
router.post("/parse", async (req, res) => {
  const { transcript, contacts = [], languageCode = "en-IN" } = req.body;
  if (!transcript) {
    res.status(400).json({ error: "Missing transcript" });
    return;
  }

  // If not English, translate to English first so name/amount matching works
  let englishTranscript = transcript;
  if (languageCode !== "en-IN") {
    try {
      const tResp = await fetch(`${SARVAM_BASE}/translate`, {
        method: "POST",
        headers: {
          "api-subscription-key": SARVAM_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: transcript,
          source_language_code: languageCode,
          target_language_code: "en-IN",
          model: "mayura:v1",
          enable_preprocessing: true,
        }),
      });
      if (tResp.ok) {
        const tData = await tResp.json() as { translated_text: string };
        englishTranscript = tData.translated_text || transcript;
      }
    } catch {
      // fallback to original transcript if translation fails
    }
  }

  const text = englishTranscript.toLowerCase().trim();

  // Hindi number words mapping (still useful for Hinglish transcripts)
  const hindiNumbers: Record<string, number> = {
    ek: 1, do: 2, teen: 3, char: 4, paanch: 5, chhe: 6, saat: 7,
    aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, terah: 13,
    chaudah: 14, pandrah: 15, solah: 16, satrah: 17, atharah: 18,
    unnees: 19, bees: 20, pachees: 25, tees: 30, chalees: 40,
    pachas: 50, saath: 60, sattar: 70, assi: 80, nabbe: 90,
    sau: 100, hazaar: 1000, lakh: 100000,
  };

  // Detect action
  let action: "send" | "schedule" | "check_balance" | "history" | "unknown" = "unknown";
  let confidence = 0.5;

  if (/\b(send|pay|bhejo|bhej|transfer|de do|dedo|bhejdo)\b/.test(text)) {
    action = "send";
    confidence += 0.2;
  } else if (/\b(schedule|kal|parso|tomorrow|next|set|remind)\b/.test(text)) {
    action = "schedule";
    confidence += 0.15;
  } else if (/\b(balance|bakiya|check|kitna|how much|paisa|paise)\b/.test(text)) {
    action = "check_balance";
    confidence += 0.2;
  } else if (/\b(history|transactions|ledger|purana|past)\b/.test(text)) {
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
    // Try Hindi number words (for Hinglish fallback)
    let extractedAmount = 0;
    let multiplier = 1;
    let found = false;

    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (hindiNumbers[word] !== undefined) {
        const val = hindiNumbers[word];
        if (val === 100) {
          if (extractedAmount === 0) extractedAmount = 100;
          else extractedAmount *= 100;
          found = true;
        } else if (val === 1000) {
          if (extractedAmount === 0) extractedAmount = 1000;
          else extractedAmount *= 1000;
          multiplier = 1000;
          found = true;
        } else if (val === 100000) {
          if (extractedAmount === 0) extractedAmount = 100000;
          else extractedAmount *= 100000;
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

  // Match recipient — now always runs against English text so contact names match
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
          else if (word.includes(namePart) || namePart.includes(word)) score += 1;
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
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (let i = 0; i < days.length; i++) {
      if (text.includes(days[i])) {
        const now = new Date();
        const diff = (i - now.getDay() + 7) % 7 || 7;
        const target = new Date(now);
        target.setDate(now.getDate() + diff);
        scheduledDate = target.toISOString().split("T")[0];
        if (action === "unknown") action = "schedule";
        break;
      }
    }
    // Match "15th", "20th" style dates
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
    rawTranscript: transcript, // always return original transcript for the HEARD card
  });
});

// POST /api/voice/tts
router.post("/tts", async (req, res) => {
  try {
    const { text, languageCode } = req.body;
    if (!text || !languageCode) {
      res.status(400).json({ error: "Missing text or languageCode" });
      return;
    }

    const response = await fetch(`${SARVAM_BASE}/text-to-speech`, {
      method: "POST",
      headers: {
        "api-subscription-key": SARVAM_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: languageCode,
        model: "bulbul:v2",
        speaker: "anushka",
        enable_preprocessing: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Sarvam TTS error:", errText);
      res.status(500).json({ error: "TTS service failed" });
      return;
    }

    const data = (await response.json()) as { audios: string[] };
    res.json({ audio: data.audios?.[0] || "" });
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/voice/translate
router.post("/translate", async (req, res) => {
  try {
    const { text, sourceLanguage, targetLanguage } = req.body;
    if (!text || !sourceLanguage || !targetLanguage) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const response = await fetch(`${SARVAM_BASE}/translate`, {
      method: "POST",
      headers: {
        "api-subscription-key": SARVAM_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        source_language_code: sourceLanguage,
        target_language_code: targetLanguage,
        model: "mayura:v1",
        enable_preprocessing: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Sarvam translate error:", errText);
      res.status(500).json({ error: "Translation service failed" });
      return;
    }

    const data = (await response.json()) as { translated_text: string };
    res.json({ translatedText: data.translated_text || "" });
  } catch (err) {
    console.error("Translate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
