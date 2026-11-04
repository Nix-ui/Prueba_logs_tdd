import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// ==========================================
// 1. CONFIGURACIÓN Y CONSTANTES
// ==========================================
const EVENTS_DIR = path.join(process.cwd(), ".tdd-events");
const METRICS_FILE = path.join(process.cwd(), "tdd-metrics.json");
const DEFAULT_BRANCH = "main";
const NULL_COMMIT_ID = "000000000000";
const TDD_COMMIT_PREFIX = "chore(tdd)";
const MERGE_MESSAGE_REGEX = /Merge branch '([^']+)'(?: into ([^\s]+))?/;
const FAST_FORWARD_REFLOG_REGEX = /^merge ([^:]+): Fast-forward/;

// ==========================================
// 2. MODELOS E INTERFACES (Dominio)
// ==========================================
export type TddPhase = "RED" | "GREEN" | "REFACTOR";

export interface TestResult {
	numPassedTests: number;
	failedTests: number;
	numTotalTests: number;
	timestamp: number;
	success: boolean;
}

export interface Author {
	name: string;
	email: string;
}

export interface CommitStats {
	filesChanged: number;
	insertions: number;
	deletions: number;
}

export interface CommitMetric {
	commitId: string;
	parents: string[];
	branch: string;
	commitName: string;
	author: Author;
	commitTimestamp: number;
	stats: CommitStats;
	tddPhase: TddPhase;
	tests: TestResult[];
}

export type GitCommitDetails = Omit<
	CommitMetric,
	"stats" | "tddPhase" | "tests"
>;

export interface BifurcationMetric {
	branchName: string;
	parentBranch: string;
	parentCommitId: string;
	createdAtTimestamp: number;
}

export interface MergeMetric {
	mergeCommitId: string;
	sourceBranch: string;
	targetBranch: string;
	mergedAtCommitId: string;
	timestamp: number;
}

export interface TddMetrics {
	repo: string;
	defaultBranch: string;
	commits: CommitMetric[];
	bifurcations: BifurcationMetric[];
	merges: MergeMetric[];
}

