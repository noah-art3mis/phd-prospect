# Claude Code n8n MCP setup

This is a handoff instruction for a future agent. Do not attempt to list or call the server's tools in the setup session.

Register the n8n MCP server at user scope:

```bash
claude mcp add --scope user --transport http n8n "https://noah-art3mis.app.n8n.cloud/mcp-server/http"
```

After registration, tell the user to restart Claude Code. The user will complete the n8n OAuth flow when prompted in the new session; tools will not be available before that authorization completes.
