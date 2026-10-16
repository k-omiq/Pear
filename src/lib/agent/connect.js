// ===== How an agent connects to the door =====
// The lines Settings shows with a copy button (docs/AI_TYPESETTING_PLAN.md
// section 6), one per client. Pure, so each line is tested as it will be
// pasted. The token is the user's to keep: it goes into their own client's
// config and nowhere else.

export const doorUrl = (port) => `http://127.0.0.1:${port}/mcp`;

export function connectLines(port, token) {
  const url = doorUrl(port);
  return {
    claude: `claude mcp add --transport http typesetter ${url} --header "Authorization: Bearer ${token}"`,
    // Page text can carry instructions, and a Claude Code session can run
    // commands. With no built-in tools, our tools are all it has.
    claudeSafe: 'claude --tools ""',
    codex: `codex mcp add typesetter --url ${url} --bearer-token-env-var TYPESETTER_TOKEN`,
    codexEnv: `export TYPESETTER_TOKEN=${token}`,
    agy: JSON.stringify(
      { mcpServers: { typesetter: { serverUrl: url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2,
    ),
  };
}
