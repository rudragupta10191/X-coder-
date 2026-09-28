import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import {
	createApiKeyFailoverFetch,
	ensureFetch,
	resolveApiEndpoints,
	resolveApiKeys,
} from "../http";
import type { ProviderFactoryResult } from "./types";

const API_VERSION_SEGMENT = /^v\d+(?:alpha|beta)?\d*$/i;
const GEMINI_API_KEY_ENV_NAMES = Array.from(
	{ length: 10 },
	(_, index) => `GEMINI_KEY_${index + 1}`,
);

async function resolveGeminiApiKeys(
	config: GatewayResolvedProviderConfig,
): Promise<string[]> {
	if (typeof process.loadEnvFile === "function") {
		try {
			process.loadEnvFile();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}

	const geminiKeys = GEMINI_API_KEY_ENV_NAMES.map((name) =>
		process.env[name]?.trim(),
	).filter((key): key is string => Boolean(key));
	return geminiKeys.length > 0
		? [...new Set(geminiKeys)]
		: await resolveApiKeys(config);
}

/**
 * The legacy Gemini base-URL setting (and Google's own `@google/genai`
 * client) treat the base URL as a host root and append the API version
 * themselves, while `@ai-sdk/google` expects the version segment to be part
 * of `baseURL` (its default is `.../v1beta`). Preserve the legacy semantics:
 * append `/v1beta` unless the URL already ends with a version segment.
 */
export function normalizeGeminiBaseUrl(
	baseUrl: string | undefined,
): string | undefined {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) {
		return undefined;
	}
	const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	return API_VERSION_SEGMENT.test(lastSegment) ? trimmed : `${trimmed}/v1beta`;
}

export async function createGoogleProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	const apiKeys = await resolveGeminiApiKeys(config);
	const apiKey = apiKeys[0];
	const envEndpoints = resolveApiEndpoints(config);
	const baseUrl = config.baseUrl ?? envEndpoints[0];
	const endpoints = [
		...new Set(
			[...(baseUrl ? [baseUrl] : []), ...envEndpoints]
				.map(normalizeGeminiBaseUrl)
				.filter((endpoint): endpoint is string => Boolean(endpoint)),
		),
	];
	const normalizedBaseUrl = normalizeGeminiBaseUrl(baseUrl);
	const provider = createGoogleGenerativeAI({
		apiKey: apiKeys[0] ?? apiKey,
		baseURL: normalizedBaseUrl,
		headers: config.headers,
		fetch: createApiKeyFailoverFetch(ensureFetch(config.fetch), apiKeys, {
			baseUrl: normalizedBaseUrl,
			endpoints,
			queryKey: "key",
		}),
		name: context.provider.id,
	});
	return {
		buildModelTools: (tools) => {
			const result: ReturnType<
				NonNullable<ProviderFactoryResult["buildModelTools"]>
			> = {};
			for (const tool of tools) {
				if (tool.name === "web_search") {
					result.web_search = { tool: provider.tools.googleSearch({}) };
				}
			}
			return result;
		},
		operations: {
			language: (modelId) => provider(modelId),
			imageGeneration: (modelId) => provider.image(modelId),
		},
	};
}
