import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import AdvisorConsole from "@/components/AdvisorConsole";

export const dynamic = "force-dynamic";

// Server component: the gate. Only a valid rep session reaches the co-pilot.
export default async function RepPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) redirect("/login");

  const username = String(session.name ?? session.sub ?? "Representative");
  return <AdvisorConsole repName={username} />;
}
