/**
 * Routing stage: decide WHICH rule batches ("routes") deserve evaluation for a change set,
 * so the expensive per-rule review only runs the rules that can apply.
 *
 * Three inputs are unioned (routes are only ever added, never suppressed):
 *  - baseline routes from the map (`always`), scheduled for every scope
 *  - host heuristics: high-precision lexical/path triggers over the changed lines
 *  - the LLM router (routing-prompt.md) judging semantic applicability per change unit
 *
 * A selected route is a statement of applicability, not a predicted violation.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface RoutingMap {
	version: string;
	always: string[];
	routes: Record<string, { trigger: string; rule_ids: number[] }>;
}

export type UnitStatus = "added" | "modified" | "deleted" | "renamed" | "file";

/** One routable slice of the scope: a changed file's hunks, or a file excerpt in full-tree mode. */
export interface ChangeUnit {
	id: string;
	path: string;
	oldPath?: string;
	status: UnitStatus;
	language: string;
	/** Diff hunks (diff scope) or an excerpt (full scope), possibly truncated. */
	text: string;
	truncated: boolean;
	/** Lines the heuristics scan: added/removed lines in diff scope, all lines in full scope. */
	signalLines: string[];
}

export type RouteSource = "baseline" | "heuristic" | "router" | "router-need" | "fallback" | "unmapped";

export interface RouteSelection {
	route: string;
	sources: Set<RouteSource>;
	/** Human-readable trigger evidence, e.g. `U3 src/db.rs: check-then-insert without a transaction`. */
	evidence: string[];
	/** Context the router asked for before it could decide (`need` entries, promoted to checks). */
	unresolved: string[];
	/** Size of the route's rule membership in the map. */
	ruleCount: number;
}

export interface RouterCheck {
	routes: string[];
	evidence: string[];
	why: string;
}
export interface RouterNeed extends RouterCheck {
	fetch: string[];
}
export interface RouterUnitResult {
	id: string;
	check: RouterCheck[];
	need: RouterNeed[];
}
export interface RouterResponse {
	version: string;
	units: RouterUnitResult[];
	unrouted: { id: string; reason: string }[];
}

export const ROUTER_VERSION = "lint-router-v1";

/** Longest unit body sent to the router; the tail is replaced by a truncation marker. */
export const MAX_UNIT_CHARS = 24_000;
/** Router input budget per call; units are packed into batches under this size. */
export const MAX_ROUTER_BATCH_CHARS = 60_000;
/** Full-tree excerpt: leading lines always shown, plus heuristic hit lines. */
const FULL_EXCERPT_HEAD_LINES = 40;
const FULL_EXCERPT_HIT_LINES = 15;

export async function loadRoutingMap(path: string): Promise<RoutingMap> {
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!parsed || typeof parsed !== "object") throw new Error(`routing map ${path}: not an object`);
	const map = parsed as RoutingMap; // shape checked below
	if (map.version !== ROUTER_VERSION) throw new Error(`routing map ${path}: version ${map.version} != ${ROUTER_VERSION}`);
	if (!Array.isArray(map.always) || !map.routes || typeof map.routes !== "object") {
		throw new Error(`routing map ${path}: missing always/routes`);
	}
	for (const [name, route] of Object.entries(map.routes)) {
		if (!Array.isArray(route.rule_ids) || !route.rule_ids.every((id) => typeof id === "number")) {
			throw new Error(`routing map ${path}: route ${name} has invalid rule_ids`);
		}
	}
	for (const name of map.always) {
		if (!(name in map.routes)) throw new Error(`routing map ${path}: always route ${name} is not defined`);
	}
	return map;
}

const LANGUAGES: Record<string, string> = {
	".rs": "rust",
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".java": "java",
	".kt": "kotlin",
	".scala": "scala",
	".cs": "csharp",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".hpp": "cpp",
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
	".zig": "zig",
	".ex": "elixir",
	".exs": "elixir",
	".erl": "erlang",
	".hs": "haskell",
	".sql": "sql",
	".sh": "shell",
	".bash": "shell",
	".proto": "protobuf",
	".toml": "toml",
	".yaml": "yaml",
	".yml": "yaml",
	".json": "json",
	".md": "markdown",
	".rst": "text",
	".txt": "text",
};

export function detectLanguage(path: string): string {
	const base = basename(path);
	if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return "dockerfile";
	if (base === "Makefile" || base === "CMakeLists.txt") return "build";
	return LANGUAGES[extname(path).toLowerCase()] ?? "unknown";
}

