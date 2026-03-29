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

// ─── Types ────────────────────────────────────────────────────────────────────
type ConversationStatus = "disconnected" | "connecting" | "connected";

interface ConversationHook {
  status: ConversationStatus;
  isSpeaking: boolean;
  startSession: (opts: {
    conversationToken?: string;
    agentId?: string;
    overrides?: { agent?: { firstMessage?: string } };
  }) => Promise<void>;
  endSession: () => Promise<void>;
  sendContextualUpdate: (text: string) => void;
}

type ParsedCommand = {
  action: "send" | "schedule" | "check_balance" | "history" | "unknown";
  amount: number | null;
  recipient: string | null;
  recipientUpiId: string | null;
  scheduledDate: string | null;
  confidence: number;
  rawTranscript: string;
};

// ─── Web conversation hook using @11labs/client ───────────────────────────────
// The @elevenlabs/react-native SDK uses LiveKit which is incompatible with web.
// On web we use the official @11labs/client browser SDK instead.
function useWebConversation(callbacks: {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onMessage?: (msg: { source: string; message: string }) => void;
  onError?: (err: unknown) => void;
  clientTools?: Record<string, (params: unknown) => Promise<string>>;
}): ConversationHook {
  const [status, setStatus] = useState<ConversationStatus>("disconnected");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const convRef = useRef<any>(null);

  const startSession = async (opts: {
    conversationToken?: string;
    agentId?: string;
    overrides?: { agent?: { firstMessage?: string } };
  }) => {
    try {
      setStatus("connecting");
      // Dynamic import avoids bundling the SDK on native platforms
      const ElevenLabsClient = await import("@11labs/client");
      const Conversation = (ElevenLabsClient as any).Conversation;

      const conv = await Conversation.startSession({
        // Use the signed token URL if we got a token from the server
        ...(opts.conversationToken
          ? {
              signedUrl: `wss://api.elevenlabs.io/v1/convai/conversation?conversation_token=${opts.conversationToken}`,
            }
          : { agentId: opts.agentId }),
        overrides: opts.overrides,
        onConnect: () => {
          setStatus("connected");
          callbacks.onConnect?.();
        },
        onDisconnect: () => {
          setStatus("disconnected");
          setIsSpeaking(false);
          callbacks.onDisconnect?.();
        },
        onMessage: (msg: { source: string; message: string }) => {
          callbacks.onMessage?.(msg);
        },
        onError: (err: unknown) => {
          setStatus("disconnected");
          setIsSpeaking(false);
          callbacks.onError?.(err);
        },
        onModeChange: ({ mode }: { mode: string }) => {
          setIsSpeaking(mode === "speaking");
        },
        clientTools: callbacks.clientTools ?? {},
      });

      convRef.current = conv;
    } catch (err) {
      setStatus("disconnected");
      callbacks.onError?.(err);
      throw err;
    }
  };

  const endSession = async () => {
    try {
      await convRef.current?.endSession();
    } catch (_) {
      // ignore
    }
    convRef.current = null;
    setStatus("disconnected");
    setIsSpeaking(false);
  };

  const sendContextualUpdate = (text: string) => {
    try {
      convRef.current?.sendContextualUpdate(text);
    } catch (_) {
      // ignore
    }
  };

  return { status, isSpeaking, startSession, endSession, sendContextualUpdate };
}

// ─── Platform router: pick native or web SDK ─────────────────────────────────
// Rules-of-hooks: both branches are hooks, but the branch is chosen at module
// load time (Platform.OS is a compile-time constant on each platform), so the
// rule is never violated at runtime.
function useVoiceConversation(
  opts: Parameters<typeof useWebConversation>[0]
): ConversationHook {
  if (Platform.OS !== "web") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useConversation } = require("@elevenlabs/react-native");
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useConversation(opts) as ConversationHook;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useWebConversation(opts);
}

// ─── API base URL ─────────────────────────────────────────────────────────────
// On web the page is served from the SAME Express server (port 3000), so
// relative paths work perfectly — no CORS, no hardcoded host.
// On native we need the full host (set EXPO_PUBLIC_API_URL in .env).
const BASE_URL =
  Platform.OS === "web"
    ? "" // empty string → relative paths → same origin
    : process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000";

