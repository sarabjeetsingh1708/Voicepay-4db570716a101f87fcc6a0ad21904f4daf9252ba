import { Router, type IRouter } from "express";
import FormData from "form-data";
import fetch from "node-fetch";

const router: IRouter = Router();

const SARVAM_API_KEY = process.env.SARVAM_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SARVAM_BASE = "https://api.sarvam.ai";
const GEMINI_MODEL = "gemini-2.0-flash-lite";   // higher free-tier RPM than gemini-2.0-flash
const GEMINI_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentMessage = { role: "user" | "assistant"; content: string };

type ParsedCommand = {
  action: "send" | "schedule" | "check_balance" | "history" | "unknown" | "clarify";
  amount: number | null;
  recipient: string | null;
  recipientUpiId: string | null;
  scheduledDate: string | null;
  confidence: number;
  rawTranscript: string;
  agentReply: string;           // spoken back to user via TTS
  needsClarification: boolean;  // true = agent is asking a follow-up
  clarificationQuestion?: string;
};

// ─── Tool definitions for Gemini ─────────────────────────────────────────────

const GEMINI_TOOLS = {
  function_declarations: [
    {
      name: "execute_payment",
      description: "Execute or schedule a UPI payment to a contact. Call this only when you have BOTH a recipient AND an amount confirmed.",
      parameters: {
        type: "OBJECT",
        properties: {
          action: {
            type: "STRING",
            enum: ["send", "schedule"],
            description: "Whether to send immediately or schedule for later",
          },
          amount: { type: "NUMBER", description: "Amount in INR (₹)" },
          recipient: { type: "STRING", description: "Full name of the recipient" },
          recipientUpiId: { type: "STRING", description: "UPI ID of the recipient" },
          scheduledDate: {
            type: "STRING",
            description: "ISO date string (YYYY-MM-DD) if scheduling. Omit for immediate send.",
          },
          confidence: {
            type: "NUMBER",
            description: "Your confidence 0-1 that you understood correctly",
          },
        },
        required: ["action", "amount", "recipient", "recipientUpiId", "confidence"],
      },
    },
    {
      name: "check_balance",
      description: "Retrieve the user's current account balance",
      parameters: {
        type: "OBJECT",
        properties: {},
      },
    },
    {
      name: "get_transaction_history",
      description: "Retrieve recent transaction history",
      parameters: {
        type: "OBJECT",
        properties: {
          limit: { type: "NUMBER", description: "Number of transactions to fetch (default 5)" },
          contactName: { type: "STRING", description: "Filter by contact name (optional)" },
        },
      },
    },
    {
      name: "ask_clarification",
      description: "Ask the user a follow-up question when intent, amount, or recipient is unclear. Only ask ONE question at a time.",
      parameters: {
        type: "OBJECT",
        properties: {
          question: {
            type: "STRING",
            description: "The clarification question to ask the user. Keep it short and natural.",
          },
          missingField: {
            type: "STRING",
            enum: ["recipient", "amount", "date", "action", "confirmation"],
            description: "Which field is unclear",
          },
        },
        required: ["question", "missingField"],
      },
    },
  ],
};

// ─── Server-side TTS reply builder (Sarvam speaks these) ─────────────────────
// Gemini decides WHAT to do. This function decides WHAT TO SAY in the user's language.
// Keeps Gemini token usage minimal and reply text always under 500 chars.

type TTSContext = {
  amount?: number;
  name?: string;
  date?: string;
  isSchedule?: boolean;
  missingField?: string;
  fallback?: string;
};