/**
 * Host heuristics. Deliberately narrow: each pattern is a strong lexical signal for the
 * route's subject. Broad words (error, state, config) are left to the LLM router, since a
 * heuristic can only add routes and every false positive costs a batch of rule evaluations.
 */
const PATH_TRIGGERS: [RegExp, string[]][] = [
	[/(^|\/)(tests?|__tests__|spec|specs|e2e|integration)\/|[._-](test|spec|tests)\.\w+$|^test_.*\.py$|_test\.(go|rs|py)$/i, ["test_design", "test_behavior", "test_environment"]],
	[/(^|\/)(Cargo\.(toml|lock)|package(-lock)?\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|go\.(mod|sum)|requirements.*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|Gemfile(\.lock)?|composer\.(json|lock)|Makefile|CMakeLists\.txt|Dockerfile[^/]*|\.github\/workflows\/.*|\.gitlab-ci\.yml|Jenkinsfile|rust-toolchain(\.toml)?|\.nvmrc|tsconfig.*\.json|\.eslintrc.*|biome\.json)$/i, ["build_dependencies"]],
	[/(^|\/)migrations?\/|\.sql$|(^|\/)schema\.(rs|prisma|graphql|sql)$/i, ["db_schema", "rollout"]],
	[/\.(proto|avsc|avdl|thrift|fbs|capnp)$|(^|\/)openapi.*\.(ya?ml|json)$|(^|\/)swagger.*\.(ya?ml|json)$|(^|\/)asyncapi.*\.(ya?ml|json)$/i, ["wire_formats", "public_api", "rollout"]],
	[/\.(env(\.\w+)?|ini|cfg|conf|properties)$|(^|\/)config(s)?\/|(^|\/)\.?config\.(toml|ya?ml|json)$|(^|\/)settings\.(toml|ya?ml|json|py)$/i, ["config_model", "config_loading"]],
	[/(^|\/)(k8s|kubernetes|helm|charts|deploy|deployment|terraform|ansible)\/|\.tf$|docker-compose.*\.ya?ml$/i, ["operations", "rollout", "config_loading"]],
];

