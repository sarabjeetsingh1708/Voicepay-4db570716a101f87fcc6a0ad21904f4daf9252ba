import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Contact = {
  id: string;
  name: string;
  upiId: string;
  avatar: string;
  initials: string;
  color: string;
};

export type Transaction = {
  id: string;
  type: "sent" | "received" | "scheduled";
  amount: number;
  contactId: string;
  contactName: string;
  date: string;
  note?: string;
  category: string;
  status: "completed" | "pending" | "failed";
  transactionId: string;
};

export type ScheduledPayment = {
  id: string;
  amount: number;
  contactId: string;
  contactName: string;
  date: string;
  recurring?: "daily" | "weekly" | "monthly" | null;
  note?: string;
};

export type PaymentRequest = {
  id: string;
  fromContactId: string;
  fromContactName: string;
  amount: number;
  note?: string;
  date: string;
  status: "pending" | "accepted" | "declined";
};

const AVATAR_COLORS = [
  "#6366F1", "#2196F3", "#FF6D00", "#F59E0B",
  "#8B5CF6", "#EC4899", "#14B8A6", "#F97316",
];

export const MOCK_CONTACTS: Contact[] = [
  { id: "1", name: "Rahul Sharma", upiId: "rahul@upi", avatar: "", initials: "RS", color: AVATAR_COLORS[0] },
  { id: "2", name: "Priya Patel", upiId: "priya@paytm", avatar: "", initials: "PP", color: AVATAR_COLORS[1] },
  { id: "3", name: "Ankit Kumar", upiId: "ankit@gpay", avatar: "", initials: "AK", color: AVATAR_COLORS[2] },
  { id: "4", name: "Sunita Devi", upiId: "sunita@upi", avatar: "", initials: "SD", color: AVATAR_COLORS[3] },
  { id: "5", name: "Vikram Singh", upiId: "vikram@upi", avatar: "", initials: "VS", color: AVATAR_COLORS[4] },
  { id: "6", name: "Meera Joshi", upiId: "meera@okaxis", avatar: "", initials: "MJ", color: AVATAR_COLORS[5] },
  { id: "7", name: "Amit Verma", upiId: "amit@upi", avatar: "", initials: "AV", color: AVATAR_COLORS[6] },
  { id: "8", name: "Kavya Nair", upiId: "kavya@upi", avatar: "", initials: "KN", color: AVATAR_COLORS[7] },
];

const CATEGORIES = ["Food", "Transport", "Shopping", "Entertainment", "Utilities", "Others"];

function generateTransactions(): Transaction[] {
  const txns: Transaction[] = [];
  const now = new Date();
  for (let i = 0; i < 60; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - Math.floor(Math.random() * 90));
    const contact = MOCK_CONTACTS[Math.floor(Math.random() * MOCK_CONTACTS.length)];
    const isSent = Math.random() > 0.3;
    txns.push({
      id: `txn_${i}`,
      type: isSent ? "sent" : "received",
      amount: Math.floor(Math.random() * 4500) + 50,
      contactId: contact.id,
      contactName: contact.name,
      date: date.toISOString(),
      category: CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)],
      status: "completed",
      transactionId: `TXN${Date.now()}${i}`,
      note: isSent ? "Payment" : "Received",
    });
  }
  return txns.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function generateScheduled(): ScheduledPayment[] {
  const now = new Date();
  return [
    {
      id: "sch_1",
      amount: 2000,
      contactId: "1",
      contactName: "Rahul Sharma",
      date: new Date(now.getTime() + 2 * 86400000).toISOString().split("T")[0],
      recurring: "monthly",
      note: "Monthly rent share",
    },
    {
      id: "sch_2",
      amount: 500,
      contactId: "2",
      contactName: "Priya Patel",
      date: new Date(now.getTime() + 5 * 86400000).toISOString().split("T")[0],
      recurring: null,
      note: "Lunch split",
    },
    {
      id: "sch_3",
      amount: 150,
      contactId: "6",
      contactName: "Meera Joshi",
      date: new Date(now.getTime() + 1 * 86400000).toISOString().split("T")[0],
      recurring: "weekly",
      note: "Weekly groceries",
    },
  ];
}

function generateRequests(): PaymentRequest[] {
  const now = new Date();
  return [
    {
      id: "req_1",
      fromContactId: "3",
      fromContactName: "Ankit Kumar",
      amount: 750,
      note: "Movie tickets",
      date: new Date(now.getTime() - 3600000).toISOString(),
      status: "pending",
    },
    {
      id: "req_2",
      fromContactId: "5",
      fromContactName: "Vikram Singh",
      amount: 1200,
      note: "Dinner split",
      date: new Date(now.getTime() - 7200000).toISOString(),
      status: "pending",
    },
  ];
}

type AppContextType = {
  contacts: Contact[];
  transactions: Transaction[];
  scheduledPayments: ScheduledPayment[];
  paymentRequests: PaymentRequest[];
  balance: number;
  balanceVisible: boolean;
  setBalanceVisible: (v: boolean) => void;
  addTransaction: (t: Transaction) => void;
  addScheduledPayment: (s: ScheduledPayment) => void;
  removeScheduledPayment: (id: string) => void;
  respondToRequest: (id: string, accepted: boolean) => void;
  language: string;
  setLanguage: (l: string) => void;
  onboardingDone: boolean;
  completeOnboarding: () => void;
};

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [transactions, setTransactions] = useState<Transaction[]>(generateTransactions());
  const [scheduledPayments, setScheduledPayments] = useState<ScheduledPayment[]>(generateScheduled());
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>(generateRequests());
  const [balanceVisible, setBalanceVisible] = useState(true);
  const [language, setLanguageState] = useState("en-IN");
  const [onboardingDone, setOnboardingDone] = useState(false);

  useEffect(() => {
    AsyncStorage.multiGet(["@language", "@onboarding"]).then((vals) => {
      const lang = vals[0][1];
      const ob = vals[1][1];
      if (lang) setLanguageState(lang);
      if (ob === "true") setOnboardingDone(true);
    });
  }, []);

  const setLanguage = useCallback((l: string) => {
    setLanguageState(l);
    AsyncStorage.setItem("@language", l);
  }, []);

  const completeOnboarding = useCallback(() => {
    setOnboardingDone(true);
    AsyncStorage.setItem("@onboarding", "true");
  }, []);

  const addTransaction = useCallback((t: Transaction) => {
    setTransactions((prev) => [t, ...prev]);
  }, []);

  const addScheduledPayment = useCallback((s: ScheduledPayment) => {
    setScheduledPayments((prev) => [s, ...prev]);
  }, []);

  const removeScheduledPayment = useCallback((id: string) => {
    setScheduledPayments((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const respondToRequest = useCallback((id: string, accepted: boolean) => {
    setPaymentRequests((prev) =>
      prev.map((r) => r.id === id ? { ...r, status: accepted ? "accepted" : "declined" } : r)
    );
  }, []);

  const balance = 24750;

  return (
    <AppContext.Provider value={{
      contacts: MOCK_CONTACTS,
      transactions,
      scheduledPayments,
      paymentRequests,
      balance,
      balanceVisible,
      setBalanceVisible,
      addTransaction,
      addScheduledPayment,
      removeScheduledPayment,
      respondToRequest,
      language,
      setLanguage,
      onboardingDone,
      completeOnboarding,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
