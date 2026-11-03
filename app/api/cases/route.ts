import { connection } from "next/server";
import { getStore } from "@/lib/store/case-store";
import { json, publicJson } from "@/lib/api";

export async function GET() {
  await connection();
  return publicJson({ cases: await getStore().list() });
}
