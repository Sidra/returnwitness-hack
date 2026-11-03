import { connection } from "next/server";
import { getStore } from "@/lib/store/case-store";
import { json, publicJson } from "@/lib/api";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const c = await getStore().get(id);
  return c ? publicJson({ case: c }) : json({ error: "not_found", message: `case ${id} not found` }, 404);
}
