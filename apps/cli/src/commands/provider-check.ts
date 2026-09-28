import {
	BUILTIN_PROVIDER_MANIFESTS_BY_ID,
	resolveApiEndpoints,
	resolveApiKeys,
} from "@cline/llms";
import type { GatewayProviderManifest } from "@cline/shared";

type ProviderCheckIo = {
	writeln: (text?: string) => void;
};

type ProviderCheckStatus = "Active" | "Rate-Limited" | "Offline";

type ProviderEndpoint = {
	name: string;
	endpoint: string;
	apiKey?: string;
	google: boolean;
};

function resolveEnvironmentEndpoint(stem: string): string[] {
	const endpoints: string[] = [];
	for (const name of [
		`${stem}_BASE_URL`,
		...Array.from(
			{ length: 10 },
			(_, index) => `${stem}_BASE_URL_${index + 1}`,
		),
	]) {
		const endpoint = process.env[name]?.trim().replace(/\/+$/, "");
		if (endpoint && !endpoints.includes(endpoint)) {
			endpoints.push(endpoint);
		}
	}
	return endpoints;
}

async function resolveConfiguredEndpoints(
	manifests: readonly GatewayProviderManifest[],
): Promise<ProviderEndpoint[]> {
	const endpoints: ProviderEndpoint[] = [];
	const configuredEnvNames = new Set<string>();
	for (const manifest of manifests) {
		const envNames = manifest.apiKeyEnv ?? [];
		for (const name of envNames) {
			configuredEnvNames.add(name);
			for (let index = 1; index <= 10; index++) {
				configuredEnvNames.add(`${name}_${index}`);
				if (name.endsWith("_API_KEY")) {
					configuredEnvNames.add(`${name.slice(0, -8)}_KEY_${index}`);
				}
			}
		}
		const apiKeys = await resolveApiKeys({ apiKeyEnv: envNames });
		if (apiKeys.length === 0) {
			continue;
		}
		const environmentEndpoints = resolveApiEndpoints({
			apiKeyEnv: envNames,
		});
		const providerEndpoints = environmentEndpoints.length
			? environmentEndpoints
			: manifest.api
				? [manifest.api]
				: [];
		if (providerEndpoints.length === 0) {
			continue;
		}
		const poolSize = Math.max(providerEndpoints.length, apiKeys.length);
		for (let index = 0; index < poolSize; index++) {
			const endpoint = providerEndpoints[index % providerEndpoints.length];
			const apiKey = apiKeys[index % apiKeys.length];
			endpoints.push({
				name:
					apiKeys.length > 1
						? `${manifest.name} (key ${index + 1})`
						: manifest.name,
				endpoint,
				apiKey,
				google: manifest.id === "gemini",
			});
		}
	}

	const customStems = new Set<string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (!value?.trim() || configuredEnvNames.has(name)) {
			continue;
		}
		const match = name.match(/^(.+?)(?:_API_KEY|_KEY)(?:_\d+)?$/i);
		if (match?.[1]) {
			customStems.add(match[1]);
		}
	}
	for (const stem of customStems) {
		const keys = [
			process.env[`${stem}_API_KEY`],
			...Array.from(
				{ length: 10 },
				(_, index) => process.env[`${stem}_API_KEY_${index + 1}`],
			),
			...Array.from(
				{ length: 10 },
				(_, index) => process.env[`${stem}_KEY_${index + 1}`],
			),
		]
			.map((key) => key?.trim())
			.filter((key): key is string => Boolean(key));
		const providerEndpoints = resolveEnvironmentEndpoint(stem);
		if (keys.length === 0 || providerEndpoints.length === 0) {
			continue;
		}
		const poolSize = Math.max(providerEndpoints.length, keys.length);
		for (let index = 0; index < poolSize; index++) {
			const endpoint = providerEndpoints[index % providerEndpoints.length];
			const apiKey = keys[index % keys.length];
			endpoints.push({
				name:
					keys.length > 1
						? `${stem.replaceAll("_", " ")} (key ${index + 1})`
						: stem.replaceAll("_", " "),
				endpoint,
				apiKey,
				google: false,
			});
		}
	}

	return endpoints.filter(
		(endpoint, index) =>
			endpoints.findIndex(
				(candidate) =>
					candidate.name === endpoint.name &&
					candidate.endpoint === endpoint.endpoint,
			) === index,
	);
}

async function probeEndpoint(
	providerEndpoint: ProviderEndpoint,
	fetchImpl: typeof fetch,
): Promise<ProviderCheckStatus> {
	try {
		const url = new URL(providerEndpoint.endpoint);
		if (!url.pathname.endsWith("/models")) {
			url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
		}
		const headers = new Headers({ accept: "application/json" });
		if (providerEndpoint.apiKey) {
			if (providerEndpoint.google) {
				url.searchParams.set("key", providerEndpoint.apiKey);
			} else {
				headers.set("authorization", `Bearer ${providerEndpoint.apiKey}`);
			}
		}
		const response = await fetchImpl(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(5_000),
		});
		if (response.status === 429) {
			return "Rate-Limited";
		}
		if (response.status === 403) {
			const body = await response
				.clone()
				.text()
				.catch(() => "");
			if (/(?:quota|resource_exhausted|rate.?limit)/i.test(body)) {
				return "Rate-Limited";
			}
			return "Offline";
		}
		return response.status === 401 || response.status >= 500
			? "Offline"
			: "Active";
	} catch {
		return "Offline";
	}
}

export async function runProviderCheckCommand(input: {
	io: ProviderCheckIo;
	fetch?: typeof fetch;
	manifests?: readonly GatewayProviderManifest[];
}): Promise<number> {
	const endpoints = await resolveConfiguredEndpoints(
		input.manifests ?? Object.values(BUILTIN_PROVIDER_MANIFESTS_BY_ID),
	);
	input.io.writeln("Provider\tEndpoint\tStatus");
	if (endpoints.length === 0) {
		input.io.writeln("No configured provider endpoints found.");
		return 1;
	}

	const fetchImpl = input.fetch ?? globalThis.fetch;
	const results = await Promise.all(
		endpoints.map(async (providerEndpoint) => ({
			...providerEndpoint,
			status: await probeEndpoint(providerEndpoint, fetchImpl),
		})),
	);
	for (const result of results) {
		input.io.writeln(`${result.name}\t${result.endpoint}\t${result.status}`);
	}
	return results.some((result) => result.status !== "Active") ? 1 : 0;
}
