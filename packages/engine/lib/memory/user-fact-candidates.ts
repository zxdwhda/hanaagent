import { getLocale } from "../i18n.ts";
import { SessionBranchError } from "../session-jsonl.ts";
import {
  revalidateUserFactProvenance,
  type ProjectedMemoryMessage,
  type VerifiedUserFact,
} from "./user-fact-provenance.ts";

type ResolveSessionBranch = (sessionId: string) => { messages?: ProjectedMemoryMessage[] } | null;

export function verifiedUserFactCandidates(
  session: any,
  resolveSessionBranch?: ResolveSessionBranch,
): VerifiedUserFact[] | null {
  const provenance = session?.userFactProvenance;
  if (provenance?.status !== "verified" || !Array.isArray(provenance.candidates)) return null;
  if (resolveSessionBranch) {
    try {
      const messages = resolveSessionBranch(session.session_id)?.messages;
      if (!Array.isArray(messages) || !revalidateUserFactProvenance(provenance, messages)) return null;
    } catch (err) {
      if (err instanceof SessionBranchError) return null;
      throw err;
    }
  }
  return provenance.candidates;
}

export function attributedUserFact({ text }: VerifiedUserFact) {
  return getLocale().startsWith("zh") ? `用户原话：${text}` : `User stated: ${text}`;
}