const TTS_PHRASES: Record<string, Record<string, (ctx: TTSContext) => string>> = {
  "en-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `Schedule ₹${amount} to ${name} on ${date}. Confirm?` : `Send ₹${amount} to ${name}. Confirm?`,
    balance: ({ amount }) => `Your balance is ₹${amount?.toLocaleString("en-IN")}.`,
    history: () => "Showing your recent transactions.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Who should I send to?" :
      missingField === "amount" ? "How much to send?" :
      missingField === "date" ? "Which date?" :
      fallback || "Could you say that again?",
    unknown: () => "I didn't catch that. Try: Send 500 to Rahul.",
  },
  "hi-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `${name} ko ₹${amount} ${date} ko schedule karein? Confirm karein.` : `${name} ko ₹${amount} bhejein? Confirm karein.`,
    balance: ({ amount }) => `Aapka balance ₹${amount?.toLocaleString("en-IN")} hai.`,
    history: () => "Aapke recent transactions dikha raha hoon.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Kisko bhejna hai?" :
      missingField === "amount" ? "Kitna bhejna hai?" :
      missingField === "date" ? "Kab bhejna hai?" :
      fallback || "Dobara bolein please.",
    unknown: () => "Samajh nahi aaya. Bolein: Rahul ko 500 bhejo.",
  },
  "bn-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `${name}-ke ₹${amount} ${date}-e schedule korbo? Confirm korun.` : `${name}-ke ₹${amount} pathabo? Confirm korun.`,
    balance: ({ amount }) => `Apnar balance ₹${amount?.toLocaleString("en-IN")}.`,
    history: () => "Apnar recent transactions dekhachhi.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Kake pathabo?" :
      missingField === "amount" ? "Koto taka pathabo?" :
      fallback || "Abar bolun please.",
    unknown: () => "Bujhte parini. Bolun: Rahul-ke 500 pathao.",
  },
  "ta-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `${name}-ku ₹${amount} ${date} anuppa schedule pannanuma? Confirm pannunga.` : `${name}-ku ₹${amount} anuppanuma? Confirm pannunga.`,
    balance: ({ amount }) => `Unga balance ₹${amount?.toLocaleString("en-IN")}.`,
    history: () => "Unga recent transactions kaaturen.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Yaarukku anuppa?" :
      missingField === "amount" ? "Evvalavu anuppa?" :
      fallback || "Maadum sollunga.",
    unknown: () => "Puriyala. Sollunga: Rahul-ku 500 anuppu.",
  },
  "te-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `${name}-ki ₹${amount} ${date} schedule cheyyanama? Confirm cheyyandi.` : `${name}-ki ₹${amount} pampinchanama? Confirm cheyyandi.`,
    balance: ({ amount }) => `Meeru balance ₹${amount?.toLocaleString("en-IN")}.`,
    history: () => "Meeru recent transactions chupistunnanu.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Evvarike pampinchali?" :
      missingField === "amount" ? "Entha pampinchali?" :
      fallback || "Marla cheppandi.",
    unknown: () => "Artham kaala. Cheppandi: Rahul-ki 500 pampu.",
  },
  "kn-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `${name}-ge ₹${amount} ${date} schedule maadali? Confirm maadi.` : `${name}-ge ₹${amount} kaḷuhisali? Confirm maadi.`,
    balance: ({ amount }) => `Nimma balance ₹${amount?.toLocaleString("en-IN")}.`,
    history: () => "Nimma recent transactions torsuttene.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Yarige kaḷuhisali?" :
      missingField === "amount" ? "Eshtu kaḷuhisali?" :
      fallback || "Matte heli please.",
    unknown: () => "Artavaagilla. Heli: Rahul-ge 500 kaḷuhisu.",
  },
  "mr-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `${name}-la ₹${amount} ${date} la schedule karायचे? Confirm kara.` : `${name}-la ₹${amount} pathavayche? Confirm kara.`,
    balance: ({ amount }) => `Tumcha balance ₹${amount?.toLocaleString("en-IN")} aahe.`,
    history: () => "Tumche recent transactions daakhavtoy.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Kunala pathavayche?" :
      missingField === "amount" ? "Kiti pathavayche?" :
      fallback || "Parat sanga please.",
    unknown: () => "Samajla nahi. Sanga: Rahul-la 500 pathav.",
  },
  "gu-IN": {
    payment: ({ amount, name, isSchedule, date }) =>
      isSchedule ? `${name}-ne ₹${amount} ${date} e schedule karvu chhe? Confirm karo.` : `${name}-ne ₹${amount} moklavu chhe? Confirm karo.`,
    balance: ({ amount }) => `Tamaro balance ₹${amount?.toLocaleString("en-IN")} chhe.`,
    history: () => "Tamara recent transactions batavun chhu.",
    clarify: ({ missingField, fallback }) =>
      missingField === "recipient" ? "Kone moklavanu chhe?" :
      missingField === "amount" ? "Ketlu moklavanu chhe?" :
      fallback || "Pharthi kaho please.",
    unknown: () => "Samajyu nahi. Kaho: Rahul-ne 500 mokal.",
  },
};

