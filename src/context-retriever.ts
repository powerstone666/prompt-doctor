import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type ExtractorOutput = {
  tolist: () => unknown;
};

type FeatureExtractor = (
  input: string | string[],
  options: { pooling: "mean"; normalize: true }
) => Promise<ExtractorOutput>;

type CodeChunk = {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  lexicalTerms: Set<string>;
  embedding?: number[];
};

type CandidateFile = {
  absolutePath: string;
  relativePath: string;
};

type IndexFingerprintEntry = {
  path: string;
  size: number;
  mtimeMs: number;
};

type PersistedChunk = {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  lexicalTerms: string[];
};

type PersistedIndex = {
  version: number;
  modelId: string;
  fingerprint: string;
  maxChunkLines: number;
  chunkOverlapLines: number;
  chunks: PersistedChunk[];
};

type RetrieverConfig = {
  rootDir?: string;
  modelId?: string;
  topK?: number;
  maxFiles?: number;
  maxChunkLines?: number;
  chunkOverlapLines?: number;
};

const OPTIMAL_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const OPTIMAL_TOP_K = 6;
const OPTIMAL_MAX_FILES = 1000;
const OPTIMAL_MAX_CHUNK_LINES = 48;
const OPTIMAL_CHUNK_OVERLAP_LINES = 8;
const OPTIMAL_EMBED_BATCH_SIZE = 24;
const LEXICAL_CANDIDATE_MULTIPLIER = 12;
const LEXICAL_SCORE_WEIGHT = 0.2;
const VECTOR_SCORE_WEIGHT = 0.8;
const RAG_DIRECTORY_NAME = ".rag";
const RAG_INDEX_FILE_NAME = "code-index-v1.json";
const RAG_EXCLUSION_FILE_NAME = "indexing-exclude.txt";
const PERSISTED_INDEX_VERSION = 1;
const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".json"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  ".next",
  RAG_DIRECTORY_NAME
]);
const DEFAULT_EXCLUDE_PATTERNS = [
  ".env",
  ".env.",
  "secrets",
  "secret",
  "private_key",
  "privatekey",
  "pem",
  "p12",
  "keystore",
  "keychain",
  "id_rsa",
  "id_dsa",
  "id_ed25519",
  "ssh_key",
  "apikey",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "bearer",
  "authorization",
  "jwt",
  "session_key",
  "client_secret",
  "app_secret",
  "consumer_secret",
  "consumer_key",
  "oauth_token",
  "oauth_secret",
  "password",
  "passwd",
  "pwd",
  "db_password",
  "database_url",
  "connection_string",
  "dsn",
  "smtp_password",
  "mail_password",
  "redis_password",
  "mongodb_uri",
  "postgres_url",
  "mysql_url",
  "sqlite_url",
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "aws_",
  "gcp_service_account",
  "google_application_credentials",
  "azure_client_secret",
  "azure_tenant_id",
  "azure_subscription_id",
  "keyvault",
  "vault",
  "vault_token",
  "kubeconfig",
  "k8s_secret",
  "ansible_vault",
  "sops",
  "doppler",
  "vercel_token",
  "netlify_auth_token",
  "github_token",
  "gitlab_token",
  "npm_token",
  "pypi_token",
  "slack_token",
  "discord_token",
  "stripe_secret",
  "paypal_secret",
  "twilio_auth_token",
  "sendgrid_api_key",
  "openai_api_key",
  "anthropic_api_key",
  "hf_token",
  "huggingface_token",
  "clerk_secret_key",
  "supabase_service_role_key",
  "firebase_private_key",
  "telegram_bot_token",
  "bot_token",
  "cookie_secret",
  "signing_key",
  "encryption_key",
  "master_key",
  "license_key",
  "prod.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx"
];

export class CodebaseContextRetriever {
  private readonly rootDir: string;
  private readonly ragDir: string;
  private readonly ragIndexFilePath: string;
  private readonly ragExclusionFilePath: string;
  private readonly modelId: string;
  private readonly topK: number;
  private readonly maxFiles: number;
  private readonly maxChunkLines: number;
  private readonly chunkOverlapLines: number;

  private extractorPromise: Promise<FeatureExtractor | null> | null = null;
  private indexChunks: CodeChunk[] = [];
  private indexFingerprint = "";
  private indexPromise: Promise<void> | null = null;
  private indexingStarted = false;

