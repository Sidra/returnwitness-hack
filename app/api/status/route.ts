import { connection } from "next/server";
import { systemStatus } from "@/lib/runtime";
import { json, publicJson } from "@/lib/api";

export async function GET() {
  await connection();
  return publicJson(systemStatus());
}
