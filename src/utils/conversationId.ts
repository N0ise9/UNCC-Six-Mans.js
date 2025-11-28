import * as fs from "fs";
import path from "path";

const CONVO_FILE = ".conversation_id";

function getConversationFilePath(): string {
  const cwd = process.cwd();
  return path.resolve(cwd, CONVO_FILE);
}

/**
 * Loads conversation id with the following precedence:
 * 1) `process.env.conversation_id` if present (and syncs it into `.conversation_id` file)
 * 2) `.conversation_id` file if present (and exports it to `process.env.conversation_id`)
 * 3) empty string if nothing found
 */
export function loadConversationId(): string {
  const envId = process.env["conversation_id"]?.trim();
  const filePath = getConversationFilePath();

  if (envId) {
    try {
      fs.writeFileSync(filePath, envId, { encoding: "utf8" });
    } catch (e) {
      // ignore file sync errors; runtime can proceed without file
    }
    return envId;
  }

  try {
    if (fs.existsSync(filePath)) {
      const fileId = fs.readFileSync(filePath, { encoding: "utf8" }).trim();
      if (fileId) {
        process.env["conversation_id"] = fileId;
        return fileId;
      }
    }
  } catch (e) {
    // ignore file read errors
  }

  return "";
}

/**
 * Saves the given conversation id into `.conversation_id` and sets the env var.
 */
export function saveConversationId(id: string): void {
  if (!id) return;
  const filePath = getConversationFilePath();
  try {
    fs.writeFileSync(filePath, id, { encoding: "utf8" });
  } catch (e) {
    // ignore write errors
  }
  process.env["conversation_id"] = id;
}
