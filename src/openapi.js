import { limits } from "./policy.js";

const objectSchema = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

const jsonBody = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});

export function openApi(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: "MyGPT GitHub Repository Mirror",
      version: "0.5.0",
      description: "Fast GitHub repository access for Custom GPT. Reads come from a Cloudflare D1/R2 mirror; GitHub is used for sync and writes.",
    },
    servers: [{ url: origin }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
          description: "Use the value stored in Cloudflare as GPT_API_KEY.",
        },
      },
      schemas: {
        SyncRepositoryRequest: objectSchema({
          repo: { type: "string", description: "Repository in owner/name format" },
          ref: { type: "string", description: "Optional branch, tag, or commit. Defaults to the repository default branch." },
        }, ["repo"]),
        InspectRepositoryRequest: objectSchema({
          repo: { type: "string" },
          path: { type: "string", description: "Optional path prefix" },
          limit: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
        }, ["repo"]),
        ReadFilesRequest: objectSchema({
          repo: { type: "string" },
          ref: { type: "string", description: "Optional ref. Mirror is used when it matches the mirrored ref; otherwise GitHub is a fallback." },
          paths: { type: "array", minItems: 1, maxItems: limits.MAX_READ_FILES, items: { type: "string" } },
        }, ["repo", "paths"]),
        SearchRepositoryRequest: objectSchema({
          repo: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        }, ["repo", "query"]),
        ReadRepositoryPageRequest: objectSchema({
          repo: { type: "string" },
          cursor: { type: "string", description: "Cursor returned by the previous page. Omit for the first page." },
          max_chars: { type: "integer", minimum: 10000, maximum: 250000, default: 120000 },
          max_files: { type: "integer", minimum: 1, maximum: 100, default: 40 },
        }, ["repo"]),
        FileChange: objectSchema({
          path: { type: "string" },
          content: { type: "string" },
          delete: { type: "boolean", default: false },
        }, ["path"]),
        PullRequestOptions: objectSchema({
          title: { type: "string" },
          body: { type: "string" },
          draft: { type: "boolean", default: true },
        }),
        ApplyChangesRequest: objectSchema({
          repo: { type: "string" },
          base: { type: "string" },
          branch: { type: "string" },
          message: { type: "string" },
          expected_head_sha: { type: "string" },
          changes: { type: "array", minItems: 1, maxItems: limits.MAX_CHANGES, items: { $ref: "#/components/schemas/FileChange" } },
          create_pull_request: { type: "boolean", default: true },
          pull_request: { $ref: "#/components/schemas/PullRequestOptions" },
        }, ["repo", "branch", "message", "changes"]),
        ErrorResponse: objectSchema({
          error: { type: "string" },
          details: { type: "object", additionalProperties: true },
        }, ["error"]),
      },
      responses: {
        BadRequest: { description: "Bad request", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        Unauthorized: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        Forbidden: { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        Conflict: { description: "Mirror not ready or branch head changed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      },
    },
    paths: {
      "/v1/repository/sync": {
        post: {
          operationId: "syncRepository",
          summary: "Start or refresh the Cloudflare repository mirror",
          description: "Use only when the mirror is missing/stale or the user asks for the latest GitHub state. This queues an asynchronous sync and returns immediately.",
          requestBody: jsonBody({ $ref: "#/components/schemas/SyncRepositoryRequest" }),
          responses: { "202": { description: "Sync queued" }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/v1/repository/inspect": {
        post: {
          operationId: "inspectRepository",
          summary: "Inspect mirrored repository metadata and file tree",
          description: "Call this first. It is a fast D1 lookup and reports mirror status, commit SHA and repository paths without calling GitHub.",
          requestBody: jsonBody({ $ref: "#/components/schemas/InspectRepositoryRequest" }),
          responses: { "200": { description: "Mirror metadata and files" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/v1/files/read": {
        post: {
          operationId: "readFiles",
          summary: "Batch-read repository files from the R2 mirror",
          description: "Uses R2 for mirrored text files. GitHub is contacted only for a cache miss, oversized file, binary, or a different ref.",
          requestBody: jsonBody({ $ref: "#/components/schemas/ReadFilesRequest" }),
          responses: { "200": { description: "File contents" }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/v1/repository/search": {
        post: {
          operationId: "searchRepository",
          summary: "Full-text search inside the mirrored repository",
          description: "Searches the local D1 FTS5 index instead of GitHub Code Search.",
          requestBody: jsonBody({ $ref: "#/components/schemas/SearchRepositoryRequest" }),
          responses: { "200": { description: "Search results" }, "400": { $ref: "#/components/responses/BadRequest" }, "409": { $ref: "#/components/responses/Conflict" } },
        },
      },
      "/v1/repository/page": {
        post: {
          operationId: "readRepositoryPage",
          summary: "Read the whole repository progressively from the mirror",
          description: "Returns a deterministic page of mirrored text files under a character budget. Keep following next_cursor until it is null to traverse all mirrored source files.",
          requestBody: jsonBody({ $ref: "#/components/schemas/ReadRepositoryPageRequest" }),
          responses: { "200": { description: "Repository page" }, "409": { $ref: "#/components/responses/Conflict" } },
        },
      },
      "/v1/changes/apply": {
        post: {
          operationId: "applyChanges",
          summary: "Commit multiple file changes and optionally create or reuse a pull request",
          description: "Write path remains GitHub-backed. Read the relevant files from the mirror before editing.",
          requestBody: jsonBody({ $ref: "#/components/schemas/ApplyChangesRequest" }),
          responses: { "200": { description: "Changes applied" }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "409": { $ref: "#/components/responses/Conflict" } },
        },
      },
    },
  };
}
