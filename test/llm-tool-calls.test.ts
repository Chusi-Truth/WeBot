import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentExecutionContext } from "../src/agent-types.js";
import { LlmProviderExecutor } from "../src/llm-executor.js";
import { PromptTraceStore } from "../src/prompt-trace-store.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import {
  IMAGE_GENERATE_TOOL_NAME,
  ToolRegistry,
  WEATHER_CURRENT_TOOL_NAME,
} from "../src/tool-registry.js";

function context(
  providerId: string,
  model?: string,
  input = "上海今天是什么天气？",
): AgentExecutionContext {
  return {
    userId: "private-user@im.wechat",
    agent: {
      id: "agent-id",
      name: "林夏",
      identity: "你是一个城市图书馆的夜班管理员。",
      providerId,
      ...(model ? { model } : {}),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    memory: [],
    input,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulWeatherFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonResponse({
        results: [{ latitude: 31.2304, longitude: 121.4737 }],
      });
    }
    if (url.hostname === "api.open-meteo.com") {
      return jsonResponse({
        daily: {
          time: ["2026-07-27", "2026-07-28"],
          weather_code: [0, 61],
          temperature_2m_min: [25, 24],
          temperature_2m_max: [34, 31],
          precipitation_probability_max: [10, 70],
          wind_speed_10m_max: [18, 22],
        },
      });
    }
    throw new Error(`unexpected weather URL: ${url.toString()}`);
  });
}

