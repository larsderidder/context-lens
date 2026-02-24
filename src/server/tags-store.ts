import fs from "node:fs";
import path from "node:path";

/**
 * Manages session tags persistence in a sidecar file.
 *
 * Tags are stored separately from capture data (in `.tags.json`) so that
 * tagging/un-tagging doesn't require rewriting large capture files.
 *
 * Structure: { [conversationId: string]: string[] }
 */
export class TagsStore {
  private readonly tagsFile: string;
  private tags = new Map<string, string[]>();
  private dirty = false;

  constructor(dataDir: string) {
    this.tagsFile = path.join(dataDir, ".tags.json");
    this.load();
  }

  /** Load tags from disk. Non-blocking; missing file is fine. */
  private load(): void {
    try {
      const content = fs.readFileSync(this.tagsFile, "utf-8");
      const parsed = JSON.parse(content);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [id, tagList] of Object.entries(parsed)) {
          if (Array.isArray(tagList)) {
            // Normalize: dedupe, trim, lowercase for consistency
            const normalized = [
              ...new Set(
                tagList
                  .filter((t): t is string => typeof t === "string")
                  .map((t) => t.trim().toLowerCase())
                  .filter((t) => t.length > 0),
              ),
            ];
            this.tags.set(id, normalized);
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupted; start fresh
      this.tags.clear();
    }
  }

  /** Save tags to disk if dirty. */
  private save(): void {
    if (!this.dirty) return;
    const obj: Record<string, string[]> = {};
    for (const [id, tagList] of this.tags) {
      if (tagList.length > 0) {
        obj[id] = tagList;
      }
    }
    try {
      fs.writeFileSync(this.tagsFile, JSON.stringify(obj, null, 2));
      this.dirty = false;
    } catch (err: unknown) {
      console.error(
        "Tags save error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Get tags for a conversation. */
  getTags(conversationId: string): string[] {
    return this.tags.get(conversationId) ?? [];
  }

  /** Set tags for a conversation (replaces existing). */
  setTags(conversationId: string, tags: string[]): void {
    // Normalize tags
    const normalized = [
      ...new Set(
        tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0),
      ),
    ];

    const existing = this.tags.get(conversationId) ?? [];
    const changed =
      normalized.length !== existing.length ||
      !normalized.every((t, i) => t === existing[i]);

    if (!changed) return;

    if (normalized.length === 0) {
      this.tags.delete(conversationId);
    } else {
      this.tags.set(conversationId, normalized);
    }
    this.dirty = true;
    this.save();
  }

  /** Add a single tag to a conversation. */
  addTag(conversationId: string, tag: string): void {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return;

    const existing = this.tags.get(conversationId) ?? [];
    if (existing.includes(normalized)) return;

    this.tags.set(conversationId, [...existing, normalized]);
    this.dirty = true;
    this.save();
  }

  /** Remove a single tag from a conversation. */
  removeTag(conversationId: string, tag: string): void {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return;

    const existing = this.tags.get(conversationId) ?? [];
    const idx = existing.indexOf(normalized);
    if (idx === -1) return;

    const next = [...existing.slice(0, idx), ...existing.slice(idx + 1)];
    if (next.length === 0) {
      this.tags.delete(conversationId);
    } else {
      this.tags.set(conversationId, next);
    }
    this.dirty = true;
    this.save();
  }

  /** Get all tags with counts across all conversations. */
  getAllTags(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const tagList of this.tags.values()) {
      for (const tag of tagList) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return counts;
  }

  /** Remove all tags for a conversation (e.g., when deleted). */
  removeConversation(conversationId: string): void {
    if (this.tags.has(conversationId)) {
      this.tags.delete(conversationId);
      this.dirty = true;
      this.save();
    }
  }

  /** Sync tags: remove tags for conversations that no longer exist. */
  syncTags(validConversationIds: Set<string>): void {
    let changed = false;
    for (const id of this.tags.keys()) {
      if (!validConversationIds.has(id)) {
        this.tags.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.save();
    }
  }
}