const CODE_TRIGGERS: [RegExp, string[]][] = [
	[/\bunsafe\b|\bextern\s+"C"|\*(const|mut)\s+\w|\btransmute\b|\bfrom_raw(_parts)?\(|\breinterpret_cast\b|\bmemcpy\b|\bctypes\b|\bMaybeUninit\b|\bmalloc\(|\bfree\(/, ["unsafe_memory"]],
	[/\b(Mutex|RwLock|ReentrantLock|Semaphore|Condvar|std::mutex|pthread_mutex_\w+|threading\.Lock|sync\.(Mutex|RWMutex))\b|\.lock\(\)|\bsynchronized\b|\block_guard\b|\bunique_lock\b/, ["locks", "shared_state"]],
	[/\bAtomic(Bool|Usize|Isize|U8|U16|U32|U64|I8|I16|I32|I64|Ptr|Integer|Long|Reference)\b|\b(fetch_add|fetch_sub|compare_exchange(_weak)?|compare_and_swap|CompareAndSwap|atomic_thread_fence|memory_order_\w+)\b|\bOrdering::(Relaxed|Acquire|Release|AcqRel|SeqCst)\b|\bstd::atomic\b|\batomic\.(Add|Load|Store|Swap)\w*\(/, ["atomic_order", "shared_state"]],
	[/\bstatic\s+mut\b|\bthread_local!|\bthread_local\b|\bthreading\.local\b|\bunsafe\s+impl\s+(Send|Sync)\b/, ["shared_state"]],
	[/\basync\s+(fn|def|function|move|\(|\w+\s*\()|\.await\b|\bawait\s+\w|\btokio::|\basync_std::|\basyncio\b|\bspawn(_blocking|_local)?\(|\bgo\s+func\b|\bCompletableFuture\b|\bcoroutine\b|\bsuspend\s+fun\b|\bPromise\.(all|allSettled|race)\b/, ["async_runtime"]],
	[/\b(thread::sleep|time\.sleep|Thread\.sleep|Condvar|notify_(one|all)|wait_timeout|park(_timeout)?\(|yield_now|sched_yield|WaitGroup|CountDownLatch|select!\s*\{|busy_?wait|spin_loop)\b/, ["waiting"]],
	[/\b(SELECT\s+[\w*,\s]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ORDER\s+BY|GROUP\s+BY|LEFT\s+JOIN|INNER\s+JOIN)\b|\bsqlx::|\bdiesel::|\bsea_orm::|\bprisma\.\w+\.(find|create|update|delete|upsert)\w*\(|\.(findOne|findMany|findAll|createQueryBuilder)\(|\bcursor\.execute\(|\bdb\.(Query|Exec|QueryRow)\w*\(/i, ["db_queries"]],
	[/\b(BEGIN(\s+TRANSACTION)?|COMMIT|ROLLBACK|SAVEPOINT|FOR\s+UPDATE|SERIALIZABLE|REPEATABLE\s+READ|READ\s+COMMITTED|ON\s+CONFLICT)\b|\.begin(_transaction)?\(|\.transaction\(|@Transactional|\bisolation_level\b|\bBeginTx\(/i, ["db_transactions"]],
	[/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|TYPE|VIEW)\b|\bADD\s+COLUMN\b|\bDROP\s+COLUMN\b|\bFOREIGN\s+KEY\b|@Entity\b|@Table\b|@Column\b|#\[sea_orm\(|#\[diesel\(|\btable!\s*\{/i, ["db_schema", "rollout"]],
	[/\b(reqwest|hyper|ureq|tonic|urllib3?|httpx|aiohttp|axios|undici)\b|\bfetch\(|\bhttp\.(Get|Post|Client|NewRequest)\b|\bHttpClient\b|\bRestTemplate\b|\bWebClient\b|\brequests\.(get|post|put|delete|request)\(|\bTcpStream\b|\bUdpSocket\b|\bnet\.Dial\b|\bsocket\.(socket|connect)\(|\bWebSocket\b|\bgrpc\.\w+\(/, ["remote_calls", "timeouts"]],
	[/\b(retry|retries|retrying|backoff|reconnect|circuit_?breaker|CircuitBreaker|hedg(e|ing)|failover)\b/i, ["retries"]],
	[/\b(timeout|deadline|time\.After|context\.WithTimeout|context\.WithDeadline|AbortSignal\.timeout|expires?_?(at|in)|ttl)\b/i, ["timeouts"]],
	[/\b(serde|Serialize|Deserialize|serde_json|bincode|prost|protobuf|rmp_serde|json!|JSON\.(parse|stringify)|json\.(loads|dumps)|Marshal|Unmarshal|pickle|to_json|from_json|ObjectMapper|Codec|MessagePack|encode_to_vec|decode_from)\b/, ["wire_formats"]],
	[/\b(Regex::new|regex::|re\.(compile|match|search|sub)|new RegExp|regexp\.(MustCompile|Compile)|Pattern\.compile|tokeni[sz]e\w*|Lexer|Parser|nom::|pest::|strtok|sscanf|split_once|splitn|parse::<)\b/, ["parsing"]],
	[/\b(with_capacity|reserve(_exact)?\(|read_to_end|read_to_string|readAll|ReadAll|ioutil\.ReadAll|io\.ReadAll|readFileSync|fs::read\(|Buffer\.alloc|unbounded_channel|unbounded\(\)|max_size|max_len|MAX_\w+\s*[:=])\b/, ["capacity"]],
	[/\b(ThreadPool|thread::spawn|std::thread|rayon::|ExecutorService|Executors\.new|ForkJoinPool|ThreadPoolExecutor|ProcessPoolExecutor|worker_threads|pool\.(get|acquire|checkout|take)|max_connections|maxPoolSize|pool_size|deadpool|bb8|r2d2|sqlx::Pool|PgPool|ConnectionPool)\b/, ["pools"]],
	[/\b(cache\.(get|set|put|insert|invalidate|evict)|memoiz\w*|\blru\b|LruCache|LRU|lazy_static!|OnceCell|OnceLock|LazyLock|Lazy::new|sync\.Once|@lru_cache|@cache|functools\.cache|Caffeine|moka::)\b/, ["caches"]],
	[/\b(criterion|#\[bench\]|BenchmarkDotNet|@Benchmark|testing\.B\b|#\[inline(\(always\))?\]|always_inline|likely\(|unlikely\(|std::hint::|black_box|opt-level|lto\s*=|codegen-units|target-cpu|_mm_\w+|__m128|__m256|SIMD|prefetch)\b/, ["perf_evidence", "hardware_io"]],
	[/\b(repr\(C\)|repr\(packed|repr\(align|#\[repr\(|__attribute__\(\(packed|alignas\(|cache_line|CACHE_LINE|NUMA|sched_setaffinity|cudaMalloc|cudaMemcpy|hipMalloc|wgpu::|TCP_NODELAY|SO_REUSEPORT|SO_RCVBUF|SO_SNDBUF|setsockopt|io_uring|epoll|kqueue|mmap|madvise)\b/, ["hardware_io"]],
	[/\b(fsync|fdatasync|sync_all|sync_data|O_DIRECT|O_SYNC|WAL|write_ahead|wal_\w+|compaction|vacuum|VACUUM|O_APPEND|append\(true\)|SSTable|LSM)\b/, ["storage_engine"]],
	[/\b(percentile|quantile|p50|p90|p95|p99|histogram|Histogram|prometheus|metrics::|opentelemetry|statsd|rate\(|irate\(|increase\(|moving_average|ewma|EWMA|stddev|variance|median)\b/, ["metric_math"]],
	[/\b(authenticat\w*|authoriz\w*|Authorization|Bearer|permission\w*|is_admin|isAdmin|RBAC|ABAC|\bACL\b|tenant_?id|TenantId|current_user|currentUser|session_id|sessionId|\bjwt\b|JWT|oauth|OAuth|SAML|@PreAuthorize|@RolesAllowed|can\?\(|policy\.(allow|check|evaluate))\b/, ["authorization"]],
	[/\b(Command::new|process::Command|exec\.Command|subprocess\.(run|Popen|call|check_output)|os\.system|child_process|execSync|spawnSync|popen|system\(|eval\(|new Function\(|innerHTML|outerHTML|dangerouslySetInnerHTML|document\.write|v-html|mark_safe|html_safe|XMLReader|DocumentBuilderFactory|sanitiz\w*|escape_?html|shell_?escape|shlex)\b|format!\(\s*"[^"]*\b(SELECT|INSERT|UPDATE|DELETE)\b|f"[^"]*\b(SELECT|INSERT|UPDATE|DELETE)\b|"\s*\+\s*\w+\s*\+\s*"\s*(WHERE|FROM|VALUES)/i, ["injection"]],
	[/\b(sha1|sha256|sha512|md5|MD5|hmac|HMAC|\bAES\b|aes_gcm|ChaCha|RSA|ecdsa|ed25519|x25519|bcrypt|argon2|scrypt|pbkdf2|PBKDF2|rand::|OsRng|thread_rng|randint|Math\.random|crypto\.(random|getRandom|subtle)|SecureRandom|nonce|Nonce|TlsConnector|rustls|openssl|native_tls|ssl\.|SSLContext|InsecureSkipVerify|danger_accept_invalid|verify_signature|certificate|Certificate|rejectUnauthorized)\b/, ["crypto"]],
	[/\b(password|passwd|PASSWORD|secret|SECRET|api_key|API_KEY|apiKey|access_key|ACCESS_KEY|private_key|PRIVATE_KEY|client_secret|CLIENT_SECRET|credential\w*)\b|token\s*[:=]\s*["']|-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-/, ["secrets"]],
	[/#\[(test|tokio::test|cfg\(test\))\]|\bfn test_\w+|\bdef test_\w+|@Test\b|@pytest\.|\b(it|test|describe)\(\s*["'`]|\bexpect\([^)]*\)\.(to|not)|\bassert(_eq|_ne|Equals|That|True|False)?[!(]|\bmock\w*\b|\bMock\w*\b|\bfake\w*\b|\bFake\w*\b|\bstub\w*\b|\bStub\w*\b|\bfixture\b|\bmockito\b|\bjest\.(fn|mock|spyOn)|\bsinon\./, ["test_design", "test_behavior", "test_environment"]],
	[/\b(log::(trace|debug|info|warn|error)|tracing::(trace|debug|info|warn|error|instrument|span)|logger\.(trace|debug|info|warn|error|exception)|logging\.(debug|info|warning|error|exception)|console\.(log|error|warn|info|debug)|println!|eprintln!|dbg!|fmt\.Print\w*|log\.(Print|Fatal|Panic|Info|Warn|Error|Debug)\w*|slog\.|zap\.|logrus\.|LOGGER\.|System\.(out|err)\.print)/, ["logging"]],
	[/\b(healthz|readyz|livez|readiness|liveness|heartbeat|graceful_?shutdown|SIGTERM|SIGHUP|signal::|signal\.Notify|reconcil\w*|crontab|cron_?job|Scheduler|background_task|BackgroundTask|degraded|quarantine|runbook|pagerduty|alertmanager)\b/i, ["operations"]],
	[/\b(env::var(_os)?\(|std::env::|process\.env\.|os\.(environ|getenv)|Getenv|LookupEnv|dotenv|from_env\(|envy::|figment|config::Config|Config::builder|viper\.|@Value\(|@ConfigurationProperties|clap::|structopt|argparse|cobra\.|yargs|commander)\b/, ["config_loading", "config_model"]],
	[/#\[cfg\((not\()?feature\s*=|cfg!\(feature|#\[cfg_attr\(feature|\[features\]|feature_?flags?|FeatureFlag|featureFlag|LaunchDarkly|ldclient|unleash|Unleash|Flagsmith|#ifdef|#ifndef|#if\s+defined|#endif|if\s+flags?\.\w+/, ["features"]],
	[/#\[(deprecated|allow\(|expect\(|ignore\])|@Deprecated|@SuppressWarnings|@deprecated|eslint-disable|@ts-ignore|@ts-expect-error|#\s*noqa|#\s*type:\s*ignore|#\s*pylint:\s*disable|nolint|@Ignore|@Disabled|\.skip\(|xit\(|xdescribe\(|it\.skip|test\.skip|@pytest\.mark\.skip|\bFIXME\b|\bHACK\b|\bXXX\b|\bpolyfill\b/, ["legacy"]],
	[/\b(kafka|Kafka|rdkafka|rabbitmq|amqp|lapin|\bnats\b|NATS|\bsqs\b|SQS|\bsns\b|SNS|pubsub|PubSub|kinesis|Kinesis|EventBridge|\.ack\(|\.nack\(|dead_?letter|DLQ|outbox|Outbox|idempotency_?key|IdempotencyKey)\b/, ["messaging"]],
	[/\b(raft|Raft|paxos|Paxos|quorum|Quorum|leader_?election|LeaderElection|is_leader|isLeader|fencing|fence_token|replica\w*|Replica\w*|consensus|etcd|zookeeper|ZooKeeper|consul|\bHLC\b|vector_clock|VectorClock|lamport|two_?phase|\b2pc\b|\bsaga\b|Saga\b|CRDT|gossip)\b/, ["replication"]],
	[/\b(Interpreter|Evaluator|\bDSL\b|AstNode|ast::|RuleEngine|rule_engine|WorkflowEngine|workflow_engine|PluginManager|plugin_manager|load_plugin|loadPlugin|dlopen|LoadLibrary|libloading|Class\.forName|reflect\.|Reflection|__getattr__|setattr\(|Reflect\.|downcast_ref|downcast\(|dynamic_cast|as_any\(\))\b/, ["dynamic_platform"]],
];

/** Prose and data formats: a keyword there is documentation or payload, not an operation. Code triggers do not apply. */
const NON_CODE_LANGUAGES: Record<string, true> = { markdown: true, text: true, json: true, yaml: true, toml: true };

/** Heuristic route triggers for a unit: route -> distinct matched snippets (max 3). */
export function heuristicRoutes(unit: ChangeUnit): Map<string, string[]> {
	const hits = new Map<string, Set<string>>();
	const add = (routes: string[], snippet: string) => {
		for (const route of routes) {
			let set = hits.get(route);
			if (!set) hits.set(route, (set = new Set()));
			if (set.size < 3) set.add(snippet);
		}
	};
	for (const [pattern, routes] of PATH_TRIGGERS) {
		if (pattern.test(unit.path) || (unit.oldPath && pattern.test(unit.oldPath))) add(routes, `path ${unit.path}`);
	}
	for (const line of NON_CODE_LANGUAGES[unit.language] ? [] : unit.signalLines) {
		for (const [pattern, routes] of CODE_TRIGGERS) {
			const match = pattern.exec(line);
			if (match) add(routes, match[0].trim());
		}
	}
	return new Map([...hits].map(([route, set]) => [route, [...set]]));
}

// ---------------------------------------------------------------------------
// Unit construction

interface DiffFile {
	path: string;
	oldPath?: string;
	status: Exclude<UnitStatus, "file">;
	body: string;
	binary: boolean;
}

/** Split `git diff` output into per-file records. Header parsing is line-based; hunks are kept verbatim. */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
	const files: DiffFile[] = [];
	const chunks = diffText.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
	for (const chunk of chunks) {
		const lines = chunk.split("\n");
		const header = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/.exec(lines[0]);
		let oldPath = header?.[1];
		let path = header?.[2] ?? oldPath ?? "";
		let status: DiffFile["status"] = "modified";
		let binary = false;
		let hunkStart = -1;
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith("@@")) {
				hunkStart = i;
				break;
			}
			if (line.startsWith("new file mode")) status = "added";
			else if (line.startsWith("deleted file mode")) status = "deleted";
			else if (line.startsWith("rename from ")) {
				oldPath = line.slice("rename from ".length);
				status = "renamed";
			} else if (line.startsWith("rename to ")) path = line.slice("rename to ".length);
			else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
			else if (line.startsWith("+++ b/")) path = line.slice("+++ b/".length);
			else if (line.startsWith("--- a/")) oldPath = line.slice("--- a/".length);
		}
		if (status === "modified" && oldPath && oldPath !== path) status = "renamed";
		if (status !== "renamed") oldPath = undefined;
		files.push({ path, oldPath, status, binary, body: hunkStart === -1 ? "" : lines.slice(hunkStart).join("\n").trimEnd() });
	}
	return files;
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: `${text.slice(0, max)}\n[... truncated ${text.length - max} chars]`, truncated: true };
}

export function unitsFromDiff(diffText: string): ChangeUnit[] {
	return parseUnifiedDiff(diffText).map((file, index) => {
		const { text, truncated } = truncate(file.binary ? "(binary file)" : file.body, MAX_UNIT_CHARS);
		const signalLines = file.body
			.split("\n")
			.filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
			.map((line) => line.slice(1));
		return {
			id: `U${index + 1}`,
			path: file.path,
			oldPath: file.oldPath,
			status: file.status,
			language: detectLanguage(file.path),
			text,
			truncated,
			signalLines,
		};
	});
}

/** Full-tree unit: leading lines plus heuristic hit lines, so the router sees what the file is and what it touches. */
export function unitFromFile(id: string, path: string, content: string): ChangeUnit {
	const lines = content.split("\n");
	const head = lines.slice(0, FULL_EXCERPT_HEAD_LINES);
	const probe: ChangeUnit = { id, path, status: "file", language: detectLanguage(path), text: "", truncated: false, signalLines: lines };
	const hitLines: string[] = [];
	if (lines.length > FULL_EXCERPT_HEAD_LINES) {
		outer: for (let i = FULL_EXCERPT_HEAD_LINES; i < lines.length; i++) {
			for (const [pattern] of CODE_TRIGGERS) {
				if (pattern.test(lines[i])) {
					hitLines.push(`${i + 1}: ${lines[i]}`);
					if (hitLines.length >= FULL_EXCERPT_HIT_LINES) break outer;
					break;
				}
			}
		}
	}
	const excerpt = [
		...head,
		...(lines.length > FULL_EXCERPT_HEAD_LINES ? [`[... ${lines.length - FULL_EXCERPT_HEAD_LINES} more lines; heuristic hits follow]`, ...hitLines] : []),
	].join("\n");
	const { text, truncated } = truncate(excerpt, MAX_UNIT_CHARS);
	return { ...probe, text, truncated: truncated || lines.length > FULL_EXCERPT_HEAD_LINES };
}

/** Pack units into router batches under the input budget; a single oversized unit forms its own batch. */
export function batchUnits(units: ChangeUnit[], maxChars = MAX_ROUTER_BATCH_CHARS): ChangeUnit[][] {
	const batches: ChangeUnit[][] = [];
	let current: ChangeUnit[] = [];
	let size = 0;
	for (const unit of units) {
		const cost = unit.text.length + unit.path.length + 200;
		if (current.length > 0 && size + cost > maxChars) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(unit);
		size += cost;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

// ---------------------------------------------------------------------------
// Router prompt and response handling

export interface RouterInputOptions {
	scopeDescription: string;
	deletedFiles?: string[];
	manifestComplete: boolean;
}

/** The user-turn payload for one router call; the routing prompt itself is the system prompt. */
export function buildRouterInput(units: ChangeUnit[], heuristics: Map<string, Map<string, string[]>>, options: RouterInputOptions): string {
	const facts: { ref: string; units: string[]; text: string }[] = [];
	let factIndex = 1;
	facts.push({ ref: `F${factIndex++}`, units: units.map((u) => u.id), text: `Scope: ${options.scopeDescription}. ${options.manifestComplete ? "The unit inventory for this batch is complete." : "This batch is one slice of a larger change set; cross-batch relationships may be missing."}` });
	if (options.deletedFiles && options.deletedFiles.length > 0) {
		facts.push({ ref: `F${factIndex++}`, units: [], text: `Deleted files (bodies unavailable): ${options.deletedFiles.join(", ")}` });
	}
	for (const unit of units) {
		const hits = heuristics.get(unit.id);
		if (hits && hits.size > 0) {
			const summary = [...hits].map(([route, snippets]) => `${route} (${snippets.join(", ")})`).join("; ");
			facts.push({ ref: `F${factIndex++}`, units: [unit.id], text: `Host lexical heuristics already scheduled these routes for ${unit.id}; they are positive facts, not exclusions: ${summary}` });
		}
		if (unit.truncated) facts.push({ ref: `F${factIndex++}`, units: [unit.id], text: `${unit.id} body is truncated/excerpted; treat the inventory of its contents as partial.` });
	}
	const payload = {
		version: ROUTER_VERSION,
		units: units.map((u) => ({
			id: u.id,
			path: u.path,
			...(u.oldPath ? { old_path: u.oldPath } : {}),
			status: u.status,
			language: u.language,
			[u.status === "file" ? "excerpt" : "diff"]: { ref: `${u.id}.${u.status === "file" ? "excerpt" : "after"}`, text: u.text },
		})),
		facts,
	};
	return [
		"Route the following change units. Evidence references you may cite: each unit's `diff`/`excerpt` ref and the fact refs.",
		"",
		"```json",
		JSON.stringify(payload, null, 1),
		"```",
		"",
		`Return only the JSON object described in your instructions, with "version":"${ROUTER_VERSION}".`,
	].join("\n");
}

/** Lenient JSON object extraction: direct parse -> last fenced block -> outermost brace slice. */
export function extractJsonObject(text: string): unknown {
	const candidates: string[] = [text.trim()];
	const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
	if (fenced.length > 0) candidates.push(fenced[fenced.length - 1][1].trim());
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * Validate a router response against the closed vocabulary and the unit inventory.
 * Throws with a specific reason (fed back to the router on retry).
 */
export function validateRouterResponse(text: string, units: ChangeUnit[], map: RoutingMap): RouterResponse {
	const parsed = extractJsonObject(text);
	if (!parsed) throw new Error("output is not a JSON object");
	const record = parsed as Record<string, unknown>; // object per extractJsonObject
	if (record.version !== ROUTER_VERSION) throw new Error(`version must be "${ROUTER_VERSION}"`);
	if (!Array.isArray(record.units) || !Array.isArray(record.unrouted)) throw new Error("units and unrouted must be arrays");

	const known = new Set(units.map((u) => u.id));
	const seen = new Set<string>();
	const claim = (id: unknown): string => {
		if (typeof id !== "string" || !known.has(id)) throw new Error(`unknown unit id ${JSON.stringify(id)}`);
		if (seen.has(id)) throw new Error(`unit ${id} appears more than once`);
		seen.add(id);
		return id;
	};
	const checkRoutes = (routes: unknown, id: string): string[] => {
		const names = asStringArray(routes);
		if (!Array.isArray(routes) || names.length !== routes.length || names.length === 0) throw new Error(`unit ${id}: routes must be a non-empty string array`);
		for (const name of names) {
			if (!(name in map.routes)) throw new Error(`unit ${id}: unknown route "${name}"`);
			if (map.always.includes(name)) throw new Error(`unit ${id}: baseline route "${name}" must not be emitted`);
		}
		return names;
	};

	const resultUnits: RouterUnitResult[] = [];
	for (const raw of record.units) {
		if (!raw || typeof raw !== "object") throw new Error("units entries must be objects");
		const entry = raw as Record<string, unknown>;
		const id = claim(entry.id);
		const check: RouterCheck[] = [];
		const need: RouterNeed[] = [];
		// A route repeated across entries, or present in both check and need, is a harmless
		// redundancy: check wins and the union is what gets scheduled. Retrying for it would
		// cost a full router round-trip for no information.
		const checked = new Set<string>();
		for (const item of Array.isArray(entry.check) ? entry.check : []) {
			const c = (item ?? {}) as Record<string, unknown>;
			const routes = checkRoutes(c.routes, id);
			for (const r of routes) checked.add(r);
			check.push({ routes, evidence: asStringArray(c.evidence), why: typeof c.why === "string" ? c.why : "" });
		}
		for (const item of Array.isArray(entry.need) ? entry.need : []) {
			const n = (item ?? {}) as Record<string, unknown>;
			const routes = checkRoutes(n.routes, id).filter((r) => !checked.has(r));
			if (routes.length === 0) continue;
			need.push({ routes, evidence: asStringArray(n.evidence), fetch: asStringArray(n.fetch), why: typeof n.why === "string" ? n.why : "" });
		}
		resultUnits.push({ id, check, need });
	}
	const unrouted: RouterResponse["unrouted"] = [];
	for (const raw of record.unrouted) {
		if (!raw || typeof raw !== "object") throw new Error("unrouted entries must be objects");
		const entry = raw as Record<string, unknown>;
		unrouted.push({ id: claim(entry.id), reason: typeof entry.reason === "string" ? entry.reason : "" });
	}
	const missing = [...known].filter((id) => !seen.has(id));
	if (missing.length > 0) throw new Error(`units not covered: ${missing.join(", ")}`);
	return { version: ROUTER_VERSION, units: resultUnits, unrouted };
}

// ---------------------------------------------------------------------------
// Selection: union of sources, expanded to rules

export class RouteSelector {
	private readonly selections = new Map<string, RouteSelection>();
	/** Synthetic route for rules absent from the map; always evaluated, never expanded via the map. */
	private unmapped: RouteSelection | undefined;

	constructor(private readonly map: RoutingMap) {}

	private entry(route: string): RouteSelection {
		let selection = this.selections.get(route);
		if (!selection) {
			this.selections.set(route, (selection = { route, sources: new Set(), evidence: [], unresolved: [], ruleCount: this.map.routes[route].rule_ids.length }));
		}
		return selection;
	}

	add(route: string, source: RouteSource, evidence?: string): void {
		if (!(route in this.map.routes)) return;
		const selection = this.entry(route);
		selection.sources.add(source);
		if (evidence && selection.evidence.length < 12 && !selection.evidence.includes(evidence)) selection.evidence.push(evidence);
	}

	addBaseline(): void {
		for (const route of this.map.always) this.add(route, "baseline", "scheduled for every scope");
	}

	addHeuristics(unit: ChangeUnit, hits: Map<string, string[]>): void {
		for (const [route, snippets] of hits) this.add(route, "heuristic", `${unit.id} ${unit.path}: matched ${snippets.join(", ")}`);
	}

	addRouterResponse(response: RouterResponse, unitsById: Map<string, ChangeUnit>): void {
		for (const unit of response.units) {
			const path = unitsById.get(unit.id)?.path ?? unit.id;
			for (const check of unit.check) {
				for (const route of check.routes) this.add(route, "router", `${unit.id} ${path}: ${check.why || "applicable"}`);
			}
			for (const need of unit.need) {
				for (const route of need.routes) {
					this.add(route, "router-need", `${unit.id} ${path}: ${need.why || "context needed"}`);
					const selection = this.entry(route);
					for (const fetch of need.fetch) {
						const line = `${unit.id} ${path}: ${fetch}`;
						if (!selection.unresolved.includes(line)) selection.unresolved.push(line);
					}
				}
			}
		}
	}

	/** Every route in the map (routing unavailable or disabled). */
	addAll(source: RouteSource, evidence: string): void {
		for (const route of Object.keys(this.map.routes)) this.add(route, source, evidence);
	}

	addUnmapped(count: number): void {
		if (count > 0) {
			this.unmapped = { route: "unmapped", sources: new Set(["unmapped"]), evidence: [`${count} rules absent from routing-map.json are always evaluated`], unresolved: [], ruleCount: count };
		}
	}

	/** Selected routes in map order (baseline first, then declaration order), the synthetic unmapped route last. */
	routes(): RouteSelection[] {
		const selected = Object.keys(this.map.routes)
			.filter((route) => this.selections.has(route))
			.map((route) => this.selections.get(route) as RouteSelection);
		return this.unmapped ? [...selected, this.unmapped] : selected;
	}

	/**
	 * Selected rule ids in route order, each id once, tagged with every selected route that
	 * contains it. Grouping rules by route keeps each evaluation batch topically coherent.
	 */
	ruleIds(): { id: number; routes: string[] }[] {
		const order: number[] = [];
		const routesById = new Map<number, string[]>();
		for (const { route } of this.routes()) {
			if (route === "unmapped") continue;
			for (const id of this.map.routes[route].rule_ids) {
				let routes = routesById.get(id);
				if (!routes) {
					routesById.set(id, (routes = []));
					order.push(id);
				}
				routes.push(route);
			}
		}
		return order.map((id) => ({ id, routes: routesById.get(id) as string[] }));
	}
}