// ==========================================
// 3. CAPA DE PERSISTENCIA Y ARCHIVOS
// ==========================================
function ensureDirectoryExists(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

function readJsonFile<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJsonFile<T>(filePath: string, data: T): void {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadMetrics(): TddMetrics {
	const existing = readJsonFile<TddMetrics>(METRICS_FILE);
	return {
		repo: existing?.repo || path.basename(process.cwd()),
		defaultBranch: existing?.defaultBranch || DEFAULT_BRANCH,
		commits: Array.isArray(existing?.commits) ? existing.commits : [],
		bifurcations: Array.isArray(existing?.bifurcations)
			? existing.bifurcations
			: [],
		merges: Array.isArray(existing?.merges) ? existing.merges : [],
	};
}

function saveMetrics(metrics: TddMetrics): void {
	writeJsonFile(METRICS_FILE, metrics);
}

// ==========================================
// 4. UTILIDADES DE GIT (lectura)
// ==========================================
function execGit(command: string): string {
	try {
		return execSync(`git ${command}`, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

function isGitRebasing(): boolean {
	const gitDir = path.join(process.cwd(), ".git");
	return (
		fs.existsSync(path.join(gitDir, "rebase-merge")) ||
		fs.existsSync(path.join(gitDir, "rebase-apply"))
	);
}

function getCurrentBranchName(): string {
	return execGit("rev-parse --abbrev-ref HEAD");
}

function getCommitId(commitHash: string): string {
	return execGit(`rev-parse ${commitHash}`);
}

function getCommitField(format: string, commitHash: string): string {
	return execGit(`log -1 --format=${format} ${commitHash}`);
}

function getCommitParents(commitHash: string): string[] {
	const parentsStr = getCommitField("%P", commitHash);
	return parentsStr ? parentsStr.split(" ") : [NULL_COMMIT_ID];
}

function getCommitSubject(commitHash = "HEAD"): string {
	return getCommitField("%s", commitHash);
}

function isTddChoreCommit(commitHash: string): boolean {
	return getCommitSubject(commitHash).startsWith(TDD_COMMIT_PREFIX);
}

// Salta los commits chore(tdd) y devuelve el commit real anterior
function resolveRealCommitId(commitHash: string): string {
	let current = getCommitId(commitHash) || commitHash;
	while (isTddChoreCommit(current)) {
		current = getCommitParents(current)[0];
	}
	return current;
}

function getLastReflogSubject(): string {
	return execGit("reflog -1 --format=%gs");
}

function getPreviousHeadId(fallback: string): string {
	const origHead = execGit("rev-parse ORIG_HEAD");
	return origHead ? resolveRealCommitId(origHead) : fallback;
}

function findBranchesContaining(commitId: string, excluding: string): string[] {
	return execGit(`branch --contains ${commitId} --format=%(refname:short)`)
		.split("\n")
		.filter((branch) => branch && branch !== excluding);
}

function parseCommitStats(diffStat: string): CommitStats {
	const filesMatch = diffStat.match(/(\d+)\s+file/);
	const insMatch = diffStat.match(/(\d+)\s+insertion/);
	const delMatch = diffStat.match(/(\d+)\s+deletion/);

	return {
		filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
		insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
		deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
	};
}

function getCommitStats(commitHash = "HEAD"): CommitStats {
	return parseCommitStats(
		execGit(`diff-tree --root --shortstat ${commitHash}`),
	);
}

function getGitCommitDetails(commitHash = "HEAD"): GitCommitDetails | null {
	if (isGitRebasing()) return null;
	if (!getCommitId(commitHash)) return null;

	const commitId = resolveRealCommitId(commitHash);
	const branchName = getCurrentBranchName();

	return {
		commitId,
		parents: getCommitParents(commitId).map(resolveRealCommitId),
		branch: branchName === "HEAD" ? "detached" : branchName,
		commitName: getCommitSubject(commitId),
		author: {
			name: getCommitField("%an", commitId),
			email: getCommitField("%ae", commitId),
		},
		commitTimestamp: parseInt(getCommitField("%at", commitId), 10) * 1000,
	};
}

// ==========================================
// 5. EVENTOS TEMPORALES Y FASE TDD
// ==========================================
interface PendingData {
	tests: TestResult[];
	bifurcations: BifurcationMetric[];
	filePaths: string[];
}

function normalizeTestResult(data: Partial<TestResult>): TestResult {
	return {
		numPassedTests: data.numPassedTests || 0,
		failedTests: data.failedTests || 0,
		numTotalTests: data.numTotalTests || 0,
		timestamp: data.timestamp || Date.now(),
		success: data.success ?? true,
	};
}

function listEventFiles(): string[] {
	ensureDirectoryExists(EVENTS_DIR);
	return fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith(".json"));
}

function collectPendingEvents(): PendingData {
	const tests: TestResult[] = [];
	const bifurcations: BifurcationMetric[] = [];
	const filePaths: string[] = [];

	for (const file of listEventFiles()) {
		const fullPath = path.join(EVENTS_DIR, file);

		if (file.startsWith("test-")) {
			const data = readJsonFile<TestResult>(fullPath);
			if (data) {
				tests.push(normalizeTestResult(data));
				filePaths.push(fullPath);
			}
		} else if (file.startsWith("bifurcation-")) {
			const data = readJsonFile<BifurcationMetric>(fullPath);
			if (data) {
				bifurcations.push(data);
				filePaths.push(fullPath);
			}
		}
	}

	tests.sort((a, b) => a.timestamp - b.timestamp);
	return { tests, bifurcations, filePaths };
}

function purgeProcessedEvents(filePaths: string[]): void {
	for (const filePath of filePaths) {
		try {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} catch {}
	}
}

export function calculateTddPhase(tests: TestResult[]): TddPhase {
	if (!tests || tests.length === 0) return "GREEN";

	const lastTest = tests[tests.length - 1];
	if (!lastTest.success || lastTest.failedTests > 0) return "RED";

	const hadPriorFailures = tests.some((t) => !t.success || t.failedTests > 0);
	if (hadPriorFailures) return "GREEN";

	return tests.length > 1 ? "REFACTOR" : "GREEN";
}

// ==========================================
// 6. HANDLER: POST-COMMIT
// ==========================================
function isCommitAlreadyTracked(
	metrics: TddMetrics,
	commitId: string,
): boolean {
	return metrics.commits.some((c) => c.commitId === commitId);
}

function registerNewBifurcations(
	metrics: TddMetrics,
	bifurcations: BifurcationMetric[],
): void {
	for (const bif of bifurcations) {
		const exists = metrics.bifurcations.some(
			(b) => b.branchName === bif.branchName,
		);
		if (!exists) metrics.bifurcations.push(bif);
	}
}

function buildCommitMetric(
	details: GitCommitDetails,
	tests: TestResult[],
): CommitMetric {
	return {
		...details,
		stats: getCommitStats(details.commitId),
		tddPhase: calculateTddPhase(tests),
		tests,
	};
}

function handlePostCommit(metrics: TddMetrics): void {
	const details = getGitCommitDetails("HEAD");
	if (!details || details.branch === "detached") return;
	if (isCommitAlreadyTracked(metrics, details.commitId)) return;

	const { tests, bifurcations, filePaths } = collectPendingEvents();

	registerNewBifurcations(metrics, bifurcations);
	metrics.commits.push(buildCommitMetric(details, tests));

	saveMetrics(metrics);
	purgeProcessedEvents(filePaths);
}

// ==========================================
// 7. HANDLER: POST-CHECKOUT
// ==========================================
function isBranchCheckout(args: string[]): boolean {
	return args[3] === "1";
}

function shouldIgnoreBranch(branchName: string): boolean {
	return !branchName || branchName === "HEAD" || branchName === DEFAULT_BRANCH;
}

function buildBifurcationMetric(
	branchName: string,
	parentCommitId: string,
): BifurcationMetric {
	return {
		branchName,
		parentBranch: DEFAULT_BRANCH,
		parentCommitId,
		createdAtTimestamp: Date.now(),
	};
}

function saveBifurcationEvent(metric: BifurcationMetric): void {
	const fileName = `bifurcation-${metric.branchName.replace(/\//g, "_")}.json`;
	writeJsonFile(path.join(EVENTS_DIR, fileName), metric);
}

function handlePostCheckout(_metrics: TddMetrics, args: string[]): void {
	if (!isBranchCheckout(args)) return;

	const branchName = getCurrentBranchName();
	if (shouldIgnoreBranch(branchName)) return;

	const parentCommitId = resolveRealCommitId(args[1] || NULL_COMMIT_ID);
	saveBifurcationEvent(buildBifurcationMetric(branchName, parentCommitId));
}

// ==========================================
// 8. HANDLER: POST-MERGE (incluye fast-forward)
// ==========================================
function isMergeCommit(parents: string[]): boolean {
	return parents.length > 1;
}

function isMergeAlreadyTracked(metrics: TddMetrics, commitId: string): boolean {
	return metrics.merges.some((m) => m.mergeCommitId === commitId);
}

function parseSourceBranchFromMessage(message: string): string | null {
	const match = message.match(MERGE_MESSAGE_REGEX);
	return match ? match[1] : null;
}

function parseSourceBranchFromReflog(reflogSubject: string): string | null {
	const match = reflogSubject.match(FAST_FORWARD_REFLOG_REGEX);
	return match ? match[1] : null;
}

function resolveSourceBranchForMergeCommit(): string {
	return parseSourceBranchFromMessage(getCommitSubject("HEAD")) ?? "unknown";
}

function resolveSourceBranchForFastForward(
	commitId: string,
	currentBranch: string,
): string {
	const fromReflog = parseSourceBranchFromReflog(getLastReflogSubject());
	if (fromReflog) return fromReflog;

	return findBranchesContaining(commitId, currentBranch)[0] ?? "unknown";
}

function buildMergeMetric(
	commit: GitCommitDetails,
	sourceBranch: string,
	mergedAtCommitId: string,
): MergeMetric {
	return {
		mergeCommitId: commit.commitId,
		sourceBranch,
		targetBranch: commit.branch,
		mergedAtCommitId,
		timestamp: Date.now(),
	};
}

function handlePostMerge(metrics: TddMetrics): void {
	const commit = getGitCommitDetails("HEAD");
	if (!commit) return;
	if (isMergeAlreadyTracked(metrics, commit.commitId)) return;

	const trueMerge = isMergeCommit(commit.parents);

	const sourceBranch = trueMerge
		? resolveSourceBranchForMergeCommit()
		: resolveSourceBranchForFastForward(commit.commitId, commit.branch);

	const mergedAtCommitId = trueMerge
		? commit.parents[0]
		: getPreviousHeadId(commit.parents[0]);

	metrics.merges.push(buildMergeMetric(commit, sourceBranch, mergedAtCommitId));
	saveMetrics(metrics);
}

// ==========================================
// 9. ORQUESTADOR PRINCIPAL (CLI Router)
// ==========================================
type Handler = (metrics: TddMetrics, args: string[]) => void;

const HANDLERS: Record<string, Handler> = {
	"post-commit": (metrics) => handlePostCommit(metrics),
	"post-checkout": (metrics, args) => handlePostCheckout(metrics, args),
	"post-merge": (metrics) => handlePostMerge(metrics),
};

function main(): void {
	ensureDirectoryExists(EVENTS_DIR);

	const cliArgs = process.argv.slice(2);
	const handler = HANDLERS[cliArgs[0]] ?? HANDLERS["post-commit"];

	handler(loadMetrics(), cliArgs);
}

main();
