/**
 * NavigableIndex — a navigable small-world (HNSW) graph in pure TypeScript.
 *
 * WHY THIS EXISTS (Incremento C, see HANDOFF.md): the KB recall surface `kb_vec`
 * was searched by a SYNCHRONOUS brute-force KNN over ~25k vectors. A single
 * cornerstone build fires 50 such scans (35–95s) that block the gateway's single
 * event loop and starve the "sul pezzo" banner. Sub-linear KNN removes the root
 * cause.
 *
 * WHY IN-HOUSE (not an ANN library): on Windows-ARM64 no prebuilt ANN library is
 * a good fit (hnswlib-node compiles from source; usearch win32-arm64 unconfirmed;
 * hnswlib-wasm is browser-only, verified). A pure-TS graph bundles clean, is
 * ARM64-safe, and — crucially — is Sinapsys-faithful: search here is a greedy
 * neighbor-to-neighbor traversal, i.e. SPREADING ACTIVATION made navigable, not a
 * database band-aid. More memories → denser graph → still fast (the north-star).
 *
 * The module is intentionally generic (opaque string id → vector). The kb_vec
 * owner/chunk de-duplication stays in the integration layer (sqlite.ts), keeping
 * this file a small, high-cohesion, independently testable unit.
 *
 * Distance convention mirrors sqlite-vec's `distance_metric=cosine`:
 *   internal distance = 1 − cosine_similarity (∈ [0, 2], lower = closer),
 *   public `score`     = 1 − distance = cosine_similarity (∈ [−1, 1], higher = closer).
 */

/** Tunables for the HNSW graph. All optional; defaults are good for ~10k–100k nodes. */
export interface NavigableIndexOptions {
  /** Neighbors per node on layers > 0 (layer 0 allows 2·M). Default 16. */
  M?: number;
  /** Beam width while inserting — bigger = better graph, slower build. Default 200. */
  efConstruction?: number;
  /** Default beam width while searching — bigger = better recall, slower. Default 64. */
  efSearch?: number;
  /** Seed for level assignment. Fixed default → deterministic, reproducible graphs. */
  seed?: number;
}

/** One search result: opaque id + cosine similarity (higher is closer). */
export interface SearchHit {
  readonly id: string;
  readonly score: number;
}

/** Serialized node: vector as base64 of its Float32 bytes (compact + exact). */
interface SnapshotNode {
  readonly id: string;
  readonly v: string;
  readonly level: number;
  readonly neighbors: number[][];
  readonly deleted: boolean;
}

/** Plain-JSON snapshot of a whole index — persist to disk to skip rebuild-at-boot. */
export interface NavigableIndexSnapshot {
  readonly version: 1;
  readonly dim: number;
  readonly options: Required<NavigableIndexOptions>;
  readonly entryPoint: number;
  readonly maxLevel: number;
  readonly nodes: readonly SnapshotNode[];
}

/** Encode a Float32Array as base64 of its raw little-endian bytes. */
function encodeVec(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
}

/** Decode base64 → a fresh Float32Array (copy, so no shared/pooled buffer). */
function decodeVec(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength % 4 !== 0) {
    throw new RangeError("NavigableIndex: corrupt vector payload (not 4-byte aligned)");
  }
  const out = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}

interface Node {
  readonly id: string;
  /** L2-normalized vector, so cosine similarity is a plain dot product. */
  readonly vec: Float32Array;
  readonly level: number;
  /** neighbors[layer] = internal node indices connected at that layer. */
  readonly neighbors: number[][];
  deleted: boolean;
}

interface Candidate {
  readonly idx: number;
  readonly dist: number;
}

const DEFAULT_SEED = 0x9e3779b9;

/** Deterministic PRNG (mulberry32) — reproducible level assignment without global state. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Binary heap. `compare(a, b) < 0` means `a` has priority (comes out first).
 * Min-heap over distance = nearest first; max-heap = farthest first.
 */
class BinaryHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i], items[parent]) < 0) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else break;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.compare(items[l], items[smallest]) < 0) smallest = l;
        if (r < n && this.compare(items[r], items[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }

  toArray(): T[] {
    return [...this.items];
  }
}

export class NavigableIndex {
  readonly dim: number;
  private readonly M: number;
  private readonly Mmax0: number;
  private readonly efConstruction: number;
  private readonly efSearch: number;
  private readonly seed: number;
  private readonly mL: number;
  private readonly rng: () => number;

  private readonly nodes: Node[] = [];
  private readonly idToIdx = new Map<string, number>();
  private entryPoint = -1;
  private maxLevel = 0;
  private liveCount = 0;

  constructor(dim: number, opts: NavigableIndexOptions = {}) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new RangeError(`NavigableIndex: dim must be a positive integer, got ${dim}`);
    }
    this.dim = dim;
    this.M = Math.max(2, Math.floor(opts.M ?? 16));
    this.Mmax0 = this.M * 2;
    this.efConstruction = Math.max(this.M, Math.floor(opts.efConstruction ?? 200));
    this.efSearch = Math.max(1, Math.floor(opts.efSearch ?? 64));
    this.seed = (opts.seed ?? DEFAULT_SEED) >>> 0;
    this.mL = 1 / Math.log(this.M);
    this.rng = mulberry32(this.seed);
  }

  /** Number of LIVE (non-tombstoned) nodes. */
  get size(): number {
    return this.liveCount;
  }

  /** Number of tombstoned (removed-but-retained-as-waypoint) nodes. Grows until a rebuild GCs them. */
  get tombstoneCount(): number {
    return this.nodes.length - this.liveCount;
  }

  /** Whether an id currently resolves to a live node. */
  has(id: string): boolean {
    return this.idToIdx.has(id);
  }

  /**
   * Index (or re-index) a vector under `id`.
   * @returns `true` if inserted, `false` if skipped (zero / non-finite vector).
   * @throws RangeError on a dimension mismatch (a programming error at the boundary).
   */
  add(id: string, vector: Float32Array): boolean {
    if (vector.length !== this.dim) {
      throw new RangeError(`NavigableIndex.add: expected dim ${this.dim}, got ${vector.length}`);
    }
    const norm = this.normalize(vector);
    if (!norm) return false; // zero / non-finite — must never pollute KNN

    // Upsert: a re-added id replaces its old vector (old node becomes a tombstone
    // waypoint). Done AFTER the zero-check so a bad vector never drops a good one.
    if (this.idToIdx.has(id)) this.remove(id);

    const level = this.randomLevel();
    const idx = this.nodes.length;
    const neighbors: number[][] = [];
    for (let l = 0; l <= level; l++) neighbors.push([]);
    this.nodes.push({ id, vec: norm, level, neighbors, deleted: false });
    this.idToIdx.set(id, idx);
    this.liveCount++;

    if (this.entryPoint === -1) {
      this.entryPoint = idx;
      this.maxLevel = level;
      return true;
    }

    let ep = this.entryPoint;
    const L = this.maxLevel;

    // Zoom in: greedily descend the layers ABOVE the new node's top layer.
    for (let lc = L; lc > level; lc--) {
      const w = this.searchLayer(norm, [ep], 1, lc);
      const nearest = this.nearest(w);
      if (nearest !== -1) ep = nearest;
    }

    // Connect from min(L, level) down to 0.
    let entryPts = [ep];
    for (let lc = Math.min(L, level); lc >= 0; lc--) {
      const w = this.searchLayer(norm, entryPts, this.efConstruction, lc);
      const maxM = lc === 0 ? this.Mmax0 : this.M;
      // Tombstoned nodes stay first-class in the GRAPH (routing waypoints) so the
      // structure never disconnects; they are excluded only from search RESULTS.
      const cands = w.filter((c) => c.idx !== idx);
      const selected = this.selectNeighbors(cands, this.M);

      for (const s of selected) {
        this.nodes[idx].neighbors[lc].push(s);
        this.nodes[s].neighbors[lc].push(idx);
        // Prune the neighbor's list back to its budget if it overflowed.
        const sNb = this.nodes[s].neighbors[lc];
        if (sNb.length > maxM) {
          const sCands: Candidate[] = sNb.map((x) => ({
            idx: x,
            dist: this.distance(this.nodes[s].vec, this.nodes[x].vec),
          }));
          this.nodes[s].neighbors[lc] = this.selectNeighbors(sCands, maxM);
        }
      }
      entryPts = w.map((c) => c.idx);
    }

    if (level > this.maxLevel) {
      this.entryPoint = idx;
      this.maxLevel = level;
    }
    return true;
  }

  /**
   * Tombstone the node for `id`: excluded from future results and neighbor
   * selection, but kept in the graph as a routing waypoint (HNSW deletion is
   * unsafe to do structurally). The build-at-boot rebuild is the real GC.
   * @returns `true` if a live node was removed, `false` if the id was unknown.
   */
  remove(id: string): boolean {
    const idx = this.idToIdx.get(id);
    if (idx === undefined) return false;
    this.nodes[idx].deleted = true;
    this.idToIdx.delete(id);
    this.liveCount--;
    // The entry point must stay LIVE: a dead entry at an emptied top layer can
    // leave freshly-added nodes unreachable. Reassign to the highest-level live node.
    if (idx === this.entryPoint) this.reassignEntryPoint();
    return true;
  }

  /** Point `entryPoint`/`maxLevel` at the highest-level live node (or -1 if none). */
  private reassignEntryPoint(): void {
    let best = -1;
    let bestLevel = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (n.deleted) continue;
      if (n.level > bestLevel) {
        bestLevel = n.level;
        best = i;
      }
    }
    this.entryPoint = best;
    this.maxLevel = best === -1 ? 0 : bestLevel;
  }

  /** Plain-JSON snapshot of the full graph (incl. tombstone waypoints) for disk persistence. */
  serialize(): NavigableIndexSnapshot {
    return {
      version: 1,
      dim: this.dim,
      options: { M: this.M, efConstruction: this.efConstruction, efSearch: this.efSearch, seed: this.seed },
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
      nodes: this.nodes.map((n) => ({
        id: n.id,
        v: encodeVec(n.vec),
        level: n.level,
        neighbors: n.neighbors.map((l) => [...l]),
        deleted: n.deleted,
      })),
    };
  }

  /**
   * Rebuild an index from a snapshot. Fully validated: a corrupt/truncated file
   * (snapshots persist to disk) throws RangeError at LOAD time — never a silent
   * wrong-distance or an opaque TypeError deep inside a later search.
   */
  static deserialize(snap: NavigableIndexSnapshot): NavigableIndex {
    if (!snap || snap.version !== 1 || !Number.isInteger(snap.dim) || snap.dim <= 0) {
      throw new RangeError("NavigableIndex.deserialize: invalid or unsupported snapshot");
    }
    if (!Array.isArray(snap.nodes)) {
      throw new RangeError("NavigableIndex.deserialize: snapshot nodes must be an array");
    }
    const n = snap.nodes.length;
    const idx = new NavigableIndex(snap.dim, snap.options);
    for (const node of snap.nodes) {
      const vec = decodeVec(node.v); // throws on non-4-byte-aligned payloads
      if (vec.length !== snap.dim) {
        throw new RangeError(`NavigableIndex.deserialize: vector length ${vec.length} != dim ${snap.dim}`);
      }
      if (!Number.isInteger(node.level) || node.level < 0) {
        throw new RangeError("NavigableIndex.deserialize: invalid node level");
      }
      if (!Array.isArray(node.neighbors) || node.neighbors.length !== node.level + 1) {
        throw new RangeError("NavigableIndex.deserialize: neighbors/level mismatch");
      }
      for (const layer of node.neighbors) {
        if (!Array.isArray(layer)) {
          throw new RangeError("NavigableIndex.deserialize: invalid neighbor layer");
        }
        for (const nb of layer) {
          if (!Number.isInteger(nb) || nb < 0 || nb >= n) {
            throw new RangeError(`NavigableIndex.deserialize: neighbor index ${nb} out of range`);
          }
        }
      }
      idx.nodes.push({
        id: node.id,
        vec,
        level: node.level,
        neighbors: node.neighbors.map((l) => [...l]),
        deleted: !!node.deleted,
      });
    }
    if (!Number.isInteger(snap.entryPoint) || snap.entryPoint < -1 || snap.entryPoint >= n) {
      throw new RangeError(`NavigableIndex.deserialize: entryPoint ${snap.entryPoint} out of range`);
    }
    if (!Number.isInteger(snap.maxLevel) || snap.maxLevel < 0) {
      throw new RangeError("NavigableIndex.deserialize: invalid maxLevel");
    }
    for (let i = 0; i < idx.nodes.length; i++) {
      const nd = idx.nodes[i];
      if (!nd.deleted) {
        idx.idToIdx.set(nd.id, i);
        idx.liveCount++;
      }
    }
    idx.entryPoint = snap.entryPoint;
    idx.maxLevel = snap.maxLevel;
    return idx;
  }

  /**
   * Approximate cosine KNN. Returns up to `k` live hits, best (highest score) first.
   * @throws RangeError on a dimension mismatch.
   */
  search(query: Float32Array, k: number, efSearch?: number): SearchHit[] {
    if (query.length !== this.dim) {
      throw new RangeError(`NavigableIndex.search: expected dim ${this.dim}, got ${query.length}`);
    }
    const kk = Math.floor(k);
    if (this.entryPoint === -1 || this.liveCount === 0 || kk <= 0) return [];
    const q = this.normalize(query);
    if (!q) return []; // zero query — cosine undefined

    const ef = Math.max(Math.floor(efSearch ?? this.efSearch), kk);
    let ep = this.entryPoint;
    for (let lc = this.maxLevel; lc > 0; lc--) {
      const w = this.searchLayer(q, [ep], 1, lc);
      const nearest = this.nearest(w);
      if (nearest !== -1) ep = nearest;
    }

    // searchLayer returns LIVE nodes only; sort by distance, dedup by id, trim to k.
    const w = this.searchLayer(q, [ep], ef, 0).sort((a, b) => a.dist - b.dist);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const c of w) {
      const id = this.nodes[c.idx].id;
      if (seen.has(id)) continue;
      seen.add(id);
      // Clamp: Float32 normalization can push dot marginally outside [-1, 1].
      hits.push({ id, score: Math.max(-1, Math.min(1, 1 - c.dist)) });
      if (hits.length >= kk) break;
    }
    return hits;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** L2-normalize; return null for a zero / non-finite vector (rejected). */
  private normalize(vector: Float32Array): Float32Array | null {
    let sumSq = 0;
    for (let i = 0; i < vector.length; i++) {
      const x = vector[i];
      if (!Number.isFinite(x)) return null;
      sumSq += x * x;
    }
    if (sumSq <= 0) return null;
    const inv = 1 / Math.sqrt(sumSq);
    const out = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) out[i] = vector[i] * inv;
    return out;
  }

  /** Cosine distance of two ALREADY-normalized vectors: 1 − dot ∈ [0, 2]. */
  private distance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return 1 - dot;
  }

  /** HNSW exponential layer assignment: floor(−ln(U) · mL). */
  private randomLevel(): number {
    let r = this.rng();
    if (r <= 0) r = Number.EPSILON;
    return Math.floor(-Math.log(r) * this.mL);
  }

  private nearest(cands: Candidate[]): number {
    let best = -1;
    let bestDist = Infinity;
    for (const c of cands) {
      if (c.dist < bestDist) {
        bestDist = c.dist;
        best = c.idx;
      }
    }
    return best;
  }

  /**
   * Greedy beam search on one layer. Tombstoned nodes are TRAVERSED as routing
   * waypoints (pushed to `candidates`) but NEVER enter `results` — so the `ef`
   * budget holds `ef` LIVE nodes and a cluster of nearer tombstones can no longer
   * starve the live result set. The live frontier still gates exploration.
   */
  private searchLayer(q: Float32Array, entryPoints: number[], ef: number, layer: number): Candidate[] {
    const visited = new Set<number>();
    const candidates = new BinaryHeap<Candidate>((a, b) => a.dist - b.dist); // nearest first
    const results = new BinaryHeap<Candidate>((a, b) => b.dist - a.dist); // farthest LIVE first

    for (const ep of entryPoints) {
      if (visited.has(ep)) continue;
      visited.add(ep);
      const d = this.distance(q, this.nodes[ep].vec);
      candidates.push({ idx: ep, dist: d });
      if (!this.nodes[ep].deleted) results.push({ idx: ep, dist: d });
    }
    while (results.size > ef) results.pop();

    while (candidates.size > 0) {
      const c = candidates.pop()!;
      const farthest = results.peek();
      // Stop only once we already hold ef LIVE results all nearer than `c`.
      if (farthest && results.size >= ef && c.dist > farthest.dist) break;

      const nb = this.nodes[c.idx].neighbors[layer];
      if (!nb) continue;
      for (const e of nb) {
        if (visited.has(e)) continue;
        visited.add(e);
        const d = this.distance(q, this.nodes[e].vec);
        const far = results.peek();
        // Explore anything within the live frontier (or while under-full).
        if (results.size < ef || (far && d < far.dist)) {
          candidates.push({ idx: e, dist: d }); // route through it (live or tombstone)
          if (!this.nodes[e].deleted) {
            results.push({ idx: e, dist: d });
            if (results.size > ef) results.pop();
          }
        }
      }
    }
    return results.toArray();
  }

  /**
   * Neighbor selection heuristic (Malkov & Yashunin, Alg. 4): keep a candidate
   * only if it is closer to the base than to any already-selected neighbor —
   * favoring diverse long-range links over a tight cluster (better recall).
   * Backfills with pruned candidates to keep the degree up (keepPrunedConnections).
   */
  private selectNeighbors(candidates: Candidate[], m: number): number[] {
    const sorted = [...candidates].sort((a, b) => a.dist - b.dist);
    const picked: Candidate[] = [];
    const pruned: Candidate[] = [];
    for (const c of sorted) {
      if (picked.length >= m) break;
      let good = true;
      for (const p of picked) {
        const dToPicked = this.distance(this.nodes[c.idx].vec, this.nodes[p.idx].vec);
        if (dToPicked < c.dist) {
          good = false;
          break;
        }
      }
      if (good) picked.push(c);
      else pruned.push(c);
    }
    for (const p of pruned) {
      if (picked.length >= m) break;
      picked.push(p);
    }
    return picked.map((p) => p.idx);
  }
}