// ─── WaveformBar ─────────────────────────────────────────────────────────────
function WaveformBar({ index, animated }: { index: number; animated: boolean }) {
  const anim = useRef(new Animated.Value(0.25)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (animated) {
      const dur = 160 + (index % 7) * 60;
      loop = Animated.loop(
        Animated.sequence([
          Animated.delay(index * 25),
          Animated.timing(anim, {
            toValue: 0.85 + (index % 3) * 0.15,
            duration: dur,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0.15,
            duration: dur,
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
    } else {
      Animated.timing(anim, {
        toValue: 0.25,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
    return () => loop?.stop();
  }, [animated]);

  return (
    <Animated.View
      style={{
        width: 4,
        borderRadius: 4,
        backgroundColor: COLORS.primary,
        transform: [{ scaleY: anim }],
        height: 40,
      }}
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function PayScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { contacts, addTransaction, addScheduledPayment, language, balance } =
    useApp();
  const params = useLocalSearchParams();

  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [selectedContact, setSelectedContact] = useState<
    (typeof contacts)[0] | null
  >(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [scheduleDate, setScheduleDate] = useState("");
  const [agentSpeech, setAgentSpeech] = useState("");

  const micScaleAnim = useRef(new Animated.Value(1)).current;
  const micPulse = useRef<Animated.CompositeAnimation | null>(null);

  const scheduleMode = params.scheduleMode === "true";

  // ── ElevenLabs conversation hook ──────────────────────────────────────────
  const conversation = useVoiceConversation({
    onConnect: () => {
      startMicPulse();
    },
    onDisconnect: () => {
      stopMicPulse();
      setAgentSpeech("");
    },
    onMessage: (message: { source: string; message: string }) => {
      if (message.source === "user" && message.message) {
        setTranscript(message.message);
      }
      if ((message.source === "ai" || message.source === "agent") && message.message) {
        setAgentSpeech(message.message);
      }
    },
    onError: (error: unknown) => {
      console.error("ElevenLabs error:", error);
      Alert.alert(
        "Voice Error",
        "Could not connect to voice agent. Check your internet connection and try again."
      );
      stopMicPulse();
    },
    clientTools: {
      // Agent calls this once it has gathered payment info
      initiate_payment: async (parameters: unknown) => {
        const p = parameters as {
          amount: number;
          recipient: string;
          action: string;
          scheduledDate?: string;
        };
        setIsProcessing(true);
        try {
          const resp = await fetch(`${BASE_URL}/api/voice/parse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transcript: `${p.action} ${p.amount} to ${p.recipient}`,
              contacts: contacts.map((c) => ({ name: c.name, upiId: c.upiId })),
              languageCode: language,
            }),
          });
          const serverParsed = (await resp.json()) as ParsedCommand;

          const mergedAction =
            (p.action as ParsedCommand["action"]) || serverParsed.action;
          const mergedAmount = p.amount || serverParsed.amount;
          const mergedRecipient = p.recipient || serverParsed.recipient;
          const mergedDate = p.scheduledDate || serverParsed.scheduledDate;

          setParsed({
            action: mergedAction,
            amount: mergedAmount,
            recipient: mergedRecipient,
            recipientUpiId: serverParsed.recipientUpiId,
            scheduledDate: mergedDate || null,
            confidence: 0.95,
            rawTranscript: transcript,
          });

          if (mergedAmount) setAmount(String(mergedAmount));
          if (mergedDate) setScheduleDate(mergedDate);

          if (mergedRecipient) {
            const found = contacts.find(
              (c) =>
                c.name
                  .toLowerCase()
                  .includes(mergedRecipient.toLowerCase()) ||
                mergedRecipient
                  .toLowerCase()
                  .includes(c.name.split(" ")[0].toLowerCase())
            );
            if (found) setSelectedContact(found);
          }
        } catch (err) {
          console.error("initiate_payment tool error:", err);
        } finally {
          setIsProcessing(false);
        }
        return "Payment details captured successfully";
      },

      // Agent calls this when user asks for balance
      check_balance: async () => {
        return `The current balance is ₹${balance.toLocaleString("en-IN")}`;
      },
    },
  });

  const isConnected = conversation.status === "connected";
  const isConnecting = conversation.status === "connecting";
  const isSpeaking = conversation.isSpeaking;

  // ── Mic pulse animation ───────────────────────────────────────────────────
  const startMicPulse = () => {
    micPulse.current = Animated.loop(
      Animated.sequence([
        Animated.spring(micScaleAnim, {
          toValue: 1.13,
          useNativeDriver: true,
          speed: 18,
        }),
        Animated.spring(micScaleAnim, {
          toValue: 1,
          useNativeDriver: true,
          speed: 18,
        }),
      ])
    );
    micPulse.current.start();
  };

  const stopMicPulse = () => {
    micPulse.current?.stop();
    Animated.spring(micScaleAnim, {
      toValue: 1,
      useNativeDriver: true,
    }).start();
  };

  // ── Pre-fill contact from navigation params ───────────────────────────────
  useEffect(() => {
    if (params.prefillContact) {
      const c = contacts.find((c) => c.id === params.prefillContact);
      if (c) setSelectedContact(c);
    }
  }, [params.prefillContact]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (isConnected) {
        conversation.endSession();
      }
    };
  }, []);

  // ── Start / stop voice session ────────────────────────────────────────────
  const handleMicPress = async () => {
    if (isConnected) {
      await conversation.endSession();
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      // Fetch a short-lived signed token from our server (keeps API key off client)
      const tokenResp = await fetch(`${BASE_URL}/api/voice/token`);
      if (!tokenResp.ok) {
        const errData = await tokenResp.json().catch(() => ({}));
        Alert.alert(
          "Server Error",
          (errData as any).error || "Could not start voice session. Make sure the API server is running."
        );
        return;
      }
      const { token } = (await tokenResp.json()) as { token: string };

      // Reset state for new session
      setTranscript("");
      setParsed(null);
      setAgentSpeech("");

      await conversation.startSession({
        conversationToken: token,
        overrides: {
          agent: {
            firstMessage:
              language === "hi-IN"
                ? "नमस्ते! मैं Awaaz हूँ। पैसे भेजने हैं या कुछ और?"
                : "Hi! I'm Awaaz. Want to send money or need something else?",
          },
        },
      });

      // Send contacts + context so the agent knows who the user can pay
      const contactNames = contacts.map((c) => c.name).join(", ");
      conversation.sendContextualUpdate(
        `User's saved contacts: ${contactNames}. User's preferred language: ${language}. Current balance: ₹${balance.toLocaleString("en-IN")}.`
      );
    } catch (err: any) {
      console.error("startSession error:", err);
      if (err?.name === "NotAllowedError") {
        Alert.alert(
          "Microphone Blocked",
          "Please allow microphone access in your browser settings and try again."
        );
      } else {
        Alert.alert(
          "Error",
          "Could not start voice session: " + (err?.message || "Unknown error")
        );
      }
    }
  };

  // ── Execute the payment ───────────────────────────────────────────────────
  const handlePay = async () => {
    if (!selectedContact || !amount) {
      Alert.alert("Missing Info", "Please select a contact and enter an amount");
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsPaying(true);

    if (isConnected) {
      await conversation.endSession();
    }

    const isSchedule = scheduleMode || parsed?.action === "schedule";
    const finalDate =
      scheduleDate ||
      parsed?.scheduledDate ||
      new Date(Date.now() + 86400000).toISOString().split("T")[0];

    setIsPaying(false);

    if (isSchedule) {
      addScheduledPayment({
        id: `sch_${Date.now()}`,
        amount: Number(amount),
        contactId: selectedContact.id,
        contactName: selectedContact.name,
        date: finalDate,
        note,
      });
      router.push({
        pathname: "/receipt",
        params: {
          type: "scheduled",
          amount,
          contactName: selectedContact.name,
          date: finalDate,
        },
      });
    } else {
      addTransaction({
        id: `txn_${Date.now()}`,
        type: "sent",
        amount: Number(amount),
        contactId: selectedContact.id,
        contactName: selectedContact.name,
        date: new Date().toISOString(),
        note: note || "Voice payment",
        category: "Others",
        status: "completed",
        transactionId: `TXN${Date.now()}`,
      });
      router.push({
        pathname: "/receipt",
        params: {
          type: "sent",
          amount,
          contactName: selectedContact.name,
          upiId: selectedContact.upiId,
        },
      });
    }
  };

  const isSchedule = scheduleMode || parsed?.action === "schedule";
  const actionColor = isSchedule ? COLORS.warning : COLORS.primary;
  const canPay = !!selectedContact && !!amount;

  const micLabel = isConnected && isSpeaking
    ? "Agent speaking…"
    : isConnected
    ? "Listening — tap to stop"
    : isConnecting
    ? "Connecting…"
    : isProcessing
    ? "Processing…"
    : "Tap to speak";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + (Platform.OS === "web" ? 20 : 10),
          paddingBottom: 24,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text
            style={[
              styles.title,
              { color: colors.text, fontFamily: "Inter_700Bold" },
            ]}
          >
            {isSchedule ? "Schedule Payment" : "Voice Pay"}
          </Text>
          <Text
            style={[
              styles.subtitle,
              {
                color: colors.textSecondary,
                fontFamily: "Inter_400Regular",
              },
            ]}
          >
            {isSchedule
              ? 'Say "Schedule 500 to Rahul tomorrow" or fill below'
              : 'Say "Send 500 to Rahul" or "Rahul ko paanch sau bhejo"'}
          </Text>
        </View>

        {/* Mic Button */}
        <View style={styles.micSection}>
          {isConnected && (
            <View style={styles.waveform}>
              {Array.from({ length: 18 }, (_, i) => (
                <WaveformBar key={i} index={i} animated={isConnected} />
              ))}
            </View>
          )}
          <Animated.View style={{ transform: [{ scale: micScaleAnim }] }}>
            <Pressable
              onPress={handleMicPress}
              disabled={isProcessing || isPaying || isConnecting}
              style={[
                styles.micBtn,
                {
                  backgroundColor: isConnected ? COLORS.danger : actionColor,
                  shadowColor: isConnected ? COLORS.danger : actionColor,
                  opacity: isProcessing || isConnecting ? 0.6 : 1,
                },
              ]}
            >
              <Ionicons
                name={
                  isConnected && isSpeaking
                    ? "volume-high"
                    : isConnected
                    ? "stop"
                    : isProcessing || isConnecting
                    ? "sync"
                    : "mic"
                }
                size={40}
                color="#fff"
              />
            </Pressable>
          </Animated.View>
          <Text
            style={[
              styles.micHint,
              {
                color: colors.textSecondary,
                fontFamily: "Inter_400Regular",
              },
            ]}
          >
            {micLabel}
          </Text>
          <Text
            style={[
              styles.micSub,
              { color: colors.textMuted, fontFamily: "Inter_400Regular" },
            ]}
          >
            Powered by ElevenLabs · speaks {language}
          </Text>
        </View>

        {/* What the user said */}
        {!!transcript && (
          <View
            style={[styles.transcriptCard, { backgroundColor: colors.card }]}
          >
            <Text
              style={[
                styles.transcriptLabel,
                {
                  color: colors.textSecondary,
                  fontFamily: "Inter_500Medium",
                },
              ]}
            >
              YOU SAID
            </Text>
            <Text
              style={[
                styles.transcriptText,
                { color: colors.text, fontFamily: "Inter_400Regular" },
              ]}
            >
              {transcript}
            </Text>
          </View>
        )}

        {/* What the agent said */}
        {!!agentSpeech && (
          <View
            style={[
              styles.transcriptCard,
              { backgroundColor: COLORS.primary + "15" },
            ]}
          >
            <Text
              style={[
                styles.transcriptLabel,
                { color: COLORS.primary, fontFamily: "Inter_500Medium" },
              ]}
            >
              AWAAZ
            </Text>
            <Text
              style={[
                styles.transcriptText,
                { color: colors.text, fontFamily: "Inter_400Regular" },
              ]}
            >
              {agentSpeech}
            </Text>
          </View>
        )}

        {/* Parsed intent card */}
        {parsed && (
          <View
            style={[
              styles.parsedCard,
              { borderColor: COLORS.success + "40" },
            ]}
          >
            <View
              style={[
                styles.parsedHeader,
                { backgroundColor: COLORS.success + "15" },
              ]}
            >
              <Ionicons
                name="checkmark-circle"
                size={16}
                color={COLORS.success}
              />
              <Text
                style={[
                  styles.parsedAction,
                  { color: colors.text, fontFamily: "Inter_600SemiBold" },
                ]}
              >
                Intent: {parsed.action}
              </Text>
              <Text
                style={[
                  styles.confidence,
                  { color: colors.textMuted, fontFamily: "Inter_400Regular" },
                ]}
              >
                {Math.round(parsed.confidence * 100)}%
              </Text>
            </View>
            {!!parsed.amount && (
              <View style={styles.parsedRow}>
                <Text
                  style={[
                    styles.parsedKey,
                    {
                      color: colors.textSecondary,
                      fontFamily: "Inter_400Regular",
                    },
                  ]}
                >
                  Amount
                </Text>
                <Text
                  style={[
                    styles.parsedVal,
                    { color: colors.text, fontFamily: "Inter_600SemiBold" },
                  ]}
                >
                  ₹{parsed.amount}
                </Text>
              </View>
            )}
            {!!parsed.recipient && (
              <View style={styles.parsedRow}>
                <Text
                  style={[
                    styles.parsedKey,
                    {
                      color: colors.textSecondary,
                      fontFamily: "Inter_400Regular",
                    },
                  ]}
                >
                  To
                </Text>
                <Text
                  style={[
                    styles.parsedVal,
                    { color: colors.text, fontFamily: "Inter_600SemiBold" },
                  ]}
                >
                  {parsed.recipient}
                </Text>
              </View>
            )}
            {!!parsed.scheduledDate && (
              <View style={styles.parsedRow}>
                <Text
                  style={[
                    styles.parsedKey,
                    {
                      color: colors.textSecondary,
                      fontFamily: "Inter_400Regular",
                    },
                  ]}
                >
                  Date
                </Text>
                <Text
                  style={[
                    styles.parsedVal,
                    { color: colors.text, fontFamily: "Inter_600SemiBold" },
                  ]}
                >
                  {parsed.scheduledDate}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Manual form section */}
        <View style={{ marginHorizontal: 20, marginTop: 8 }}>
          <Text
            style={[
              styles.formSectionLabel,
              { color: colors.textMuted, fontFamily: "Inter_500Medium" },
            ]}
          >
            OR FILL MANUALLY
          </Text>

          {/* Contact chips */}
          <Text
            style={[
              styles.fieldLabel,
              {
                color: colors.textSecondary,
                fontFamily: "Inter_500Medium",
              },
            ]}
          >
            Contact
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginBottom: 14 }}
          >
            {contacts.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedContact(
                    selectedContact?.id === c.id ? null : c
                  );
                }}
                style={[
                  styles.contactChip,
                  {
                    backgroundColor:
                      selectedContact?.id === c.id
                        ? actionColor + "20"
                        : colors.card,
                    borderColor:
                      selectedContact?.id === c.id
                        ? actionColor
                        : colors.border,
                  },
                ]}
              >
                <View
                  style={[styles.chipAvatar, { backgroundColor: c.color }]}
                >
                  <Text
                    style={{
                      color: "#fff",
                      fontFamily: "Inter_700Bold",
                      fontSize: 12,
                    }}
                  >
                    {c.initials}
                  </Text>
                </View>
                <Text
                  style={{
                    color: colors.text,
                    fontFamily: "Inter_500Medium",
                    fontSize: 13,
                  }}
                >
                  {c.name.split(" ")[0]}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Amount */}
          <Text
            style={[
              styles.fieldLabel,
              {
                color: colors.textSecondary,
                fontFamily: "Inter_500Medium",
              },
            ]}
          >
            Amount
          </Text>
          <View
            style={[
              styles.inputRow,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <Text
              style={[
                styles.rupeeSymbol,
                { color: colors.textMuted, fontFamily: "Inter_700Bold" },
              ]}
            >
              ₹
            </Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="0"
              keyboardType="numeric"
              placeholderTextColor={colors.textMuted}
              style={[
                styles.amountInput,
                { color: colors.text, fontFamily: "Inter_700Bold" },
              ]}
            />
          </View>

          {/* Schedule date (only in schedule mode) */}
          {(isSchedule || !!scheduleDate) && (
            <>
              <Text
                style={[
                  styles.fieldLabel,
                  {
                    color: colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                  },
                ]}
              >
                Date
              </Text>
              <View
                style={[
                  styles.inputRow,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Ionicons
                  name="calendar-outline"
                  size={18}
                  color={colors.textMuted}
                  style={{ marginRight: 8 }}
                />
                <TextInput
                  value={scheduleDate}
                  onChangeText={setScheduleDate}
                  placeholder={
                    new Date(Date.now() + 86400000)
                      .toISOString()
                      .split("T")[0]
                  }
                  placeholderTextColor={colors.textMuted}
                  style={[
                    styles.noteInput,
                    { color: colors.text, fontFamily: "Inter_400Regular" },
                  ]}
                />
              </View>
            </>
          )}

          {/* Note */}
          <Text
            style={[
              styles.fieldLabel,
              {
                color: colors.textSecondary,
                fontFamily: "Inter_500Medium",
              },
            ]}
          >
            Note (optional)
          </Text>
          <View
            style={[
              styles.inputRow,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Add a note"
              placeholderTextColor={colors.textMuted}
              style={[
                styles.noteInput,
                { color: colors.text, fontFamily: "Inter_400Regular" },
              ]}
            />
          </View>

          {/* Pay button */}
          <Pressable
            onPress={handlePay}
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
            {isPaying ? (
              <Ionicons name="sync" size={20} color="#fff" />
            ) : (
              <Ionicons
                name={isSchedule ? "calendar" : "send"}
                size={20}
                color="#fff"
              />
            )}
            <Text
              style={[styles.payBtnText, { fontFamily: "Inter_600SemiBold" }]}
            >
              {isPaying
                ? "Confirming…"
                : isSchedule
                ? selectedContact && amount
                  ? `Schedule ₹${amount} → ${selectedContact.name.split(" ")[0]}`
                  : "Schedule Payment"
                : selectedContact && amount
                ? `Pay ₹${amount} → ${selectedContact.name.split(" ")[0]}`
                : "Select contact & amount"}
            </Text>
          </Pressable>

          {/* UPI info */}
          <View
            style={[
              styles.infoBox,
              {
                backgroundColor: colors.card,
                borderColor: COLORS.primary + "30",
              },
            ]}
          >
            <Ionicons
              name="information-circle-outline"
              size={16}
              color={COLORS.primary}
            />
            <Text
              style={[
                styles.infoText,
                {
                  color: colors.textSecondary,
                  fontFamily: "Inter_400Regular",
                },
              ]}
            >
              UPI payments are instant — the recipient's bank account is
              credited within seconds via NPCI's network. They'll see a
              notification on their phone automatically.
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
  waveform: {
    flexDirection: "row",
    alignItems: "center",
    height: 60,
    gap: 4,
    marginBottom: 20,
  },
  micBtn: {
    width: 90,
    height: 90,
    borderRadius: 45,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  micHint: { marginTop: 12, fontSize: 13 },
  micSub: { marginTop: 4, fontSize: 11 },
  transcriptCard: {
    marginHorizontal: 20,
    padding: 16,
    borderRadius: 16,
    marginBottom: 12,
  },
  transcriptLabel: { fontSize: 10, letterSpacing: 1.2, marginBottom: 6 },
  transcriptText: { fontSize: 16, lineHeight: 22 },
  parsedCard: {
    marginHorizontal: 20,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 16,
    overflow: "hidden",
  },
  parsedHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 6,
  },
  parsedAction: { fontSize: 13, flex: 1 },
  confidence: { fontSize: 12 },
  parsedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  parsedKey: { fontSize: 13 },
  parsedVal: { fontSize: 15 },
  formSectionLabel: { fontSize: 10, letterSpacing: 1.2, marginBottom: 14 },
  fieldLabel: { fontSize: 13, marginBottom: 8 },
  contactChip: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    marginRight: 8,
    gap: 8,
  },
  chipAvatar: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  inputRow: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    marginBottom: 14,
    flexDirection: "row",
    alignItems: "center",
  },
  rupeeSymbol: { fontSize: 22, marginRight: 4 },
  amountInput: { flex: 1, fontSize: 28, paddingVertical: 14 },
  noteInput: { flex: 1, fontSize: 15, paddingVertical: 14 },
  payBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 18,
    borderRadius: 18,
    gap: 10,
    marginTop: 4,
    marginBottom: 16,
  },
  payBtnText: { color: "#fff", fontSize: 16 },
  infoBox: {
    flexDirection: "row",
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 24,
    alignItems: "flex-start",
  },
  infoText: { flex: 1, fontSize: 12, lineHeight: 18 },
});