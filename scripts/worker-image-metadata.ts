import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type Inspect = (args: string[]) => Promise<string>;
const inspect: Inspect = async (args) =>
  (await execFileAsync("docker", args, { timeout: 1500, maxBuffer: 16_384 })).stdout;

/** Inspect the actual running container, never infer the image from a mutable
 * tag or dump its config (which contains secret environment variables). */
export async function containerImageMetadata(
  name: string,
  run: Inspect = inspect,
): Promise<{ image_id: string | null; image_digests: string[] }> {
  let imageId: string | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const result = (await run(["container", "inspect", "--format", "{{.Image}}", name])).trim();
      if (/^sha256:[a-f0-9]{64}$/.test(result)) imageId = result;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (imageId === null) return { image_id: null, image_digests: [] };
  let digests: string[] = [];
  try {
    const parsed: unknown = JSON.parse(
      await run(["image", "inspect", "--format", "{{json .RepoDigests}}", imageId]),
    );
    if (Array.isArray(parsed)) {
      digests = parsed.filter(
        (item): item is string =>
          typeof item === "string" && /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(item),
      );
    }
  } catch {
    /* local-only images have an ID without registry digests */
  }
  return { image_id: imageId, image_digests: digests };
}