  constructor(config: RetrieverConfig = {}) {
    this.rootDir = config.rootDir ?? process.cwd();
    this.ragDir = path.join(this.rootDir, RAG_DIRECTORY_NAME);
    this.ragIndexFilePath = path.join(this.ragDir, RAG_INDEX_FILE_NAME);
    this.ragExclusionFilePath = path.join(this.ragDir, RAG_EXCLUSION_FILE_NAME);
    this.modelId = config.modelId ?? OPTIMAL_MODEL_ID;
    this.topK = config.topK ?? OPTIMAL_TOP_K;
    this.maxFiles = config.maxFiles ?? OPTIMAL_MAX_FILES;
    this.maxChunkLines = config.maxChunkLines ?? OPTIMAL_MAX_CHUNK_LINES;
    this.chunkOverlapLines = config.chunkOverlapLines ?? OPTIMAL_CHUNK_OVERLAP_LINES;
  }

  public async getContextForPrompt(prompt: string, activeFile?: string): Promise<string | undefined> {
    if (!prompt.trim()) {
      return undefined;
    }

    // Start indexing in background if not already started
    this.startIndexingIfNeeded();

    // Use whatever index is currently available (might be partial or empty)
    if (this.indexChunks.length === 0) {
      return undefined;
    }

    const rankedChunks = await this.rankChunks(prompt);
    const selected = rankedChunks
      .slice(0, this.topK)
      .map((entry) => entry.chunk);

    const normalizedActiveFile = this.normalizeFilePath(activeFile);
    const activeFileChunks = normalizedActiveFile
      ? this.indexChunks
          .filter((chunk) => this.isSameFile(chunk.filePath, normalizedActiveFile))
          .slice(0, 2)
      : [];

    if (selected.length === 0 && activeFileChunks.length === 0) {
      return undefined;
    }

    return this.formatContext(selected, normalizedActiveFile, activeFileChunks);
  }

  private startIndexingIfNeeded(): void {
    if (this.indexingStarted) {
      return;
    }

    this.indexingStarted = true;
    
    // Try to eagerly load cached index for immediate use
    this.tryLoadCachedIndexSync();
    
    // Fire and forget - full indexing happens in background
    this.ensureIndex().catch((error) => {
      console.error("Background indexing failed:", error);
    });
  }

  private tryLoadCachedIndexSync(): void {
    // Attempt to read and parse cached index synchronously for immediate availability
    // This is a best-effort attempt - any errors are silently ignored
    try {
      const fs = require("node:fs");
      const raw = fs.readFileSync(this.ragIndexFilePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedIndex;
      
      if (parsed.version === PERSISTED_INDEX_VERSION && Array.isArray(parsed.chunks)) {
        this.indexChunks = parsed.chunks.map((chunk) => ({
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          lexicalTerms: new Set(chunk.lexicalTerms)
        }));
        this.indexFingerprint = parsed.fingerprint;
        console.error(`Loaded ${this.indexChunks.length} chunks from cache for immediate use`);
      }
    } catch {
      // Cache not available or invalid - background indexing will handle it
    }
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexPromise) {
      await this.indexPromise;
      return;
    }

    this.indexPromise = this.rebuildIndexIfNeeded().finally(() => {
      this.indexPromise = null;
    });

    await this.indexPromise;
  }

  private async rebuildIndexIfNeeded(): Promise<void> {
    const excludePatterns = await this.loadExcludePatterns();
    const files = await this.collectCandidateFiles(this.rootDir);
    const fingerprintEntries: IndexFingerprintEntry[] = [];

    for (const file of files) {
      if (this.shouldExcludeFile(file.relativePath, excludePatterns)) {
        continue;
      }

      const fileStat = await this.safeStat(file.absolutePath);
      if (!fileStat) {
        continue;
      }

      fingerprintEntries.push({
        path: file.relativePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      });
    }

    const fingerprint = fingerprintEntries
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `${entry.path}:${entry.size}:${entry.mtimeMs}`)
      .join("|");

    if (fingerprint === this.indexFingerprint && this.indexChunks.length > 0) {
      return;
    }

    const cachedChunks = await this.tryLoadPersistedIndex(fingerprint);
    if (cachedChunks) {
      this.indexFingerprint = fingerprint;
      this.indexChunks = cachedChunks;
      return;
    }

