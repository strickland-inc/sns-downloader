export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startMaintenance } = await import("@/lib/server/maintenance");
  startMaintenance();
}
