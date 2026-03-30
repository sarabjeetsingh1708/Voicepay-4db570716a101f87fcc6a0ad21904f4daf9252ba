import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { COLORS } from "@/constants/colors";
import { useTheme } from "@/context/ThemeContext";
import { useApp } from "@/context/AppContext";

// On Replit: EXPO_PUBLIC_DOMAIN points to the deployed domain
// On local:  EXPO_PUBLIC_API_URL points to your Express server e.g. http://localhost:3000
// Fallback:  empty string (same-origin) — only works if both servers share a port
const BASE_URL =
  process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000";

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
  agentReply: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
  conversationHistory?: AgentMessage[];
};

// ─── Waveform ─────────────────────────────────────────────────────────────────

function WaveformBar({ index, animated }: { index: number; animated: boolean }) {
  const anim = useRef(new Animated.Value(0.25)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (animated) {
      const dur = 160 + (index % 7) * 60;
      loop = Animated.loop(
        Animated.sequence([
          Animated.delay(index * 25),
          Animated.timing(anim, { toValue: 0.85 + (index % 3) * 0.15, duration: dur, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0.15, duration: dur, useNativeDriver: true }),
        ])
      );
      loop.start();
    } else {
      Animated.timing(anim, { toValue: 0.25, duration: 200, useNativeDriver: true }).start();
    }
    return () => loop?.stop();
  }, [animated]);

  return (
    <Animated.View
      style={{
        width: 4, borderRadius: 4, backgroundColor: COLORS.primary,
        transform: [{ scaleY: anim }], height: 40,
      }}
    />
  );
}

// ─── TTS helper ───────────────────────────────────────────────────────────────