    const nextChunks: CodeChunk[] = [];
    for (const file of files) {
      if (this.shouldExcludeFile(file.relativePath, excludePatterns)) {
        continue;
      }

      const content = await this.safeRead(file.absolutePath);
      if (!content) {
        continue;
      }

      const chunks = this
        .chunkFileContent(file.relativePath, content)
        .filter((chunk) => !this.shouldExcludeChunk(chunk, excludePatterns));
      nextChunks.push(...chunks);
    }

    // Skip embedding during indexing - embed only at query time for speed

    this.indexFingerprint = fingerprint;
    this.indexChunks = nextChunks;
    console.error(`Indexed ${nextChunks.length} chunks from ${files.length} files (background)`);
    await this.persistIndex(fingerprint, nextChunks);
  }

  private async collectCandidateFiles(rootDir: string): Promise<CandidateFile[]> {
    const results: CandidateFile[] = [];
    const queue = [rootDir];

    while (queue.length > 0 && results.length < this.maxFiles) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (results.length >= this.maxFiles) {
          break;
        }

        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) {
            queue.push(fullPath);
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const extension = path.extname(entry.name);
        if (SUPPORTED_EXTENSIONS.has(extension)) {
          results.push({
            absolutePath: fullPath,
            relativePath: path.relative(this.rootDir, fullPath)
          });
        }
      }
    }

    return results;
  }

  private chunkFileContent(relativePath: string, content: string): CodeChunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: CodeChunk[] = [];
    const step = Math.max(1, this.maxChunkLines - this.chunkOverlapLines);

    // First pass: identify code structure boundaries (functions, classes, exports)
    const boundaries = this.identifyCodeBoundaries(lines);

    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length, start + this.maxChunkLines);
      
      // Try to align chunk with code boundaries for better semantic coherence
      const alignedEnd = this.alignToCodeBoundary(start, end, boundaries);
      
      const text = lines.slice(start, alignedEnd).join("\n").trim();
      if (!text) {
        continue;
      }

      const chunkMetadata = this.extractChunkMetadata(text);

      chunks.push({
        filePath: relativePath,
        startLine: start + 1,
        endLine: alignedEnd,
        text: chunkMetadata ? `[${chunkMetadata}]\n${text}` : text,
        lexicalTerms: this.tokenize(text)
      });
    }

    return chunks;
  }

  private identifyCodeBoundaries(lines: string[]): Set<number> {
    const boundaries = new Set<number>();
    const functionPatterns = [
      /^\s*(export\s+)?(async\s+)?function\s+\w+/,
      /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,
      /^\s*(public|private|protected|static)\s+(async\s+)?\w+\s*\(/,
      /^\s*\w+\s*\([^)]*\)\s*\{/
    ];
    const classPatterns = [
      /^\s*(export\s+)?(abstract\s+)?class\s+\w+/,
      /^\s*(export\s+)?interface\s+\w+/,
      /^\s*(export\s+)?type\s+\w+\s*=/,
      /^\s*(export\s+)?enum\s+\w+/
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isFunction = functionPatterns.some(p => p.test(line));
      const isClass = classPatterns.some(p => p.test(line));
      
      if (isFunction || isClass) {
        boundaries.add(i);
      }
    }

    return boundaries;
  }

  private alignToCodeBoundary(start: number, end: number, boundaries: Set<number>): number {
    // If we're close to a boundary, extend to include it
    for (let i = end; i < Math.min(end + 5, start + this.maxChunkLines); i++) {
      if (boundaries.has(i)) {
        return i;
      }
    }
    return end;
  }

  private extractChunkMetadata(text: string): string | null {
    // Extract key code structure information for context
    const functionMatch = text.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(|(?:public|private|protected|static)\s+(?:async\s+)?(\w+)\s*\(/);
    const classMatch = text.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)|(?:export\s+)?interface\s+(\w+)|(?:export\s+)?type\s+(\w+)\s*=/);
    
    if (functionMatch) {
      const name = functionMatch[1] || functionMatch[2] || functionMatch[3];
      return `Function: ${name}`;
    }
    if (classMatch) {
      const name = classMatch[1] || classMatch[2] || classMatch[3];
      const type = classMatch[0].includes('interface') ? 'Interface' : 
                   classMatch[0].includes('type') ? 'Type' : 'Class';
      return `${type}: ${name}`;
    }
    
    return null;
  }

  private tokenize(input: string): Set<string> {
    const normalized = input.toLowerCase();
    const tokens = normalized.match(/[a-z0-9_]{3,}/g) ?? [];
    return new Set(tokens);
  }

  private async rankChunks(prompt: string): Promise<Array<{ chunk: CodeChunk; score: number }>> {
    const queryTerms = this.tokenize(prompt);
    const lexicalScores = new Map<CodeChunk, number>();

    for (const chunk of this.indexChunks) {
      let overlap = 0;
      for (const term of queryTerms) {
        if (chunk.lexicalTerms.has(term)) {
          overlap += 1;
        }
      }

      if (overlap === 0) {
        continue;
      }

      const normalized = overlap / Math.sqrt(Math.max(1, queryTerms.size * chunk.lexicalTerms.size));
      lexicalScores.set(chunk, normalized);
    }

    const lexicalCandidates = Array.from(lexicalScores.entries())
      .map(([chunk, score]) => ({ chunk, score }))
      .sort((left, right) => right.score - left.score)
      .slice(0, this.topK * LEXICAL_CANDIDATE_MULTIPLIER);

    if (lexicalCandidates.length === 0) {
      return [];
    }

    const extractor = await this.getExtractor();
    if (!extractor) {
      return lexicalCandidates;
    }

    // Embed query and candidates on-demand for semantic reranking
    const queryEmbedding = await this.embedText(prompt, extractor);
    if (!queryEmbedding) {
      return lexicalCandidates;
    }

    // Embed only the lexical candidates (much smaller set)
    const candidateTexts = lexicalCandidates.map(c => c.chunk.text);
    const candidateEmbeddings = await this.embedBatch(candidateTexts, extractor);

    const reranked = lexicalCandidates
      .map((candidate, index) => {
        const vectorScore = candidateEmbeddings[index]
          ? this.cosineSimilarity(queryEmbedding, candidateEmbeddings[index])
          : 0;
        return {
          chunk: candidate.chunk,
          score: candidate.score * LEXICAL_SCORE_WEIGHT + vectorScore * VECTOR_SCORE_WEIGHT
        };
      })
      .sort((left, right) => right.score - left.score);

    return reranked;
  }

  private formatContext(chunks: CodeChunk[], activeFile?: string, activeFileChunks: CodeChunk[] = []): string {
    const sections: string[] = [];
    
    // Active file section - ALWAYS first and clearly marked
    if (activeFile) {
      const activeChunk = activeFileChunks[0];
      const summary = activeChunk ? this.summarizeChunk(activeChunk.text) : "No indexed excerpt available.";
      const activeSectionParts = [
        "=== ACTIVE FILE (PRIMARY TARGET) ===",
        `File path: ${activeFile}`,
        `Summary: ${summary}`,
        ""
      ];
      
      if (activeFileChunks.length > 0) {
        activeSectionParts.push(
          "Code excerpts from active file:\n" +
          activeFileChunks
            .map(
              (chunk) =>
                `Lines ${chunk.startLine}-${chunk.endLine}:\n` +
                "```\n" +
                `${chunk.text}\n` +
                "```"
            )
            .join("\n\n")
        );
      }
      sections.push(activeSectionParts.join("\n"));
    }

    // Reference context - clearly marked as reference only
    if (chunks.length > 0) {
      sections.push(
        "=== REFERENCE CONTEXT (for patterns/conventions only) ===\n" +
        chunks
          .map(
            (chunk) =>
              `File: ${chunk.filePath} (lines ${chunk.startLine}-${chunk.endLine})\n` +
              "```\n" +
              `${chunk.text}\n` +
              "```"
          )
          .join("\n\n")
      );
    }

    return sections.join("\n\n");
  }

  private normalizeFilePath(filePath?: string): string | undefined {
    if (!filePath?.trim()) {
      return undefined;
    }

    const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (path.isAbsolute(normalized)) {
      const relative = path.relative(this.rootDir, normalized).replace(/\\/g, "/");
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative;
      }
    }

    return normalized;
  }

  private isSameFile(left: string, right: string): boolean {
    const normalizedLeft = left.replace(/\\/g, "/").toLowerCase();
    const normalizedRight = right.replace(/\\/g, "/").toLowerCase();
    return normalizedLeft === normalizedRight;
  }

  private summarizeChunk(text: string): string {
    const firstLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return "No readable content available.";
    }

    const compact = firstLine.replace(/\s+/g, " ");
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }

  private async embedBatch(input: string[], extractor: FeatureExtractor): Promise<number[][]> {
    const output = await extractor(input, { pooling: "mean", normalize: true });
    const raw = output.tolist();
    if (!Array.isArray(raw)) {
      return [];
    }

    if (Array.isArray(raw[0])) {
      return raw as number[][];
    }

    return [raw as number[]];
  }

  private async embedText(input: string, extractor: FeatureExtractor): Promise<number[] | undefined> {
    const output = await this.embedBatch([input], extractor);
    return output[0];
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dot = 0;
    for (let index = 0; index < a.length; index += 1) {
      dot += a[index] * b[index];
    }
    return dot;
  }

  private async tryLoadPersistedIndex(fingerprint: string): Promise<CodeChunk[] | undefined> {
    const raw = await this.safeRead(this.ragIndexFilePath);
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedIndex;
      const isCompatible =
        parsed.version === PERSISTED_INDEX_VERSION &&
        parsed.fingerprint === fingerprint &&
        parsed.modelId === this.modelId &&
        parsed.maxChunkLines === this.maxChunkLines &&
        parsed.chunkOverlapLines === this.chunkOverlapLines &&
        Array.isArray(parsed.chunks);

      if (!isCompatible) {
        return undefined;
      }

      return parsed.chunks.map((chunk) => ({
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        lexicalTerms: new Set(chunk.lexicalTerms)
      }));
    } catch {
      return undefined;
    }
  }

  private async persistIndex(fingerprint: string, chunks: CodeChunk[]): Promise<void> {
    const payload: PersistedIndex = {
      version: PERSISTED_INDEX_VERSION,
      modelId: this.modelId,
      fingerprint,
      maxChunkLines: this.maxChunkLines,
      chunkOverlapLines: this.chunkOverlapLines,
      chunks: chunks.map((chunk) => ({
        filePath: chunk.filePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text: chunk.text,
        lexicalTerms: Array.from(chunk.lexicalTerms)
      }))
    };

    try {
      await mkdir(this.ragDir, { recursive: true });
      await writeFile(this.ragIndexFilePath, JSON.stringify(payload), "utf8");
    } catch (error) {
      console.error("Failed to persist RAG index:", error);
    }
  }

  private async getExtractor(): Promise<FeatureExtractor | null> {
    if (this.extractorPromise) {
      return this.extractorPromise;
    }

    this.extractorPromise = this.loadExtractor();
    return this.extractorPromise;
  }

  private async loadExtractor(): Promise<FeatureExtractor | null> {
    try {
      const dynamicImport = new Function(
        "modulePath",
        "return import(modulePath)"
      ) as (modulePath: string) => Promise<{ pipeline: (...args: unknown[]) => Promise<FeatureExtractor> }>;

      const { pipeline } = await dynamicImport("@huggingface/transformers");
      return await pipeline("feature-extraction", this.modelId);
    } catch (error) {
      console.error("RAG embeddings disabled (could not initialize @huggingface/transformers):", error);
      return null;
    }
  }

  private async loadExcludePatterns(): Promise<string[]> {
    await this.ensureExclusionFileExists();
    const content = await this.safeRead(this.ragExclusionFilePath);
    if (!content) {
      return [];
    }

    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.toLowerCase());
  }

  private async ensureExclusionFileExists(): Promise<void> {
    const existing = await this.safeRead(this.ragExclusionFilePath);
    if (existing !== undefined) {
      return;
    }

    try {
      await mkdir(this.ragDir, { recursive: true });
      await writeFile(this.ragExclusionFilePath, DEFAULT_EXCLUDE_PATTERNS.join("\n"), "utf8");
    } catch (error) {
      console.error("Failed to initialize RAG exclusion patterns file:", error);
    }
  }

  private shouldExcludeFile(relativePath: string, patterns: string[]): boolean {
    return this.matchesAnyPattern(relativePath.toLowerCase(), patterns);
  }

  private shouldExcludeChunk(chunk: CodeChunk, patterns: string[]): boolean {
    const searchable = `${chunk.filePath}\n${chunk.text}`.toLowerCase();
    return this.matchesAnyPattern(searchable, patterns);
  }

  private matchesAnyPattern(text: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (!pattern) {
        continue;
      }

      if (pattern.includes("*")) {
        const wildcardRegex = new RegExp(
          pattern
            .split("*")
            .map((part) => this.escapeRegex(part))
            .join(".*")
        );
        if (wildcardRegex.test(text)) {
          return true;
        }
        continue;
      }

      if (text.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private async safeRead(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  private async safeStat(filePath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
    try {
      const stats = await stat(filePath);
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs
      };
    } catch {
      return undefined;
    }
  }
}
