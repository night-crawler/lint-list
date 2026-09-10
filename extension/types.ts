export interface Rule {
	id: number | string;
	title: string;
	category: string;
	pattern?: string;
	why_bad?: string;
	detection?: string;
	counterexample?: string;
	fix?: string;
	/** relative path of the source JSON, for diagnostics */
	_path: string;
}

export type Severity = "high" | "medium" | "low";

export interface Finding {
	rule_id: number | string;
	file: string;
	lines?: string;
	evidence?: string;
	suggestion: string;
	severity?: Severity;
}

export interface GroupResult {
	group: string;
	ruleIds: (number | string)[];
	/** Routes that selected the rules of this group, in route order. */
	routes: string[];
	findings: Finding[];
	clean: boolean;
	error?: string;
	raw?: string;
}

/** Whole-tree audit, or one bounded to the current branch's diff against a base ref. */
export type AuditScope =
	| { kind: "full"; files: string[] }
	| { kind: "diff"; base: string; files: string[]; deletedFiles: string[]; diffText: string; embedDiff: boolean };
