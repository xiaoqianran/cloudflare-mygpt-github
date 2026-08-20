import { limits } from "./policy.js";

export function openApi(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: "MyGPT GitHub Gateway",
      version: "0.2.1",
      description: "A minimal, safety-focused GitHub read/write gateway for Custom GPT Actions.",
    },
    servers: [{ url: origin }],
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
          description: "Use the same secret value stored in Cloudflare as GPT_API_KEY.",
        },
      },
      schemas: {
        InspectRepositoryRequest: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository in owner/name format", example: "xiaoqianran/cloudflare-mygpt-github" },
            ref: { type: "string", description: "Branch, tag, or commit SHA. Defaults to the repository default branch." },
            path: { type: "string", description: "Optional repository path prefix" },
            recursive: { type: "boolean", default: true },
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
          },
          required: ["repo"],
        },
        TreeItem: {
          type: "object",
          properties: {
            path: { type: "string" },
            mode: { type: "string" },
            type: { type: "string" },
            sha: { type: "string" },
            size: { type: "integer" },
          },
        },
        InspectRepositoryResponse: {
          type: "object",
          properties: {
            repo: { type: "string" },
            ref: { type: "string" },
            default_branch: { type: "string" },
            private: { type: "boolean" },
            description: { type: "string" },
            html_url: { type: "string" },
            truncated: { type: "boolean" },
            items: { type: "array", items: { $ref: "#/components/schemas/TreeItem" } },
          },
        },
        ReadFilesRequest: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository in owner/name format" },
            ref: { type: "string" },
            paths: {
              type: "array",
              minItems: 1,
              maxItems: limits.MAX_READ_FILES,
              items: { type: "string" },
              description: "Repository-relative file paths to read in one batch",
            },
          },
          required: ["repo", "paths"],
        },
        FileContent: {
          type: "object",
          properties: {
            path: { type: "string" },
            sha: { type: "string" },
            size: { type: "integer" },
            content: { type: "string" },
          },
        },
        ReadFilesResponse: {
          type: "object",
          properties: {
            repo: { type: "string" },
            ref: { type: "string" },
            files: { type: "array", items: { $ref: "#/components/schemas/FileContent" } },
          },
        },
        SearchCodeRequest: {
          type: "object",
          properties: {
            repo: { type: "string" },
            query: { type: "string", description: "GitHub code search query scoped automatically to the repository" },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          required: ["repo", "query"],
        },
        SearchCodeResponse: {
          type: "object",
          properties: {
            repo: { type: "string" },
            query: { type: "string" },
            total_count: { type: "integer" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  path: { type: "string" },
                  sha: { type: "string" },
                  html_url: { type: "string" },
                  text_matches: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        FileChange: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repository-relative path" },
            content: { type: "string", description: "Complete UTF-8 file content for create/update. Omit only when delete=true." },
            delete: { type: "boolean", default: false },
          },
          required: ["path"],
        },
        PullRequestOptions: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            draft: { type: "boolean", default: true },
          },
        },
        ApplyChangesRequest: {
          type: "object",
          properties: {
            repo: { type: "string" },
            base: { type: "string", description: "Base branch. Defaults to repository default branch." },
            branch: { type: "string", description: "Working branch. Must start with the configured mygpt/ prefix." },
            message: { type: "string", description: "Git commit message" },
            expected_head_sha: { type: "string", description: "Optional optimistic concurrency guard" },
            changes: {
              type: "array",
              minItems: 1,
              maxItems: limits.MAX_CHANGES,
              items: { $ref: "#/components/schemas/FileChange" },
            },
            create_pull_request: { type: "boolean", default: true, description: "Set false to commit without creating or reusing a pull request." },
            pull_request: { $ref: "#/components/schemas/PullRequestOptions" },
          },
          required: ["repo", "branch", "message", "changes"],
        },
        ApplyChangesResponse: {
          type: "object",
          properties: {
            repo: { type: "string" },
            base: { type: "string" },
            branch: { type: "string" },
            branch_created: { type: "boolean" },
            previous_head_sha: { type: "string" },
            commit_sha: { type: "string" },
            changed_paths: { type: "array", items: { type: "string" } },
            pull_request: { type: "object" },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string" },
            details: { type: "object" },
          },
          required: ["error"],
        },
      },
      responses: {
        BadRequest: { description: "Bad request", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        Unauthorized: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        Forbidden: { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      },
    },
    paths: {
      "/v1/repository/inspect": {
        post: {
          operationId: "inspectRepository",
          summary: "Inspect repository metadata and file tree",
          description: "Use this first to understand repository structure and discover the default branch.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/InspectRepositoryRequest" } } } },
          responses: {
            "200": { description: "Repository inspection", content: { "application/json": { schema: { $ref: "#/components/schemas/InspectRepositoryResponse" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/v1/files/read": {
        post: {
          operationId: "readFiles",
          summary: "Read multiple repository files in one request",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ReadFilesRequest" } } } },
          responses: {
            "200": { description: "File contents", content: { "application/json": { schema: { $ref: "#/components/schemas/ReadFilesResponse" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/v1/code/search": {
        post: {
          operationId: "searchCode",
          summary: "Search code inside one allowed repository",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SearchCodeRequest" } } } },
          responses: {
            "200": { description: "Search results", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchCodeResponse" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/v1/changes/apply": {
        post: {
          operationId: "applyChanges",
          summary: "Create/reuse a working branch, commit multiple changes atomically, and optionally open a PR",
          description: "Use after reading the relevant files. Direct writes to main/master are blocked.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ApplyChangesRequest" } } } },
          responses: {
            "200": { description: "Changes applied", content: { "application/json": { schema: { $ref: "#/components/schemas/ApplyChangesResponse" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "409": { description: "Branch head changed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
    },
  };
}
