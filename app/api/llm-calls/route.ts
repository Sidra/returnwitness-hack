import { connection } from "next/server";
import { recentLlmCalls } from "@/lib/obs/llm-log";
import { json, publicJson } from "@/lib/api";

export async function GET() {
  await connection();
  return publicJson({ calls: recentLlmCalls().slice(0, 100) });
}
