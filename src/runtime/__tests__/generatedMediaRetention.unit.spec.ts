import fs from "fs";
import os from "os";
import path from "path";
import { pruneGeneratedMedia } from "../generatedMediaRetention";

describe("generatedMediaRetention", () => {
  function createTempDirectory(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "generated-media-"));
  }

  function cleanup(directory: string): void {
    if (fs.existsSync(directory)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }

  it("prunes files older than the retention window and keeps newer files", () => {
    const directory = createTempDirectory();
    const imagesDirectory = path.join(directory, "images");
    const videosDirectory = path.join(directory, "videos");
    fs.mkdirSync(imagesDirectory, { recursive: true });
    fs.mkdirSync(videosDirectory, { recursive: true });

    const oldFile = path.join(imagesDirectory, "old.png");
    const newFile = path.join(videosDirectory, "new.mp4");
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(newFile, "new");

    const now = Date.now();
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(now - eightDaysMs), new Date(now - eightDaysMs));
    fs.utimesSync(newFile, new Date(now), new Date(now));

    try {
      const deletedCount = pruneGeneratedMedia(directory, now, 7 * 24 * 60 * 60 * 1000);

      expect(deletedCount).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);
    } finally {
      cleanup(directory);
    }
  });
});