function buildTTSReply(type: "payment" | "balance" | "history" | "clarify" | "unknown", languageCode: string, ctx: TTSContext): string {
  const phrases = TTS_PHRASES[languageCode] ?? TTS_PHRASES["en-IN"];
  const fn = phrases[type] ?? TTS_PHRASES["en-IN"][type];
  const reply = fn(ctx);
  return reply.slice(0, 490); // Sarvam TTS hard limit
}

// ─── System prompt ────────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  "en-IN": "English", "hi-IN": "Hindi", "bn-IN": "Bengali", "ta-IN": "Tamil",
  "te-IN": "Telugu", "kn-IN": "Kannada", "mr-IN": "Marathi", "gu-IN": "Gujarati",
};

function buildSystemPrompt(contacts: { name: string; upiId: string }[], balance: number, languageCode: string = "en-IN"): string {
  const contactList = contacts.map(c => `${c.name}|${c.upiId}`).join(", ");
  const today = new Date().toISOString().split("T")[0];

  // Gemini only does intent extraction — NO reply text, that is built by the server
  return `UPI payment intent extractor. Date:${today} Balance:${balance}
Contacts: ${contactList}
Always call exactly one tool based on user intent:
- execute_payment: when both recipient name AND amount are clear
- ask_clarification: when recipient OR amount is missing or ambiguous (set question field)
- check_balance: balance/bakiya/kitna/how much/eshtu/evvalavu/ketlu
- get_transaction_history: history/transactions/purana/past
Numbers: sau/nooru/so/shô=100, hazaar/hajar/aayiram/veyyi/savira=1000, lakh=100000, paanch/ainthu/aidu=5, das/pathu/padi/hattu=10, bees/vees=20
Dates: kal/naalai/repu/naale/kaale=tomorrow, parso/naalandru/yelundi/nade/parmodhe=day-after-tomorrow
Fuzzy match contact names. Do NOT generate any spoken reply text — only call the tool.`;
}

// ─── Call Gemini with function calling ───────────────────────────────────────

