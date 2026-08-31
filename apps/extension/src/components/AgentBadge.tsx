export type AgentStatus = "checking" | "connected" | "disconnected";

export function AgentBadge({ status }: { status: AgentStatus }) {
  const modifier = status === "connected" ? "aias-badge-on" : status === "checking" ? "aias-badge-neutral" : "";
  const text = status === "checking" ? "Checking Agent…" : status === "connected" ? "Agent connected" : "Agent not running";
  return (
    <span className={`aias-badge ${modifier}`.trim()}>
      <span className="aias-badge-dot" />
      {text}
    </span>
  );
}

