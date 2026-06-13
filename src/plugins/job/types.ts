/**
 * Job plugin — extra types not already in core/dtos.
 */

/** Parsed summary of a job's config.xml (schedule + email info). */
export interface JobConfigSummary {
  schedule: string;
  email: string;
  email_cond: string;
  email_keywords: string;
  email_regex: string;
  /** Job description. "" when none. Used to prefill the edit form. */
  description: string;
  /**
   * Shell command from the first hudson.tasks.Shell builder, with a leading
   * `cd <dir> && ` stripped into `chdir`. "" when no shell builder. Used to
   * prefill the edit form (so the user sees the real value, not "leave blank").
   */
  shell_cmd: string;
  /** Working dir extracted from a leading `cd <dir> && ` in the shell command. "" when none. */
  chdir: string;
  /** Assigned node/label (<assignedNode>), or "" when the job can roam anywhere. */
  node: string;
  /** Existing string parameter definitions. [] when none. */
  params: StringParamDef[];
}

/** A single String build-parameter definition on a job. */
export interface StringParamDef {
  name: string;
  defaultValue?: string;
  description?: string;
}

/** Options for createFreestyleJob. */
export interface CreateFreestyleOpts {
  desc?: string;
  shellCmd?: string;
  chdir?: string | null;
  node?: string | null;
  schedule?: string | null;
  email?: string | null;
  emailCond?: string;
  emailKeywords?: string[] | null;
  emailRegex?: string | null;
  params?: StringParamDef[] | null;
}

/** Options for updateJobFreestyle — all fields optional; omit = leave unchanged. */
export interface UpdateFreestyleOpts {
  desc?: string | null;
  shellCmd?: string | null;
  node?: string | null;
  schedule?: string | null;
  email?: string | null;
  emailCond?: string | null;
  emailKeywords?: string[] | null;
  emailRegex?: string | null;
  clearEmailKeywords?: boolean;
  clearEmailRegex?: boolean;
  params?: StringParamDef[] | null;
  clearParams?: boolean;
}
export interface FreestyleXmlOpts {
  desc?: string;
  shellCmd?: string;
  node?: string | null;
  chdir?: string | null;
  schedule?: string | null;
  email?: string | null;
  emailCond?: string;
  emailKeywords?: string[] | null;
  emailRegex?: string | null;
  params?: StringParamDef[] | null;
}
