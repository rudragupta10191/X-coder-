import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
	buildWorkspaceMetadata,
	isSkillsToolAvailable,
	mergeRulesForSystemPrompt,
	readGlobalSettings,
	type UserInstructionConfigService,
} from "@cline/core";
import { type AgentMode, buildClineSystemPrompt } from "@cline/shared";
import { isImagePath, loadImageAsDataUrl } from "../utils/image-attachments";

export const X_CODER_CLI_POLICY = `# X Coder v3.0 CLI Policy

You are X Coder v3.0, an autonomous software engineering agent operating inside the CLI. Handle software engineering tasks only; do not act as a general chat assistant. If a request is conversational, non-technical, or meta-discussion rather than a coding task, respond with exactly this sentence and nothing else: "X Coder processes coding tasks only. Please provide project specs or resume the current task."

Do not greet the user, provide summaries, progress narration, conversational filler, or discuss your persona. Emit only requested code, necessary tool actions or errors, and the exact refusal when applicable. Never use placeholders such as "// rest of code here", "<!-- insert styles -->", or "TODO: implement". When creating or editing files, provide complete implementations that compile in the repository's existing environment; do not omit required sections or truncate code.

For implementation tasks, follow two passes while respecting the active mode and existing tool permissions:
1. Research: inspect relevant files, dependencies, entry points, and tests; identify constraints and edge cases before editing. In execution-capable modes, use the existing file tools and their normal approvals to create .xcoder/architecture.json containing the task requirements, dependency map, affected files, and verification plan.
2. Execution: make changes in dependency order using existing approval and safety rules. Update .xcoder/context.json through the existing file tools with the implementation state, changed files, and verification results. Do not create or modify files in plan-only mode; describe the intended state artifacts in the plan instead.

Do not install dependencies or run destructive commands unless the existing runtime permission flow explicitly authorizes them. Never bypass approval gates.`;

export async function resolveSystemPrompt(input: {
	cwd: string;
	explicitSystemPrompt?: string;
	providerId?: string;
	rules?: string;
	mode?: AgentMode;
}): Promise<string> {
	const metadata = await buildWorkspaceMetadata(input.cwd);
	// Mode-tag and plan-mode instructions are appended by the shared prompt
	// builder itself (see MODE_TAG_INSTRUCTIONS / PLAN_MODE_INSTRUCTIONS in
	// @cline/shared), so only the caller-specific rules are merged here.
	const rules = mergeRulesForSystemPrompt(undefined, input.rules);
	const basePrompt = buildClineSystemPrompt({
		ide: "Terminal Shell",
		workspaceRoot: input.cwd,
		workspaceName: basename(input.cwd),
		metadata,
		rules,
		mode: input.mode,
		providerId: input.providerId,
		overridePrompt: input.explicitSystemPrompt,
		platform:
			(typeof process !== "undefined" && process?.platform) || "unknown",
	});
	return `${basePrompt}\n\n${X_CODER_CLI_POLICY}`;
}

const FILE_MENTION_PREFIX = String.raw`(?:\/|~\/|\.{1,2}\/)`;
const FILE_MENTION_PATTERN_TEST = new RegExp(
	String.raw`@(?:"${FILE_MENTION_PREFIX}[^"\r\n]+"|${FILE_MENTION_PREFIX}\S+)`,
	"i",
);
const FILE_MENTION_PATTERN_EXEC = new RegExp(
	String.raw`@(?:"(${FILE_MENTION_PREFIX}[^"\r\n]+)"|(${FILE_MENTION_PREFIX}\S+))`,
	"g",
);
function hasFileMentions(prompt: string): boolean {
	return FILE_MENTION_PATTERN_TEST.test(prompt);
}

function extractFileMentions(
	prompt: string,
): Array<{ path: string; index: number; raw: string }> {
	const matches: Array<{ path: string; index: number; raw: string }> = [];
	let match: RegExpExecArray | null;
	const pattern = new RegExp(
		FILE_MENTION_PATTERN_EXEC.source,
		FILE_MENTION_PATTERN_EXEC.flags,
	);

	for (;;) {
		match = pattern.exec(prompt);
		if (!match) break;
		const path = match[1] ?? match[2];
		if (!path) continue;
		matches.push({
			path,
			index: match.index,
			raw: match[0],
		});
	}
	return matches;
}

function resolveMentionPath(filePath: string): string {
	if (filePath.startsWith("~/")) {
		return resolve(homedir(), filePath.slice(2));
	}
	return resolve(filePath);
}

/**
 * Whether a typed `/skill` command must be textually expanded into the
 * prompt. When the session registers the runtime's `skills` tool (its
 * description requires the model to invoke it on slash-command references),
 * the typed command passes through and the instructions arrive as a tool
 * result — keeping the persisted transcript as what the user typed. When the
 * tool is unavailable (yolo preset, user toggle), expansion is the only
 * delivery path.
 */
export function shouldExpandSkillSlashCommands(mode?: string): boolean {
	try {
		return !isSkillsToolAvailable({
			mode: mode === "plan" || mode === "yolo" ? mode : "act",
			disabledToolIds: new Set(readGlobalSettings().disabledTools ?? []),
		});
	} catch {
		return true;
	}
}

export async function buildUserInputMessage(
	rawPrompt: string,
	userInstructionService?: UserInstructionConfigService,
	options?: { mode?: string },
): Promise<{
	prompt: string;
	userImages: string[];
	userFiles: string[];
}> {
	// First, resolve slash commands if the core config service is available.
	let prompt = rawPrompt;
	if (userInstructionService) {
		prompt = userInstructionService.resolveRuntimeSlashCommand(rawPrompt, {
			expandSkillCommands: shouldExpandSkillSlashCommands(options?.mode),
		});
	}

	if (!hasFileMentions(prompt)) {
		return {
			prompt,
			userImages: [],
			userFiles: [],
		};
	}

	const fileMentions = extractFileMentions(prompt);

	if (fileMentions.length === 0) {
		return {
			prompt,
			userImages: [],
			userFiles: [],
		};
	}

	fileMentions.sort((a, b) => b.index - a.index);

	let processedPrompt = prompt;
	const userImages: string[] = [];
	const userFiles: string[] = [];
	const loadedImages: Array<{
		index: number;
		dataUrl: string;
		fileName: string;
	}> = [];
	const loadedFiles: Array<{
		index: number;
		path: string;
		fileName: string;
	}> = [];

	for (const mention of fileMentions) {
		try {
			const resolvedPath = resolveMentionPath(mention.path);
			const stats = statSync(resolvedPath);
			if (!stats.isFile()) {
				throw new Error(`Path is not a file: ${resolvedPath}`);
			}
			const fileName = basename(resolvedPath);

			if (isImagePath(resolvedPath)) {
				const dataUrl = loadImageAsDataUrl(resolvedPath);
				loadedImages.push({
					index: mention.index,
					dataUrl,
					fileName,
				});
				processedPrompt = processedPrompt.replace(
					mention.raw,
					`[image: ${fileName}]`,
				);
				continue;
			}

			loadedFiles.push({
				index: mention.index,
				path: resolvedPath,
				fileName,
			});
			processedPrompt = processedPrompt.replace(
				mention.raw,
				`[file: ${fileName}]`,
			);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(`[warning] ${errorMsg}`);
		}
	}

	for (const image of loadedImages.reverse()) {
		userImages.push(image.dataUrl);
	}
	for (const file of loadedFiles.reverse()) {
		userFiles.push(file.path);
	}

	return {
		prompt: processedPrompt,
		userImages,
		userFiles,
	};
}
