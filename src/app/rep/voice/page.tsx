import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import VoiceSetup from "@/components/VoiceSetup";

export const dynamic = "force-dynamic";

// One-time voice enrolment, gated like the console: only a signed-in rep gets in. The username (the
// login) keys the stored voiceprint; the prettified name is for display.
export default async function VoicePage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!session) redirect("/login");

  const username = String(session.sub ?? session.name ?? "rep");
  const repName = prettifyName(String(session.name ?? session.sub ?? "Representative"));
  return <VoiceSetup username={username} repName={repName} />;
}

function prettifyName(s: string): string {
  return (
    s
      .trim()
      .split(/\s+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ") || "Representative"
  );
}
