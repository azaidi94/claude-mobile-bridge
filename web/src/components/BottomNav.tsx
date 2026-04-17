type Tab = "chat" | "sessions" | "status" | "agents";

interface BottomNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: "chat", icon: "⌨", label: "Chat" },
  { id: "sessions", icon: "▤", label: "Sessions" },
  { id: "status", icon: "◉", label: "Status" },
  { id: "agents", icon: "◈", label: "Agents" },
];

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="flex bg-terminal-surface border-t border-terminal-border">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-xs uppercase tracking-widest transition-colors ${
            active === tab.id ? "text-terminal-green" : "text-terminal-muted"
          }`}
        >
          <span className="text-base">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
