import type { GatewayProviderManifest } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProviderCheckCommand } from "./provider-check";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("provider-check command", () => {
	it("probes configured endpoints and reports ASCII health statuses", async () => {
		vi.stubEnv("CHECK_ACTIVE_API_KEY", "active-key");
		vi.stubEnv("CHECK_LIMITED_API_KEY", "limited-key");
		vi.stubEnv("CHECK_OFFLINE_API_KEY", "offline-key");
		const output: string[] = [];
		const manifests = [
			manifest("active", "Active Provider", "https://active.example.test/v1"),
			manifest(
				"limited",
				"Limited Provider",
				"https://limited.example.test/v1",
			),
			manifest(
				"offline",
				"Offline Provider",
				"https://offline.example.test/v1",
			),
		];
		const fetchImpl = vi.fn(
			async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
				const endpoint = String(input);
				if (endpoint.includes("limited")) {
					return new Response("rate limit", { status: 429 });
				}
				if (endpoint.includes("offline")) {
					throw new TypeError("connection refused");
				}
				return new Response("ok", { status: 200 });
			},
		);

		const exitCode = await runProviderCheckCommand({
			io: { writeln: (line = "") => output.push(line) },
			fetch: fetchImpl as unknown as typeof fetch,
			manifests,
		});

		expect(exitCode).toBe(1);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
			"https://active.example.test/v1/models",
		);
		expect(
			new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization"),
		).toBe("Bearer active-key");
		expect(output).toEqual([
			"Provider\tEndpoint\tStatus",
			"Active Provider\thttps://active.example.test/v1\tActive",
			"Limited Provider\thttps://limited.example.test/v1\tRate-Limited",
			"Offline Provider\thttps://offline.example.test/v1\tOffline",
		]);
	});

	it("probes numbered custom base URLs for otherwise unknown API keys", async () => {
		vi.stubEnv("CUSTOM_LLM_API_KEY_1", "custom-key");
		vi.stubEnv("CUSTOM_LLM_BASE_URL_1", "https://custom.example.test/v1");
		const output: string[] = [];
		const fetchImpl = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response("ok"),
		);

		await runProviderCheckCommand({
			io: { writeln: (line = "") => output.push(line) },
			fetch: fetchImpl as unknown as typeof fetch,
			manifests: [],
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(output[1]).toBe(
			"CUSTOM LLM\thttps://custom.example.test/v1\tActive",
		);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
			"https://custom.example.test/v1/models",
		);
		expect(
			new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization"),
		).toBe("Bearer custom-key");
	});

	it("passes Gemini credentials in the query string", async () => {
		vi.stubEnv("CHECK_GEMINI_API_KEY", "gemini-secret");
		const fetchImpl = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response("ok", { status: 200 }),
		);

		await runProviderCheckCommand({
			io: { writeln: () => {} },
			fetch: fetchImpl as unknown as typeof fetch,
			manifests: [
				{
					...manifest(
						"gemini",
						"Google Gemini",
						"https://google.example.test/v1beta",
					),
					apiKeyEnv: ["CHECK_GEMINI_API_KEY"],
				},
			],
		});

		const probeUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
		expect(probeUrl.pathname).toBe("/v1beta/models");
		expect(probeUrl.searchParams.get("key")).toBe("gemini-secret");
	});
});

function manifest(
	id: string,
	name: string,
	api: string,
): GatewayProviderManifest {
	return {
		id,
		name,
		description: name,
		defaultModelId: "probe-model",
		models: [],
		env: ["node"],
		api,
		apiKeyEnv: [`CHECK_${id.toUpperCase()}_API_KEY`],
	};
}