async function callAgentLLM(
  messages: AgentMessage[],
  contacts: { name: string; upiId: string }[],
  balance: number,
  languageCode: string = "en-IN"
): Promise<{
  toolName: string;
  toolInput: Record<string, unknown>;
  agentText: string;
}> {
  const systemPrompt = buildSystemPrompt(contacts, balance, languageCode);

  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set in environment variables");
  }

  // Gemini uses "contents" array; system prompt goes as a separate field
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  console.log("Calling Gemini with", messages.length, "messages, lang:", languageCode);

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [GEMINI_TOOLS],
    tool_config: { function_calling_config: { mode: "ANY" } },
    generationConfig: { maxOutputTokens: 1024 },
  };

  // ── LOG: show exactly what we send to Gemini ──
  console.log("\n===== GEMINI REQUEST =====");
  console.log("Model:", GEMINI_MODEL);
  console.log("Language:", languageCode, "→", LANGUAGE_NAMES[languageCode]);
  console.log("--- system_instruction ---");
  console.log(systemPrompt);
  console.log("--- contents ---");
  contents.forEach((c, i) => console.log(`[${i}] ${c.role}:`, c.parts[0].text));
  console.log("--- tool names ---", GEMINI_TOOLS.function_declarations.map(t => t.name).join(", "));
  console.log("--- approx tokens (chars/4) ---", Math.round(JSON.stringify(payload).length / 4));
  console.log("==========================\n");

  const requestBody = JSON.stringify(payload);

  // Retry once on 429 — Gemini tells us exactly how long to wait
  let response = await fetch(`${GEMINI_BASE}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });

  if (response.status === 429) {
    const errJson = (await response.json()) as { error?: { details?: Array<{ retryDelay?: string }> } };
    const delayStr = errJson.error?.details?.find(d => d.retryDelay)?.retryDelay ?? "15s";
    const delayMs = (parseInt(delayStr) || 15) * 1000;
    console.warn(`Gemini 429 — waiting ${delayMs}ms then retrying...`);
    await new Promise(r => setTimeout(r, delayMs));
    response = await fetch(`${GEMINI_BASE}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    candidates: Array<{
      content: {
        parts: Array<
          | { text: string }
          | { functionCall: { name: string; args: Record<string, unknown> } }
        >;
      };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
  };

  // Surface prompt blocking (e.g. safety filters)
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked prompt: ${data.promptFeedback.blockReason}`);
  }

  let agentText = "";
  let toolName = "";
  let toolInput: Record<string, unknown> = {};

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  console.log("Gemini response parts:", JSON.stringify(parts).slice(0, 300));

  for (const part of parts) {
    if ("text" in part) agentText = part.text;
    if ("functionCall" in part) {
      toolName = part.functionCall.name;
      toolInput = part.functionCall.args;
    }
  }

  if (!toolName) {
    throw new Error(`Gemini returned no function call. finishReason: ${data.candidates?.[0]?.finishReason}. Text: "${agentText.slice(0, 200)}"`);
  }

  return { toolName, toolInput, agentText };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/voice/stt — unchanged, proxies to Sarvam
router.post("/stt", async (req, res) => {
  try {
    const { audio, languageCode } = req.body;
    if (!audio || !languageCode) {
      res.status(400).json({ error: "Missing audio or languageCode" });
      return;
    }

    const audioBuffer = Buffer.from(audio, "base64");
    const rawMime = (req.body.mimeType as string) || "audio/wav";
    const mimeType = rawMime.split(";")[0].trim();
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp3") ? "mp3" : "wav";

    const form = new FormData();
    form.append("file", audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
    form.append("language_code", languageCode);
    form.append("model", "saaras:v3");   // upgraded from saarika:v2.5 (legacy)
    form.append("mode", "transcribe");   // saaras:v3 requires explicit mode

    const response = await fetch(`${SARVAM_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": SARVAM_API_KEY, ...form.getHeaders() },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Sarvam STT error:", errText);
      // Return the actual Sarvam error so the frontend can show it
      res.status(500).json({ error: errText.slice(0, 200) });
      return;
    }

    const sttData = (await response.json()) as { transcript: string };
    res.json({ transcript: sttData.transcript || "" });
  } catch (err) {
    console.error("STT error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/voice/parse — NOW AGENTIC via Claude
// Accepts conversation history for multi-turn context
router.post("/parse", async (req, res) => {
  const { transcript, contacts = [], balance = 24750, conversationHistory = [], languageCode = "en-IN" } = req.body;

  if (!transcript) {
    res.status(400).json({ error: "Missing transcript" });
    return;
  }

  // Build message history (multi-turn memory)
  const messages: AgentMessage[] = [
    ...conversationHistory,
    { role: "user", content: transcript },
  ];

  try {
    const { toolName, toolInput, agentText } = await callAgentLLM(messages, contacts, balance, languageCode);

    // Map tool calls to ParsedCommand shape the frontend already understands
    let result: ParsedCommand;

    if (toolName === "execute_payment") {
      const inp = toolInput as {
        action: "send" | "schedule";
        amount: number;
        recipient: string;
        recipientUpiId: string;
        scheduledDate?: string;
        confidence: number;
      };

      const isSchedule = inp.action === "schedule" || !!inp.scheduledDate;
      const recipientFirst = inp.recipient.split(" ")[0];

      // Server builds the spoken reply — Sarvam TTS will say this, not Gemini
      const agentReply = buildTTSReply("payment", languageCode, {
        amount: inp.amount, name: recipientFirst,
        date: inp.scheduledDate, isSchedule,
      });

      result = {
        action: isSchedule ? "schedule" : "send",
        amount: inp.amount,
        recipient: inp.recipient,
        recipientUpiId: inp.recipientUpiId,
        scheduledDate: inp.scheduledDate || null,
        confidence: inp.confidence,
        rawTranscript: transcript,
        agentReply,
        needsClarification: false,
      };
    } else if (toolName === "check_balance") {
      result = {
        action: "check_balance",
        amount: null,
        recipient: null,
        recipientUpiId: null,
        scheduledDate: null,
        confidence: 1.0,
        rawTranscript: transcript,
        agentReply: buildTTSReply("balance", languageCode, { amount: balance }),
        needsClarification: false,
      };
    } else if (toolName === "get_transaction_history") {
      result = {
        action: "history",
        amount: null,
        recipient: null,
        recipientUpiId: null,
        scheduledDate: null,
        confidence: 1.0,
        rawTranscript: transcript,
        agentReply: buildTTSReply("history", languageCode, {}),
        needsClarification: false,
      };
    } else if (toolName === "ask_clarification") {
      const inp = toolInput as { question: string; missingField: string };
      // Clarification questions come from Gemini — but we translate the missingField
      // to a natural phrase via Sarvam if possible; fallback to Gemini's question
      const agentReply = buildTTSReply("clarify", languageCode, {
        missingField: inp.missingField,
        fallback: inp.question,
      });
      result = {
        action: "clarify",
        amount: null,
        recipient: null,
        recipientUpiId: null,
        scheduledDate: null,
        confidence: 0.5,
        rawTranscript: transcript,
        agentReply,
        needsClarification: true,
        clarificationQuestion: agentReply,
      };
    } else {
      // Fallback
      result = {
        action: "unknown",
        amount: null,
        recipient: null,
        recipientUpiId: null,
        scheduledDate: null,
        confidence: 0.1,
        rawTranscript: transcript,
        agentReply: buildTTSReply("unknown", languageCode, {}),
        needsClarification: true,
      };
    }

    // Return updated conversation history for the frontend to store and pass back
    const updatedHistory: AgentMessage[] = [
      ...messages,
      { role: "assistant", content: result.agentReply },
    ];

    res.json({ ...result, conversationHistory: updatedHistory });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("Agent parse error:", detail);
    res.status(500).json({
      action: "unknown",
      amount: null,
      recipient: null,
      recipientUpiId: null,
      scheduledDate: null,
      confidence: 0,
      rawTranscript: transcript,
      // Show real error in the chat bubble so you can debug without checking server logs
      agentReply: `Agent error: ${detail}`,
      needsClarification: true,
      error: detail,
    });
  }
});

// POST /api/voice/tts — proxies to Sarvam Bulbul v3
router.post("/tts", async (req, res) => {
  try {
    const { text, languageCode } = req.body;
    if (!text || !languageCode) {
      res.status(400).json({ error: "Missing text or languageCode" });
      return;
    }

    // Sarvam TTS hard limit is 500 chars per input
    const safeText = String(text).slice(0, 490);

    const response = await fetch(`${SARVAM_BASE}/text-to-speech`, {
      method: "POST",
      headers: {
        "api-subscription-key": SARVAM_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: [safeText],
        target_language_code: languageCode,
        model: "bulbul:v3",
        speaker: "priya",
        enable_preprocessing: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Sarvam TTS error:", errText);
      res.status(500).json({ error: "TTS service failed" });
      return;
    }

    const ttsData = (await response.json()) as { audios: string[] };
    res.json({ audio: ttsData.audios?.[0] || "" });
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/voice/translate — unchanged
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

    const translateData = (await response.json()) as { translated_text: string };
    res.json({ translatedText: translateData.translated_text || "" });
  } catch (err) {
    console.error("Translate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;