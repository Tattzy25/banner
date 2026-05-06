#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000");

// ─── HTTP server (serves UI + MCP endpoint + WebSocket) ───────────────────────
const app = express();
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

app.get("/", (_req, res) => res.sendFile(join(__dirname, "..", "index.html")));

// ─── WebSocket broadcast to connected banner clients ──────────────────────────
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function broadcast(data: object): void {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "inkwell-press-mcp-server",
  version: "1.0.0",
});

// Tool: inkwell_complete_task
server.registerTool(
  "inkwell_complete_task",
  {
    title: "Complete Inkwell Task",
    description: `Transitions the Inkwell Press banner into its completion (ready) state.

Triggers the green completion animation, updates the headline to "Ink Permanence Achieved", resets the ETA to 00:00:00, and slides up the notification tray. Call when the underlying processing task finishes.

Args:
  - modelName (string, optional): Model/version label to show in the stats panel (max 50 chars). Omit to keep the current value.

Returns: Confirmation string.`,
    inputSchema: z
      .object({
        modelName: z
          .string()
          .max(50)
          .optional()
          .describe("Model/version label, e.g. 'ETCHED-FINAL-V2'"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ modelName }) => {
    broadcast({ type: "complete", modelName: modelName ?? null });
    return {
      content: [{ type: "text", text: "Banner updated — task marked complete." }],
    };
  }
);

// Tool: inkwell_update_status
server.registerTool(
  "inkwell_update_status",
  {
    title: "Update Inkwell Status",
    description: `Updates the large headline status message on the Inkwell Press banner while the task is in progress.

Use this to surface key milestones to the user (e.g. "Rendering layer 3 of 8", "Finalising output").

Args:
  - message (string, required): Status headline text, max 100 chars. Displayed in 42px bold type.

Returns: Confirmation string.`,
    inputSchema: z
      .object({
        message: z
          .string()
          .min(1)
          .max(100)
          .describe("Status headline text, e.g. 'Rendering layer 3 of 8'"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ message }) => {
    broadcast({ type: "status", message });
    return {
      content: [{ type: "text", text: `Status updated: "${message}"` }],
    };
  }
);

// Tool: inkwell_update_stats
server.registerTool(
  "inkwell_update_stats",
  {
    title: "Update Inkwell Stats",
    description: `Updates individual stat values in the right-side stats panel of the Inkwell Press banner.

All fields are optional — only provided fields are changed. Use this to reflect real processing metrics as the task progresses.

Args:
  - model (string, optional): Model/version label, max 30 chars (e.g. 'NEURAL-INK v.3').
  - intensity (string, optional): Intensity metric, max 20 chars (e.g. '1200 DPI').
  - eta (string, optional): Time remaining in HH:MM:SS format (e.g. '00:02:30').

Returns: Confirmation string.`,
    inputSchema: z
      .object({
        model: z
          .string()
          .max(30)
          .optional()
          .describe("Model label, e.g. 'NEURAL-INK v.3'"),
        intensity: z
          .string()
          .max(20)
          .optional()
          .describe("Intensity value, e.g. '1200 DPI'"),
        eta: z
          .string()
          .regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS")
          .optional()
          .describe("Time remaining, e.g. '00:02:30'"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ model, intensity, eta }) => {
    broadcast({ type: "stats", model, intensity, eta });
    return {
      content: [{ type: "text", text: "Stats panel updated." }],
    };
  }
);

// ─── Streamable HTTP transport (JSON-RPC 2.0) ─────────────────────────────────
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — return server info so clients can discover the endpoint
app.get("/mcp", (_req, res) => {
  res.json({
    name: "inkwell-press-mcp-server",
    version: "1.0.0",
    transport: "streamable-http",
    endpoint: "/mcp",
  });
});

// ─── POST /training-complete — receive training workflow notifications ─────────
app.post("/training-complete", (req, res) => {
  try {
    const { modelName, intensity, eta } = req.body || {};

    if (!modelName && !intensity && !eta) {
      return res.status(400).json({
        error: "At least one field required: modelName, intensity, or eta",
      });
    }

    broadcast({ type: "complete", modelName, intensity, eta });
    console.error(
      `[training-complete] broadcasted — modelName=${modelName ?? "—"} intensity=${intensity ?? "—"} eta=${eta ?? "—"}`
    );
    res.json({ success: true, message: "Training completion broadcasted to banner" });
  } catch (error) {
    res
      .status(400)
      .json({ error: `Invalid request: ${error instanceof Error ? error.message : String(error)}` });
  }
});

httpServer.listen(PORT, () => {
  console.error(`inkwell-press-mcp-server running`);
  console.error(`  UI:  http://localhost:${PORT}/`);
  console.error(`  MCP: http://localhost:${PORT}/mcp (JSON-RPC 2.0)`);
});
