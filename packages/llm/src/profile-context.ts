/** Candidate profile context extracted from master_profile.json (S4). */
export interface ProfileSummary {
  summary: string;
  skills: string[];
  targetTitles: string[];
  nocCodes: string[];
  location: string;
  workAuthorization: string;
}

export function extractProfileSummary(master: {
  summary?: string;
  skills?: Record<string, string[]>;
  search_config?: { noc_codes?: string[]; target_province?: string; seniority?: string[] };
  identity?: { work_authorization?: string };
}): ProfileSummary {
  const allSkills = Object.values(master.skills ?? {}).flat();
  const titles = (master.search_config?.seniority ?? []).map((s) => `${s} Developer`);
  return {
    summary: master.summary ?? 'Software developer',
    skills: allSkills.slice(0, 25),
    targetTitles: titles.length > 0 ? titles : ['Senior Developer'],
    nocCodes: master.search_config?.noc_codes ?? ['21231'],
    location: `${master.search_config?.target_province ?? 'Alberta'}, Canada (open to relocation)`,
    workAuthorization: master.identity?.work_authorization ?? 'Employer-supported work authorization required (requires LMIA/sponsorship)',
  };
}
