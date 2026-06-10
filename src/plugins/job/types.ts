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
}

/** Parsed email-filter metadata stored in the presendScript marker line. */
export interface EmailFilterMeta {
  version: number;
  keywords: string[];
  regex: string | null;
  case_sensitive: boolean;
}

/** Options for buildFreestyleXml. */
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
}
