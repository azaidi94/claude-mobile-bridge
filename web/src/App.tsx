import { useState } from "react";
import { BottomNav } from "./components/BottomNav";
import { ChatPage } from "./pages/ChatPage";
import { SessionsPage } from "./pages/SessionsPage";
import { StatusPage } from "./pages/StatusPage";
import { AgentsPage } from "./pages/AgentsPage";

type Tab = "chat" | "sessions" | "status" | "agents";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");

  return (
    <div className="flex flex-col h-screen bg-terminal-bg text-terminal-text font-mono overflow-hidden">
      <div className="flex-1 overflow-hidden">
        {tab === "chat" && <ChatPage />}
        {tab === "sessions" && <SessionsPage onSwitchToChat={() => setTab("chat")} />}
        {tab === "status" && <StatusPage />}
        {tab === "agents" && <AgentsPage />}
      </div>
      <BottomNav active={tab} onChange={setTab} />
    </div>
  );
}
