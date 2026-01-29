/**
 * Moltbot Hindsight Memory Plugin
 *
 * Long-term memory backed by Hindsight (HearthMinds vector store).
 * Provides hindsight_recall and hindsight_retain tools, plus lifecycle hooks
 * for automatic memory capture and context injection.
 */

import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { stringEnum } from "clawdbot/plugin-sdk";

// ============================================================================
// Config Schema
// ============================================================================

const configSchema = z.object({
  baseUrl: z.string().default("http://localhost:8001"),
  bankId: z.string().default("aletheia"),
  apiKey: z.string().optional(),
  autoRetain: z.boolean().default(true),
  autoRecall: z.boolean().default(false),
});

type PluginConfig = z.infer<typeof configSchema>;

// ============================================================================
// Hindsight Client (inline, no external dep)
// ============================================================================

class HindsightClient {
  constructor(
    private readonly baseUrl: string,
    private readonly bankId: string,
    private readonly apiKey?: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hindsight API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async retain(
    content: string,
    options?: { context?: string; tags?: string[] },
  ): Promise<{ success: boolean; items_count: number }> {
    return this.request("POST", `/v1/default/banks/${this.bankId}/memories`, {
      items: [
        {
          content,
          context: options?.context,
          tags: options?.tags,
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  async recall(
    query: string,
    options?: { maxTokens?: number; tags?: string[] },
  ): Promise<{
    results: Array<{
      memory_id: string;
      content: string;
      score: number;
      timestamp?: string;
    }>;
  }> {
    return this.request("POST", `/v1/default/banks/${this.bankId}/memories/recall`, {
      query,
      max_tokens: options?.maxTokens ?? 2000,
      budget: "mid",
      tags: options?.tags,
    });
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const hindsightMemoryPlugin = {
  id: "hindsight-memory",
  name: "Memory (Hindsight)",
  description: "Hindsight-backed long-term memory for HearthMinds",
  kind: "memory" as const,
  configSchema,

  register(api: MoltbotPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig);
    const client = new HindsightClient(cfg.baseUrl, cfg.bankId, cfg.apiKey);

    api.logger.info(
      `hindsight-memory: registered (bank: ${cfg.bankId}, url: ${cfg.baseUrl})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "hindsight_recall",
        label: "Memory Recall",
        description:
          "Search through Aletheia's long-term memory for relevant context. Use when you need information about past conversations, user preferences, decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({
            description: "What to search for in memory",
          }),
          maxTokens: Type.Optional(
            Type.Number({
              description: "Max tokens to return (default: 2000)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, maxTokens } = params as {
            query: string;
            maxTokens?: number;
          };

          try {
            const response = await client.recall(query, { maxTokens });

            if (!response.results || response.results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No relevant memories found." },
                ],
                details: { count: 0 },
              };
            }

            const text = response.results
              .map(
                (r, i) =>
                  `${i + 1}. ${r.content} (relevance: ${(r.score * 100).toFixed(0)}%)`,
              )
              .join("\n\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${response.results.length} memories:\n\n${text}`,
                },
              ],
              details: {
                count: response.results.length,
                memories: response.results.map((r) => ({
                  id: r.memory_id,
                  content: r.content,
                  score: r.score,
                })),
              },
            };
          } catch (err) {
            api.logger.warn(`hindsight_recall failed: ${String(err)}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Memory recall failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "hindsight_recall" },
    );

    api.registerTool(
      {
        name: "hindsight_retain",
        label: "Memory Store",
        description:
          "Store important information in Aletheia's long-term memory. Use for facts, preferences, decisions, and anything worth remembering across conversations.",
        parameters: Type.Object({
          content: Type.String({
            description: "Information to remember",
          }),
          context: Type.Optional(
            Type.String({
              description: "Additional context about when/why this was stored",
            }),
          ),
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Tags for categorization (e.g., 'preference', 'fact', 'decision')",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { content, context, tags } = params as {
            content: string;
            context?: string;
            tags?: string[];
          };

          try {
            const response = await client.retain(content, { context, tags });

            return {
              content: [
                {
                  type: "text",
                  text: `Stored in memory: "${content.slice(0, 100)}${content.length > 100 ? "..." : ""}"`,
                },
              ],
              details: {
                action: "created",
                memoryIds: response.memory_ids,
              },
            };
          } catch (err) {
            api.logger.warn(`hindsight_retain failed: ${String(err)}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to store memory: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "hindsight_retain" },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject relevant memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 10) return;

        try {
          const response = await client.recall(event.prompt, {
            maxTokens: 1500,
          });

          if (!response.results || response.results.length === 0) return;

          const memoryContext = response.results
            .slice(0, 5)
            .map((r) => `- ${r.content}`)
            .join("\n");

          api.logger.info?.(
            `hindsight-memory: injecting ${response.results.length} memories into context`,
          );

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`hindsight-memory: auto-recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-retain: store conversation messages after agent ends
    if (cfg.autoRetain) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          // Extract user and assistant messages
          const toRetain: string[] = [];

          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;

            // Only retain user messages (assistant responses are derivable)
            if (role !== "user") continue;

            const content = msgObj.content;
            if (typeof content === "string" && content.trim().length > 10) {
              toRetain.push(content.trim());
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block
                ) {
                  const text = (block as Record<string, unknown>).text;
                  if (typeof text === "string" && text.trim().length > 10) {
                    toRetain.push(text.trim());
                  }
                }
              }
            }
          }

          // Retain each message (limit to 5 per conversation to avoid spam)
          let retained = 0;
          for (const content of toRetain.slice(0, 5)) {
            await client.retain(content, {
              context: "auto-captured from conversation",
              tags: ["conversation", "auto"],
            });
            retained++;
          }

          if (retained > 0) {
            api.logger.info(
              `hindsight-memory: auto-retained ${retained} messages`,
            );
          }
        } catch (err) {
          api.logger.warn(
            `hindsight-memory: auto-retain failed: ${String(err)}`,
          );
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "hindsight-memory",
      start: () => {
        api.logger.info(
          `hindsight-memory: started (bank: ${cfg.bankId}, autoRetain: ${cfg.autoRetain}, autoRecall: ${cfg.autoRecall})`,
        );
      },
      stop: () => {
        api.logger.info("hindsight-memory: stopped");
      },
    });
  },
};

export default hindsightMemoryPlugin;
