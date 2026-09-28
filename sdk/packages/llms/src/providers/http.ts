import type { GatewayProviderSettings } from "@cline/shared";

export function ensureFetch(fetchImpl?: typeof fetch): typeof fetch {
	const resolved = fetchImpl ?? globalThis.fetch;
	if (!resolved) {
		throw new Error(
			"No fetch implementation is available. Pass one in the gateway or provider config.",
		);
	}
	return resolved;
}

export async function resolveApiKey(
	settings: GatewayProviderSettings,
): Promise<string | undefined> {
	return (await resolveApiKeys(settings))[0];
}

export async function resolveApiKeys(
	settings: GatewayProviderSettings,
): Promise<string[]> {
	const keys: string[] = [];
	const addKey = (value: string | undefined) => {
		const key = value?.trim();
		if (key && !keys.includes(key)) {
			keys.push(key);
		}
	};
	addKey(settings.apiKey);
	addKey(await settings.apiKeyResolver?.());
	for (const name of settings.apiKeyEnv ?? []) {
		if (
			/^AWS_(?:REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i.test(
				name,
			) ||
			!/(?:API_KEY|_TOKEN|_KEY)$/i.test(name)
		) {
			continue;
		}
		const envKeys: string[] = [];
		const baseKey = readEnv(name);
		if (baseKey) {
			envKeys.push(baseKey);
		}
		for (let index = 1; index <= 10; index++) {
			const numberedKey = readEnv(`${name}_${index}`);
			if (numberedKey) {
				envKeys.push(numberedKey);
			}
			if (name.endsWith("_API_KEY")) {
				const alternateNumberedKey = readEnv(
					`${name.slice(0, -8)}_KEY_${index}`,
				);
				if (alternateNumberedKey) {
					envKeys.push(alternateNumberedKey);
				}
			}
		}
		if (envKeys.length > 0) {
			for (const key of envKeys) {
				addKey(key);
			}
		}
	}
	return keys;
}

export function resolveApiEndpoints(
	settings: GatewayProviderSettings,
): string[] {
	const endpoints: string[] = [];
	const addEndpoint = (value: string | undefined) => {
		const endpoint = value?.trim().replace(/\/+$/, "");
		if (endpoint && !endpoints.includes(endpoint)) {
			endpoints.push(endpoint);
		}
	};
	for (const name of settings.apiKeyEnv ?? []) {
		const stem = name.replace(/_(?:API_)?KEY$/, "").replace(/_TOKEN$/, "");
		if (stem === name) {
			continue;
		}
		addEndpoint(readEnv(`${stem}_BASE_URL`));
		for (let index = 1; index <= 10; index++) {
			addEndpoint(readEnv(`${stem}_BASE_URL_${index}`));
		}
	}
	return endpoints;
}

export function createApiKeyFailoverFetch(
	fetchImpl: typeof fetch,
	apiKeys: readonly string[],
	options: {
		baseUrl?: string;
		endpoints?: readonly string[];
		queryKey?: string;
	} = {},
): typeof fetch {
	const keys = [...new Set(apiKeys.map((key) => key.trim()).filter(Boolean))];
	const endpoints = [
		...new Set(
			(options.endpoints ?? [])
				.map((endpoint) => endpoint.trim().replace(/\/+$/, ""))
				.filter(Boolean),
		),
	];
	const poolSize = Math.max(keys.length, endpoints.length);
	if (poolSize < 2) {
		return fetchImpl;
	}

	const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
	let activePoolIndex = 0;
	return (async (input, init) => {
		const originalRequest =
			input instanceof Request ? new Request(input, init) : undefined;
		const sourceUrl = originalRequest?.url ?? String(input);
		const originalHeaders = new Headers(
			originalRequest?.headers ?? init?.headers,
		);
		const primaryKey = keys[0];
		let lastError: unknown;

		for (let attempt = 0; attempt < poolSize; attempt++) {
			const poolIndex = (activePoolIndex + attempt) % poolSize;
			const apiKey =
				keys.length > 0 ? keys[poolIndex % keys.length] : undefined;
			const endpoint =
				endpoints.length > 0
					? endpoints[poolIndex % endpoints.length]
					: undefined;
			const url = new URL(sourceUrl);
			if (baseUrl && endpoint && endpoint !== baseUrl) {
				const currentUrl = url.toString();
				if (currentUrl.startsWith(baseUrl)) {
					url.href = `${endpoint}${currentUrl.slice(baseUrl.length)}`;
				}
			}
			if (apiKey && primaryKey) {
				if (options.queryKey) {
					url.searchParams.set(options.queryKey, apiKey);
				}
				for (const [name, value] of url.searchParams) {
					if (
						value === primaryKey ||
						/^(?:key|api_?key|access_token)$/i.test(name)
					) {
						url.searchParams.set(name, apiKey);
					}
				}
			}
			const headers = new Headers(originalHeaders);
			if (apiKey && primaryKey) {
				for (const [name, value] of headers) {
					if (value === primaryKey) {
						headers.set(name, apiKey);
					} else if (value === `Bearer ${primaryKey}`) {
						headers.set(name, `Bearer ${apiKey}`);
					} else if (value === `ApiKey ${primaryKey}`) {
						headers.set(name, `ApiKey ${apiKey}`);
					}
				}
			}

			try {
				let response: Response;
				if (originalRequest) {
					const request = new Request(url.toString(), originalRequest);
					for (const [name, value] of headers) {
						request.headers.set(name, value);
					}
					response = await fetchImpl(request);
				} else {
					response = await fetchImpl(
						typeof input === "string" ? url.toString() : url,
						{ ...init, headers },
					);
				}
				if (!isApiKeyFailoverResponse(response)) {
					activePoolIndex = poolIndex;
					return response;
				}
				if (attempt === poolSize - 1) {
					return response;
				}
			} catch (error) {
				lastError = error;
				if (init?.signal?.aborted || originalRequest?.signal.aborted) {
					throw error;
				}
				if (attempt === poolSize - 1) {
					throw error;
				}
			}
		}
		throw lastError;
	}) as typeof fetch;
}

function isApiKeyFailoverResponse(response: Response): boolean {
	if (
		response.status === 429 ||
		response.status === 403 ||
		response.status >= 500
	) {
		return true;
	}
	return false;
}

export async function fetchJson(
	url: string,
	init: RequestInit,
	options: {
		fetch: typeof fetch;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<unknown> {
	const controller = new AbortController();
	const signal = mergeSignals(options.signal, controller.signal);
	const timeoutMs = options.timeoutMs ?? 30_000;
	const timeout =
		timeoutMs > 0
			? setTimeout(
					() => controller.abort(new Error("Request timed out")),
					timeoutMs,
				)
			: undefined;

	try {
		const response = await options.fetch(url, { ...init, signal });
		const text = await response.text();
		const payload = text ? (JSON.parse(text) as unknown) : undefined;

		if (!response.ok) {
			const message =
				typeof payload === "object" && payload && "error" in payload
					? JSON.stringify((payload as { error: unknown }).error)
					: text || `${response.status} ${response.statusText}`;
			throw new Error(`Gateway request failed: ${message}`);
		}

		return payload;
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function mergeSignals(
	first: AbortSignal | undefined,
	second: AbortSignal,
): AbortSignal {
	if (!first) {
		return second;
	}

	if (first.aborted) {
		second.throwIfAborted?.();
		return first;
	}

	const controller = new AbortController();
	const abort = (event?: Event) => {
		const target = event?.target as AbortSignal | null;
		controller.abort(target?.reason);
	};

	first.addEventListener("abort", abort, { once: true });
	second.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T;
}

function readEnv(key: string): string | undefined {
	const env = globalThis.process?.env;
	if (!env) {
		return undefined;
	}

	const value = env[key];
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
