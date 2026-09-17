import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_API = process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";

async function gitlabFetch(path: string, options: RequestInit = {}) {
  if (!GITLAB_TOKEN) {
    throw new Error("GITLAB_TOKEN environment variable is not set");
  }

  const res = await fetch(`${GITLAB_API}${path}`, {
    ...options,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API error ${res.status}: ${text}`);
  }

  return res.json();
}

const handler = createMcpHandler((server) => {
  // 1. List projects
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description: "List GitLab projects accessible by the token",
      inputSchema: z.object({
        search: z.string().optional().describe("Optional search term"),
        per_page: z.number().min(1).max(100).optional().default(20),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ search, per_page }) => {
      const params = new URLSearchParams({ per_page: String(per_page) });
      if (search) params.set("search", search);
      const data = await gitlabFetch(`/projects?${params}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 2. Get repository tree (list files/folders)
  server.registerTool(
    "get_repository_tree",
    {
      title: "Get Repository Tree",
      description: "List files and folders in a GitLab project",
      inputSchema: z.object({
        project_id: z.string().describe("Project ID or path (e.g. DeclineOptionalCookies/gfiles)"),
        path: z.string().optional().default("").describe("Path inside the repo"),
        ref: z.string().optional().default("main"),
        recursive: z.boolean().optional().default(false),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ project_id, path, ref, recursive }) => {
      const encoded = encodeURIComponent(project_id);
      const params = new URLSearchParams({ ref, recursive: String(recursive) });
      if (path) params.set("path", path);
      const data = await gitlabFetch(`/projects/${encoded}/repository/tree?${params}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // 3. Get file content
  server.registerTool(
    "get_file",
    {
      title: "Get File",
      description: "Get the content of a file from a GitLab project",
      inputSchema: z.object({
        project_id: z.string(),
        file_path: z.string().describe("Full path to the file"),
        ref: z.string().optional().default("main"),
      }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ project_id, file_path, ref }) => {
      const encodedProject = encodeURIComponent(project_id);
      const encodedPath = encodeURIComponent(file_path);
      const data = await gitlabFetch(
        `/projects/${encodedProject}/repository/files/${encodedPath}?ref=${ref}`
      );
      // content is base64
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    }
  );

  // 4. Create or update a file
  server.registerTool(
    "create_or_update_file",
    {
      title: "Create or Update File",
      description: "Create or update a file in a GitLab project",
      inputSchema: z.object({
        project_id: z.string(),
        file_path: z.string(),
        content: z.string().describe("File content"),
        commit_message: z.string(),
        branch: z.string().optional().default("main"),
      }).strict(),
      annotations: { destructiveHint: true },
    },
    async ({ project_id, file_path, content, commit_message, branch }) => {
      const encodedProject = encodeURIComponent(project_id);
      const encodedPath = encodeURIComponent(file_path);

      // Check if file exists
      let method = "POST";
      try {
        await gitlabFetch(
          `/projects/${encodedProject}/repository/files/${encodedPath}?ref=${branch}`
        );
        method = "PUT"; // exists → update
      } catch {
        method = "POST"; // doesn't exist → create
      }

      const body = {
        branch,
        content,
        commit_message,
      };
