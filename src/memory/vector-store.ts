import { join } from "node:path";
import { getAppPath } from "../utils/appPath.js";
import { existsSync, mkdirSync } from "node:fs";

/**
 * Pillar 3: Continuous Digital Twin - Vector Store
 * A semantic memory database using SQLite.
 * This stores the continuous background captures of the screen,
 * allowing Jarvis to answer questions like "What was I reading an hour ago?"
 */
export interface SleepTask {
  intention: string;
  priority: number;
  status: "pending" | "processing" | "completed";
}

export class VectorStore {
  private dbPath: string;
  private sleepQueue: SleepTask[] = [];

  constructor() {
    const memoryDir = join(getAppPath(), "memory", "semantic");
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
    this.dbPath = join(memoryDir, "digital_twin.sqlite");
    this.initDb();
  }

  private initDb() {
    // Scaffold: Initialize SQLite database for storing screen text and embeddings.
    console.log(`[Digital Twin] Initialized vector store at ${this.dbPath}`);
  }

  public async queueSleepTask(intention: string, priority: number = 1) {
    this.sleepQueue.push({ intention, priority, status: "pending" });
    this.sleepQueue.sort((a, b) => b.priority - a.priority);
    console.log(`[Digital Twin] Queued background sleep task: "${intention}"`);
  }

  public async processSleepQueue() {
    // Scaffold: The digital twin wakes up and processes these while the screen is asleep.
    for (const task of this.sleepQueue.filter(t => t.status === "pending")) {
       task.status = "processing";
       console.log(`[Digital Twin] Processing sleep task: "${task.intention}"... done.`);
       task.status = "completed";
    }
  }

  public async ingestScreenText(text: string, timestamp: number) {
    if (text.length < 20) return;
    
    // Scaffold: In production, generate an embedding vector for this text using a local MLX model
    // or lightweight ONNX model, then insert into the SQLite table.
    
    // console.log(`[Digital Twin] Ingested ${text.length} chars at ${timestamp}`);
  }

  public async semanticSearch(query: string): Promise<string[]> {
    // Scaffold: Generate embedding for query, then run vector similarity search in SQLite.
    return [
      `Scaffolded search result matching "${query}"`,
      `In the future, this will return exact context blocks from your digital twin memory.`
    ];
  }
}

export const digitalTwinDb = new VectorStore();
