import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createApiKeyFailoverFetch,
	resolveApiEndpoints,
	resolveApiKeys,
} from "./http";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("provider API key failover", () => {
	it("loads numbered keys for the provider's declared environment variable", async () => {
		vi.stubEnv("OPENAI_API_KEY", "primary-key");
		vi.stubEnv("OPENAI_API_KEY_1", "secondary-key");
		vi.stubEnv("OPENAI_API_KEY_2", "third-key");

		await expect(
			resolveApiKeys({
				providerId: "openai",
				apiKeyEnv: ["OPENAI_API_KEY"],
			}),
		).resolves.toEqual(["primary-key", "secondary-key", "third-key"]);
	});

	it("loads keys from each declared environment alias", async () => {
		vi.stubEnv("OPENAI_API_KEY", "primary-key");
		vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "alternate-key");

		await expect(
			resolveApiKeys({
				apiKeyEnv: ["OPENAI_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
			}),
		).resolves.toEqual(["primary-key", "alternate-key"]);
	});

	it("does not treat provider metadata variables as API credentials", async () => {
		vi.stubEnv("AWS_REGION", "us-east-1");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "aws-access-id");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret");

		await expect(
			resolveApiKeys({
				apiKeyEnv: ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
			}),
		).resolves.toEqual([]);
	});

	it("loads numbered base URLs for the provider's declared key", () => {
		vi.stubEnv("OPENAI_BASE_URL", "https://primary.example.test/v1/");
		vi.stubEnv("OPENAI_BASE_URL_1", "https://secondary.example.test/v1");

		expect(
			resolveApiEndpoints({
				providerId: "openai-compatible",
				apiKeyEnv: ["OPENAI_API_KEY"],
			}),
		).toEqual([
			"https://primary.example.test/v1",
			"https://secondary.example.test/v1",
		]);
	});

	it("rotates credentials across rate-limit and server errors", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
			.mockResolvedValueOnce(
				new Response("temporarily unavailable", { status: 503 }),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const fetchWithFailover = createApiKeyFailoverFetch(fetchImpl, [
			"first-key",
			"second-key",
			"third-key",
		]);
		const body = JSON.stringify({
			messages: [{ role: "user", content: "probe" }],
		});

		const response = await fetchWithFailover(
			"https://api.example.test/v1/chat/completions",
			{
				method: "POST",
				headers: { authorization: "Bearer first-key" },
				body,
			},
		);

		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		for (const [index, key] of [
			"first-key",
			"second-key",
			"third-key",
		].entries()) {
			const init = fetchImpl.mock.calls[index]?.[1];
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Bearer ${key}`,
			);
			expect(init?.body).toBe(body);
		}
	});

	it("rotates endpoints when the active endpoint returns a server error", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const fetchWithFailover = createApiKeyFailoverFetch(
			fetchImpl,
			["shared-key"],
			{
				baseUrl: "https://primary.example.test/v1",
				endpoints: [
					"https://primary.example.test/v1",
					"https://secondary.example.test/v1",
				],
			},
		);

		const response = await fetchWithFailover(
			"https://primary.example.test/v1/chat/completions",
			{ headers: { authorization: "Bearer shared-key" } },
		);

		expect(response.status).toBe(200);
		expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
			"https://secondary.example.test/v1/chat/completions",
		);
	});

	it("moves to the next key after a connection failure", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new TypeError("connection reset"))
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const fetchWithFailover = createApiKeyFailoverFetch(fetchImpl, [
			"first-key",
			"second-key",
		]);

		const response = await fetchWithFailover(
			"https://api.example.test/v1/models",
			{
				headers: { authorization: "Bearer first-key" },
			},
		);

		expect(response.status).toBe(200);
		expect(
			new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("authorization"),
		).toBe("Bearer second-key");
	});
});
