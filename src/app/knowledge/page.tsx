import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { productAreas } from "@/lib/knowledge";
import KnowledgeManager from "@/components/KnowledgeManager";

export const dynamic = "force-dynamic";

// The rep-managed knowledge base. Gated like the console: only a signed-in rep gets in.
export default async function KnowledgePage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!session) redirect("/login");

  const areas = productAreas();
  return <KnowledgeManager areas={areas.length ? areas : ["Health Protection"]} />;
}
