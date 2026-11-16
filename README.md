# grants-discovery-mcp-server

An [MCP](https://modelcontextprotocol.io) server for finding US federal grant funding. Ask your AI assistant to search open opportunities, read the full announcement, and see who has won similar awards. **No API keys required.**

Data sources: [Grants.gov](https://www.grants.gov) (opportunities) and [USAspending.gov](https://www.usaspending.gov) (past awards).

## Tools

| Tool | What it does |
|---|---|
| `grants_search_opportunities` | Search Grants.gov by keyword, status, agency, applicant type, category, or ALN. Paginated. |
| `grants_get_opportunity` | Full announcement: summary, award floor/ceiling, total funding, eligibility, dates, contact. |
| `grants_list_filter_options` | Valid codes for applicant types, funding categories, and instruments. |
| `grants_search_past_awards` | Historical awards from USAspending by topic or recipient, largest first. |

All tools are read-only. Every tool accepts `response_format`: `markdown` (default) or `json`.

## Install

**Claude Desktop / any stdio client**

```json
{
  "mcpServers": {
    "grants": { "command": "npx", "args": ["-y", "grants-discovery-mcp-server"] }
  }
}
```

**Claude Code**

```bash
claude mcp add grants -- npx -y grants-discovery-mcp-server
```

Requires Node.js 20.3+.

## Example prompts

- "Find open NIH opportunities about rural diabetes for nonprofits."
- "Summarize opportunity 359145: award size, deadline, and who can apply."
- "Who received USDA funding for rural broadband in FY2024, and how much?"
- "Which funding categories and applicant types can I filter by?"

## Development

```bash
npm install
npm run build
npm run smoke   # runs the built server against the live APIs
npx @modelcontextprotocol/inspector node dist/index.js
```

## Notes

- Grants.gov and USAspending are public US government APIs and may rate-limit or change. This project is not affiliated with or endorsed by either.
- Always confirm deadlines and eligibility in the official announcement before applying.

## License

MIT
