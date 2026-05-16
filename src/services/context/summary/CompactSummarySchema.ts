import { z } from 'zod/v4'

export const CompactSummarySchema = z.object({
  schemaVersion: z.literal(1),
  sourceRange: z.object({
    startUuid: z.string(),
    endUuid: z.string(),
    transcriptPath: z.string().optional(),
  }),
  primaryRequest: z.string(),
  activeTask: z.string(),
  hardConstraints: z.array(z.string()),
  userPreferences: z.array(z.string()),
  files: z.array(
    z.object({
      path: z.string(),
      role: z.enum([
        'read',
        'modified',
        'created',
        'deleted',
        'mentioned',
        'test',
        'config',
      ]),
      facts: z.array(z.string()),
      latestKnownState: z.string().optional(),
    }),
  ),
  commands: z.array(
    z.object({
      command: z.string(),
      cwd: z.string().optional(),
      outcome: z.string(),
      importantOutput: z.string().optional(),
    }),
  ),
  errors: z.array(
    z.object({
      symptom: z.string(),
      cause: z.string().optional(),
      fixAttempted: z.string().optional(),
      status: z.enum(['resolved', 'unresolved', 'unknown']),
    }),
  ),
  decisions: z.array(
    z.object({
      decision: z.string(),
      rationale: z.string().optional(),
    }),
  ),
  tests: z.array(
    z.object({
      command: z.string(),
      result: z.enum(['pass', 'fail', 'not_run', 'partial', 'unknown']),
      notes: z.string().optional(),
    }),
  ),
  plan: z.array(
    z.object({
      item: z.string(),
      status: z.enum(['todo', 'doing', 'done', 'blocked']),
    }),
  ),
  nextAction: z.string(),
  artifactRefs: z.array(
    z.object({
      kind: z.string(),
      id: z.string(),
      path: z.string().optional(),
      summary: z.string(),
    }),
  ),
  doNotForget: z.array(z.string()),
})

export const EmergencyCompactSummarySchema = z.object({
  schemaVersion: z.literal(1),
  activeTask: z.string(),
  hardConstraints: z.array(z.string()),
  changedFiles: z.array(z.string()),
  failingTests: z.array(z.string()),
  nextAction: z.string(),
  artifactRefs: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
    }),
  ),
})

export type CompactSummary = z.infer<typeof CompactSummarySchema>
export type EmergencyCompactSummary = z.infer<typeof EmergencyCompactSummarySchema>

export type ParsedCompactSummary =
  | { ok: true; summary: CompactSummary | EmergencyCompactSummary }
  | { ok: false; error: string }
