/**
 * Canonical hook handler — executed by the agent-prism runner on EVERY agent.
 * payload: { platform, hookId, pluginRoot, sessionId, cwd, toolName, toolInput, raw }
 * Return a HookResult; keep handlers fast and never throw (failures are logged
 * and swallowed so the host agent is never broken).
 */
export async function run(payload) {
  // Example: observe tool calls. To BLOCK, return { block: true, reason: "..." }.
  // To inject context on session-start/prompt-submit: { additionalContext: "..." }.
  // For permission decisions: { permissionDecision: "allow" | "deny" | "ask" }.
  if (payload.toolName) {
    console.error(`[my-plugin] ${payload.platform} tool: ${payload.toolName}`);
  }
  return {};
}