async function playTTS(text: string, language: string) {
  if (Platform.OS !== "web") return;
  try {
    const resp = await fetch(`${BASE_URL}/api/voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, languageCode: language }),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { audio: string };
    if (!data.audio) return;
    const audio = new Audio(`data:audio/wav;base64,${data.audio}`);
    await audio.play();
  } catch {
    // TTS failure is non-critical
  }
}

// ─── Conversation bubble ──────────────────────────────────────────────────────

function ConversationBubble({
  message, isUser, colors,
}: {
  message: AgentMessage;
  isUser: boolean;
  colors: ReturnType<typeof import("@/context/ThemeContext").useTheme>["colors"];
}) {
  return (
    <View style={[bubbleStyles.row, isUser ? bubbleStyles.userRow : bubbleStyles.agentRow]}>
      {!isUser && (
        <View style={[bubbleStyles.avatar, { backgroundColor: COLORS.primary + "20" }]}>
          <Ionicons name="mic" size={12} color={COLORS.primary} />
        </View>
      )}
      <View
        style={[
          bubbleStyles.bubble,
          {
            backgroundColor: isUser ? COLORS.primary : colors.card,
            borderColor: isUser ? COLORS.primary : colors.border,
          },
        ]}
      >
        <Text
          style={{
            color: isUser ? "#fff" : colors.text,
            fontSize: 14,
            lineHeight: 20,
            fontFamily: "Inter_400Regular",
          }}
        >
          {message.content}
        </Text>
      </View>
    </View>
  );
}

const bubbleStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", marginBottom: 8, gap: 8 },
  userRow: { justifyContent: "flex-end" },
  agentRow: { justifyContent: "flex-start" },
  avatar: { width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  bubble: {
    maxWidth: "78%", paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18, borderWidth: 1,
  },
});

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function PayScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { contacts, balance, addTransaction, addScheduledPayment, language } = useApp();
  const params = useLocalSearchParams();

  // Voice state
  const [isRecording, setIsRecording] = useState(false);
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [micStatus, setMicStatus] = useState<"idle" | "requesting" | "recording" | "processing">("idle");

  // Agentic conversation
  const [conversationHistory, setConversationHistory] = useState<AgentMessage[]>([]);
  const [displayMessages, setDisplayMessages] = useState<AgentMessage[]>([]);
  const [awaitingClarification, setAwaitingClarification] = useState(false);

  // Manual form (filled from agent or by hand)
  const [selectedContact, setSelectedContact] = useState<(typeof contacts)[0] | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");

  // Confirmation gate — agent sets this, user taps confirm
  const [pendingPayment, setPendingPayment] = useState<ParsedCommand | null>(null);

  const micScaleAnim = useRef(new Animated.Value(1)).current;
  const micPulse = useRef<Animated.CompositeAnimation | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const scheduleMode = params.scheduleMode === "true";

  useEffect(() => {
    if (params.prefillContact) {
      const c = contacts.find((c) => c.id === params.prefillContact);
      if (c) setSelectedContact(c);
    }
  }, [params.prefillContact]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Auto-scroll conversation to bottom
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [displayMessages]);

  // ── Mic animation helpers ──

  const startMicPulse = () => {
    micPulse.current = Animated.loop(
      Animated.sequence([
        Animated.spring(micScaleAnim, { toValue: 1.13, useNativeDriver: true, speed: 18 }),
        Animated.spring(micScaleAnim, { toValue: 1, useNativeDriver: true, speed: 18 }),
      ])
    );
    micPulse.current.start();
  };

  const stopMicPulse = () => {
    micPulse.current?.stop();
    Animated.spring(micScaleAnim, { toValue: 1, useNativeDriver: true }).start();
  };

  // ── Core: send transcript to agent ────────────────────────────────────────

  const processTranscript = async (text: string) => {
    if (!text.trim()) return;

    // Add user message to display
    const userMsg: AgentMessage = { role: "user", content: text };
    setDisplayMessages((prev) => [...prev, userMsg]);

    setMicStatus("processing");
    setIsProcessing(true);
    setAwaitingClarification(false);

    try {
      const resp = await fetch(`${BASE_URL}/api/voice/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: text,
          contacts: contacts.map((c) => ({ name: c.name, upiId: c.upiId })),
          balance,
          languageCode: language,       // tells Gemini which language to reply in
          conversationHistory,          // multi-turn memory
        }),
      });

      const data = (await resp.json()) as ParsedCommand;
      setParsed(data);

      // Add agent reply to display
      const agentMsg: AgentMessage = { role: "assistant", content: data.agentReply };
      setDisplayMessages((prev) => [...prev, agentMsg]);

      // Update conversation history for next turn
      if (data.conversationHistory) {
        setConversationHistory(data.conversationHistory);
      }

      // Speak the agent's reply
      await playTTS(data.agentReply, language);

      // Handle action outcomes
      if (data.needsClarification) {
        setAwaitingClarification(true);
        return;
      }

      // Fill form fields from agent
      if (data.amount) setAmount(String(data.amount));
      if (data.scheduledDate) setScheduleDate(data.scheduledDate);
      if (data.recipient) {
        const found = contacts.find(
          (c) =>
            c.name.toLowerCase().includes(data.recipient!.toLowerCase()) ||
            data.recipient!.toLowerCase().includes(c.name.split(" ")[0].toLowerCase())
        );
        if (found) setSelectedContact(found);
      }

      // For send/schedule with high confidence, go to confirmation gate
      if ((data.action === "send" || data.action === "schedule") && data.confidence >= 0.7) {
        setPendingPayment(data);
      }

      // Handle balance/history actions
      if (data.action === "check_balance" || data.action === "history") {
        // Agent reply already spoken; nothing more to do
      }
    } catch {
      const errMsg: AgentMessage = { role: "assistant", content: "Sorry, I had trouble processing that. Please try again." };
      setDisplayMessages((prev) => [...prev, errMsg]);
      setAwaitingClarification(false);
    } finally {
      setIsProcessing(false);
      setMicStatus("idle");
    }
  };

  // ── Recording logic ────────────────────────────────────────────────────────

  const stopRecordingAndTranscribe = (recorder: MediaRecorder, mimeType: string) => {
    // IMPORTANT: set handlers BEFORE calling stop() — stop() fires onstop
    // synchronously in some browsers, so setting ondataavailable after is too late
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = async () => {
      stopMicPulse();
      setIsRecording(false);
      setMicStatus("processing");
      streamRef.current?.getTracks().forEach((t) => t.stop());

      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];

      // Guard: empty blob means no audio was captured at all
      if (blob.size < 1000) {
        const errMsg: AgentMessage = { role: "assistant", content: "Recording was too short or empty. Hold the mic button and speak, then tap again to stop." };
        setDisplayMessages((prev) => [...prev, errMsg]);
        stopMicPulse();
        setIsRecording(false);
        setMicStatus("idle");
        streamRef.current?.getTracks().forEach((t) => t.stop());
        return;
      }

      try {
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
        }
        const base64 = btoa(binary);

        const resp = await fetch(`${BASE_URL}/api/voice/stt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64, mimeType, languageCode: language }),
        });
        const sttData = (await resp.json()) as { transcript?: string; error?: string };
        if (sttData.transcript) {
          await processTranscript(sttData.transcript);
        } else {
          const detail = sttData.error ? ` (${sttData.error})` : "";
          const errMsg: AgentMessage = { role: "assistant", content: `Could not hear clearly${detail}. Please try again.` };
          setDisplayMessages((prev) => [...prev, errMsg]);
          setMicStatus("idle");
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("STT fetch error:", detail);
        const errMsg: AgentMessage = {
          role: "assistant",
          content: `Error: ${detail}. Check that your API server is running on ${BASE_URL}.`,
        };
        setDisplayMessages((prev) => [...prev, errMsg]);
        setMicStatus("idle");
        setIsProcessing(false);
      }
    };
    // Call stop() AFTER handlers are registered
    recorder.stop();
  };

  const handleMicPress = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current?.state === "recording") {
        stopRecordingAndTranscribe(mediaRecorderRef.current, mediaRecorderRef.current.mimeType);
      }
      return;
    }
    if (micStatus === "processing") return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    if (Platform.OS === "web" && navigator.mediaDevices) {
      setMicStatus("requesting");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/ogg";

        const recorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
        recorder.start(100);
        setIsRecording(true);
        setMicStatus("recording");
        startMicPulse();
      } catch (err: unknown) {
        setMicStatus("idle");
        const domErr = err as DOMException;
        if (domErr.name === "NotAllowedError") {
          Alert.alert("Microphone Blocked", "Please allow microphone access and try again.");
        } else {
          Alert.alert("Error", "Could not access microphone: " + domErr.message);
        }
      }
    } else {
      // Native / demo fallback
      setIsRecording(true);
      setMicStatus("recording");
      startMicPulse();
      setTimeout(() => {
        stopMicPulse();
        setIsRecording(false);
        processTranscript("Send 500 to Rahul");
      }, 3000);
    }
  };

  // ── Confirm and execute payment ────────────────────────────────────────────

  const handleConfirmPayment = async () => {
    const payData = pendingPayment;
    const contact = selectedContact || (payData?.recipient
      ? contacts.find((c) =>
          c.name.toLowerCase().includes(payData.recipient!.toLowerCase()) ||
          payData.recipient!.toLowerCase().includes(c.name.split(" ")[0].toLowerCase())
        )
      : null);
    const payAmount = amount || String(payData?.amount || "");

    if (!contact || !payAmount) {
      Alert.alert("Missing Info", "Please select a contact and enter amount");
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsPaying(true);

    const isSchedule = scheduleMode || payData?.action === "schedule";
    const finalDate = scheduleDate || payData?.scheduledDate || new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const recipientFirst = contact.name.split(" ")[0];

    const confirmText = isSchedule
      ? `Done! Scheduled ₹${payAmount} to ${recipientFirst} for ${finalDate}.`
      : `Done! ₹${payAmount} sent to ${recipientFirst}.`;

    // Add confirmation to conversation
    const confirmMsg: AgentMessage = { role: "assistant", content: confirmText };
    setDisplayMessages((prev) => [...prev, confirmMsg]);

    await playTTS(confirmText, language);
    setIsPaying(false);
    setPendingPayment(null);

    if (isSchedule) {
      addScheduledPayment({
        id: `sch_${Date.now()}`,
        amount: Number(payAmount),
        contactId: contact.id,
        contactName: contact.name,
        date: finalDate,
        note,
      });
      router.push({
        pathname: "/receipt",
        params: { type: "scheduled", amount: payAmount, contactName: contact.name, date: finalDate },
      });
    } else {
      addTransaction({
        id: `txn_${Date.now()}`,
        type: "sent",
        amount: Number(payAmount),
        contactId: contact.id,
        contactName: contact.name,
        date: new Date().toISOString(),
        note: note || "Voice payment",
        category: "Others",
        status: "completed",
        transactionId: `TXN${Date.now()}`,
      });
      router.push({
        pathname: "/receipt",
        params: { type: "sent", amount: payAmount, contactName: contact.name, upiId: contact.upiId },
      });
    }
  };

  // ── Reset conversation ─────────────────────────────────────────────────────

  const handleReset = () => {
    setConversationHistory([]);
    setDisplayMessages([]);
    setParsed(null);
    setPendingPayment(null);
    setAwaitingClarification(false);
    setAmount("");
    setScheduleDate("");
    setNote("");
    setSelectedContact(null);
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const isSchedule = scheduleMode || parsed?.action === "schedule";
  const actionColor = isSchedule ? COLORS.warning : COLORS.primary;
  const canPay = !!selectedContact && !!amount;
  const hasConversation = displayMessages.length > 0;

  const micLabel =
    micStatus === "requesting" ? "Requesting mic…" :
    micStatus === "recording" ? "Tap to stop" :
    micStatus === "processing" ? "Thinking…" :
    awaitingClarification ? "Tap to answer" :
    "Tap to speak";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{
          paddingTop: insets.top + (Platform.OS === "web" ? 20 : 10),
          paddingBottom: 32,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
            {isSchedule ? "Schedule Payment" : "Voice Pay"}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {awaitingClarification
              ? "Agent needs more info — tap mic to answer"
              : isSchedule
              ? 'Try "Schedule 500 to Rahul kal" in any language'
              : 'Try "Send 500 to Rahul" or "Rahul ko paanch sau bhejo"'}
          </Text>
        </View>

        {/* Mic Section */}
        <View style={styles.micSection}>
          {micStatus === "recording" && (
            <View style={styles.waveform}>
              {Array.from({ length: 18 }, (_, i) => (
                <WaveformBar key={i} index={i} animated />
              ))}
            </View>
          )}
          <Animated.View style={{ transform: [{ scale: micScaleAnim }] }}>
            <Pressable
              onPress={handleMicPress}
              disabled={micStatus === "processing" || micStatus === "requesting" || isPaying}
              style={[
                styles.micBtn,
                {
                  backgroundColor:
                    micStatus === "recording" ? COLORS.danger :
                    awaitingClarification ? COLORS.warning :
                    actionColor,
                  shadowColor:
                    micStatus === "recording" ? COLORS.danger : actionColor,
                  opacity: (micStatus === "processing" || micStatus === "requesting") ? 0.6 : 1,
                },
              ]}
            >
              <Ionicons
                name={
                  micStatus === "recording" ? "stop" :
                  micStatus === "processing" ? "sync" :
                  awaitingClarification ? "chatbubble" :
                  "mic"
                }
                size={40}
                color="#fff"
              />
            </Pressable>
          </Animated.View>
          <Text style={[styles.micHint, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {micLabel}
          </Text>
          {Platform.OS === "web" && micStatus === "idle" && (
            <Text style={[styles.micSub, { color: colors.textMuted, fontFamily: "Inter_400Regular" }]}>
              Powered by Sarvam AI + Claude agent
            </Text>
          )}
        </View>

        {/* Conversation history */}
        {hasConversation && (
          <View style={[styles.conversationCard, { backgroundColor: colors.card }]}>
            <View style={styles.conversationHeader}>
              <Text style={[styles.conversationLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                CONVERSATION
              </Text>
              <Pressable onPress={handleReset}>
                <Text style={[styles.resetBtn, { color: COLORS.danger, fontFamily: "Inter_500Medium" }]}>
                  Reset
                </Text>
              </Pressable>
            </View>
            {displayMessages.map((msg, i) => (
              <ConversationBubble key={i} message={msg} isUser={msg.role === "user"} colors={colors} />
            ))}
            {isProcessing && (
              <View style={[bubbleStyles.row, bubbleStyles.agentRow]}>
                <View style={[bubbleStyles.avatar, { backgroundColor: COLORS.primary + "20" }]}>
                  <Ionicons name="mic" size={12} color={COLORS.primary} />
                </View>
                <View style={[bubbleStyles.bubble, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Text style={{ color: colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 14 }}>
                    Thinking…
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Confirmation gate — appears when agent is confident */}
        {pendingPayment && !pendingPayment.needsClarification && (
          <View style={[styles.confirmCard, { backgroundColor: colors.card, borderColor: actionColor + "50" }]}>
            <View style={[styles.confirmHeader, { backgroundColor: actionColor + "18" }]}>
              <Ionicons name="checkmark-circle-outline" size={18} color={actionColor} />
              <Text style={[styles.confirmTitle, { color: actionColor, fontFamily: "Inter_600SemiBold" }]}>
                Confirm Payment
              </Text>
            </View>
            {pendingPayment.amount && (
              <View style={styles.confirmRow}>
                <Text style={[styles.confirmKey, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Amount</Text>
                <Text style={[styles.confirmVal, { color: colors.text, fontFamily: "Inter_700Bold" }]}>₹{pendingPayment.amount}</Text>
              </View>
            )}
            {pendingPayment.recipient && (
              <View style={styles.confirmRow}>
                <Text style={[styles.confirmKey, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>To</Text>
                <Text style={[styles.confirmVal, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>{pendingPayment.recipient}</Text>
              </View>
            )}
            {pendingPayment.scheduledDate && (
              <View style={styles.confirmRow}>
                <Text style={[styles.confirmKey, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Date</Text>
                <Text style={[styles.confirmVal, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>{pendingPayment.scheduledDate}</Text>
              </View>
            )}
            <View style={styles.confirmBtns}>
              <Pressable
                onPress={() => setPendingPayment(null)}
                style={[styles.confirmBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <Text style={{ color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmPayment}
                disabled={isPaying}
                style={[styles.confirmBtn, { backgroundColor: actionColor, flex: 1 }]}
              >
                <Ionicons name={isSchedule ? "calendar" : "send"} size={16} color="#fff" />
                <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold" }}>
                  {isPaying ? "Processing…" : isSchedule ? "Schedule" : "Send Now"}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Manual form — always available as fallback */}
        <View style={{ marginHorizontal: 20 }}>
          <Text style={[styles.formSectionLabel, { color: colors.textMuted, fontFamily: "Inter_500Medium" }]}>
            {hasConversation ? "OR EDIT MANUALLY" : "OR FILL MANUALLY"}
          </Text>

          <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Recipient</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
            {contacts.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedContact(c); }}
                style={[
                  styles.contactChip,
                  { backgroundColor: selectedContact?.id === c.id ? actionColor : colors.card, borderColor: selectedContact?.id === c.id ? actionColor : colors.border },
                ]}
              >
                <View style={[styles.chipAvatar, { backgroundColor: selectedContact?.id === c.id ? "#fff3" : c.color + "30" }]}>
                  <Text style={{ color: selectedContact?.id === c.id ? "#fff" : c.color, fontFamily: "Inter_700Bold", fontSize: 12 }}>
                    {c.initials}
                  </Text>
                </View>
                <Text style={{ color: selectedContact?.id === c.id ? "#fff" : colors.text, fontFamily: "Inter_500Medium", fontSize: 13 }}>
                  {c.name.split(" ")[0]}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Amount (₹)</Text>
          <View style={[styles.inputRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.rupeeSymbol, { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>₹</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={colors.textMuted}
              style={[styles.amountInput, { color: colors.text, fontFamily: "Inter_700Bold" }]}
            />
          </View>

          {isSchedule && (
            <>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Date</Text>
              <View style={[styles.inputRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Ionicons name="calendar-outline" size={18} color={colors.textMuted} style={{ marginRight: 8 }} />
                <TextInput
                  value={scheduleDate}
                  onChangeText={setScheduleDate}
                  placeholder={new Date(Date.now() + 86400000).toISOString().split("T")[0]}
                  placeholderTextColor={colors.textMuted}
                  style={[styles.noteInput, { color: colors.text, fontFamily: "Inter_400Regular" }]}
                />
              </View>
            </>
          )}

          <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Note (optional)</Text>
          <View style={[styles.inputRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Add a note"
              placeholderTextColor={colors.textMuted}
              style={[styles.noteInput, { color: colors.text, fontFamily: "Inter_400Regular" }]}
            />
          </View>

          {/* Manual pay button — only shows if no agent pending payment */}
          {!pendingPayment && (
            <Pressable
              onPress={handleConfirmPayment}
              disabled={!canPay || isPaying}
              style={({ pressed }) => [
                styles.payBtn,
                {
                  backgroundColor: !canPay ? colors.surface : actionColor,
                  opacity: pressed ? 0.85 : 1,
                  transform: [{ scale: pressed ? 0.97 : 1 }],
                },
              ]}
            >
              <Ionicons name={isSchedule ? "calendar" : "send"} size={20} color="#fff" />
              <Text style={[styles.payBtnText, { fontFamily: "Inter_600SemiBold" }]}>
                {isPaying
                  ? "Confirming…"
                  : selectedContact && amount
                  ? `${isSchedule ? "Schedule" : "Pay"} ₹${amount} → ${selectedContact.name.split(" ")[0]}`
                  : "Select contact & amount"}
              </Text>
            </Pressable>
          )}

          <View style={[styles.infoBox, { backgroundColor: colors.card, borderColor: COLORS.primary + "30" }]}>
            <Ionicons name="information-circle-outline" size={16} color={COLORS.primary} />
            <Text style={[styles.infoText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              The AI agent understands Hindi, English, and Hinglish. It remembers context across turns — you can say "same amount, different person" and it'll understand.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, marginBottom: 20 },
  title: { fontSize: 28, letterSpacing: -0.5, marginBottom: 6 },
  subtitle: { fontSize: 13, lineHeight: 18 },
  micSection: { alignItems: "center", marginBottom: 20, paddingBottom: 4 },
  waveform: { flexDirection: "row", alignItems: "center", height: 60, gap: 4, marginBottom: 20 },
  micBtn: {
    width: 90, height: 90, borderRadius: 45, alignItems: "center", justifyContent: "center",
    shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: 4 }, elevation: 8,
  },
  micHint: { marginTop: 12, fontSize: 13 },
  micSub: { marginTop: 4, fontSize: 11 },
  conversationCard: {
    marginHorizontal: 20, padding: 16, borderRadius: 20, marginBottom: 16,
  },
  conversationHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12,
  },
  conversationLabel: { fontSize: 10, letterSpacing: 1.2 },
  resetBtn: { fontSize: 12 },
  confirmCard: {
    marginHorizontal: 20, borderRadius: 16, borderWidth: 1, marginBottom: 16, overflow: "hidden",
  },
  confirmHeader: { flexDirection: "row", alignItems: "center", padding: 12, gap: 8 },
  confirmTitle: { fontSize: 14 },
  confirmRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 },
  confirmKey: { fontSize: 13 },
  confirmVal: { fontSize: 15 },
  confirmBtns: { flexDirection: "row", gap: 10, padding: 16 },
  confirmBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14, gap: 8, borderWidth: 1,
  },
  formSectionLabel: { fontSize: 10, letterSpacing: 1.2, marginBottom: 14 },
  fieldLabel: { fontSize: 13, marginBottom: 8 },
  contactChip: {
    flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 12,
    borderWidth: 1, marginRight: 8, gap: 8,
  },
  chipAvatar: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  inputRow: {
    borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, marginBottom: 14,
    flexDirection: "row", alignItems: "center",
  },
  rupeeSymbol: { fontSize: 22, marginRight: 4 },
  amountInput: { flex: 1, fontSize: 28, paddingVertical: 14 },
  noteInput: { flex: 1, fontSize: 15, paddingVertical: 14 },
  payBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    paddingVertical: 18, borderRadius: 18, gap: 10, marginTop: 4, marginBottom: 16,
  },
  payBtnText: { color: "#fff", fontSize: 16 },
  infoBox: {
    flexDirection: "row", gap: 10, padding: 14, borderRadius: 14,
    borderWidth: 1, marginBottom: 24, alignItems: "flex-start",
  },
  infoText: { flex: 1, fontSize: 12, lineHeight: 18 },
});