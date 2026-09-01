export type AgentStatus = "checking" | "connected" | "disconnected";

export function AgentBadge({ status }: { status: AgentStatus }) {
  const modifier = status === "connected" ? "aias-badge-on" : status === "checking" ? "aias-badge-neutral" : "";
  const text =
    status === "checking" ? "Checking Local App…" : status === "connected" ? "Local App connected" : "Local App not running";
  return (
    <span className={`aias-badge aias-badge--bare ${modifier}`.trim()}>
      <span className="aias-badge-dot" />
      {text}
    </span>
  );
}

