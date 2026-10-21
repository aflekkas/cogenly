/** Three dots pulsing in sequence: the agent is composing. Sits inside an agent bubble. */
export function AgentTypingDots() {
  return (
    <span className="agent-typing" role="status" aria-label="Typing">
      <i aria-hidden />
      <i aria-hidden />
      <i aria-hidden />
    </span>
  );
}