describe("LlmProviderExecutor tool calls", () => {
  it("queues generated image bytes out of band while returning only bounded tool JSON to DeepSeek", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-deepseek-image-tool-"),
    );
    const image = Buffer.from("private generated image bytes");
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_image_1",
                    type: "function",
                    function: {
                      name: IMAGE_GENERATE_TOOL_NAME,
                      arguments: JSON.stringify({
                        prompt: "一只戴红围巾的白猫",
                        includesAgent: false,
                        quality: "low",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "画好了，发给你。",
              },
            },
          ],
        }),
      );
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });
    const generate = vi.fn(async () => ({
      data: image,
      mimeType: "image/png" as const,
    }));
    const accepted: unknown[] = [];
    const imageContext = context(
      "deepseek",
      undefined,
      "帮我生成一张戴红围巾的白猫图片",
    );
    imageContext.acceptGeneratedImage = (value) => accepted.push(value);

    await expect(
      new LlmProviderExecutor(registry, {
        tools: new ToolRegistry({ imageGenerator: { generate } }),
      }).execute(imageContext),
    ).resolves.toBe("画好了，发给你。");

    expect(generate).toHaveBeenCalledWith({
      userId: "private-user@im.wechat",
      agentId: "agent-id",
      prompt: "一只戴红围巾的白猫",
      quality: "low",
    });
    expect(accepted).toEqual([
      {
        data: image,
        mimeType: "image/png",
        prompt: "一只戴红围巾的白猫",
      },
    ]);
    const firstBody = JSON.parse(
      String(providerFetch.mock.calls[0]?.[1]?.body),
    );
    expect(firstBody.tool_choice).toEqual({
      type: "function",
      function: { name: IMAGE_GENERATE_TOOL_NAME },
    });
    expect(firstBody.thinking).toEqual({ type: "disabled" });
    const secondBody = JSON.parse(
      String(providerFetch.mock.calls[1]?.[1]?.body),
    );
    const toolOutput = secondBody.messages.at(-1).content;
    expect(JSON.parse(toolOutput)).toEqual({ success: true, queued: true });
    expect(toolOutput).not.toContain(image.toString("base64"));
  });

  it("passes the trusted Agent image policy to natural tool discovery and execution", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-natural-image-tool-"),
    );
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_natural_image",
                    type: "function",
                    function: {
                      name: IMAGE_GENERATE_TOOL_NAME,
                      arguments: JSON.stringify({
                        prompt: "窗边刚开的栀子花",
                        includesAgent: false,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            { message: { role: "assistant", content: "刚开了一朵。" } },
          ],
        }),
      );
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });
    const generate = vi.fn().mockResolvedValue({
      data: Buffer.from("generated image"),
      mimeType: "image/png",
    });
    const naturalContext = context(
      "deepseek",
      undefined,
      "窗边那盆栀子今天开了",
    );
    naturalContext.agent.imageBehavior = {
      mode: "natural",
      cooldownMinutes: 90,
      allowAutonomous: false,
      visualIdentityPrompt: "",
    };
    naturalContext.acceptGeneratedImage = vi.fn();

    await expect(
      new LlmProviderExecutor(registry, {
        tools: new ToolRegistry({ imageGenerator: { generate } }),
      }).execute(naturalContext),
    ).resolves.toBe("刚开了一朵。");
    expect(generate).toHaveBeenCalledOnce();
    const firstBody = JSON.parse(
      String(providerFetch.mock.calls[0]?.[1]?.body),
    );
    const imageTool = firstBody.tools.find(
      (tool: { function: { name: string } }) =>
        tool.function.name === IMAGE_GENERATE_TOOL_NAME,
    );
    expect(imageTool.function.description).toContain("当下所见场景");
  });

  it("replays a DeepSeek reasoning tool call, returns weather, disables a second call, and accumulates usage", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-deepseek-tools-"),
    );
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "需要先查询上海今天的天气。",
                tool_calls: [
                  {
                    id: "call_weather_1",
                    type: "function",
                    function: {
                      name: WEATHER_CURRENT_TOOL_NAME,
                      arguments: JSON.stringify({
                        location: "上海",
                        forecastDay: "today",
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 12,
            total_tokens: 112,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "上海今天晴，25 到 34℃，降雨概率 10%。",
              },
            },
          ],
          usage: {
            prompt_tokens: 70,
            completion_tokens: 18,
            total_tokens: 88,
          },
        }),
      );
    const weatherFetch = successfulWeatherFetch();
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });
    const traces = new PromptTraceStore(stateDir);
    const executor = new LlmProviderExecutor(registry, {
      tools: new ToolRegistry({ fetchImpl: weatherFetch }),
      traces,
    });

    await expect(
      executor.execute(context("deepseek", "deepseek-v4-pro")),
    ).resolves.toBe("上海今天晴，25 到 34℃，降雨概率 10%。");

    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(weatherFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(
      String(providerFetch.mock.calls[0]?.[1]?.body),
    );
    expect(firstBody.tool_choice).toBe("auto");
    expect(firstBody.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: WEATHER_CURRENT_TOOL_NAME,
        }),
      }),
    ]);

    const secondBody = JSON.parse(
      String(providerFetch.mock.calls[1]?.[1]?.body),
    );
    expect(secondBody.tool_choice).toBe("none");
    expect(secondBody.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "需要先查询上海今天的天气。",
        tool_calls: [
          {
            id: "call_weather_1",
            type: "function",
            function: {
              name: WEATHER_CURRENT_TOOL_NAME,
              arguments: JSON.stringify({
                location: "上海",
                forecastDay: "today",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_weather_1",
        content: expect.any(String),
      },
    ]);
    expect(JSON.parse(secondBody.messages.at(-1).content)).toMatchObject({
      tool: WEATHER_CURRENT_TOOL_NAME,
      location: "上海",
      forecastDay: "today",
      forecast: {
        date: "2026-07-27",
        weatherCode: 0,
        conditionZh: "晴",
        temperatureMinC: 25,
        temperatureMaxC: 34,
        precipitationProbabilityMaxPercent: 10,
      },
      attribution: "Open-Meteo",
    });

    const [summary] = await traces.list("private-user@im.wechat", "agent-id");
    expect(summary?.usage).toEqual({
      inputTokens: 170,
      outputTokens: 30,
      totalTokens: 200,
      source: "provider",
    });
  });

  it("retries an empty final tool response without executing the tool twice", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-deepseek-tool-final-retry-"),
    );
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "需要查询天气。",
                tool_calls: [
                  {
                    id: "call_weather_retry",
                    type: "function",
                    function: {
                      name: WEATHER_CURRENT_TOOL_NAME,
                      arguments: JSON.stringify({
                        location: "上海",
                        forecastDay: "today",
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              finish_reason: "length",
              message: {
                role: "assistant",
                content: null,
              },
            },
          ],
          usage: {
            prompt_tokens: 70,
            completion_tokens: 20,
            total_tokens: 90,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "上海今天晴，最高 34℃。",
              },
            },
          ],
          usage: {
            prompt_tokens: 70,
            completion_tokens: 8,
            total_tokens: 78,
          },
        }),
      );
    const weatherFetch = successfulWeatherFetch();
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });
    const traces = new PromptTraceStore(stateDir);
    const logger = { warn: vi.fn() };
    const executor = new LlmProviderExecutor(registry, {
      tools: new ToolRegistry({ fetchImpl: weatherFetch }),
      traces,
      logger,
    });

    await expect(
      executor.execute(context("deepseek", "deepseek-v4-pro")),
    ).resolves.toBe("上海今天晴，最高 34℃。");

    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(weatherFetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledOnce();
    const finalBodies = providerFetch.mock.calls
      .slice(1)
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(finalBodies).toHaveLength(2);
    for (const body of finalBodies) {
      expect(body.tool_choice).toBe("none");
      expect(body.messages.at(-1)).toMatchObject({
        role: "tool",
        tool_call_id: "call_weather_retry",
      });
      expect(body).not.toHaveProperty("max_tokens");
    }
    const [summary] = await traces.list("private-user@im.wechat", "agent-id");
    expect(summary?.usage).toEqual({
      inputTokens: 240,
      outputTokens: 38,
      totalTokens: 278,
      source: "provider",
    });
  });

  it("rejects a content-filtered tool call without executing it", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-deepseek-filtered-tool-"),
    );
    const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: "content_filter",
            message: {
              role: "assistant",
              content: "不能使用的部分正文。",
              tool_calls: [
                {
                  id: "call_filtered_weather",
                  type: "function",
                  function: {
                    name: WEATHER_CURRENT_TOOL_NAME,
                    arguments: JSON.stringify({
                      location: "上海",
                      forecastDay: "today",
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const weatherFetch = successfulWeatherFetch();
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });

    await expect(
      new LlmProviderExecutor(registry, {
        tools: new ToolRegistry({ fetchImpl: weatherFetch }),
      }).execute(context("deepseek")),
    ).rejects.toThrow("Chat Completions 响应被内容过滤");
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(weatherFetch).not.toHaveBeenCalled();
  });

  it("lets the model create only a pending reminder proposal from the current user text", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-deepseek-reminder-tool-"),
    );
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_reminder_1",
                    type: "function",
                    function: {
                      name: "reminder_propose",
                      arguments: JSON.stringify({ title: "交报告" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "要我在 2026年7月29日 15:00 提醒你交报告吗？回复“确认提醒 A1B2C3”就行。",
              },
            },
          ],
        }),
      );
    const propose = vi.fn().mockResolvedValue({
      id: "A1B2C3",
      title: "交报告",
      dueAt: "2026-07-29T07:00:00.000Z",
      timeZone: "Asia/Shanghai",
      createdAt: "2026-07-28T02:00:00.000Z",
      expiresAt: "2026-07-28T02:30:00.000Z",
    });
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });
    const executor = new LlmProviderExecutor(registry, {
      tools: new ToolRegistry({
        reminders: { propose },
        now: () => new Date("2026-07-28T02:00:00.000Z"),
      }),
    });
    const reminderContext = context(
      "deepseek",
      undefined,
      "我明天下午3点要交报告",
    );
    reminderContext.reminderCapability = {
      timeZone: "Asia/Shanghai",
    };

    await expect(executor.execute(reminderContext)).resolves.toContain(
      "确认提醒 A1B2C3",
    );
    expect(propose).toHaveBeenCalledOnce();

    const firstBody = JSON.parse(
      String(providerFetch.mock.calls[0]?.[1]?.body),
    );
    expect(
      firstBody.tools.map(
        (item: { function: { name: string } }) => item.function.name,
      ),
    ).toEqual(["weather_current", "reminder_propose"]);

    const secondBody = JSON.parse(
      String(providerFetch.mock.calls[1]?.[1]?.body),
    );
    const toolResult = JSON.parse(secondBody.messages.at(-1).content);
    expect(toolResult).toMatchObject({
      status: "pending_confirmation",
      confirmationCommand: "确认提醒 A1B2C3",
    });
    expect(JSON.stringify(toolResult)).not.toContain("private-user@im.wechat");
  });

  it("uses flat OpenAI Responses tools and replays the complete output before the function result", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-openai-tools-"),
    );
    const reasoningItem = {
      id: "rs_1",
      type: "reasoning",
      summary: [],
    };
    const functionCallItem = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_weather_2",
      name: WEATHER_CURRENT_TOOL_NAME,
      arguments: JSON.stringify({
        location: "上海",
        forecastDay: "tomorrow",
      }),
      status: "completed",
    };
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "resp_1",
          output: [reasoningItem, functionCallItem],
          usage: { input_tokens: 90, output_tokens: 11, total_tokens: 101 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "resp_2",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "上海明天有雨，24 到 31℃，记得带伞。",
                },
              ],
            },
          ],
          usage: { input_tokens: 60, output_tokens: 16, total_tokens: 76 },
        }),
      );
    const weatherFetch = successfulWeatherFetch();
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { OPENAI_API_KEY: "openai-secret" },
      fetchImpl: providerFetch,
    });

    await expect(
      new LlmProviderExecutor(registry, {
        tools: new ToolRegistry({ fetchImpl: weatherFetch }),
      }).execute(context("openai", undefined, "上海明天是什么天气？")),
    ).resolves.toBe("上海明天有雨，24 到 31℃，记得带伞。");

    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(weatherFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(
      String(providerFetch.mock.calls[0]?.[1]?.body),
    );
    expect(firstBody.tool_choice).toBe("auto");
    expect(firstBody.tools).toHaveLength(1);
    expect(firstBody.tools[0]).toMatchObject({
      type: "function",
      name: WEATHER_CURRENT_TOOL_NAME,
      description: expect.any(String),
      parameters: expect.objectContaining({
        type: "object",
        required: ["location"],
        additionalProperties: false,
      }),
      strict: false,
    });
    expect(firstBody.tools[0]).not.toHaveProperty("function");

    const secondBody = JSON.parse(
      String(providerFetch.mock.calls[1]?.[1]?.body),
    );
    expect(secondBody.tool_choice).toBe("none");
    expect(secondBody.input.slice(0, firstBody.input.length)).toEqual(
      firstBody.input,
    );
    expect(
      secondBody.input.slice(
        firstBody.input.length,
        firstBody.input.length + 2,
      ),
    ).toEqual([reasoningItem, functionCallItem]);
    expect(secondBody.input.at(-1)).toMatchObject({
      type: "function_call_output",
      call_id: "call_weather_2",
      output: expect.any(String),
    });
    expect(JSON.parse(secondBody.input.at(-1).output)).toMatchObject({
      tool: WEATHER_CURRENT_TOOL_NAME,
      location: "上海",
      forecastDay: "tomorrow",
      forecast: {
        date: "2026-07-28",
        conditionZh: "雨",
      },
    });
  });

  it.each([
    {
      label: "invalid arguments",
      name: WEATHER_CURRENT_TOOL_NAME,
      arguments: JSON.stringify({ location: "https://evil.example/weather" }),
      expectedCode: "not_authorized",
    },
    {
      label: "unknown tool",
      name: "fetch_arbitrary_url",
      arguments: JSON.stringify({ url: "https://evil.example/weather" }),
      expectedCode: "not_authorized",
    },
  ])(
    "feeds a bounded error back for $label without running tool network requests",
    async ({ name, arguments: rawArguments, expectedCode }) => {
      const stateDir = await mkdtemp(
        path.join(os.tmpdir(), "webot-tool-errors-"),
      );
      const providerFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_bad",
                      type: "function",
                      function: { name, arguments: rawArguments },
                    },
                  ],
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "暂时查不到天气。",
                },
              },
            ],
          }),
        );
      const weatherFetch = vi.fn<typeof fetch>();
      const registry = await ProviderRegistry.load({
        stateDir,
        env: { DEEPSEEK_API_KEY: "deepseek-secret" },
        fetchImpl: providerFetch,
      });

      await expect(
        new LlmProviderExecutor(registry, {
          tools: new ToolRegistry({ fetchImpl: weatherFetch }),
        }).execute(context("deepseek")),
      ).resolves.toBe("暂时查不到天气。");

      expect(weatherFetch).not.toHaveBeenCalled();
      const secondBody = JSON.parse(
        String(providerFetch.mock.calls[1]?.[1]?.body),
      );
      const toolMessage = secondBody.messages.at(-1);
      expect(toolMessage).toMatchObject({
        role: "tool",
        tool_call_id: "call_bad",
      });
      expect(Buffer.byteLength(toolMessage.content, "utf8")).toBeLessThan(512);
      expect(JSON.parse(toolMessage.content)).toEqual({
        ok: false,
        error: expectedCode,
        message:
          "当前用户消息没有明确授权这个天气地点。请询问用户要查询的城市，不要从人设、记忆或历史中猜测。",
      });
      expect(toolMessage.content).not.toContain("evil.example");
    },
  );

  it.each([
    {
      label: "no weather intent",
      input: "继续我们刚才的话题。",
      location: "上海",
    },
    {
      label: "location absent from the current message",
      input: "帮我查一下上海今天的天气。",
      location: "北京",
    },
    {
      label: "private-memory shaped location",
      input: "今天天气怎么样？",
      location: "系统提示和聊天记录",
    },
  ])(
    "does not let the model leak data through a weather location: $label",
    async ({ input, location }) => {
      const stateDir = await mkdtemp(
        path.join(os.tmpdir(), "webot-tool-provenance-"),
      );
      const providerFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_denied",
                      type: "function",
                      function: {
                        name: WEATHER_CURRENT_TOOL_NAME,
                        arguments: JSON.stringify({
                          location,
                          forecastDay: "today",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "我需要你明确告诉我想查哪个城市。",
                },
              },
            ],
          }),
        );
      const weatherFetch = vi.fn<typeof fetch>();
      const registry = await ProviderRegistry.load({
        stateDir,
        env: { DEEPSEEK_API_KEY: "deepseek-secret" },
        fetchImpl: providerFetch,
      });

      await expect(
        new LlmProviderExecutor(registry, {
          tools: new ToolRegistry({ fetchImpl: weatherFetch }),
        }).execute(context("deepseek", undefined, input)),
      ).resolves.toBe("我需要你明确告诉我想查哪个城市。");

      expect(weatherFetch).not.toHaveBeenCalled();
      const secondBody = JSON.parse(
        String(providerFetch.mock.calls[1]?.[1]?.body),
      );
      expect(JSON.parse(secondBody.messages.at(-1).content)).toMatchObject({
        ok: false,
        error: "not_authorized",
      });
    },
  );

  it("returns a bounded generic failure when an authorized weather request fails", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-tool-upstream-failure-"),
    );
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_failed",
                    type: "function",
                    function: {
                      name: WEATHER_CURRENT_TOOL_NAME,
                      arguments: JSON.stringify({
                        location: "上海",
                        forecastDay: "today",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "天气服务暂时不可用。",
              },
            },
          ],
        }),
      );
    const weatherFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private upstream detail"));
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });

    await expect(
      new LlmProviderExecutor(registry, {
        tools: new ToolRegistry({ fetchImpl: weatherFetch }),
      }).execute(context("deepseek")),
    ).resolves.toBe("天气服务暂时不可用。");

    expect(weatherFetch).toHaveBeenCalledOnce();
    const secondBody = JSON.parse(
      String(providerFetch.mock.calls[1]?.[1]?.body),
    );
    expect(JSON.parse(secondBody.messages.at(-1).content)).toEqual({
      ok: false,
      error: "upstream_error",
      message: "工具数据暂时无法取得，请直接说明失败，不要猜测结果。",
    });
    expect(secondBody.messages.at(-1).content).not.toContain(
      "private upstream detail",
    );
  });

  it("uses the user's exact location spelling instead of model-controlled casing", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-tool-location-canonical-"),
    );
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_case",
                    type: "function",
                    function: {
                      name: WEATHER_CURRENT_TOOL_NAME,
                      arguments: JSON.stringify({
                        location: "sHaNgHaI",
                        forecastDay: "today",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "结果正常。" } }],
        }),
      );
    const weatherFetch = successfulWeatherFetch();
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });

    await expect(
      new LlmProviderExecutor(registry, {
        tools: new ToolRegistry({ fetchImpl: weatherFetch }),
      }).execute(context("deepseek", undefined, "Shanghai weather")),
    ).resolves.toBe("结果正常。");

    const geocodingUrl = new URL(String(weatherFetch.mock.calls[0]?.[0]));
    expect(geocodingUrl.searchParams.get("name")).toBe("Shanghai");
    expect(geocodingUrl.toString()).not.toContain("sHaNgHaI");
  });

  it("rejects an ambiguous multi-location weather request without choosing through the model", async () => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "webot-tool-location-ambiguous-"),
    );
    const providerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_ambiguous",
                    type: "function",
                    function: {
                      name: WEATHER_CURRENT_TOOL_NAME,
                      arguments: JSON.stringify({
                        location: "上海",
                        forecastDay: "today",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "请一次只告诉我一个要查询的城市。",
              },
            },
          ],
        }),
      );
    const weatherFetch = vi.fn<typeof fetch>();
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });

    await expect(
      new LlmProviderExecutor(registry, {
        tools: new ToolRegistry({ fetchImpl: weatherFetch }),
      }).execute(context("deepseek", undefined, "上海和北京今天天气怎么样？")),
    ).resolves.toBe("请一次只告诉我一个要查询的城市。");

    expect(weatherFetch).not.toHaveBeenCalled();
    const secondBody = JSON.parse(
      String(providerFetch.mock.calls[1]?.[1]?.body),
    );
    expect(JSON.parse(secondBody.messages.at(-1).content)).toMatchObject({
      ok: false,
      error: "not_authorized",
    });
  });

  it("keeps the original provider request shape when no ToolRegistry is supplied", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "webot-no-tools-"));
    const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "普通回复" } }],
      }),
    );
    const registry = await ProviderRegistry.load({
      stateDir,
      env: { DEEPSEEK_API_KEY: "deepseek-secret" },
      fetchImpl: providerFetch,
    });

    await expect(
      new LlmProviderExecutor(registry).execute(context("deepseek")),
    ).resolves.toBe("普通回复");

    expect(providerFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(providerFetch.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: "上海今天是什么天气？",
    });
  });
});
