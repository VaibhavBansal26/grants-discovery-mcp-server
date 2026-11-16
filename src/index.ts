#!/usr/bin/env node
/**
 * Grants discovery MCP server.
 * Sources: Grants.gov (opportunities) and USAspending.gov (past awards). No API keys needed.
 * Serves stdio.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { grantsPost, usaspendingPost } from "./api.js";

const CHARACTER_LIMIT = 25_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const ResponseFormat = z.enum(["markdown", "json"]).default("markdown")
  .describe("'markdown' for readable text, 'json' for structured data");

type Content = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> };

function reply(format: "markdown" | "json", markdown: string, data: Record<string, unknown>): Content {
  if (format === "json") return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  return { content: [{ type: "text", text: markdown }] };
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function day(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, 10) : undefined;
}

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && String(value).trim() !== "" ? `$${n.toLocaleString("en-US")}` : "not specified";
}

// ---- Grants.gov shapes (only the fields we use) ----

interface OppHit {
  id: string; number: string; title: string; agencyCode: string; agency: string;
  openDate: string; closeDate: string; oppStatus: string; docType: string; cfdaList: string[];
}
interface Option { label: string; value: string; count: number }
interface SearchData {
  hitCount: number; oppHits: OppHit[];
  eligibilities?: Option[]; fundingCategories?: Option[]; fundingInstruments?: Option[]; agencies?: Option[];
}

function formatHit(h: OppHit): string {
  const lines = [
    `## ${h.title}`,
    `- ID: ${h.id} | Number: ${h.number} | Status: ${h.oppStatus}`,
    `- Agency: ${h.agency} (${h.agencyCode})`,
    `- Opens: ${h.openDate || "n/a"} | Closes: ${h.closeDate || "n/a"}`
  ];
  if (h.cfdaList?.length) lines.push(`- Assistance Listing (ALN): ${h.cfdaList.join(", ")}`);
  return lines.join("\n");
}

function createServer(): McpServer {
  const server = new McpServer({ name: "grants-discovery-mcp-server", version: "0.1.0" });

  server.registerTool(
    "grants_search_opportunities",
    {
      title: "Search Grant Opportunities",
      description: `Search US federal funding opportunities on Grants.gov.

Returns one page of matches with ID, number, agency, open/close dates, and status. If more results exist, the result gives next_offset; call again with that offset. Use grants_get_opportunity with an ID for the full announcement (award sizes, eligibility, contacts).

Filter values are codes: agencies like 'HHS-NIH11' (prefix match, e.g. 'HHS'), eligibilities like '25' (use grants_list_filter_options for codes).

Examples:
  - "Open diabetes research grants" -> keyword="diabetes", statuses=["posted"]
  - "Forecasted NIH opportunities" -> agencies=["HHS-NIH11"], statuses=["forecasted"]
  - "Grants for nonprofits on rural health" -> keyword="rural health", eligibilities=["25"]`,
      inputSchema: z.strictObject({
        keyword: z.string().max(200).default("").describe("Free-text search over title and description, e.g. 'rural health'"),
        statuses: z.array(z.enum(["forecasted", "posted", "closed", "archived"])).default(["posted", "forecasted"])
          .describe("Opportunity statuses to include. Default: posted and forecasted (still actionable)"),
        agencies: z.array(z.string()).default([]).describe("Agency codes, e.g. ['HHS-NIH11','USDA']"),
        eligibilities: z.array(z.string()).default([]).describe("Applicant-type codes from grants_list_filter_options, e.g. ['25']"),
        funding_categories: z.array(z.string()).default([]).describe("Category codes, e.g. ['HL'] for Health"),
        aln: z.string().default("").describe("Assistance Listing Number (formerly CFDA), e.g. '93.847'"),
        limit: z.number().int().min(1).max(50).default(10).describe("Results per page"),
        offset: z.number().int().min(0).default(0).describe("Records to skip, for pagination"),
        response_format: ResponseFormat
      }),
      annotations: READ_ONLY
    },
    async (a, ctx) => {
      const data = await grantsPost<SearchData>("search2", {
        rows: a.limit,
        startRecordNum: a.offset,
        keyword: a.keyword,
        oppStatuses: a.statuses.join("|"),
        agencies: a.agencies.join("|"),
        eligibilities: a.eligibilities.join("|"),
        fundingCategories: a.funding_categories.join("|"),
        aln: a.aln
      }, ctx.mcpReq.signal);

      const render = (hits: OppHit[]) => {
        const nextOffset = a.offset + hits.length;
        const hasMore = data.hitCount > nextOffset;
        const page = {
          total: data.hitCount, count: hits.length, offset: a.offset, opportunities: hits,
          has_more: hasMore, ...(hasMore ? { next_offset: nextOffset } : {})
        };
        const md = [`# Grant opportunities`, `Showing ${hits.length} of ${data.hitCount}.`, "", hits.map(formatHit).join("\n\n")];
        if (hasMore) md.push("", `More results: call again with offset=${nextOffset}.`);
        return { page, md: md.join("\n") };
      };

      let hits = data.oppHits ?? [];
      if (hits.length === 0) {
        return reply(a.response_format, "No opportunities match. Try fewer filters, a broader keyword, or add 'closed' to statuses.",
          { total: 0, count: 0, offset: a.offset, opportunities: [], has_more: false });
      }
      let r = render(hits);
      const len = () => (a.response_format === "json" ? JSON.stringify(r.page, null, 2) : r.md).length;
      while (hits.length > 1 && len() > CHARACTER_LIMIT) {
        hits = hits.slice(0, Math.ceil(hits.length / 2));
        r = render(hits);
      }
      return reply(a.response_format, r.md, r.page);
    }
  );

  server.registerTool(
    "grants_get_opportunity",
    {
      title: "Get Grant Opportunity Details",
      description: `Get the full announcement for one Grants.gov opportunity: summary, eligibility, award ceiling/floor, total funding, expected number of awards, cost sharing, key dates, and agency contact.

Use grants_search_opportunities first to find the numeric opportunity ID.`,
      inputSchema: z.strictObject({
        opportunity_id: z.number().int().positive().describe("Numeric opportunity ID from search results, e.g. 359145"),
        response_format: ResponseFormat
      }),
      annotations: READ_ONLY
    },
    async ({ opportunity_id, response_format }, ctx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = await grantsPost<any>("fetchOpportunity", { opportunityId: opportunity_id }, ctx.mcpReq.signal);
      const s = d.synopsis ?? {};
      const detail = {
        id: d.id,
        number: d.opportunityNumber,
        title: d.opportunityTitle,
        agency: s.agencyDetails?.agencyName ?? s.agencyName ?? d.owningAgencyCode,
        category: d.opportunityCategory?.description,
        posting_date: day(s.postingDateStr ?? s.postingDate),
        close_date: day(s.responseDateStr ?? s.responseDate),
        award_ceiling: s.awardCeiling,
        award_floor: s.awardFloor,
        estimated_total_funding: s.estimatedFunding,
        expected_awards: s.numberOfAwards,
        cost_sharing_required: s.costSharing,
        eligible_applicant_types: (s.applicantTypes ?? []).map((t: { description?: string }) => t.description),
        funding_instruments: (s.fundingInstruments ?? []).map((t: { description?: string }) => t.description),
        eligibility_notes: stripHtml(s.applicantEligibilityDesc),
        summary: stripHtml(s.synopsisDesc),
        contact: { name: s.agencyContactName, email: s.agencyContactEmail, phone: s.agencyContactPhone },
        url: `https://www.grants.gov/search-results-detail/${d.id}`
      };
      const md = [
        `# ${detail.title}`,
        `- Number: ${detail.number} | ID: ${detail.id} | Category: ${detail.category ?? "n/a"}`,
        `- Agency: ${detail.agency}`,
        `- Posted: ${detail.posting_date ?? "n/a"} | Closes: ${detail.close_date ?? "n/a"}`,
        `- Award range: ${money(detail.award_floor)} to ${money(detail.award_ceiling)} | Total funding: ${money(detail.estimated_total_funding)} | Expected awards: ${detail.expected_awards ?? "n/a"}`,
        `- Cost sharing: ${detail.cost_sharing_required === true || detail.cost_sharing_required === "Yes" ? "required" : "see announcement"}`,
        `- Eligible applicants: ${detail.eligible_applicant_types.join("; ") || "see announcement"}`,
        `- Contact: ${[detail.contact.name?.split("\n")[0], detail.contact.email, detail.contact.phone].filter(Boolean).join(" | ") || "n/a"}`,
        `- Link: ${detail.url}`,
        "", "## Summary", detail.summary.slice(0, 8000) || "n/a"
      ];
      if (detail.eligibility_notes) md.push("", "## Eligibility notes", detail.eligibility_notes.slice(0, 3000));
      return reply(response_format, md.join("\n"), detail);
    }
  );

  server.registerTool(
    "grants_list_filter_options",
    {
      title: "List Grant Filter Options",
      description: `List valid filter codes for grants_search_opportunities: applicant eligibility codes, funding categories, and funding instruments, with how many current opportunities each matches. Call this when a user describes an applicant type (e.g. 'nonprofit', 'tribal government') or topic area and you need the matching code.`,
      inputSchema: z.strictObject({ response_format: ResponseFormat }),
      annotations: READ_ONLY
    },
    async ({ response_format }, ctx) => {
      const d = await grantsPost<SearchData>("search2", { rows: 1, oppStatuses: "posted|forecasted" }, ctx.mcpReq.signal);
      const strip = (o?: Option[]) => (o ?? []).map(({ label, value, count }) => ({ label, value, count }));
      const out = {
        eligibilities: strip(d.eligibilities),
        funding_categories: strip(d.fundingCategories),
        funding_instruments: strip(d.fundingInstruments)
      };
      const section = (title: string, o: Option[]) => `## ${title}\n${o.map(x => `- ${x.value}: ${x.label} (${x.count})`).join("\n")}`;
      const md = [section("Eligibilities (eligibilities)", out.eligibilities),
        section("Funding categories (funding_categories)", out.funding_categories),
        section("Funding instruments", out.funding_instruments)].join("\n\n");
      return reply(response_format, md, out);
    }
  );

  server.registerTool(
    "grants_search_past_awards",
    {
      title: "Search Past Federal Awards",
      description: `Search historical federal grant awards on USAspending.gov to see who has been funded, by whom, and how much. Useful for competitive research: find peer organizations funded for a topic, typical award sizes, and which agencies fund an area.

Examples:
  - "Who got funded for rural diabetes programs in FY2024?" -> keyword="rural diabetes", fiscal_year_start=2024, fiscal_year_end=2024
  - "What has Navajo Nation received?" -> recipient="Navajo Nation"
Results are sorted by award amount, largest first.`,
      inputSchema: z.strictObject({
        keyword: z.string().max(200).default("").describe("Topic text matched against award descriptions"),
        recipient: z.string().max(200).default("").describe("Recipient name search, e.g. 'University of Michigan'"),
        fiscal_year_start: z.number().int().min(2008).max(2030).default(2024).describe("First federal fiscal year (Oct-Sep)"),
        fiscal_year_end: z.number().int().min(2008).max(2030).default(2025).describe("Last federal fiscal year"),
        limit: z.number().int().min(1).max(50).default(10).describe("Results per page"),
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
        response_format: ResponseFormat
      }),
      annotations: READ_ONLY
    },
    async (a, ctx) => {
      if (!a.keyword && !a.recipient) {
        return { content: [{ type: "text", text: "Provide a keyword or recipient; an unfiltered award search is too broad to be useful." }], isError: true } as never;
      }
      const filters: Record<string, unknown> = {
        award_type_codes: ["02", "03", "04", "05"], // grants: block, formula, project, cooperative agreements
        time_period: [{ start_date: `${a.fiscal_year_start - 1}-10-01`, end_date: `${a.fiscal_year_end}-09-30` }]
      };
      if (a.keyword) filters.keywords = [a.keyword];
      if (a.recipient) filters.recipient_search_text = [a.recipient];
      const res = await usaspendingPost<{
        results: Record<string, string | number>[];
        page_metadata: { hasNext: boolean };
      }>("search/spending_by_award/", {
        filters,
        fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "Description"],
        limit: a.limit, page: a.page, sort: "Award Amount", order: "desc"
      }, ctx.mcpReq.signal);

      const awards = res.results.map(r => ({
        award_id: r["Award ID"], recipient: r["Recipient Name"], amount: r["Award Amount"],
        agency: r["Awarding Agency"], start_date: r["Start Date"], description: r["Description"],
        url: `https://www.usaspending.gov/award/${r["generated_internal_id"]}`
      }));
      const data = { page: a.page, count: awards.length, awards, has_more: res.page_metadata.hasNext, ...(res.page_metadata.hasNext ? { next_page: a.page + 1 } : {}) };
      if (awards.length === 0) return reply(a.response_format, "No awards found. Try a broader keyword or wider fiscal-year range.", data);
      const md = [`# Past awards (page ${a.page})`, "",
        awards.map(x => `## ${x.recipient}\n- ${money(x.amount)} | ${x.agency} | started ${x.start_date}\n- Award ID: ${x.award_id}\n- ${String(x.description ?? "").slice(0, 300)}\n- ${x.url}`).join("\n\n")];
      if (data.has_more) md.push("", `More results: call again with page=${a.page + 1}.`);
      return reply(a.response_format, md.join("\n"), data);
    }
  );

  return server;
}

serveStdio(createServer);
console.error("grants-discovery-mcp-server running on stdio");
