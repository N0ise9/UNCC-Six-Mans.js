import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getAsset, getAssetKeys } from "node:sea";
import { getPackagedAssetRoot, isPackagedRuntime } from "./runtimePaths";

const PRISMA_STUDIO_ASSET_PREFIX = "prisma-studio/";
const EXTRACTION_MARKER_FILENAME = ".complete";

type PrismaStudioAssetsOptions = {
  assetKeys?: () => string[];
  assetReader?: (key: string) => ArrayBuffer;
  packaged?: boolean;
  targetRoot?: string;
};

export function ensurePrismaStudioAssetsExtracted(options: PrismaStudioAssetsOptions = {}): string {
  const packaged = isPackagedRuntime({ packaged: options.packaged });
  const targetRoot = options.targetRoot ?? getPackagedAssetRoot({ packaged });

  if (!packaged) {
    return targetRoot;
  }

  const markerPath = path.resolve(targetRoot, EXTRACTION_MARKER_FILENAME);
  if (fs.existsSync(markerPath)) {
    return targetRoot;
  }

  const assetKeys = (options.assetKeys ?? getAssetKeys)().filter((key) => key.startsWith(PRISMA_STUDIO_ASSET_PREFIX));
  if (assetKeys.length === 0) {
    throw new Error("Embedded Prisma Studio assets were not found in the packaged executable.");
  }

  fs.rmSync(targetRoot, { force: true, recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });

  const readAsset = options.assetReader ?? getAsset;
  for (const assetKey of assetKeys) {
    const relativeSegments = assetKey.split("/").filter(Boolean);
    const normalizedSegments = relativeSegments.map((segment, index) => {
      if (index !== relativeSegments.length - 1 || !segment.endsWith(".gz")) {
        return segment;
      }

      return segment.slice(0, -3);
    });
    const targetPath = path.resolve(targetRoot, ...normalizedSegments);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const assetBuffer = Buffer.from(readAsset(assetKey));
    fs.writeFileSync(targetPath, assetKey.endsWith(".gz") ? zlib.gunzipSync(assetBuffer) : assetBuffer);
  }

  fs.writeFileSync(markerPath, "ok\n", "utf8");
  return targetRoot;
}
